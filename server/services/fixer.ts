import { exec, execSync, spawn } from "child_process";
import crypto from "crypto";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  RepoConfig,
  BotComment,
  CommentState,
  FixResult,
  PersistedRunHistory,
  RunHistoryStep,
} from "../types.js";
import { appendRunHistory, getRunHistory } from "./db.js";
import { getReviewService } from "../infrastructure/reviewers/registry.js";
import { fetchOrigin } from "./git.js";
import { buildPersistedRunHistory } from "./runHistory.js";

const execAsync = promisify(exec);

export type FixerAgent = "claude" | "codex";

const FIXER_AGENT_META: Record<FixerAgent, { label: string; command: string }> = {
  claude: { label: "Claude Code", command: "claude" },
  codex: { label: "Codex", command: "codex" },
};

// --- Fix progress log (in-memory, keyed by "repo:prNumber") ---

export type FixLogEntry = RunHistoryStep;

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
  restorePaths: string[];
  transientSymlinkPaths: string[];
}

const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeWorktreeNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "fix";
}

async function resolveProjectRoot(repoPath: string): Promise<string> {
  const { stdout } = await execAsync("git rev-parse --git-common-dir", {
    cwd: repoPath,
    timeout: 30000,
  });
  const gitCommonDir = stdout.trim();
  if (!gitCommonDir) return repoPath;
  const absoluteGitCommonDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(repoPath, gitCommonDir);
  return path.dirname(absoluteGitCommonDir);
}

async function restoreWorkspaceMutations(
  workDir: string,
  restorePaths: string[],
  transientSymlinkPaths: string[],
): Promise<void> {
  for (const relativePath of transientSymlinkPaths) {
    const fullPath = path.join(workDir, relativePath);
    try {
      if (fs.lstatSync(fullPath).isSymbolicLink()) {
        fs.unlinkSync(fullPath);
      }
    } catch {}
  }

  if (restorePaths.length > 0) {
    const quotedPaths = restorePaths.map((p) => shellQuote(p)).join(" ");
    await execAsync(`git checkout -- ${quotedPaths}`, { cwd: workDir });
  }
}

