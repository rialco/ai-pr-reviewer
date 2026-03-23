import { exec, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import type { PRInfo, BotComment, RepoConfig, PRMergeStateStatus, PRMergeable } from "../types.js";
import { fetchOrigin } from "./git.js";

const execAsync = promisify(exec);

export interface PRFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface PROverview {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  mergeable: PRMergeable | null;
  mergeStateStatus: PRMergeStateStatus | null;
  needsConflictResolution: boolean;
  blockedReason: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  files: PRFileChange[];
}

/** Run a gh command that needs stdin input (e.g. posting comment bodies). */
function ghWithInput(args: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args.split(/\s+/), {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`gh exited ${code}: ${stderr}`));
      else resolve();
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function gh(args: string, options?: { input?: string }): Promise<string> {
  const { stdout } = await execAsync(`gh ${args}`, {
    encoding: "utf-8",
    timeout: 30000,
    ...(options?.input ? { input: options.input } : {}),
  });
  return stdout;
}

/** Parse NDJSON output (one JSON object per line) into an array. */
function parseNDJSON<T>(raw: string): T[] {
  const results: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

export function needsConflictResolution(
  mergeable: PRMergeable | null | undefined,
  mergeStateStatus: PRMergeStateStatus | null | undefined,
): boolean {
  return (
    mergeable === "CONFLICTING" ||
    mergeStateStatus === "DIRTY" ||
    mergeStateStatus === "BEHIND" ||
    mergeStateStatus === "BLOCKED"
  );
}

export function describeMergeBlockage(
  mergeable: PRMergeable | null | undefined,
  mergeStateStatus: PRMergeStateStatus | null | undefined,
): string | null {
  if (!needsConflictResolution(mergeable, mergeStateStatus)) return null;

  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    return "GitHub reports merge conflicts with the base branch.";
  }

  if (mergeStateStatus === "BEHIND") {
    return "The PR branch is behind the base branch and should be synced before other work continues.";
  }

  if (mergeStateStatus === "BLOCKED") {
    return "GitHub reports the PR as blocked, so the first recovery step is syncing it with the base branch.";
  }

  return "The PR is blocked from merging and should be synced with the base branch first.";
}

export async function listOpenPRs(repo: RepoConfig): Promise<PRInfo[]> {
  try {
    const raw = await gh(
      `pr list --repo ${repo.label} --author @me --state open --json number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus,author,createdAt,updatedAt`,
    );
    const prs = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      url: string;
      headRefName: string;
      baseRefName: string;
      mergeable?: PRMergeable | null;
      mergeStateStatus?: PRMergeStateStatus | null;
      author: { login: string };
      createdAt: string;
      updatedAt: string;
    }>;
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      mergeable: pr.mergeable ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? null,
      author: pr.author.login,
      repo: repo.label,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    }));
  } catch {
    return [];
  }
}

export async function getPROverview(repo: string, prNumber: number): Promise<PROverview | null> {
  try {
    const raw = await gh(
      `pr view ${prNumber} --repo ${repo} --json number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,author,createdAt,updatedAt,additions,deletions,files,commits`,
    );
    const pr = JSON.parse(raw) as {
      number: number;
      title: string;
      body: string | null;
      url: string;
      headRefName: string;
      baseRefName: string;
      mergeable?: PRMergeable | null;
      mergeStateStatus?: PRMergeStateStatus | null;
      author?: { login?: string | null } | null;
      createdAt: string;
      updatedAt: string;
      additions?: number | null;
      deletions?: number | null;
      files?: Array<{
        path?: string | null;
        additions?: number | null;
        deletions?: number | null;
      }> | null;
      commits?: Array<unknown> | null;
    };

    const files = (pr.files ?? [])
      .filter((file): file is { path: string; additions?: number | null; deletions?: number | null } => !!file?.path)
      .map((file) => ({
        path: file.path,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      }));

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      mergeable: pr.mergeable ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? null,
      needsConflictResolution: needsConflictResolution(pr.mergeable ?? null, pr.mergeStateStatus ?? null),
      blockedReason: describeMergeBlockage(pr.mergeable ?? null, pr.mergeStateStatus ?? null),
      author: pr.author?.login ?? "unknown",
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: files.length,
      commitCount: pr.commits?.length ?? 0,
      files,
    };
  } catch {
    return null;
  }
}

