import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, exec, spawn } from "child_process";
import { promisify } from "util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildReviewPrompt, parseReviewOutput } from "../server/infrastructure/reviewers/reviewPrompt";
import { analyzeComments, type AnalysisProgressEvent, type AnalyzerAgent } from "../server/services/analyzer";
import { getPRDiff } from "../server/services/github";
import { fetchOrigin } from "../server/services/git";
import type { BotComment, RepoConfig } from "../server/types";
import {
  loadWorkerConfig,
  readWorkerSession,
  writeWorkerSession,
  type WorkerSession,
} from "./config";

const execAsync = promisify(exec);

function detectCapabilities() {
  const hasBinary = (binary: string) => {
    try {
      execFileSync("which", [binary], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  return {
    git: hasBinary("git"),
    gh: hasBinary("gh"),
    claude: hasBinary("claude"),
    codex: hasBinary("codex"),
  };
}

function runCommand(binary: string, args: string[], options?: { cwd?: string }) {
  return execFileSync(binary, args, {
    cwd: options?.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function registerMachine(client: ConvexHttpClient, config: ReturnType<typeof loadWorkerConfig>) {
  if (!config.enrollmentToken) {
    throw new Error(
      "No machine session is stored and WORKER_ENROLLMENT_TOKEN is missing. Create an enrollment token in the app first.",
    );
  }

  const result = await client.mutation(api.machines.registerWithEnrollmentToken, {
    enrollmentToken: config.enrollmentToken,
    machineSlug: config.machineSlug,
    machineName: config.machineName,
    hostname: os.hostname(),
    platform: `${process.platform}/${process.arch}`,
    version: config.version,
    capabilities: detectCapabilities(),
  });

  writeWorkerSession(config.sessionPath, {
    machineId: result.machineId,
    machineToken: result.machineToken,
    workspaceId: result.workspaceId,
  });

  return result;
}

async function sendHeartbeat(
  client: ConvexHttpClient,
  machineToken: string,
  status: "idle" | "busy" | "error" | "offline",
  version: string,
  currentJobLabel?: string,
) {
  return client.mutation(api.machines.heartbeat, {
    machineToken,
    status,
    version,
    currentJobLabel,
    capabilities: detectCapabilities(),
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

interface ClaimedMachineJob {
  kind: string;
  payload: unknown;
}

interface SyncSnapshotComment {
  githubCommentId: number;
  type: "inline" | "review" | "issue_comment";
  user: string;
  body: string;
  path?: string;
  line?: number;
  diffHunk?: string;
  githubUrl?: string;
  createdAt: string;
  updatedAt: string;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

async function prepareReviewWorktree(localPath: string, branch: string, prefix: string) {
  await fetchOrigin(localPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await execAsync(`git worktree add ${JSON.stringify(tmpDir)} origin/${branch}`, {
    cwd: localPath,
    timeout: 60000,
  });

  return {
    cwd: tmpDir,
    cleanup: async () => {
      await execAsync(`git worktree remove ${JSON.stringify(tmpDir)} --force`, {
        cwd: localPath,
      });
    },
  };
}

function runClaudeReview(cwd: string, prompt: string, onOutput?: (line: string) => void): Promise<string> {
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
          if (event.type === "result" && typeof event.result === "string") {
            lastResult = event.result;
          }
          if (event.type === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (
              block?.type === "text" &&
              typeof block.text === "string" &&
              block.text.trim().length > 0 &&
              block.text.length <= 200
            ) {
              onOutput?.(block.text.trim());
            }
          }
        } catch {
          onOutput?.(line.trim());
        }
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude review timed out after 10 minutes"));
    }, 600000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>;
          if (event.type === "result" && typeof event.result === "string") {
            lastResult = event.result;
          }
        } catch {}
      }
      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      } else if (lastResult) {
        resolve(lastResult);
      } else {
        reject(new Error(`No result from Claude. stderr: ${stderr.slice(0, 500)}`));
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function runCodexReview(cwd: string, prompt: string, onOutput?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--full-auto", prompt], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Codex review timed out after 20 minutes"));
    }, 20 * 60 * 1000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        const cleanStderr = stderr.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim();
        const errorLine = cleanStderr
          .split("\n")
          .filter((line) => line.trim())
          .find((line) => /error/i.test(line));
        reject(new Error(errorLine?.replace(/^ERROR:\s*/i, "").trim() || cleanStderr || "Codex failed"));
        return;
      }
      resolve(stdout);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function syncSinglePrSnapshot(params: {
  repoLabel: string;
  owner: string;
  repoName: string;
  prNumber: number;
  localPath: string;
}) {
  const { repoLabel, owner, repoName, prNumber, localPath } = params;
  const prViewJson = runCommand(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repoLabel,
      "--json",
      "number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,author,createdAt,updatedAt,additions,deletions,changedFiles,commits,files",
    ],
    { cwd: localPath },
  );
  const issueCommentsJson = runCommand(
    "gh",
    ["api", `repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`],
    { cwd: localPath },
  );
  const reviewCommentsJson = runCommand(
    "gh",
    ["api", `repos/${owner}/${repoName}/pulls/${prNumber}/comments?per_page=100`],
    { cwd: localPath },
  );

  const prView = parseJson<{
    number: number;
    title: string;
    body?: string;
    url: string;
    headRefName?: string;
    baseRefName?: string;
    mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
    mergeStateStatus?:
      | "BEHIND"
      | "BLOCKED"
      | "CLEAN"
      | "DIRTY"
      | "DRAFT"
      | "HAS_HOOKS"
      | "UNKNOWN"
      | "UNSTABLE"
      | null;
    author?: { login?: string | null } | null;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    commits?: Array<unknown>;
    files?: Array<{
      path?: string;
      additions?: number;
      deletions?: number;
    }>;
    createdAt: string;
    updatedAt: string;
  }>(prViewJson);
  const issueComments = parseJson<Array<{
    id: number;
    body?: string | null;
    html_url?: string | null;
    user?: { login?: string | null } | null;
    created_at: string;
    updated_at: string;
  }>>(issueCommentsJson);
  const reviewComments = parseJson<Array<{
    id: number;
    body?: string | null;
    html_url?: string | null;
    path?: string | null;
    line?: number | null;
    diff_hunk?: string | null;
    user?: { login?: string | null } | null;
    created_at: string;
    updated_at: string;
  }>>(reviewCommentsJson);

  const comments: SyncSnapshotComment[] = [
    ...issueComments.map((comment) => ({
      githubCommentId: comment.id,
      type: "issue_comment" as const,
      user: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      githubUrl: comment.html_url ?? undefined,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
    ...reviewComments.map((comment) => ({
      githubCommentId: comment.id,
      type: comment.path ? "inline" as const : "review" as const,
      user: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      path: comment.path ?? undefined,
      line: comment.line ?? undefined,
      diffHunk: comment.diff_hunk ?? undefined,
      githubUrl: comment.html_url ?? undefined,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    number: prView.number,
    title: prView.title,
    body: prView.body ?? "",
    url: prView.url,
    headRefName: prView.headRefName,
    baseRefName: prView.baseRefName,
    mergeable: prView.mergeable ?? undefined,
    mergeStateStatus: prView.mergeStateStatus ?? undefined,
    author: prView.author?.login ?? "unknown",
    additions: prView.additions ?? 0,
    deletions: prView.deletions ?? 0,
    changedFiles: prView.changedFiles ?? 0,
    commitCount: Array.isArray(prView.commits) ? prView.commits.length : 0,
    files: (prView.files ?? [])
      .filter((file): file is { path: string; additions?: number; deletions?: number } => Boolean(file.path))
      .map((file) => ({
        path: file.path,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      })),
    comments,
    createdAt: prView.createdAt,
    updatedAt: prView.updatedAt,
  };
}

async function executeJob(client: ConvexHttpClient, session: WorkerSession, job: ClaimedMachineJob) {
  const payload =
    job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : null;
  const now = new Date().toISOString();

  if (job.kind === "machine_command") {
    const command = typeof payload?.command === "string" ? payload.command : null;

    if (command !== "self_check") {
      throw new Error(`Unsupported machine command: ${command ?? "unknown"}`);
    }

    const capabilities = detectCapabilities();

    return {
      output: [
        `[self-check] completed at ${now}`,
        `[self-check] machine=${session.machineId}`,
        `[self-check] workspace=${session.workspaceId}`,
        `[self-check] hostname=${os.hostname()}`,
        `[self-check] platform=${process.platform}/${process.arch}`,
        `[self-check] cwd=${process.cwd()}`,
        `[self-check] capabilities=${JSON.stringify(capabilities)}`,
      ],
      steps: [
        {
          step: "claim",
          detail: `Claimed by ${os.hostname()}`,
          status: "done" as const,
          ts: now,
        },
        {
          step: "self_check",
          detail: "Collected machine identity and local capability snapshot",
          status: "done" as const,
          ts: now,
        },
      ],
    };
  }

  if (job.kind === "sync_repo") {
    const repoId = typeof payload?.repoId === "string" ? (payload.repoId as Id<"repos">) : null;
    const repoLabel = typeof payload?.repoLabel === "string" ? payload.repoLabel : null;
    const owner = typeof payload?.owner === "string" ? payload.owner : null;
    const repoName = typeof payload?.repo === "string" ? payload.repo : null;
    const localPath = typeof payload?.localPath === "string" ? payload.localPath : null;

    if (!repoId || !repoLabel || !owner || !repoName || !localPath) {
      throw new Error("sync_repo payload is missing repoId, repoLabel, owner, repo, or localPath.");
    }

    if (!fs.existsSync(localPath)) {
      throw new Error(`Configured checkout path does not exist: ${localPath}`);
    }

    const stats = fs.statSync(localPath);
    if (!stats.isDirectory()) {
      throw new Error(`Configured checkout path is not a directory: ${localPath}`);
    }

    const remoteUrl = runCommand("git", ["remote", "get-url", "origin"], { cwd: localPath });
    const branchStatus = runCommand("git", ["status", "--short", "--branch"], { cwd: localPath });
    const prListJson = runCommand(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repoLabel,
        "--author",
        "@me",
        "--state",
        "open",
        "--json",
        "number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus,author,createdAt,updatedAt",
      ],
      { cwd: localPath },
    );
    const openPrs = parseJson<Array<{
      number: number;
      title: string;
      url: string;
      headRefName?: string;
      baseRefName?: string;
      mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
      mergeStateStatus?:
        | "BEHIND"
        | "BLOCKED"
        | "CLEAN"
        | "DIRTY"
        | "DRAFT"
        | "HAS_HOOKS"
        | "UNKNOWN"
        | "UNSTABLE"
        | null;
      author?: { login?: string | null } | null;
      createdAt: string;
      updatedAt: string;
    }>>(prListJson);

    const syncSnapshots = await Promise.all(
      openPrs.map((pr) =>
        syncSinglePrSnapshot({
          repoLabel,
          owner,
          repoName,
          prNumber: pr.number,
          localPath,
        }),
      ),
    );

    await client.mutation(api.prs.upsertRepoSyncSnapshot, {
      machineToken: session.machineToken,
      repoId,
      pruneMissing: true,
      eventType: "comments_fetched",
      prs: syncSnapshots,
    });

    return {
      output: [
        `[sync_repo] completed at ${now}`,
        `[sync_repo] repo=${repoLabel}`,
        `[sync_repo] localPath=${localPath}`,
        `[sync_repo] remote=${remoteUrl}`,
        `[sync_repo] openPrCount=${syncSnapshots.length}`,
        `[sync_repo] convexSnapshotUpdated=true`,
        `[sync_repo] branchStatus=${branchStatus.replaceAll("\n", " | ")}`,
        ...syncSnapshots.slice(0, 5).map(
          (pr) => `[sync_repo] pr #${pr.number} ${pr.title} comments=${pr.comments.length}`,
        ),
      ],
      steps: [
        {
          step: "verify_checkout",
          detail: localPath,
          status: "done" as const,
          ts: now,
        },
        {
          step: "inspect_git_remote",
          detail: remoteUrl,
          status: "done" as const,
          ts: now,
        },
        {
          step: "query_open_prs",
          detail: `${syncSnapshots.length} open PR(s) visible through gh`,
          status: "done" as const,
          ts: now,
        },
        {
          step: "persist_cloud_snapshot",
          detail: `Updated Convex snapshot for ${syncSnapshots.length} PR(s)`,
          status: "done" as const,
          ts: now,
        },
      ],
    };
  }

  if (job.kind === "refresh_pr") {
    const repoId = typeof payload?.repoId === "string" ? (payload.repoId as Id<"repos">) : null;
    const repoLabel = typeof payload?.repoLabel === "string" ? payload.repoLabel : null;
    const owner = typeof payload?.owner === "string" ? payload.owner : null;
    const repoName = typeof payload?.repo === "string" ? payload.repo : null;
    const prNumber = typeof payload?.prNumber === "number" ? payload.prNumber : null;
    const localPath = typeof payload?.localPath === "string" ? payload.localPath : null;

    if (!repoId || !repoLabel || !owner || !repoName || !prNumber || !localPath) {
      throw new Error("refresh_pr payload is missing repoId, repoLabel, owner, repo, prNumber, or localPath.");
    }

    if (!fs.existsSync(localPath)) {
      throw new Error(`Configured checkout path does not exist: ${localPath}`);
    }

    const stats = fs.statSync(localPath);
    if (!stats.isDirectory()) {
      throw new Error(`Configured checkout path is not a directory: ${localPath}`);
    }

    const snapshot = await syncSinglePrSnapshot({
      repoLabel,
      owner,
      repoName,
      prNumber,
      localPath,
    });

    await client.mutation(api.prs.upsertRepoSyncSnapshot, {
      machineToken: session.machineToken,
      repoId,
      pruneMissing: false,
      eventType: "comments_fetched",
      prs: [snapshot],
    });

    return {
      output: [
        `[refresh_pr] completed at ${now}`,
        `[refresh_pr] repo=${repoLabel}`,
        `[refresh_pr] pr=${prNumber}`,
        `[refresh_pr] localPath=${localPath}`,
        `[refresh_pr] changedFiles=${snapshot.changedFiles}`,
        `[refresh_pr] comments=${snapshot.comments.length}`,
      ],
      steps: [
        {
          step: "refresh_pr",
          detail: `${repoLabel} #${prNumber}`,
          status: "done" as const,
          ts: now,
        },
        {
          step: "persist_cloud_snapshot",
          detail: `Updated Convex snapshot for ${repoLabel} #${prNumber}`,
          status: "done" as const,
          ts: now,
        },
      ],
    };
  }

  if (job.kind === "request_review") {
    const repoId = typeof payload?.repoId === "string" ? (payload.repoId as Id<"repos">) : null;
    const repoLabel = typeof payload?.repoLabel === "string" ? payload.repoLabel : null;
    const prNumber = typeof payload?.prNumber === "number" ? payload.prNumber : null;
    const prTitle = typeof payload?.prTitle === "string" ? payload.prTitle : null;
    const branch = typeof payload?.branch === "string" ? payload.branch : null;
    const localPath = typeof payload?.localPath === "string" ? payload.localPath : null;
    const reviewerId =
      payload?.reviewerId === "claude" || payload?.reviewerId === "codex"
        ? payload.reviewerId
        : null;

    if (!repoId || !repoLabel || !prNumber || !prTitle || !branch || !localPath || !reviewerId) {
      throw new Error("request_review payload is missing repoId, repoLabel, prNumber, prTitle, branch, localPath, or reviewerId.");
    }

    const capabilities = detectCapabilities();
    if (reviewerId === "claude" && !capabilities.claude) {
      throw new Error("Claude CLI is not available on this machine.");
    }
    if (reviewerId === "codex" && !capabilities.codex) {
      throw new Error("Codex CLI is not available on this machine.");
    }

    const prDiff = await getPRDiff(repoLabel, prNumber, localPath, branch);
    if (!prDiff) {
      throw new Error(`Could not fetch PR diff for ${repoLabel} #${prNumber}`);
    }

    let reviewCwd = localPath;
    let cleanupWorktree: (() => Promise<void>) | undefined;
    try {
      try {
        const worktree = await prepareReviewWorktree(
          localPath,
          branch,
          reviewerId === "claude" ? "pr-review-claude-" : "pr-review-codex-",
        );
        reviewCwd = worktree.cwd;
        cleanupWorktree = worktree.cleanup;
      } catch {
        reviewCwd = localPath;
      }

      const prompt = buildReviewPrompt(
        {
          repo: repoLabel,
          prNumber,
          prTitle,
          branch,
          localPath,
        },
        prDiff.length > 30000 ? `${prDiff.slice(0, 30000)}\n... (diff truncated)` : prDiff,
        reviewCwd !== localPath,
        [],
      );

      const outputLines: string[] = [];
      const rawOutput =
        reviewerId === "claude"
          ? await runClaudeReview(reviewCwd, prompt, (line) => outputLines.push(`[claude] ${line}`))
          : await runCodexReview(reviewCwd, prompt, (line) => outputLines.push(`[codex] ${line}`));
      const parsed = parseReviewOutput(rawOutput);

      await client.mutation(api.reviews.upsertReviewResult, {
        machineToken: session.machineToken,
        repoId,
        prNumber,
        reviewerId,
        source: "local",
        confidenceScore: parsed.confidenceScore,
        summary: parsed.summary,
        rawOutput,
        comments: parsed.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          body: comment.body,
          suggestion: comment.suggestion,
          severity: comment.severity,
          confidence: comment.confidence ?? undefined,
          evidence: comment.evidence
            ? {
                filesRead: comment.evidence.filesRead,
                changedLinesChecked: comment.evidence.changedLinesChecked,
                ruleReferences: comment.evidence.ruleReferences,
                riskSummary: comment.evidence.riskSummary,
              }
            : undefined,
        })),
      });

      return {
        output: [
          `[request_review] completed at ${now}`,
          `[request_review] repo=${repoLabel}`,
          `[request_review] pr=${prNumber}`,
          `[request_review] reviewer=${reviewerId}`,
          `[request_review] confidence=${parsed.confidenceScore}`,
          `[request_review] comments=${parsed.comments.length}`,
          ...outputLines.slice(-12),
        ],
        steps: [
          {
            step: "fetch_pr_diff",
            detail: `${repoLabel} #${prNumber}`,
            status: "done" as const,
            ts: now,
          },
          {
            step: "run_reviewer",
            detail: reviewerId,
            status: "done" as const,
            ts: now,
          },
          {
            step: "persist_review",
            detail: `Stored ${parsed.comments.length} comment(s) in Convex`,
            status: "done" as const,
            ts: now,
          },
        ],
      };
    } finally {
      if (cleanupWorktree) {
        try {
          await cleanupWorktree();
        } catch {}
      }
    }
  }

  if (job.kind === "analyze_comments") {
    const source = typeof payload?.source === "string" ? payload.source : null;
    const repoId = typeof payload?.repoId === "string" ? (payload.repoId as Id<"repos">) : null;
    const repoLabel = typeof payload?.repoLabel === "string" ? payload.repoLabel : null;
    const owner = typeof payload?.owner === "string" ? payload.owner : null;
    const repoName = typeof payload?.repo === "string" ? payload.repo : null;
    const prNumber = typeof payload?.prNumber === "number" ? payload.prNumber : null;
    const prTitle = typeof payload?.prTitle === "string" ? payload.prTitle : null;
    const localPath = typeof payload?.localPath === "string" ? payload.localPath : null;
    const reviewerId =
      payload?.reviewerId === "claude" || payload?.reviewerId === "codex"
        ? payload.reviewerId
        : null;
    const analyzerAgent =
      payload?.analyzerAgent === "claude" || payload?.analyzerAgent === "codex"
        ? (payload.analyzerAgent as AnalyzerAgent)
        : null;

    if (
      source !== "local_review_comments" ||
      !repoId ||
      !repoLabel ||
      !owner ||
      !repoName ||
      !prNumber ||
      !prTitle ||
      !localPath ||
      !reviewerId ||
      !analyzerAgent
    ) {
      throw new Error("analyze_comments payload is missing repo or review analysis context.");
    }

    const pendingComments = await client.query(api.reviews.listCommentsForMachine, {
      machineToken: session.machineToken,
      repoId,
      prNumber,
      reviewerId,
    });

    if (pendingComments.length === 0) {
      return {
        output: [
          `[analyze_comments] completed at ${now}`,
          `[analyze_comments] repo=${repoLabel}`,
          `[analyze_comments] reviewer=${reviewerId}`,
          "[analyze_comments] no pending review comments found",
        ],
        steps: [
          {
            step: "load_review_comments",
            detail: "No pending review comments to analyze",
            status: "done" as const,
            ts: now,
          },
        ],
      };
    }

    const commentIdMap = new Map<number, Id<"reviewComments">>();
    const botComments: BotComment[] = pendingComments.map((comment, index) => {
      const syntheticId = index + 1;
      commentIdMap.set(syntheticId, comment._id);
      return {
        id: syntheticId,
        prNumber,
        prTitle,
        prUrl: `https://github.com/${repoLabel}/pull/${prNumber}`,
        repo: repoLabel,
        path: comment.path,
        line: comment.line,
        diffHunk: null,
        body: comment.body,
        user: comment.reviewerId,
        createdAt: comment.createdAt,
        url: null,
        type: "inline",
      };
    });
    const repoConfig: RepoConfig = {
      owner,
      repo: repoName,
      label: repoLabel,
      botUsers: [],
      localPath,
    };
    const progressOutput: string[] = [];
    const analysisResults = await analyzeComments(
      botComments,
      repoConfig,
      analyzerAgent,
      (event: AnalysisProgressEvent) => {
        if (event.type !== "progress") {
          return;
        }
        if (event.step === "claude_output" || event.step === "codex_output") {
          progressOutput.push(event.message);
          return;
        }
        if (event.detail) {
          progressOutput.push(`${event.step}: ${event.message} · ${event.detail}`);
          return;
        }
        progressOutput.push(`${event.step}: ${event.message}`);
      },
    );

    await client.mutation(api.reviews.applyReviewCommentAnalysisResults, {
      machineToken: session.machineToken,
      repoId,
      prNumber,
      reviewerId,
      analyzerAgent,
      results: analysisResults
        .map((result) => {
          const commentId = commentIdMap.get(result.commentId);
          if (!commentId) {
            return null;
          }

          return {
            commentId,
            category: result.category,
            reasoning: result.reasoning,
            verdict: result.verdict,
            severity: result.severity ?? undefined,
            confidence: result.confidence ?? undefined,
            accessMode: result.accessMode,
            evidence: result.evidence
              ? {
                  filesRead: result.evidence.filesRead,
                  symbolsChecked: result.evidence.symbolsChecked,
                  callersChecked: result.evidence.callersChecked,
                  testsChecked: result.evidence.testsChecked,
                  riskSummary: result.evidence.riskSummary,
                  validationNotes: result.evidence.validationNotes,
                }
              : undefined,
          };
        })
        .filter((result): result is NonNullable<typeof result> => result !== null),
    });

    return {
      output: [
        `[analyze_comments] completed at ${now}`,
        `[analyze_comments] repo=${repoLabel}`,
        `[analyze_comments] reviewer=${reviewerId}`,
        `[analyze_comments] analyzer=${analyzerAgent}`,
        `[analyze_comments] analyzed=${analysisResults.length}`,
        ...progressOutput.slice(-12),
      ],
      steps: [
        {
          step: "load_review_comments",
          detail: `${pendingComments.length} pending review comment(s)`,
          status: "done" as const,
          ts: now,
        },
        {
          step: "triage_review_comments",
          detail: analyzerAgent,
          status: "done" as const,
          ts: now,
        },
        {
          step: "persist_review_analysis",
          detail: `Stored ${analysisResults.length} triaged review comment(s) in Convex`,
          status: "done" as const,
          ts: now,
        },
      ],
    };
  }

  throw new Error(`Unsupported job kind: ${job.kind}`);
}

async function main() {
  const config = loadWorkerConfig();
  const client = new ConvexHttpClient(config.convexUrl);
  let session = readWorkerSession(config.sessionPath);
  let currentStatus: "idle" | "busy" | "error" | "offline" = "idle";
  let currentJobLabel = "Awaiting jobs";
  let isExecutingJob = false;

  console.log("[worker] Starting cloud worker");
  console.log(`[worker] machine=${config.machineName} slug=${config.machineSlug}`);
  console.log(`[worker] hostname=${os.hostname()}`);

  if (!session) {
    const registered = await registerMachine(client, config);
    console.log("[worker] Machine registered with Convex");
    console.log(`[worker] registeredMachineId=${registered.machineId}`);
    session = readWorkerSession(config.sessionPath);
  }

  if (!session) {
    throw new Error("Worker session was not persisted after registration.");
  }

  console.log(`[worker] workspace=${session.workspaceId}`);

  const sendCurrentHeartbeat = async () => {
    await sendHeartbeat(client, session!.machineToken, currentStatus, config.version, currentJobLabel);
  };

  const pollForJobs = async () => {
    if (isExecutingJob) {
      return;
    }

    try {
      const claimedJob = await client.mutation(api.jobs.claimNextForMachine, {
        machineToken: session!.machineToken,
      });

      if (!claimedJob) {
        return;
      }

      isExecutingJob = true;
      currentStatus = "busy";
      currentJobLabel = claimedJob.title;

      console.log(`[worker] claimed job ${claimedJob._id} (${claimedJob.title})`);

      try {
        const result = await executeJob(client, session!, claimedJob);
        await client.mutation(api.jobs.completeMachineJob, {
          machineToken: session!.machineToken,
          jobId: claimedJob._id,
          output: result.output,
          steps: result.steps,
        });
        console.log(`[worker] completed job ${claimedJob._id}`);
      } catch (error) {
        const detail = formatError(error);
        await client.mutation(api.jobs.failMachineJob, {
          machineToken: session!.machineToken,
          jobId: claimedJob._id,
          errorMessage: detail,
          output: [detail],
        });
        console.error(`[worker] job failed ${claimedJob._id}`);
        console.error(detail);
      } finally {
        currentStatus = "idle";
        currentJobLabel = "Awaiting jobs";
        isExecutingJob = false;
      }
    } catch (error) {
      currentStatus = "error";
      currentJobLabel = "Claim loop error";
      console.error("[worker] Job poll failed");
      console.error(error);
    }
  };

  await sendCurrentHeartbeat();
  console.log("[worker] Initial heartbeat sent");
  console.log(`[worker] sessionPath=${config.sessionPath}`);

  const interval = setInterval(() => {
    void sendCurrentHeartbeat()
      .then(() => {
        console.log(`[worker] heartbeat ${new Date().toISOString()}`);
        if (currentStatus === "error") {
          currentStatus = "idle";
          currentJobLabel = "Awaiting jobs";
        }
      })
      .catch((error) => {
        console.error("[worker] Heartbeat failed");
        console.error(error);
      });
  }, config.heartbeatIntervalMs);

  const pollInterval = setInterval(() => {
    void pollForJobs();
  }, config.jobPollIntervalMs);

  await pollForJobs();

  const shutdown = async () => {
    clearInterval(interval);
    clearInterval(pollInterval);
    try {
      await sendHeartbeat(client, session!.machineToken, "offline", config.version, "Worker stopped");
      console.log("[worker] Offline heartbeat sent");
    } catch (error) {
      console.error("[worker] Failed to send offline heartbeat");
      console.error(error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("[worker] Failed to start worker scaffold");
  console.error(error);
  process.exitCode = 1;
});