export async function getWorkDir(repo: RepoConfig, branch: string, fixerAgent?: FixerAgent): Promise<WorkDir> {
  if (repo.localPath) {
    const projectRoot = await resolveProjectRoot(repo.localPath);
    await fetchOrigin(projectRoot);

    // Create commit-capable worktrees under .worktrees/ so repos with
    // path-based commit guards accept the generated commit.
    const worktreesDir = path.join(projectRoot, ".worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
    const worktreeName = `pr-fix-${sanitizeWorktreeNamePart(branch)}-${crypto.randomUUID().slice(0, 8)}`;
    const tmpDir = path.join(worktreesDir, worktreeName);
    await execAsync(`git worktree add ${shellQuote(tmpDir)} origin/${branch}`, {
      cwd: projectRoot,
      timeout: 60000,
    });

    const restorePaths: string[] = [];
    const transientSymlinkPaths: string[] = [];

    // Claude-specific repo hooks can interfere with automated fixes inside
    // the temporary worktree. Strip only the hook directory we mutate here.
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const hadHooks = fixerAgent === "claude" && fs.existsSync(hooksDir);
    if (hadHooks) {
      fs.rmSync(hooksDir, { recursive: true, force: true });
      restorePaths.push(".claude/hooks");
    }

    const rootEnvLocalPath = path.join(projectRoot, ".env.local");
    const worktreeEnvLocalPath = path.join(tmpDir, ".env.local");
    if (fs.existsSync(rootEnvLocalPath) && !fs.existsSync(worktreeEnvLocalPath)) {
      fs.copyFileSync(rootEnvLocalPath, worktreeEnvLocalPath);
    }

    // Symlink generated dependency artifacts from the local repo so the
    // temporary worktree can resolve installed packages.
    const transientDependencyPaths = [
      "node_modules",
      ".pnp.cjs",
      ".pnp.js",
      ".pnp.loader.mjs",
    ];
    for (const relativePath of transientDependencyPaths) {
      const localDependencyPath = path.join(repo.localPath, relativePath);
      const worktreeDependencyPath = path.join(tmpDir, relativePath);
      if (!fs.existsSync(localDependencyPath) || fs.existsSync(worktreeDependencyPath)) continue;

      const symlinkType = fs.lstatSync(localDependencyPath).isDirectory() ? "dir" : "file";
      fs.symlinkSync(localDependencyPath, worktreeDependencyPath, symlinkType);
      transientSymlinkPaths.push(relativePath);
    }

    return {
      workDir: tmpDir,
      restorePaths,
      transientSymlinkPaths,
      cleanup: async () => {
        await restoreWorkspaceMutations(tmpDir, restorePaths, transientSymlinkPaths);
        await execAsync(`git worktree remove ${shellQuote(tmpDir)} --force`, {
          cwd: projectRoot,
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
    restorePaths: [],
    transientSymlinkPaths: [],
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

function hasInstalledNodeDependencies(workDir: string): boolean {
  if (fs.existsSync(path.join(workDir, "node_modules"))) return true;
  if (fs.existsSync(path.join(workDir, ".pnp.cjs"))) return true;
  if (fs.existsSync(path.join(workDir, ".pnp.js"))) return true;
  if (fs.existsSync(path.join(workDir, ".pnp.loader.mjs"))) return true;
  return false;
}

function getDependencyInstallCommand(packageManager: "pnpm" | "yarn" | "npm"): string {
  return packageManager === "pnpm"
    ? "pnpm install"
    : packageManager === "yarn"
      ? "yarn install"
      : "npm install";
}

async function ensureNodeDependenciesInstalled(
  workDir: string,
  onOutput?: (line: string) => void,
): Promise<void> {
  const pkgPath = path.join(workDir, "package.json");
  if (!fs.existsSync(pkgPath) || hasInstalledNodeDependencies(workDir)) return;

  const pm = detectPackageManager(workDir);
  const installCommand = getDependencyInstallCommand(pm);
  onOutput?.(`Installing dependencies with ${installCommand}`);

  try {
    await runLoggedCommand(installCommand, { cwd: workDir, timeout: 900000, onOutput });
  } catch (err) {
    throw new Error(
      `Dependency installation failed for "${installCommand}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!hasInstalledNodeDependencies(workDir)) {
    throw new Error(
      `Dependency installation completed but required artifacts are still missing after "${installCommand}"`,
    );
  }

  onOutput?.("Dependency installation complete");
}

interface LoggedCommandOptions {
  cwd: string;
  timeout?: number;
  onOutput?: (line: string) => void;
}

function createLineForwarder(onLine?: (line: string) => void): {
  push: (text: string) => void;
  flush: () => void;
} {
  let buffer = "";

  return {
    push(text: string) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = stripAnsi(line).trim();
        if (trimmed) onLine?.(trimmed);
      }
    },
    flush() {
      const trimmed = stripAnsi(buffer).trim();
      if (trimmed) onLine?.(trimmed);
      buffer = "";
    },
  };
}

function runLoggedCommand(
  command: string,
  { cwd, timeout, onOutput }: LoggedCommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const recentLines: string[] = [];
    const recordLine = (line: string) => {
      recentLines.push(line);
      if (recentLines.length > 20) {
        recentLines.shift();
      }
      onOutput?.(line);
    };
    const stdoutForwarder = createLineForwarder(recordLine);
    const stderrForwarder = createLineForwarder(recordLine);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdoutForwarder.flush();
      stderrForwarder.flush();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutForwarder.push(chunk.toString());
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrForwarder.push(chunk.toString());
    });

    child.on("error", (err) => finish(err));

    child.on("close", (code, signal) => {
      stdoutForwarder.flush();
      stderrForwarder.flush();

      if (signal) {
        finish(new Error(`killed by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        finish(new Error(
          recentLines.length > 0
            ? `exited with code ${code}: ${recentLines.slice(-10).join(" | ")}`
            : `exited with code ${code}`,
        ));
        return;
      }

      finish();
    });

    if (timeout) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`timed out after ${Math.ceil(timeout / 1000)}s`));
      }, timeout);
    }
  });
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
      await runLoggedCommand(`${run} format`, { cwd: workDir, timeout: 120000, onOutput });
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
      .map((f) => shellQuote(f))
      .join(" ");
    if (!files) return;
    onOutput?.(`Running prettier on ${changedFiles.length} changed file(s)`);
    try {
      await runLoggedCommand(`npx prettier --write ${files}`, { cwd: workDir, timeout: 120000, onOutput });
      onOutput?.("Prettier formatting complete");
    } catch (err) {
      onOutput?.(`Prettier failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
}

async function runPostFixVerification(
  workDir: string,
  skipTypecheck = false,
  onOutput?: (line: string) => void,
): Promise<void> {
  onOutput?.("Running git diff --check");
  try {
    await runLoggedCommand("git diff --check", { cwd: workDir, timeout: 30000, onOutput });
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

  if (skipTypecheck) {
    onOutput?.("Skipping repo verification script per repository setting");
    return;
  }

  if (!hasInstalledNodeDependencies(workDir)) {
    const installCommand = getDependencyInstallCommand(pm);
    throw new Error(
      `Dependencies are still missing before verification. Expected node_modules or Yarn PnP artifacts after "${installCommand}"`,
    );
  }

  for (const command of commands) {
    onOutput?.(`Running ${command}`);
    try {
      await runLoggedCommand(command, { cwd: workDir, timeout: 180000, onOutput });
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
  onHistoryUpdate?: (history: PersistedRunHistory) => void;
}

export async function fixComments(input: FixCommentsInput): Promise<FixResult[]> {
  const {
    fixerAgent,
    repo,
    branch,
    prNumber,
    comments,
    commentStates,
    prTitle,
    onDebug,
    onHistoryUpdate,
  } = input;
  const repoLabel = repo.label;
  const agentLabel = getFixerAgentLabel(fixerAgent);

  if (!isFixerAgentAvailable(fixerAgent)) {
    throw new Error(`${agentLabel} CLI is not available on this machine`);
  }

  const emitPersistedHistory = (overrides?: {
    status?: PersistedRunHistory["status"];
    detail?: string;
    currentStep?: string;
  }): void => {
    if (!onHistoryUpdate) return;
    const progress = getFixProgress(repoLabel, prNumber);
    if (!progress) return;
    const activeStep = progress.steps.find((step) => step.status === "active");
    const currentStep =
      overrides?.currentStep ??
      activeStep?.step ??
      progress.steps[progress.steps.length - 1]?.step;
    const lastStep = progress.steps[progress.steps.length - 1];

    onHistoryUpdate(
      buildPersistedRunHistory({
        status: overrides?.status,
        startedAt: progress.startedAt,
        finishedAt: progress.finishedAt,
        currentStep,
        detail: overrides?.detail ?? activeStep?.detail ?? lastStep?.detail,
        steps: progress.steps,
        output: progress.output,
      }),
    );
  };

  const logHistoryStep = (step: string, detail?: string): void => {
    logStep(repoLabel, prNumber, step, detail, fixerAgent);
    emitPersistedHistory({ detail, currentStep: step });
  };

  const logHistoryOutput = (line: string): void => {
    logOutput(repoLabel, prNumber, line, fixerAgent);
    emitPersistedHistory();
  };

  const completeHistory = (detail?: string): void => {
    logDone(repoLabel, prNumber);
    emitPersistedHistory({ status: "done", detail });
  };

  const failHistory = (error: string): void => {
    logError(repoLabel, prNumber, error);
    emitPersistedHistory({ status: "error", detail: error });
  };

  logHistoryStep("Preparing workspace", `Fetching branch ${branch}`);
  const { workDir, cleanup, restorePaths, transientSymlinkPaths } = await getWorkDir(
    repo,
    branch,
    fixerAgent,
  );

  try {
    logHistoryStep(`Running ${agentLabel} fix`, `${comments.length} issue(s) to address`);
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
    logHistoryOutput(`--- Prompt (${prompt.length} chars) ---`);
    for (const c of comments) {
      logHistoryOutput(`  #${c.id}: ${c.path ?? "general"}${c.line ? `:${c.line}` : ""} — ${c.body.split("\n")[0].slice(0, 100)}`);
      logHistoryOutput(`    diffHunk: ${c.diffHunk ? `${c.diffHunk.length} chars` : "NONE"}`);
    }
    logHistoryOutput("---");
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
      logHistoryOutput(cleaned);
    });

    logHistoryStep("Checking changes");
    const { stdout: diffOutput } = await execAsync("git diff --name-only", {
      cwd: workDir,
    });

    // Restore only the temporary workspace mutations we introduced so they
    // do not count as source changes.
    await restoreWorkspaceMutations(workDir, restorePaths, transientSymlinkPaths);

    if (!diffOutput.trim()) {
      logHistoryStep("No changes needed", `${agentLabel} produced no diff`);
      completeHistory(`${agentLabel} produced no diff`);
      return [];
    }

    // Re-check diff after restoring temporary workspace mutations
    const { stdout: cleanDiff } = await execAsync("git diff --name-only", { cwd: workDir });
    if (!cleanDiff.trim()) {
      logHistoryStep("No source changes", "Only temporary workspace paths were modified");
      completeHistory("Only temporary workspace paths were modified");
      return [];
    }

    const filesChanged = cleanDiff.trim().split("\n").filter(Boolean);

    if (fs.existsSync(path.join(workDir, "package.json")) && !hasInstalledNodeDependencies(workDir)) {
      logHistoryStep("Installing dependencies", detectPackageManager(workDir));
      await ensureNodeDependenciesInstalled(workDir, (line) => {
        logHistoryOutput(line);
      });
    }

    // Run post-fix formatting (prettier, format script, etc.)
    logHistoryStep("Running formatters", `${filesChanged.length} file(s)`);
    await runPostFixFormatting(workDir, filesChanged, (line) => {
      logHistoryOutput(line);
    });

    logHistoryStep(
      "Running verification",
      repo.skipTypecheck ? "git diff --check only (repo verification script disabled)" : undefined,
    );
    await runPostFixVerification(workDir, Boolean(repo.skipTypecheck), (line) => {
      logHistoryOutput(line);
    });

    const commitMessage = buildCommitMessage(comments, commentStates, prTitle);

    await restoreWorkspaceMutations(workDir, restorePaths, transientSymlinkPaths);

    logHistoryStep("Committing changes", `${filesChanged.length} file(s) modified`);
    await execAsync("git add -A", { cwd: workDir });
    const commitMsgFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
    fs.writeFileSync(commitMsgFile, commitMessage, "utf-8");
    try {
      await execAsync(`git commit -F ${shellQuote(commitMsgFile)}`, {
        cwd: workDir,
      });
    } finally {
      try { fs.unlinkSync(commitMsgFile); } catch {}
    }

    logHistoryStep("Pushing to remote", `origin/${branch}`);
    await execAsync(`git push origin HEAD:refs/heads/${branch}`, {
      cwd: workDir,
      timeout: 60000,
    });

    const { stdout: hashOutput } = await execAsync("git rev-parse --short HEAD", {
      cwd: workDir,
    });
    const commitHash = hashOutput.trim();

    logHistoryStep("Fix complete", `${agentLabel} created commit ${commitHash}`);
    completeHistory(`${agentLabel} created commit ${commitHash}`);

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
    failHistory(msg);
    throw err;
  } finally {
    await cleanup();
  }
}

