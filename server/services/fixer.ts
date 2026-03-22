import { exec, execSync, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import type { RepoConfig, BotComment, CommentState, FixResult } from "../types.js";
import { appendRunHistory, getRunHistory } from "./db.js";
import { getReviewService } from "../infrastructure/reviewers/registry.js";

const execAsync = promisify(exec);

export type FixerAgent = "claude" | "codex";

const FIXER_AGENT_META: Record<FixerAgent, { label: string; command: string }> = {
  claude: { label: "Claude Code", command: "claude" },
  codex: { label: "Codex", command: "codex" },
};

// --- Fix progress log (in-memory, keyed by "repo:prNumber") ---

export interface FixLogEntry {
  step: string;
  status: "active" | "done" | "error";
  detail?: string;
  ts: string;
}

export interface FixProgress {
  agent: FixerAgent;
  steps: FixLogEntry[];
  output: string[]; // Live fixer CLI output lines
  startedAt: string;
  finishedAt?: string;
}

// Active fix progress (one per PR)
const fixLogs = new Map<string, FixProgress>();
// History of completed fix/analyze runs (keyed by "repo:prNumber", stores last 10)
const fixHistory = new Map<string, FixProgress[]>();

function fixKey(repo: string, prNumber: number): string {
  return `${repo}:${prNumber}`;
}

function getOrCreateProgress(repo: string, prNumber: number, agent: FixerAgent = "claude"): FixProgress {
  const key = fixKey(repo, prNumber);
  let progress = fixLogs.get(key);
  if (!progress) {
    progress = { agent, steps: [], output: [], startedAt: new Date().toISOString() };
    fixLogs.set(key, progress);
  } else if (!progress.agent) {
    progress.agent = agent;
  }
  return progress;
}

function logStep(
  repo: string,
  prNumber: number,
  step: string,
  detail?: string,
  agent: FixerAgent = "claude",
): void {
  const progress = getOrCreateProgress(repo, prNumber, agent);
  // Mark previous active step as done
  for (const s of progress.steps) {
    if (s.status === "active") s.status = "done";
  }
  progress.steps.push({ step, status: "active", detail, ts: new Date().toISOString() });
}

function logOutput(repo: string, prNumber: number, line: string, agent: FixerAgent = "claude"): void {
  const progress = getOrCreateProgress(repo, prNumber, agent);
  progress.output.push(line);
  // Cap at 200 lines to prevent memory bloat
  if (progress.output.length > 200) {
    progress.output = progress.output.slice(-200);
  }
}

function archiveProgress(repo: string, prNumber: number): void {
  const key = fixKey(repo, prNumber);
  const progress = fixLogs.get(key);
  if (!progress) return;
  progress.finishedAt = new Date().toISOString();
  const archived = { ...progress, steps: [...progress.steps], output: [...progress.output] };
  // In-memory cache
  const history = fixHistory.get(key) ?? [];
  history.push(archived);
  if (history.length > 20) history.shift();
  fixHistory.set(key, history);
  // Persist to DB
  appendRunHistory(repo, prNumber, archived);
}

function logDone(repo: string, prNumber: number): void {
  const progress = fixLogs.get(fixKey(repo, prNumber));
  if (progress) {
    for (const s of progress.steps) {
      if (s.status === "active") s.status = "done";
    }
  }
  archiveProgress(repo, prNumber);
}

function logError(repo: string, prNumber: number, error: string): void {
  const progress = fixLogs.get(fixKey(repo, prNumber));
  if (progress) {
    for (const s of progress.steps) {
      if (s.status === "active") {
        s.status = "error";
        s.detail = error;
      }
    }
  }
  archiveProgress(repo, prNumber);
}

export function getFixProgress(repo: string, prNumber: number): FixProgress | null {
  return fixLogs.get(fixKey(repo, prNumber)) ?? null;
}

export function clearFixProgress(repo: string, prNumber: number): void {
  fixLogs.delete(fixKey(repo, prNumber));
}

export function getAllFixProgress(): Map<string, FixProgress> {
  return fixLogs;
}

export function getFixHistory(repo: string, prNumber: number): FixProgress[] {
  // Check in-memory first, fall back to DB
  const inMemory = fixHistory.get(fixKey(repo, prNumber));
  if (inMemory && inMemory.length > 0) return inMemory;
  return getRunHistory(repo, prNumber) as FixProgress[];
}

export function isFixerAgentAvailable(agent: FixerAgent): boolean {
  try {
    execSync(`which ${FIXER_AGENT_META[agent].command}`, { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function getFixerAgentLabel(agent: FixerAgent): string {
  return FIXER_AGENT_META[agent].label;
}

// --- Stream JSON parsing helpers ---

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      name?: string;
      text?: string;
      input?: Record<string, unknown>;
      content?: string | Array<{ type: string; text?: string }>;
      tool_use_id?: string;
      is_error?: boolean;
    }>;
  };
  result?: string;
  tool_name?: string;
  content_block?: {
    type: string;
    name?: string;
    text?: string;
    input?: Record<string, unknown>;
  };
}

function summarizeStreamEvent(event: StreamEvent): string | null {
  // Handle content_block_start events (tool_use start)
  if (event.type === "content_block_start" && event.content_block) {
    const block = event.content_block;
    if (block.type === "tool_use" && block.name) {
      const input = block.input ?? {};
      if (block.name === "Read" && input.file_path) {
        return `Reading ${input.file_path}`;
      }
      if (block.name === "Edit" && input.file_path) {
        return `Editing ${input.file_path}`;
      }
      if (block.name === "Write" && input.file_path) {
        return `Writing ${input.file_path}`;
      }
      if (block.name === "Bash" && input.command) {
        const cmd = String(input.command);
        return `Running: ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
      }
      if (block.name === "Glob" && input.pattern) {
        return `Searching for ${input.pattern}`;
      }
      if (block.name === "Grep" && input.pattern) {
        return `Searching for "${input.pattern}"`;
      }
      return `Using ${block.name}`;
    }
    if (block.type === "text" && block.text) {
      const text = block.text.trim();
      if (text.length > 0 && text.length <= 150) {
        return text;
      }
    }
  }

  // Handle full assistant messages (non-streaming format)
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use" && block.name) {
        const input = block.input ?? {};
        if (block.name === "Read" && input.file_path) {
          return `Reading ${input.file_path}`;
        }
        if (block.name === "Edit" && input.file_path) {
          return `Editing ${input.file_path}`;
        }
        if (block.name === "Write" && input.file_path) {
          return `Writing ${input.file_path}`;
        }
        if (block.name === "Bash" && input.command) {
          const cmd = String(input.command);
          return `Running: ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
        }
        return `Using ${block.name}`;
      }
    }
  }

  // Handle tool results — show errors and short outputs
  if (event.type === "tool" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? "").join("")
            : "";
        if (text) return `⚠ Error: ${text.slice(0, 200)}`;
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        const text = block.content.trim();
        if (text && text.length <= 200) return `→ ${text}`;
      }
    }
  }

  return null;
}

