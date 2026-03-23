import { spawn, exec, execSync } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  BotComment,
  RepoConfig,
  AnalysisResult,
  AnalysisCategory,
  AnalysisAccessMode,
  AnalysisEvidence,
  AnalysisSeverity,
  AnalysisVerdict,
} from "../types.js";
import { fetchOrigin } from "./git.js";
import { getPRBranch, getPRDiff } from "./github.js";

const execAsync = promisify(exec);

export type AnalyzerAgent = "claude" | "codex";

const ANALYZER_AGENT_META: Record<AnalyzerAgent, { label: string; command: string }> = {
  claude: { label: "Claude Code", command: "claude" },
  codex: { label: "Codex", command: "codex" },
};

export interface AnalysisProgressEvent {
  type: "progress" | "complete" | "error";
  step: string;
  message: string;
  progress: number; // 0-100
  detail?: string;
  analyzed?: number;
  results?: AnalysisResult[];
}

export interface AnalysisDebugInfo extends Record<string, unknown> {
  analyzerAgent: AnalyzerAgent;
  analyzerName: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  branch: string | null;
  hasWorktree: boolean;
  accessMode: AnalysisAccessMode;
  commentIds: number[];
  commentCount: number;
  filePaths: string[];
  diffLength: number;
  diffTruncated: boolean;
  prompt: string;
}