interface ResolveMergeConflictInput {
  fixerAgent: FixerAgent;
  repo: RepoConfig;
  branch: string;
  baseBranch: string;
  prNumber: number;
  prTitle: string;
  mergeStateStatus?: string | null;
  onDebug?: (debugDetail: Record<string, unknown>) => void;
  onHistoryUpdate?: (history: PersistedRunHistory) => void;
}

export interface ResolveMergeConflictResult {
  filesChanged: string[];
  commitHash: string;
  commitMessage: string;
  fixedAt: string;
}

function buildMergeConflictPrompt(input: {
  agent: FixerAgent;
  prTitle: string;
  branch: string;
  baseBranch: string;
  mergeStateStatus?: string | null;
  conflictedFiles: string[];
  gitStatus: string;
}): string {
  const agentLabel = getFixerAgentLabel(input.agent);
  const conflictList = input.conflictedFiles.map((file) => `- ${file}`).join("\n");

  return `You are resolving a pull request merge conflict.

## PR: ${input.prTitle}
## Head branch: ${input.branch}
## Base branch: ${input.baseBranch}
## GitHub merge state: ${input.mergeStateStatus ?? "unknown"}

## Conflicted files
${conflictList || "- none reported"}

## Git status
\`\`\`
${input.gitStatus}
\`\`\`

## Instructions

**IMPORTANT: A git merge is already in progress in this worktree. Do NOT run any git commands (no fetch, no checkout, no merge, no rebase, no commit, no worktree operations). Do NOT remove the merge state. Just edit files to resolve the conflicts.**

1. Follow visible repository instructions in this worktree, including files like AGENTS.md when present
2. Read the conflicted files and any nearby code that determines the correct merged behavior
3. Resolve the conflict markers so the result preserves the intended PR changes while staying compatible with the latest base branch
4. Prefer the smallest correct merge result; do not do unrelated cleanup
5. Remove every conflict marker and leave the files ready to stage
6. Do not remove or rename branch-visible exports, public APIs, or entry points unless you also update every affected caller in this same resolution
7. If the base branch refactored code into different modules, preserve branch behavior first; do not assume the branch should adopt the new architecture unless the callers are migrated and validated here
8. Run the lightest relevant validation if it helps you confirm the merge result
9. Stop if the correct resolution would require a product decision, a broad refactor, or touching many files outside the conflicted set

Leave the worktree ready for the backend to run verification and create the merge commit. Use ${agentLabel} carefully and prefer correctness over speed.`;
}