// --- WorkDir ---

interface WorkDir {
  workDir: string;
  cleanup: () => Promise<void>;
}

export async function getWorkDir(repo: RepoConfig, branch: string): Promise<WorkDir> {
  if (repo.localPath) {
    await execAsync("git fetch origin", {
      cwd: repo.localPath,
      timeout: 60000,
    });

    // Use a temporary worktree to avoid conflicts with branches
    // already checked out in other worktrees
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-fix-"));
    await execAsync(`git worktree add ${tmpDir} origin/${branch}`, {
      cwd: repo.localPath,
      timeout: 60000,
    });

    // Remove any .claude/hooks from the worktree so Claude doesn't
    // try to follow repo-specific hook instructions (e.g. require-worktree)
    // We restore them before committing so only source changes get committed
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const hadHooks = fs.existsSync(hooksDir);
    if (hadHooks) {
      fs.rmSync(hooksDir, { recursive: true, force: true });
    }

    // Symlink node_modules from the local repo so formatters/linters
    // (e.g. prettier with plugins) can resolve their dependencies
    const localNodeModules = path.join(repo.localPath, "node_modules");
    const worktreeNodeModules = path.join(tmpDir, "node_modules");
    if (fs.existsSync(localNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      fs.symlinkSync(localNodeModules, worktreeNodeModules, "dir");
    }

    return {
      workDir: tmpDir,
      cleanup: async () => {
        // Remove symlink before worktree removal so git doesn't complain
        try { if (fs.lstatSync(worktreeNodeModules).isSymbolicLink()) fs.unlinkSync(worktreeNodeModules); } catch {}
        await execAsync(`git worktree remove ${JSON.stringify(tmpDir)} --force`, {
          cwd: repo.localPath,
        });
      },
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-fix-"));
  await execAsync(
    `gh repo clone ${repo.label} ${tmpDir} -- --branch ${branch} --single-branch`,
    { timeout: 120000 },
  );
  return {
    workDir: tmpDir,
    cleanup: async () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// --- Run Claude with stream-json for live output ---

export function runClaudeFix(
  workDir: string,
  prompt: string,
  onOutput?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode", "bypassPermissions",
        "--disallowedTools", "Agent,EnterWorktree,ExitWorktree,ToolSearch",
      ],
      { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] },
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
          const event = JSON.parse(line) as StreamEvent;

          // Extract the final result
          if (event.type === "result" && event.result) {
            lastResult = event.result;
          }

          // Summarize for the UI
          const summary = summarizeStreamEvent(event);
          if (summary) {
            onOutput?.(summary);
          }
        } catch {
          // Not valid JSON — forward raw line if non-empty
          if (line.trim()) onOutput?.(line.trim());
        }
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Forward stderr lines too
      for (const line of text.split("\n")) {
        if (line.trim()) onOutput?.(line.trim());
      }
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code, signal) => {
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as StreamEvent;
          if (event.type === "result" && event.result) {
            lastResult = event.result;
          }
        } catch {
          // ignore
        }
      }

      if (signal) {
        reject(new Error(`claude was killed by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }

      onOutput?.(`Claude finished (exit code 0)`);
      resolve(lastResult);
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();

    // 20 minute timeout
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude fix timed out after 20 minutes"));
    }, 1200000);

    child.on("close", () => clearTimeout(timeout));
  });
}

export function runCodexFix(
  workDir: string,
  prompt: string,
  onOutput?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "--full-auto", prompt],
      { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] },
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

    child.on("error", (err) => reject(err));

    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`codex was killed by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        const cleanStderr = stderr.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim();
        reject(new Error(`codex exited with code ${code}: ${cleanStderr || "Unknown error"}`));
        return;
      }

      onOutput?.("Codex finished (exit code 0)");
      resolve(stdout.trim());
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Codex fix timed out after 20 minutes"));
    }, 1200000);

    child.on("close", () => clearTimeout(timeout));
  });
}