export function isAnalyzerAgentAvailable(agent: AnalyzerAgent): boolean {
  try {
    execSync(`which ${ANALYZER_AGENT_META[agent].command}`, { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function getAnalyzerAgentLabel(agent: AnalyzerAgent): string {
  return ANALYZER_AGENT_META[agent].label;
}

const ANALYSIS_CATEGORIES: AnalysisCategory[] = [
  "MUST_FIX",
  "SHOULD_FIX",
  "NICE_TO_HAVE",
  "DISMISS",
  "ALREADY_ADDRESSED",
];

const ANALYSIS_SEVERITIES: AnalysisSeverity[] = [
  "MUST_FIX",
  "SHOULD_FIX",
  "NICE_TO_HAVE",
];

const ANALYSIS_VERDICTS: AnalysisVerdict[] = [
  "ACTIONABLE",
  "DISMISS",
  "ALREADY_ADDRESSED",
];

function isAnalysisCategory(value: string): value is AnalysisCategory {
  return ANALYSIS_CATEGORIES.includes(value as AnalysisCategory);
}

function normalizeAnalysisVerdict(value: unknown): AnalysisVerdict | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  return ANALYSIS_VERDICTS.includes(upper as AnalysisVerdict)
    ? upper as AnalysisVerdict
    : undefined;
}

function normalizeAnalysisSeverity(value: unknown): AnalysisSeverity | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  return ANALYSIS_SEVERITIES.includes(upper as AnalysisSeverity)
    ? upper as AnalysisSeverity
    : undefined;
}

function normalizeAnalysisConfidence(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(1, Math.min(5, Math.round(numeric)));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeAnalysisEvidence(value: unknown): AnalysisEvidence | null {
  if (!value || typeof value !== "object") return null;
  const evidence = value as Record<string, unknown>;
  const normalized: AnalysisEvidence = {
    filesRead: normalizeStringArray(evidence.filesRead),
    symbolsChecked: normalizeStringArray(evidence.symbolsChecked),
    callersChecked: normalizeStringArray(evidence.callersChecked),
    testsChecked: normalizeStringArray(evidence.testsChecked),
  };

  if (typeof evidence.riskSummary === "string" && evidence.riskSummary.trim()) {
    normalized.riskSummary = evidence.riskSummary.trim();
  }
  if (typeof evidence.validationNotes === "string" && evidence.validationNotes.trim()) {
    normalized.validationNotes = evidence.validationNotes.trim();
  }

  return (
    normalized.riskSummary ||
    normalized.validationNotes ||
    normalized.filesRead.length > 0 ||
    normalized.symbolsChecked.length > 0 ||
    normalized.callersChecked.length > 0 ||
    normalized.testsChecked.length > 0
  )
    ? normalized
    : null;
}

function normalizeAnalysisAccessMode(
  value: unknown,
  fallback: AnalysisAccessMode,
): AnalysisAccessMode {
  if (typeof value !== "string") return fallback;
  const upper = value.trim().toUpperCase();
  return upper === "FULL_CODEBASE" || upper === "DIFF_ONLY"
    ? upper as AnalysisAccessMode
    : fallback;
}

function deriveCategoryFromStructuredAnalysis(raw: {
  category?: unknown;
  verdict?: unknown;
  severity?: unknown;
}): AnalysisCategory | null {
  if (typeof raw.category === "string" && isAnalysisCategory(raw.category.trim().toUpperCase())) {
    return raw.category.trim().toUpperCase() as AnalysisCategory;
  }

  const verdict = normalizeAnalysisVerdict(raw.verdict);
  const severity = normalizeAnalysisSeverity(raw.severity);

  if (verdict === "DISMISS") return "DISMISS";
  if (verdict === "ALREADY_ADDRESSED") return "ALREADY_ADDRESSED";
  if (verdict === "ACTIONABLE" && severity) return severity;
  if (!verdict && severity) return severity;

  return null;
}

function runClaudeAnalysis(prompt: string, cwd: string, onOutput?: (line: string) => void): Promise<string> {
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
      reject(new Error("Claude Code timed out after 20 minutes"));
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
        reject(new Error(`Claude Code exited with code ${code}: ${stderr}`));
      } else if (lastResult) {
        resolve(lastResult);
      } else {
        reject(new Error(`No result from Claude Code stream. stderr: ${stderr.slice(0, 500)}`));
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

function runCodexAnalysis(prompt: string, cwd: string, onOutput?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "--full-auto", prompt],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (line.trim()) onOutput?.(line.trim());
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) onOutput?.(line.trim());
      }
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Codex timed out after 20 minutes"));
    }, 1200000);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);

      if (signal) {
        reject(new Error(`Codex was killed by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        const cleanStderr = stderr.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim();
        const message = cleanStderr || "Unknown error";
        reject(new Error(`Codex exited with code ${code}: ${message}`));
        return;
      }

      resolve(stdout.trim());
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function analyzeComments(
  comments: BotComment[],
  repo: RepoConfig,
  analyzerAgent: AnalyzerAgent = "claude",
  onProgress?: (event: AnalysisProgressEvent) => void,
  onDebug?: (debug: AnalysisDebugInfo) => void,
): Promise<AnalysisResult[]> {
  if (comments.length === 0) return [];
  if (!isAnalyzerAgentAvailable(analyzerAgent)) {
    throw new Error(`${getAnalyzerAgentLabel(analyzerAgent)} is not available on this machine`);
  }

  const emit = (e: AnalysisProgressEvent) => onProgress?.(e);
  const analyzerLabel = getAnalyzerAgentLabel(analyzerAgent);
  const analyzerOutputStep = `${analyzerAgent}_output`;

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
    const branch = await getPRBranch(repoLabel, prNumber);

    // Step 2: Fetch PR diff for full cross-file context
    emit({
      type: "progress",
      step: "fetching_diff",
      message: "Fetching full PR diff for cross-file context...",
      progress: 15,
    });
    const prDiff = await getPRDiff(repoLabel, prNumber, repo.localPath, branch ?? undefined);

    // Step 3: Set up a read-only local worktree so the analyzer can explore the full codebase.
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
        await fetchOrigin(repo.localPath);
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pr-analyze-${analyzerAgent}-`));
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

    const accessMode: AnalysisAccessMode = workDir ? "FULL_CODEBASE" : "DIFF_ONLY";

    // Step 4: Read file contents from the local worktree for inline context
    const filePaths = [...new Set(prComments.filter((c) => c.path).map((c) => c.path!))];
    emit({
      type: "progress",
      step: "reading_files",
      message: workDir
        ? `Reading ${filePaths.length} file(s) from the local worktree...`
        : `Using diff/snippet context for ${filePaths.length} referenced file(s)...`,
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
    let diffTruncated = false;
    if (prDiff) {
      const maxDiffLen = 12000;
      diffTruncated = prDiff.length > maxDiffLen;
      const truncatedDiff = diffTruncated
        ? prDiff.slice(0, maxDiffLen) + "\n... (diff truncated for length)"
        : prDiff;
      diffSection = `\n## Full PR Diff (use this for cross-file context)\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
    }

    const prompt = `You are a senior staff engineer triaging automated code review comments on a pull request.
Your job is to separate signal from noise, identify real engineering risk, and filter out review noise that wastes developer time.
The most important part of this task is tracing ripple effects: a comment is only actionable if it still applies in the current code and survives side-effect analysis.

## PR: ${prComments[0].prTitle} (#${prNumber})
Repository: ${repoLabel}

## Access Mode
${accessMode}
${workDir
    ? "You are running inside a local checkout of the PR branch. Use your file and search tools to inspect the full codebase. Read full files, callers, and tests when needed."
    : "You do NOT have safe access to the target repository beyond the diff and snippets in this prompt. Do NOT claim you searched the repo or read files that are not included here. If evidence is incomplete, lower confidence and say so explicitly."}
${diffSection}
## Bot Comments to Analyze

${commentDescriptions.join("\n---\n")}

## Decision Model

For EACH comment, decide two things separately:
1. **Verdict**: is the comment actionable, a false positive, or already addressed?
2. **Severity**: if actionable, how important is it to fix?

This separation is mandatory. Do not overload severity to mean "the bot is wrong."

### Step 0: Build the right context
${workDir
    ? `- Read the full files referenced in the comment
- Check imports, types, interfaces, and adjacent code
- Search for callers, consumers, and affected tests
- Inspect relevant config, constants, and shared state`
    : `- Use only the diff, inline snippets, and comment text provided here
- Infer cautiously from the visible code
- Do not invent unseen callers, tests, or files`}

### Step 1: Is the issue still present?
If the current code already addresses the concern, return verdict = ALREADY_ADDRESSED.

### Step 2: Is the bot comment valid?
Review bots are noisy. Ask:
- Does the suggestion apply to this exact code path?
- Is the bot misunderstanding intent, API behavior, or architecture?
- Would the suggested change improve the code, or would it be unnecessary or harmful?
- If the bot's proposed fix is wrong, is there still a real underlying issue that should be fixed another way?

### Step 3: Trace ripple effects before calling it actionable
For comments that might be valid, inspect or infer the blast radius:
- Callers and consumers
- Type contracts and interfaces
- Shared state and data flow
- Behavioral side effects such as ordering, async behavior, and error propagation
- Boundary effects across API, database, serialization, or external integrations

### Step 4: Assign severity only if the issue is actionable
- **MUST_FIX**: concrete bug, security issue, or correctness failure with a specific path to breakage
- **SHOULD_FIX**: worthwhile improvement with real benefit and low regression risk
- **NICE_TO_HAVE**: low-impact improvement or maintainability cleanup

### Verdict rules
- **ACTIONABLE**: the underlying issue is real and worth fixing. If the bot's suggested patch is wrong but the underlying concern is real, still use ACTIONABLE and explain the safer fix direction.
- **DISMISS**: false positive, irrelevant concern, misunderstanding of the code, or a suggestion that would make the code worse.
- **ALREADY_ADDRESSED**: the latest code already resolves it.

## Response Format

Respond with a JSON array. Each element must be:
{
  "commentId": <number>,
  "verdict": "ACTIONABLE" | "DISMISS" | "ALREADY_ADDRESSED",
  "severity": "MUST_FIX" | "SHOULD_FIX" | "NICE_TO_HAVE" | null,
  "confidence": <number 1-5>,
  "reasoning": "<3-5 sentences. Start with the verdict, then explain the evidence. If ACTIONABLE and MUST_FIX, describe the concrete failure scenario. If DISMISS, explain exactly why the bot is wrong. Mention limitations if you are in DIFF_ONLY mode.>",
  "accessMode": "${accessMode}",
  "evidence": {
    "filesRead": ["<files actually inspected or visible in prompt>"],
    "symbolsChecked": ["<functions/types/contracts inspected>"],
    "callersChecked": ["<callers/consumers checked or inferred>"],
    "testsChecked": ["<tests inspected, if any>"],
    "riskSummary": "<one sentence on why applying or ignoring the comment is safe or risky>",
    "validationNotes": "<optional limitation or uncertainty note>"
  }
}

Compatibility note for downstream systems:
- If verdict = ACTIONABLE, category is derived from severity
- If verdict = DISMISS, category is DISMISS
- If verdict = ALREADY_ADDRESSED, category is ALREADY_ADDRESSED

Never return ACTIONABLE with severity = null. Never claim repo-wide evidence in DIFF_ONLY mode.`;

    onDebug?.({
      analyzerAgent,
      analyzerName: analyzerLabel,
      repo: repoLabel,
      prNumber,
      prTitle: prComments[0].prTitle,
      branch,
      hasWorktree: Boolean(workDir),
      accessMode,
      commentIds: prComments.map((c) => c.id),
      commentCount: prComments.length,
      filePaths,
      diffLength: prDiff?.length ?? 0,
      diffTruncated,
      prompt,
    });

    // Step 6: Send to the selected analyzer
    const analyzerCwd = workDir ?? process.cwd();
    emit({
      type: "progress",
      step: `calling_${analyzerAgent}`,
      message: `Sending ${prComments.length} comment(s) to ${analyzerLabel} for deep analysis${workDir ? " (with local codebase access)" : ""}...`,
      progress: 45,
      detail: `${analyzerLabel} is reviewing each comment against the full PR context. This may take 1-2 minutes.`,
    });

    let result: string;
    try {
      const runAnalysis = analyzerAgent === "codex" ? runCodexAnalysis : runClaudeAnalysis;
      result = await runAnalysis(prompt, analyzerCwd, (line) => {
        emit({
          type: "progress",
          step: analyzerOutputStep,
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
      message: `${analyzerLabel} responded — parsing results...`,
      progress: 85,
    });

    // Extract JSON array from the response — the analyzer may wrap it in text/code blocks
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
      const analyses = JSON.parse(cleaned) as Array<Record<string, unknown>>;

      const parsedResults: AnalysisResult[] = [];

      for (const a of analyses) {
        const commentId = Number(a.commentId);
        if (!Number.isFinite(commentId)) continue;

        const category = deriveCategoryFromStructuredAnalysis(a) ?? "SHOULD_FIX";
        const verdict = normalizeAnalysisVerdict(a.verdict);
        const severity = normalizeAnalysisSeverity(a.severity) ?? (category === "MUST_FIX" || category === "SHOULD_FIX" || category === "NICE_TO_HAVE" ? category : null);
        const reasoning = typeof a.reasoning === "string" && a.reasoning.trim()
          ? a.reasoning.trim()
          : "Analysis completed, but no reasoning was provided.";

        parsedResults.push({
          commentId,
          category,
          reasoning,
          verdict: verdict ?? (category === "DISMISS" ? "DISMISS" : category === "ALREADY_ADDRESSED" ? "ALREADY_ADDRESSED" : "ACTIONABLE"),
          severity,
          confidence: normalizeAnalysisConfidence(a.confidence),
          accessMode: normalizeAnalysisAccessMode(a.accessMode, accessMode),
          evidence: normalizeAnalysisEvidence(a.evidence),
        });
      }

      allResults.push(...parsedResults);

      // Emit summary
      const counts: Record<string, number> = {};
      for (const result of parsedResults) {
        counts[result.category] = (counts[result.category] ?? 0) + 1;
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
      console.error(`Failed to parse ${analyzerLabel} response:`, cleaned);
      emit({
        type: "error",
        step: "parse_error",
        message: `Failed to parse ${analyzerLabel}'s response — marking all for manual review.`,
        progress: 100,
      });
      for (const c of prComments) {
        allResults.push({
          commentId: c.id,
          category: "SHOULD_FIX",
          reasoning: "Analysis failed — please review manually.",
          verdict: "ACTIONABLE",
          severity: "SHOULD_FIX",
          accessMode,
        });
      }
    }
  }

  return allResults;
}