function buildMergeConflictCommitMessage(branch: string, baseBranch: string): string {
  return `chore(merge): sync ${branch} with ${baseBranch}

Merge ${baseBranch} into ${branch} to unblock the pull request.`;
}

const MERGE_CONFLICT_MAX_REMOVED_EXPORTS = 8;
const MERGE_CONFLICT_MAX_ADDITIONAL_EDIT_FILES = 3;

interface MergeConflictSafetyBaseline {
  branchExportsByFile: Record<string, string[]>;
}

function isTrackedCodeModule(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(filePath) && !filePath.endsWith(".d.ts");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNamedExports(source: string): string[] {
  const exports = new Set<string>();

  const declarationPattern =
    /export\s+(?:async\s+function|function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(declarationPattern)) {
    const name = match[1]?.trim();
    if (name) exports.add(name);
  }

  const listPattern = /export\s*{\s*([^}]+)\s*}(?:\s*from\s*["'][^"']+["'])?/gs;
  for (const match of source.matchAll(listPattern)) {
    const block = match[1];
    if (!block) continue;
    for (const part of block.split(",")) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const aliasParts = cleaned.split(/\s+as\s+/i);
      const exportedName = aliasParts[1]?.trim() || aliasParts[0]?.trim();
      if (exportedName && /^[A-Za-z_$][\w$]*$/.test(exportedName)) {
        exports.add(exportedName);
      }
    }
  }

  return Array.from(exports).sort((a, b) => a.localeCompare(b));
}