// --- Prompt building ---

interface FixInput {
  agent: FixerAgent;
  comments: BotComment[];
  commentStates: CommentState[];
  prTitle: string;
}

function formatPromptList(items: string[] | undefined): string {
  if (!items || items.length === 0) return "none";
  return items.join(", ");
}

export function buildFixPrompt(input: FixInput): string {
  const commentDescriptions = input.comments.map((c, i) => {
    const state = input.commentStates.find((s) => s.commentId === c.id);
    const category = state?.analysis?.category ?? "SHOULD_FIX";
    const reasoning = state?.analysis?.reasoning ?? "";

    let desc = `### Issue ${i + 1} (Comment ID: ${c.id})\n`;
    desc += `- **Category**: ${category}\n`;
    if (c.path) desc += `- **File**: ${c.path}${c.line ? `:${c.line}` : ""}\n`;
    desc += `- **Reviewer comment**: ${c.body}\n`;
    if (state?.analysis?.verdict) desc += `- **Analysis verdict**: ${state.analysis.verdict}\n`;
    if (state?.analysis?.severity) desc += `- **Analysis severity**: ${state.analysis.severity}\n`;
    if (typeof state?.analysis?.confidence === "number") desc += `- **Analysis confidence**: ${state.analysis.confidence}/5\n`;
    if (state?.analysis?.accessMode) desc += `- **Analysis access mode**: ${state.analysis.accessMode}\n`;
    if (reasoning) desc += `- **Analysis reasoning**: ${reasoning}\n`;
    if (state?.analysis?.evidence) {
      desc += `- **Analysis evidence**:\n`;
      desc += `  - Files read: ${formatPromptList(state.analysis.evidence.filesRead)}\n`;
      desc += `  - Symbols checked: ${formatPromptList(state.analysis.evidence.symbolsChecked)}\n`;
      desc += `  - Callers checked: ${formatPromptList(state.analysis.evidence.callersChecked)}\n`;
      desc += `  - Tests checked: ${formatPromptList(state.analysis.evidence.testsChecked)}\n`;
      if (state.analysis.evidence.riskSummary) desc += `  - Risk summary: ${state.analysis.evidence.riskSummary}\n`;
      if (state.analysis.evidence.validationNotes) desc += `  - Validation notes: ${state.analysis.evidence.validationNotes}\n`;
    }
    if (c.diffHunk) {
      desc += `- **Code being reviewed** (diff hunk):\n\`\`\`diff\n${c.diffHunk}\n\`\`\`\n`;
    }
    return desc;
  });
  const agentLabel = getFixerAgentLabel(input.agent);

  return `You are fixing code review issues on a pull request.

## PR: ${input.prTitle}
## Issues to Fix

${commentDescriptions.join("\n---\n")}

## Instructions

**IMPORTANT: You are already in a git worktree checked out at the correct branch. Do NOT run any git commands (no fetch, no checkout, no merge, no worktree operations). Do NOT create worktrees. Just read and edit files directly in the current directory.**

1. Follow visible repository instructions in this worktree, including files like AGENTS.md when present
2. Read the relevant files before editing; do not rely only on the review comment
3. Use the analyzer evidence above to avoid breaking callers, contracts, and tests
4. Fix each issue with a minimal, targeted diff
5. If an issue is already fixed, leave it alone
6. Do not make unrelated cleanup changes
7. Do not add explanatory code comments unless they are necessary for maintainability
8. Before finishing, run the lightest project validation that proves the change is safe. Prefer existing repo scripts such as typecheck or focused tests when available
9. If validation fails, keep the code in a debuggable state and stop rather than guessing
10. If a fix would require a broad refactor, public API change, schema migration, or an unclear product decision, do not force it into this automated pass

When the bot's suggested patch is wrong but the underlying issue is real, implement the safer fix instead of following the suggestion literally.
The backend will run formatting and verification after you finish, so leave the worktree in a state that should pass those checks.

Fix all the issues listed above. Use ${agentLabel} carefully, keep the diff minimal, and prefer correctness over coverage.`;
}