export async function fetchBotComments(
  repo: RepoConfig,
  prNumber: number,
  prTitle: string,
  prUrl: string,
): Promise<BotComment[]> {
  const botFilter = repo.botUsers
    .map((b) => `.user.login == "${b}"`)
    .join(" or ");

  // Run all 3 API calls in parallel
  const [inlineResult, reviewResult, issueResult] = await Promise.allSettled([
    // 1. Inline review comments
    gh(
      `api repos/${repo.label}/pulls/${prNumber}/comments --paginate --jq '.[] | {id, in_reply_to_id, user: .user.login, path, line: (.line // .original_line), diff_hunk, body, created_at, url}'`,
    ),
    // 2. Review-level comments
    gh(
      `api repos/${repo.label}/pulls/${prNumber}/reviews --paginate --jq '.[] | select(${botFilter}) | select(.body != "") | {id, body, user: .user.login, state, submitted_at}'`,
    ),
    // 3. Issue-level comments (PR conversation)
    gh(
      `api repos/${repo.label}/issues/${prNumber}/comments --paginate --jq '.[] | select(${botFilter}) | {id, body, user: .user.login, created_at, url}'`,
    ),
  ]);

  const comments: BotComment[] = [];

  // Process inline review comments
  if (inlineResult.status === "fulfilled") {
    const allReviewComments = parseNDJSON<{
      id: number;
      in_reply_to_id: number | null;
      user: string;
      path: string;
      line: number;
      diff_hunk: string;
      body: string;
      created_at: string;
      url: string;
    }>(inlineResult.value);

    // Find bot comment IDs that have human replies
    const repliedBotIds = new Set(
      allReviewComments
        .filter(
          (c) => c.in_reply_to_id !== null && !repo.botUsers.includes(c.user),
        )
        .map((c) => c.in_reply_to_id),
    );

    // Keep only unreplied bot comments
    for (const c of allReviewComments) {
      if (
        c.in_reply_to_id === null &&
        repo.botUsers.includes(c.user) &&
        !repliedBotIds.has(c.id)
      ) {
        comments.push({
          id: c.id,
          prNumber,
          prTitle,
          prUrl,
          repo: repo.label,
          path: c.path,
          line: c.line,
          diffHunk: c.diff_hunk,
          body: c.body,
          user: c.user,
          createdAt: c.created_at,
          url: c.url,
          type: "inline",
        });
      }
    }
  }

  // Process review-level comments
  if (reviewResult.status === "fulfilled") {
    const reviews = parseNDJSON<{
      id: number;
      body: string;
      user: string;
      state: string;
      submitted_at: string;
    }>(reviewResult.value);

    for (const r of reviews) {
      comments.push({
        id: r.id,
        prNumber,
        prTitle,
        prUrl,
        repo: repo.label,
        path: null,
        line: null,
        diffHunk: null,
        body: r.body,
        user: r.user,
        createdAt: r.submitted_at,
        url: null,
        type: "review",
      });
    }
  }

  // Process issue-level comments
  if (issueResult.status === "fulfilled") {
    const issueComments = parseNDJSON<{
      id: number;
      body: string;
      user: string;
      created_at: string;
      url: string;
    }>(issueResult.value);

    for (const c of issueComments) {
      comments.push({
        id: c.id,
        prNumber,
        prTitle,
        prUrl,
        repo: repo.label,
        path: null,
        line: null,
        diffHunk: null,
        body: c.body,
        user: c.user,
        createdAt: c.created_at,
        url: c.url,
        type: "issue_comment",
      });
    }
  }

  return comments;
}

export async function getFileFromBranch(
  repo: string,
  branch: string,
  filePath: string,
): Promise<string | null> {
  try {
    const raw = await gh(
      `api repos/${repo}/contents/${filePath}?ref=${branch} --jq '.content'`,
    );
    return Buffer.from(raw.trim(), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export async function getPRBranch(repo: string, prNumber: number): Promise<string | null> {
  try {
    const raw = await gh(
      `pr view ${prNumber} --repo ${repo} --json headRefName --jq '.headRefName'`,
    );
    return raw.trim();
  } catch {
    return null;
  }
}

export async function postPRComment(
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await ghWithInput(
    `api repos/${repo}/issues/${prNumber}/comments --method POST --field body=@-`,
    body,
  );
}

export async function replyToReviewComment(
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  await ghWithInput(
    `api repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies --method POST --field body=@-`,
    body,
  );
}

export async function getPRDiff(
  repo: string,
  prNumber: number,
  localPath?: string,
  branch?: string,
): Promise<string | null> {
  // Try gh pr diff first
  try {
    return await gh(`pr diff ${prNumber} --repo ${repo}`);
  } catch {
    // gh pr diff fails for large diffs (HTTP 406) — fall back to local git diff
  }

  // Fallback: use local git diff if we have a local checkout
  if (localPath && branch) {
    try {
      await fetchOrigin(localPath);
      const { stdout } = await execAsync(
        `git diff origin/main...origin/${branch}`,
        { cwd: localPath, encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      );
      if (stdout.trim()) return stdout;
    } catch {
      // fall through
    }
  }

  return null;
}

/** Submit a formal PR review with inline comments and optional code suggestions. */
export async function submitPRReview(
  repo: string,
  prNumber: number,
  opts: {
    body: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    comments: Array<{
      path: string;
      line: number;
      body: string;
    }>;
  },
): Promise<void> {
  const payload = JSON.stringify({
    event: opts.event,
    body: opts.body,
    comments: opts.comments,
  });
  const tmpFile = path.join(os.tmpdir(), `pr-review-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, payload, "utf-8");
  try {
    await execAsync(
      `gh api repos/${repo}/pulls/${prNumber}/reviews --method POST --input ${tmpFile}`,
      { encoding: "utf-8", timeout: 30000 },
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Confidence score fetching is now handled by GreptileReviewer.fetchLatestReview()