async function readFileFromGitRef(workDir: string, ref: string, filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git show ${shellQuote(`${ref}:${filePath}`)}`, {
      cwd: workDir,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function captureMergeConflictSafetyBaseline(
  workDir: string,
  conflictedFiles: string[],
): Promise<MergeConflictSafetyBaseline> {
  const branchExportsByFile: Record<string, string[]> = {};

  for (const filePath of conflictedFiles) {
    if (!isTrackedCodeModule(filePath)) continue;
    const source = await readFileFromGitRef(workDir, "HEAD", filePath);
    if (!source) continue;
    const exports = extractNamedExports(source);
    if (exports.length > 0) {
      branchExportsByFile[filePath] = exports;
    }
  }

  return { branchExportsByFile };
}

async function getWorkingTreeExports(workDir: string, filePath: string): Promise<string[]> {
  if (!isTrackedCodeModule(filePath)) return [];
  const absolutePath = path.join(workDir, filePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return [];
  const source = fs.readFileSync(absolutePath, "utf-8");
  return extractNamedExports(source);
}

async function findSymbolUsages(workDir: string, symbol: string, excludedFiles: Set<string>): Promise<string[]> {
  if (!symbol) return [];

  const rgPattern = `\\b${escapeRegExp(symbol)}\\b`;
  const command = [
    "rg",
    "-n",
    "--color",
    "never",
    "--hidden",
    "--glob",
    "'!node_modules'",
    "--glob",
    "'!.git'",
    "--glob",
    "'!dist'",
    "--glob",
    "'!build'",
    "--glob",
    "'!coverage'",
    "--glob",
    "'!**/_generated/**'",
    "--glob",
    "'!**/*.d.ts'",
    "--glob",
    "'*.ts'",
    "--glob",
    "'*.tsx'",
    "--glob",
    "'*.js'",
    "--glob",
    "'*.jsx'",
    "--glob",
    "'*.mjs'",
    "--glob",
    "'*.cjs'",
    shellQuote(rgPattern),
    ".",
  ].join(" ");

  try {
    const { stdout } = await execAsync(command, {
      cwd: workDir,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const firstColon = line.indexOf(":");
        if (firstColon === -1) return false;
        const filePath = line.slice(0, firstColon);
        return !excludedFiles.has(filePath);
      })
      .slice(0, 10);
  } catch (err) {
    const error = err as { code?: number };
    if (error?.code === 1) return [];
    throw err;
  }
}

async function evaluateMergeConflictResolutionSafety(input: {
  workDir: string;
  conflictedFiles: string[];
  baseline: MergeConflictSafetyBaseline;
  additionalEditedFiles: string[];
}): Promise<string[]> {
  const findings: string[] = [];

  if (input.additionalEditedFiles.length > MERGE_CONFLICT_MAX_ADDITIONAL_EDIT_FILES) {
    findings.push(
      `Manual review required: conflict resolution edited ${input.additionalEditedFiles.length} additional file(s) outside the conflicted set (${input.additionalEditedFiles.slice(0, 5).join(", ")}).`,
    );
  }

  const removedExportsWithCallers: string[] = [];
  const broadlyRemovedExports: string[] = [];

  for (const [filePath, branchExports] of Object.entries(input.baseline.branchExportsByFile)) {
    if (branchExports.length === 0) continue;

    const resolvedExports = new Set(await getWorkingTreeExports(input.workDir, filePath));
    const removedExports = branchExports.filter((name) => !resolvedExports.has(name));

    if (removedExports.length > MERGE_CONFLICT_MAX_REMOVED_EXPORTS) {
      broadlyRemovedExports.push(`${filePath}: ${removedExports.slice(0, 8).join(", ")}`);
    }

    for (const exportName of removedExports) {
      const callers = await findSymbolUsages(input.workDir, exportName, new Set([filePath]));
      if (callers.length === 0) continue;
      removedExportsWithCallers.push(`${filePath} -> ${exportName} still referenced by ${callers.join(", ")}`);
    }
  }

  if (broadlyRemovedExports.length > 0) {
    findings.push(
      `Manual review required: conflict resolution removed a large branch export surface (${broadlyRemovedExports.join(" | ")}).`,
    );
  }

  if (removedExportsWithCallers.length > 0) {
    findings.push(
      `Manual review required: removed branch exports still have callers (${removedExportsWithCallers.join(" | ")}).`,
    );
  }

  return findings;
}

export async function resolveMergeConflict(input: ResolveMergeConflictInput): Promise<ResolveMergeConflictResult | null> {
  const {
    fixerAgent,
    repo,
    branch,
    baseBranch,
    prNumber,
    prTitle,
    mergeStateStatus,
    onDebug,
    onHistoryUpdate,
  } = input;
  const repoLabel = repo.label;
  const agentLabel = getFixerAgentLabel(fixerAgent);

  if (!isFixerAgentAvailable(fixerAgent)) {
    throw new Error(`${agentLabel} CLI is not available on this machine`);
  }

  const emitPersistedHistory = (overrides?: {
    status?: PersistedRunHistory["status"];
    detail?: string;
    currentStep?: string;
  }): void => {
    if (!onHistoryUpdate) return;
    const progress = getFixProgress(repoLabel, prNumber);
    if (!progress) return;
    const activeStep = progress.steps.find((step) => step.status === "active");
    const currentStep =
      overrides?.currentStep ??
      activeStep?.step ??
      progress.steps[progress.steps.length - 1]?.step;
    const lastStep = progress.steps[progress.steps.length - 1];

    onHistoryUpdate(
      buildPersistedRunHistory({
        status: overrides?.status,
        startedAt: progress.startedAt,
        finishedAt: progress.finishedAt,
        currentStep,
        detail: overrides?.detail ?? activeStep?.detail ?? lastStep?.detail,
        steps: progress.steps,
        output: progress.output,
      }),
    );
  };

  const logHistoryStep = (step: string, detail?: string): void => {
    logStep(repoLabel, prNumber, step, detail, fixerAgent);
    emitPersistedHistory({ detail, currentStep: step });
  };

  const logHistoryOutput = (line: string): void => {
    logOutput(repoLabel, prNumber, line, fixerAgent);
    emitPersistedHistory();
  };

  const completeHistory = (detail?: string): void => {
    logDone(repoLabel, prNumber);
    emitPersistedHistory({ status: "done", detail });
  };

  const failHistory = (error: string): void => {
    logError(repoLabel, prNumber, error);
    emitPersistedHistory({ status: "error", detail: error });
  };

  logHistoryStep("Preparing workspace", `Syncing ${branch} with ${baseBranch}`);
  const { workDir, cleanup, restorePaths, transientSymlinkPaths } = await getWorkDir(repo, branch, fixerAgent);

  try {
    await fetchOrigin(workDir);

    let realWorkDir: string;
    try { realWorkDir = fs.realpathSync(workDir); } catch { realWorkDir = workDir; }
    const pathVariants = [...new Set([realWorkDir, workDir])].sort((a, b) => b.length - a.length);
    const cleanOutput = (line: string) => {
      let cleaned = line;
      for (const p of pathVariants) {
        cleaned = cleaned.replaceAll(p + "/", "").replaceAll(p, ".");
      }
      logHistoryOutput(cleaned);
    };

    logHistoryStep("Merging base branch", `git merge origin/${baseBranch}`);
    let mergeNeedsResolution = false;
    try {
      const { stdout, stderr } = await execAsync(`git merge --no-ff --no-commit origin/${baseBranch}`, {
        cwd: workDir,
        timeout: 60000,
      });
      for (const line of `${stdout}\n${stderr}`.split("\n")) {
        if (line.trim()) cleanOutput(line.trim());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const line of message.split("\n")) {
        if (line.trim()) cleanOutput(line.trim());
      }
      const { stdout: unmergedOutput } = await execAsync("git diff --name-only --diff-filter=U", {
        cwd: workDir,
        timeout: 30000,
      });
      mergeNeedsResolution = unmergedOutput.trim().length > 0;
      if (!mergeNeedsResolution) {
        throw err;
      }
    }

    const { stdout: mergeHeadOutput } = await execAsync("git rev-parse -q --verify MERGE_HEAD", {
      cwd: workDir,
      timeout: 30000,
    }).catch(() => ({ stdout: "" }));
    if (!mergeHeadOutput.trim()) {
      logHistoryStep("Already synchronized", `${branch} already contains ${baseBranch}`);
      completeHistory(`${branch} already contains ${baseBranch}`);
      return null;
    }

    if (mergeNeedsResolution) {
      const { stdout: conflictedFilesOutput } = await execAsync("git diff --name-only --diff-filter=U", {
        cwd: workDir,
        timeout: 30000,
      });
      const conflictedFiles = conflictedFilesOutput
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const { stdout: gitStatusOutput } = await execAsync("git status --short", {
        cwd: workDir,
        timeout: 30000,
      });
      const mergeSafetyBaseline = await captureMergeConflictSafetyBaseline(workDir, conflictedFiles);

      logHistoryStep(`Running ${agentLabel} conflict resolution`, `${conflictedFiles.length} conflicted file(s)`);
      const prompt = buildMergeConflictPrompt({
        agent: fixerAgent,
        prTitle,
        branch,
        baseBranch,
        mergeStateStatus,
        conflictedFiles,
        gitStatus: gitStatusOutput.trim() || "(no status output)",
      });
      onDebug?.({
        fixerAgent,
        repo: repo.label,
        prNumber,
        prTitle,
        branch,
        baseBranch,
        mergeStateStatus: mergeStateStatus ?? null,
        conflictedFiles,
        prompt,
      });
      logHistoryOutput(`--- Prompt (${prompt.length} chars) ---`);
      for (const file of conflictedFiles) {
        logHistoryOutput(`  conflict: ${file}`);
      }
      logHistoryOutput("---");

      const runFix = fixerAgent === "codex" ? runCodexFix : runClaudeFix;
      await runFix(workDir, prompt, cleanOutput);

      const { stdout: aiEditedFilesOutput } = await execAsync("git diff --name-only", {
        cwd: workDir,
        timeout: 30000,
      });
      const additionalEditedFiles = aiEditedFilesOutput
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((filePath) => !conflictedFiles.includes(filePath));

      // Mark edited files as resolved before checking for remaining unmerged entries.
      await execAsync("git add -A", {
        cwd: workDir,
        timeout: 30000,
      });

      const { stdout: remainingConflictsOutput } = await execAsync("git diff --name-only --diff-filter=U", {
        cwd: workDir,
        timeout: 30000,
      });
      const remainingConflicts = remainingConflictsOutput
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (remainingConflicts.length > 0) {
        throw new Error(`Merge conflict markers remain in: ${remainingConflicts.join(", ")}`);
      }

      logHistoryStep("Reviewing merge safety", `${conflictedFiles.length} conflicted file(s)`);
      const safetyFindings = await evaluateMergeConflictResolutionSafety({
        workDir,
        conflictedFiles,
        baseline: mergeSafetyBaseline,
        additionalEditedFiles,
      });
      for (const finding of safetyFindings) {
        cleanOutput(finding);
      }
      if (safetyFindings.length > 0) {
        throw new Error(safetyFindings.join(" "));
      }
    }

    logHistoryStep("Checking merge changes");
    const { stdout: stagedFilesOutput } = await execAsync("git diff --cached --name-only", {
      cwd: workDir,
      timeout: 30000,
    });
    const stagedFiles = stagedFilesOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    await restoreWorkspaceMutations(workDir, restorePaths, transientSymlinkPaths);
    await execAsync("git add -A", {
      cwd: workDir,
      timeout: 30000,
    });

    const { stdout: filesToCommitOutput } = await execAsync("git diff --cached --name-only", {
      cwd: workDir,
      timeout: 30000,
    });
    const filesChanged = filesToCommitOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (filesChanged.length === 0 && stagedFiles.length === 0) {
      logHistoryStep("No merge changes", "Nothing changed after syncing with the base branch");
      completeHistory("Nothing changed after syncing with the base branch");
      return null;
    }

    if (fs.existsSync(path.join(workDir, "package.json")) && !hasInstalledNodeDependencies(workDir)) {
      logHistoryStep("Installing dependencies", detectPackageManager(workDir));
      await ensureNodeDependenciesInstalled(workDir, cleanOutput);
    }

    logHistoryStep("Running formatters", `${filesChanged.length || stagedFiles.length} file(s)`);
    await runPostFixFormatting(workDir, filesChanged.length > 0 ? filesChanged : stagedFiles, cleanOutput);

    logHistoryStep(
      "Running verification",
      repo.skipTypecheck ? "git diff --check only (repo verification script disabled)" : undefined,
    );
    await runPostFixVerification(workDir, Boolean(repo.skipTypecheck), cleanOutput);

    logHistoryStep("Committing merge", `${filesChanged.length || stagedFiles.length} file(s) modified`);
    await execAsync("git add -A", {
      cwd: workDir,
      timeout: 30000,
    });
    const commitMessage = buildMergeConflictCommitMessage(branch, baseBranch);
    const commitMsgFile = path.join(os.tmpdir(), `merge-commit-msg-${Date.now()}.txt`);
    fs.writeFileSync(commitMsgFile, commitMessage, "utf-8");
    try {
      await execAsync(`git commit -F ${shellQuote(commitMsgFile)}`, {
        cwd: workDir,
        timeout: 60000,
      });
    } finally {
      try { fs.unlinkSync(commitMsgFile); } catch {}
    }

    logHistoryStep("Pushing to remote", `origin/${branch}`);
    await execAsync(`git push origin HEAD:refs/heads/${branch}`, {
      cwd: workDir,
      timeout: 60000,
    });

    const { stdout: hashOutput } = await execAsync("git rev-parse --short HEAD", {
      cwd: workDir,
      timeout: 30000,
    });
    const commitHash = hashOutput.trim();

    logHistoryStep("Merge conflict resolved", `${agentLabel} created commit ${commitHash}`);
    completeHistory(`${agentLabel} created commit ${commitHash}`);

    return {
      filesChanged: filesChanged.length > 0 ? filesChanged : stagedFiles,
      commitHash,
      commitMessage,
      fixedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failHistory(msg);
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
