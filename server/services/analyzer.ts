import { spawn, exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import type { BotComment, RepoConfig, AnalysisResult, AnalysisCategory } from "../types.js";
import { getPRBranch, getPRDiff } from "./github.js";

const execAsync = promisify(exec);

interface ClaudeJsonOutput {
  result: string;
}

export interface AnalysisProgressEvent {
  type: "progress" | "complete" | "error";
  step: string;
  message: string;
  progress: number; // 0-100
  detail?: string;
  analyzed?: number;
  results?: AnalysisResult[];
}

function runClaude(prompt: string, cwd: string, onOutput?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );

    let buffer = "";
    let lastResult = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;

          // Extract the final result
          if (event.type === "result" && typeof event.result === "string") {
            lastResult = event.result;
          }

          // Forward content block text to the UI
          if (event.type === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0 && block.text.length <= 200) {
              onOutput?.(block.text.trim());
            }
          }

          // Forward assistant message text
          if (event.type === "assistant") {
            const msg = event.message as Record<string, unknown> | undefined;
            const content = msg?.content as Array<Record<string, unknown>> | undefined;
            if (content) {
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                  const text = block.text.trim();
                  if (text.length > 0 && text.length <= 200) {
                    onOutput?.(text);
                  }
                }
              }
            }
          }
        } catch {
          // Not valid JSON, forward raw if non-empty
          if (line.trim()) onOutput?.(line.trim());
        }
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) onOutput?.(line.trim());
      }
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude timed out after 20 minutes"));
    }, 1200000);

    child.on("close", (code) => {
      clearTimeout(timeout);

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>;
          if (event.type === "result" && typeof event.result === "string") {
            lastResult = event.result;
          }
        } catch {
          // ignore
        }
      }

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      } else if (lastResult) {
        resolve(lastResult);
      } else {
        reject(new Error(`No result from Claude stream. stderr: ${stderr.slice(0, 500)}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function analyzeComments(
  comments: BotComment[],
  repo: RepoConfig,
  onProgress?: (event: AnalysisProgressEvent) => void,
): Promise<AnalysisResult[]> {
  if (comments.length === 0) return [];

  const emit = (e: AnalysisProgressEvent) => onProgress?.(e);

  // Group by PR for context
  const byPR = new Map<string, BotComment[]>();
  for (const c of comments) {
    const key = `${c.repo}#${c.prNumber}`;
    if (!byPR.has(key)) byPR.set(key, []);
    byPR.get(key)!.push(c);
  }

  const allResults: AnalysisResult[] = [];

  for (const [prKey, prComments] of byPR) {
    const [repoLabel, prNumStr] = prKey.split("#");
    const prNumber = parseInt(prNumStr, 10);

    // Step 1: Fetch PR branch
    emit({
      type: "progress",
      step: "fetching_branch",
      message: "Fetching PR branch info...",
      progress: 5,
    });
    const branch = getPRBranch(repoLabel, prNumber);

    // Step 2: Fetch PR diff for full cross-file context
    emit({
      type: "progress",
      step: "fetching_diff",
      message: "Fetching full PR diff for cross-file context...",
      progress: 15,
    });
    const prDiff = getPRDiff(repoLabel, prNumber);

    // Step 3: Set up a read-only local worktree so Claude can explore the full codebase.
    // Unlike the fixer's getWorkDir, we do NOT symlink node_modules or strip hooks —
    // analysis is read-only and those mutations can corrupt the git state / PR.
    let workDir: string | undefined;
    let cleanupWorkDir: (() => Promise<void>) | undefined;
    if (branch && repo.localPath) {
      emit({
        type: "progress",
        step: "setting_up_worktree",
        message: "Setting up local worktree for codebase access...",
        progress: 20,
      });
      try {
        await execAsync("git fetch origin", { cwd: repo.localPath, timeout: 60000 });
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-analyze-"));
        await execAsync(`git worktree add ${tmpDir} origin/${branch}`, {
          cwd: repo.localPath,
          timeout: 60000,
        });
        workDir = tmpDir;
        cleanupWorkDir = async () => {
          await execAsync(`git worktree remove ${JSON.stringify(tmpDir)} --force`, {
            cwd: repo.localPath,
          });
        };
      } catch (err) {
        emit({
          type: "progress",
          step: "worktree_warning",
          message: `Could not set up local worktree: ${err}. Analysis will proceed with limited context.`,
          progress: 22,
        });
      }
    }

    // Step 4: Read file contents from the local worktree for inline context
    const filePaths = [...new Set(prComments.filter((c) => c.path).map((c) => c.path!))];
    emit({
      type: "progress",
      step: "reading_files",
      message: `Reading ${filePaths.length} file(s) from ${workDir ? "local worktree" : "PR branch"}...`,
      progress: 25,
      detail: filePaths.join(", "),
    });

    const fileContents = new Map<string, string | null>();
    if (workDir) {
      // Read files directly from the local worktree
      for (const filePath of filePaths) {
        try {
          const fullPath = path.join(workDir, filePath);
          fileContents.set(filePath, fs.readFileSync(fullPath, "utf-8"));
        } catch {
          fileContents.set(filePath, null);
        }
      }
    }

    // Step 5: Build prompt with comprehensive context
    emit({
      type: "progress",
      step: "building_prompt",
      message: `Building analysis prompt for ${prComments.length} comment(s)...`,
      progress: 35,
    });

    const commentDescriptions = prComments.map((c, i) => {
      let desc = `### Comment ${i + 1} (ID: ${c.id})\n`;
      desc += `- **Bot**: ${c.user}\n`;
      desc += `- **Type**: ${c.type}\n`;
      if (c.path) desc += `- **File**: ${c.path}:${c.line}\n`;
      desc += `- **Comment**:\n${c.body}\n`;

      // Include the diff hunk — shows the exact code change being commented on
      if (c.diffHunk) {
        desc += `- **Diff hunk** (the code change this comment refers to):\n\`\`\`diff\n${c.diffHunk}\n\`\`\`\n`;
      }

      // Include current code with expanded context (±30 lines)
      if (c.type === "inline" && c.path && fileContents.has(c.path)) {
        const content = fileContents.get(c.path);
        if (content) {
          const lines = content.split("\n");
          const lineNum = c.line ?? 1;
          const start = Math.max(0, lineNum - 30);
          const end = Math.min(lines.length, lineNum + 30);
          const snippet = lines
            .slice(start, end)
            .map((l, idx) => `${start + idx + 1} | ${l}`)
            .join("\n");
          desc += `- **Current code at that location** (±30 lines):\n\`\`\`\n${snippet}\n\`\`\`\n`;
        }
      }

      return desc;
    });

    // Include PR diff for cross-file context (truncate if too large)
    let diffSection = "";
    if (prDiff) {
      const maxDiffLen = 12000;
      const truncatedDiff =
        prDiff.length > maxDiffLen
          ? prDiff.slice(0, maxDiffLen) + "\n... (diff truncated for length)"
          : prDiff;
      diffSection = `\n## Full PR Diff (use this for cross-file context)\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
    }

    const prompt = `You are a senior staff engineer triaging automated code review comments on a pull request.
Your job is to separate signal from noise: identify genuine issues while filtering out false positives that waste developer time.
Critically, you must trace the **ripple effects** of each suggested change — bugs often hide in the interactions between components, not in the code a bot points at.

## PR: ${prComments[0].prTitle} (#${prNumber})
Repository: ${repoLabel}
${workDir ? `\n**You are running inside a local checkout of this repository at the PR branch. Use your Read, Grep, Glob, and other file tools to explore the full codebase. Do NOT claim files don't exist locally — they are all available to you.**\n` : ""}
${diffSection}
## Bot Comments to Analyze

${commentDescriptions.join("\n---\n")}

## Your Task

You have full access to the codebase. **You MUST read files beyond the snippets above** before making any judgment. For EACH comment, perform the following deep investigation:

### Step 0: Explore the codebase thoroughly
Before evaluating any comment, build a mental model of the area being changed:
- Read the **full files** referenced in comments, not just the snippets
- Check **imports, type definitions, interfaces, and base classes** to understand contracts
- Search for **all callers and consumers** of any function/method/type being discussed (use grep/search)
- Read **test files** related to the changed code to understand expected behavior and edge cases
- Check **configuration files, constants, and shared state** that the code depends on

### Step 1: Is the issue still present?
Read the current code at the location. If the code has already been updated to address the concern, mark as ALREADY_ADDRESSED.

### Step 2: Is this a real issue or a false positive?
Bot reviewers frequently produce false positives. Consider:
- Does the bot's suggestion actually apply to this specific code in context?
- Is the bot misunderstanding the code's intent, the API being used, or the broader system design?
- Does the suggestion make sense when considering the full PR diff and how different changed files interact?
- Would the suggested change actually improve the code, or is it unnecessary, wrong, or would it introduce new problems?
- Is the bot flagging something that is actually correct by design or convention in this codebase?

### Step 3: Deep side-effect and ripple analysis (CRITICAL)
This is the most important step. For each comment where the bot suggests a code change, you MUST trace what would happen if the suggestion were applied:

**Callers & consumers**: Search the codebase for every place that calls or references the function/method/variable/type being discussed. Would the suggested change break any of them? Would it change behavior they depend on (return type, error handling, null vs undefined, ordering, etc.)?

**Type contracts & interfaces**: If the suggestion changes a function signature, return type, object shape, or class interface — find every implementation and every consumer. Would any of them need updating? Would TypeScript catch it, or would it be a silent runtime change?

**Shared state & data flow**: Trace how data flows into and out of the code in question. If the suggestion changes how data is produced, stored, or validated — what downstream consumers would be affected? Check database schemas, API response shapes, cached values, and global/module-level state.

**Behavioral side effects**: Would the suggestion change timing, ordering, error propagation, or async behavior? For example: changing a synchronous call to async, swallowing an error that callers expect to be thrown, changing the order of operations that has implicit dependencies, altering retry/timeout behavior.

**Cross-boundary impacts**: Does this code sit at a boundary (API endpoint, database layer, message handler, serialization boundary)? Changes at boundaries often have invisible consumers (other services, frontend code, stored data, external integrations).

### Step 4: Severity assessment
Be conservative with severity. Most valid bot suggestions are improvements, not bugs.
**Elevate severity** when your side-effect analysis reveals hidden impacts the bot didn't mention — a "minor style fix" that would silently break callers is a MUST_FIX, not a NICE_TO_HAVE. Conversely, **lower severity** if the bot claims high urgency but your analysis shows the blast radius is zero.

## Categories

- **MUST_FIX** — Genuine bug, security vulnerability, or correctness problem with **concrete evidence** it will cause failures. You must be able to describe the specific failure scenario. Theoretical concerns without a concrete path to failure do NOT qualify. Also applies when applying the bot's own suggestion would introduce breakage due to unconsidered side effects.
- **SHOULD_FIX** — Valid improvement with real benefit: performance problem with measurable impact, best practice violation with real consequences, or meaningful maintainability gain. The suggestion must be correct and beneficial, and your side-effect analysis confirms it is safe to apply.
- **NICE_TO_HAVE** — Minor style preference, trivial improvement, or low-impact suggestion. Not wrong, but not important enough to block a PR. Side-effect analysis shows negligible risk.
- **DISMISS** — False positive, irrelevant suggestion, bot misunderstanding the code, or suggestion that would make the code worse. You MUST explain specifically why the bot is wrong. Also use this when your side-effect analysis shows the suggestion would introduce regressions or break existing behavior.
- **ALREADY_ADDRESSED** — The issue has been fixed in the current code.

## Response Format

After you have explored the codebase and formed your judgments, respond with a JSON array. Each element:
- "commentId": number
- "category": one of "MUST_FIX", "SHOULD_FIX", "NICE_TO_HAVE", "DISMISS", "ALREADY_ADDRESSED"
- "reasoning": string (3-5 sentences. Start with your verdict, then cite what you found in the codebase. For MUST_FIX: describe the specific failure scenario. For DISMISS: explain why the bot is wrong. ALWAYS include what your side-effect analysis found — which callers/consumers/types you checked and whether applying the change is safe or dangerous. Name the specific files and functions you investigated.)

Example: [{"commentId": 123, "category": "DISMISS", "reasoning": "The bot flags a potential null dereference on line 45, but fetchUser() is guaranteed to return a non-null value here because of the guard clause on line 38 that returns early if the user doesn't exist. Checked all 3 callers of this function (UserService.ts:89, AuthController.ts:142, AdminRoute.ts:67) — none pass values that could bypass the guard. The bot is not considering the control flow."}]`;

    // Step 6: Send to Claude
    const claudeCwd = workDir ?? process.cwd();
    emit({
      type: "progress",
      step: "calling_claude",
      message: `Sending ${prComments.length} comment(s) to Claude for deep analysis${workDir ? " (with local codebase access)" : ""}...`,
      progress: 45,
      detail: "Claude is reviewing each comment against the full PR context. This may take 1-2 minutes.",
    });

    let result: string;
    try {
      result = await runClaude(prompt, claudeCwd, (line) => {
        emit({
          type: "progress",
          step: "claude_output",
          message: line,
          progress: 50,
        });
      });
    } finally {
      // Clean up the worktree after analysis completes
      if (cleanupWorkDir) {
        try {
          await cleanupWorkDir();
        } catch (err) {
          console.error("Failed to clean up analysis worktree:", err);
        }
      }
    }

    // Step 6: Parse response
    emit({
      type: "progress",
      step: "parsing_response",
      message: "Claude responded — parsing results...",
      progress: 85,
    });

    // Extract JSON array from the response — Claude may wrap it in text/code blocks
    let cleaned = result.trim();

    // Try to extract from code block first
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }

    // If still not starting with [, find the first [ and last ]
    if (!cleaned.startsWith("[")) {
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");
      if (start !== -1 && end !== -1 && end > start) {
        cleaned = cleaned.slice(start, end + 1);
      }
    }

    try {
      const analyses = JSON.parse(cleaned) as Array<{
        commentId: number;
        category: AnalysisCategory;
        reasoning: string;
      }>;

      for (const a of analyses) {
        allResults.push({
          commentId: a.commentId,
          category: a.category,
          reasoning: a.reasoning,
        });
      }

      // Emit summary
      const counts: Record<string, number> = {};
      for (const a of analyses) {
        counts[a.category] = (counts[a.category] ?? 0) + 1;
      }
      const summary = Object.entries(counts)
        .map(([cat, n]) => `${n} ${cat.replace(/_/g, " ")}`)
        .join(", ");

      emit({
        type: "progress",
        step: "analysis_complete",
        message: `Analysis complete: ${summary}`,
        progress: 100,
        detail: summary,
      });
    } catch (parseErr) {
      console.error("Failed to parse Claude response:", cleaned);
      emit({
        type: "error",
        step: "parse_error",
        message: "Failed to parse Claude's response — marking all for manual review.",
        progress: 100,
      });
      for (const c of prComments) {
        allResults.push({
          commentId: c.id,
          category: "SHOULD_FIX",
          reasoning: "Analysis failed — please review manually.",
        });
      }
    }
  }

  return allResults;
}