export function buildCommitMessage(
  comments: BotComment[],
  commentStates: CommentState[],
  prTitle: string,
): string {
  const hasBugFix = commentStates.some(
    (s) => s.analysis?.category === "MUST_FIX",
  );
  const prefix = hasBugFix ? "fix" : "refactor";

  const details = comments.map((c) => {
    const state = commentStates.find((s) => s.commentId === c.id);
    const category = state?.analysis?.category ?? "SHOULD_FIX";
    const file = c.path ? ` (${c.path})` : "";
    const bodyText = c.body.replace(/<[^>]*>/g, "").trim().split("\n")[0].slice(0, 80);
    return `- [${category}]${file}: ${bodyText}`;
  });

  return `${prefix}: address review comments on "${prTitle}"

Addressed bot review comments:
${details.join("\n")}`;
}

// --- Post-fix formatting ---

function detectPackageManager(workDir: string): "pnpm" | "yarn" | "npm" {
  if (fs.existsSync(path.join(workDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(workDir, "yarn.lock"))) return "yarn";
  return "npm";
}

async function runPostFixFormatting(
  workDir: string,
  changedFiles: string[],
  onOutput?: (line: string) => void,
): Promise<void> {
  const pkgPath = path.join(workDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return;
  }

  const pm = detectPackageManager(workDir);
  const run = pm === "npm" ? "npm run" : `${pm}`;

  // Prefer an explicit "format" script
  if (pkg.scripts?.format) {
    onOutput?.(`Running ${run} format`);
    try {
      await execAsync(`${run} format`, { cwd: workDir, timeout: 120000 });
      onOutput?.("Formatting complete");
    } catch (err) {
      onOutput?.(`Format script failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Fall back to prettier if installed
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (allDeps.prettier) {
    // Only format the files the fixer actually changed
    const files = changedFiles
      .filter((f) => !f.startsWith("."))
      .map((f) => JSON.stringify(f))
      .join(" ");
    if (!files) return;
    onOutput?.(`Running prettier on ${changedFiles.length} changed file(s)`);
    try {
      await execAsync(`npx prettier --write ${files}`, { cwd: workDir, timeout: 120000 });
      onOutput?.("Prettier formatting complete");
    } catch (err) {
      onOutput?.(`Prettier failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
}

async function runPostFixVerification(
  workDir: string,
  onOutput?: (line: string) => void,
): Promise<void> {
  onOutput?.("Running git diff --check");
  try {
    await execAsync("git diff --check", { cwd: workDir, timeout: 30000 });
    onOutput?.("git diff --check passed");
  } catch (err) {
    throw new Error(`git diff --check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pkgPath = path.join(workDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    onOutput?.("No package.json found; skipped repo verification");
    return;
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
  } catch {
    onOutput?.("Could not parse package.json; skipped repo verification");
    return;
  }

  const pm = detectPackageManager(workDir);
  const run = pm === "npm" ? "npm run" : pm;
  const commands: string[] = [];

  if (pkg.scripts?.typecheck) {
    commands.push(`${run} typecheck`);
  } else if (pkg.scripts?.check) {
    commands.push(`${run} check`);
  }

  if (commands.length === 0) {
    onOutput?.("No verification script found; skipped repo verification");
    return;
  }

  for (const command of commands) {
    onOutput?.(`Running ${command}`);
    try {
      await execAsync(command, { cwd: workDir, timeout: 180000 });
      onOutput?.(`${command} passed`);
    } catch (err) {
      throw new Error(`Verification failed for "${command}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// --- Fix comments ---

interface FixCommentsInput {
  fixerAgent: FixerAgent;
  repo: RepoConfig;
  branch: string;
  prNumber: number;
  prTitle: string;
  comments: BotComment[];
  commentStates: CommentState[];
  onDebug?: (debugDetail: Record<string, unknown>) => void;
}

export async function fixComments(input: FixCommentsInput): Promise<FixResult[]> {
  const { fixerAgent, repo, branch, prNumber, comments, commentStates, prTitle, onDebug } = input;
  const repoLabel = repo.label;
  const agentLabel = getFixerAgentLabel(fixerAgent);

  if (!isFixerAgentAvailable(fixerAgent)) {
    throw new Error(`${agentLabel} CLI is not available on this machine`);
  }

  logStep(repoLabel, prNumber, "Preparing workspace", `Fetching branch ${branch}`, fixerAgent);
  const { workDir, cleanup } = await getWorkDir(repo, branch);

  try {
    logStep(repoLabel, prNumber, `Running ${agentLabel} fix`, `${comments.length} issue(s) to address`, fixerAgent);
    const prompt = buildFixPrompt({ agent: fixerAgent, comments, commentStates, prTitle });
    onDebug?.({
      fixerAgent,
      repo: repo.label,
      prNumber,
      prTitle,
      branch,
      commentIds: comments.map((c) => c.id),
      commentCount: comments.length,
      filePaths: [...new Set(comments.map((c) => c.path).filter((path): path is string => Boolean(path)))],
      comments: comments.map((c) => {
        const state = commentStates.find((s) => s.commentId === c.id);
        return {
          id: c.id,
          path: c.path,
          line: c.line,
          reviewer: c.user,
          category: state?.analysis?.category ?? null,
        };
      }),
      prompt,
    });
    logOutput(repoLabel, prNumber, `--- Prompt (${prompt.length} chars) ---`, fixerAgent);
    for (const c of comments) {
      logOutput(repoLabel, prNumber, `  #${c.id}: ${c.path ?? "general"}${c.line ? `:${c.line}` : ""} — ${c.body.split("\n")[0].slice(0, 100)}`, fixerAgent);
      logOutput(repoLabel, prNumber, `    diffHunk: ${c.diffHunk ? `${c.diffHunk.length} chars` : "NONE"}`, fixerAgent);
    }
    logOutput(repoLabel, prNumber, "---", fixerAgent);
    // Build path variants to strip from output (macOS resolves /var → /private/var)
    // Use realpath to get the canonical path, then collect both variants, longest first
    let realWorkDir: string;
    try { realWorkDir = fs.realpathSync(workDir); } catch { realWorkDir = workDir; }
    const pathVariants = [...new Set([realWorkDir, workDir])].sort((a, b) => b.length - a.length);

    const runFix = fixerAgent === "codex" ? runCodexFix : runClaudeFix;
    await runFix(workDir, prompt, (line) => {
      let cleaned = line;
      for (const p of pathVariants) {
        cleaned = cleaned.replaceAll(p + "/", "").replaceAll(p, ".");
      }
      logOutput(repoLabel, prNumber, cleaned, fixerAgent);
    });

    logStep(repoLabel, prNumber, "Checking changes", undefined, fixerAgent);
    const { stdout: diffOutput } = await execAsync("git diff --name-only", {
      cwd: workDir,
    });

    // Restore .claude/ before checking diff so hook deletions don't count
    await execAsync("git checkout -- .claude/ 2>/dev/null || true", { cwd: workDir });

    if (!diffOutput.trim()) {
      logStep(repoLabel, prNumber, "No changes needed", `${agentLabel} produced no diff`, fixerAgent);
      logDone(repoLabel, prNumber);
      return [];
    }

    // Re-check diff after restoring .claude/
    const { stdout: cleanDiff } = await execAsync("git diff --name-only", { cwd: workDir });
    if (!cleanDiff.trim()) {
      logStep(repoLabel, prNumber, "No source changes", "Only local instruction files were modified", fixerAgent);
      logDone(repoLabel, prNumber);
      return [];
    }

    const filesChanged = cleanDiff.trim().split("\n").filter(Boolean);

    // Run post-fix formatting (prettier, format script, etc.)
    logStep(repoLabel, prNumber, "Running formatters", `${filesChanged.length} file(s)`, fixerAgent);
    await runPostFixFormatting(workDir, filesChanged, (line) => {
      logOutput(repoLabel, prNumber, line, fixerAgent);
    });

    logStep(repoLabel, prNumber, "Running verification", undefined, fixerAgent);
    await runPostFixVerification(workDir, (line) => {
      logOutput(repoLabel, prNumber, line, fixerAgent);
    });

    const commitMessage = buildCommitMessage(comments, commentStates, prTitle);

    // Restore .claude/hooks before committing so we only commit source changes
    await execAsync("git checkout -- .claude/ 2>/dev/null || true", { cwd: workDir });

    // Remove the node_modules symlink before staging so it doesn't get committed
    const nmSymlink = path.join(workDir, "node_modules");
    try { if (fs.lstatSync(nmSymlink).isSymbolicLink()) fs.unlinkSync(nmSymlink); } catch {}

    logStep(repoLabel, prNumber, "Committing changes", `${filesChanged.length} file(s) modified`, fixerAgent);
    await execAsync("git add -A", { cwd: workDir });
    const commitMsgFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
    fs.writeFileSync(commitMsgFile, commitMessage, "utf-8");
    try {
      await execAsync(`git commit -F ${JSON.stringify(commitMsgFile)}`, {
        cwd: workDir,
      });
    } finally {
      try { fs.unlinkSync(commitMsgFile); } catch {}
    }

    logStep(repoLabel, prNumber, "Pushing to remote", `origin/${branch}`, fixerAgent);
    await execAsync(`git push origin HEAD:refs/heads/${branch}`, {
      cwd: workDir,
      timeout: 60000,
    });

    const { stdout: hashOutput } = await execAsync("git rev-parse --short HEAD", {
      cwd: workDir,
    });
    const commitHash = hashOutput.trim();

    logStep(repoLabel, prNumber, "Fix complete", `${agentLabel} created commit ${commitHash}`, fixerAgent);
    logDone(repoLabel, prNumber);

    const fixedAt = new Date().toISOString();

    return comments.map((c) => ({
      commentId: c.id,
      filesChanged,
      commitHash,
      commitMessage,
      fixedAt,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(repoLabel, prNumber, msg);
    throw err;
  } finally {
    await cleanup();
  }
}

// Re-review comment building is now handled by GreptileReviewer.buildReReviewBody()

interface FixAndReReviewInput extends FixCommentsInput {
  prNumber: number;
  requestReReview: boolean;
}

export async function fixAndPostReReview(input: FixAndReReviewInput): Promise<FixResult[]> {
  const results = await fixComments(input);

  if (results.length > 0 && input.requestReReview) {
    try {
      const service = getReviewService();
      const greptile = service.getReviewer("greptile");
      if (greptile) {
        await greptile.requestReview({
          repo: input.repo.label,
          prNumber: input.prNumber,
          prTitle: input.prTitle,
          branch: input.branch,
          localPath: input.repo.localPath,
        });
      }
    } catch (err) {
      console.error("Failed to request Greptile re-review:", err);
    }
  }

  return results;
}
