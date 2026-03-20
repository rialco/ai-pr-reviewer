import { execSync } from "child_process";
import type { PRInfo, BotComment, RepoConfig } from "../types.js";

function gh(args: string): string {
  return execSync(`gh ${args}`, { encoding: "utf-8", timeout: 30000 });
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

export function listOpenPRs(repo: RepoConfig): PRInfo[] {
  try {
    const raw = gh(
      `pr list --repo ${repo.label} --author @me --state open --json number,title,url,headRefName,author,createdAt,updatedAt`,
    );
    const prs = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      url: string;
      headRefName: string;
      author: { login: string };
      createdAt: string;
      updatedAt: string;
    }>;
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      author: pr.author.login,
      repo: repo.label,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    }));
  } catch {
    return [];
  }
}

export function fetchBotComments(
  repo: RepoConfig,
  prNumber: number,
  prTitle: string,
  prUrl: string,
): BotComment[] {
  const botFilter = repo.botUsers
    .map((b) => `.user.login == "${b}"`)
    .join(" or ");

  const comments: BotComment[] = [];

  // 1. Inline review comments — filter out those with human replies
  try {
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
    }>(
      gh(
        `api repos/${repo.label}/pulls/${prNumber}/comments --paginate --jq '.[] | {id, in_reply_to_id, user: .user.login, path, line: (.line // .original_line), diff_hunk, body, created_at, url}'`,
      ),
    );

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
  } catch {
    // ignore
  }

  // 2. Review-level comments
  try {
    const reviews = parseNDJSON<{
      id: number;
      body: string;
      user: string;
      state: string;
      submitted_at: string;
    }>(
      gh(
        `api repos/${repo.label}/pulls/${prNumber}/reviews --paginate --jq '.[] | select(${botFilter}) | select(.body != "") | {id, body, user: .user.login, state, submitted_at}'`,
      ),
    );

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
  } catch {
    // ignore
  }

  // 3. Issue-level comments (PR conversation)
  try {
    const issueComments = parseNDJSON<{
      id: number;
      body: string;
      user: string;
      created_at: string;
      url: string;
    }>(
      gh(
        `api repos/${repo.label}/issues/${prNumber}/comments --paginate --jq '.[] | select(${botFilter}) | {id, body, user: .user.login, created_at, url}'`,
      ),
    );

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
  } catch {
    // ignore
  }

  return comments;
}

export function getFileFromBranch(
  repo: string,
  branch: string,
  filePath: string,
): string | null {
  try {
    const raw = gh(
      `api repos/${repo}/contents/${filePath}?ref=${branch} --jq '.content'`,
    );
    return Buffer.from(raw.trim(), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export function getPRBranch(repo: string, prNumber: number): string | null {
  try {
    return gh(
      `pr view ${prNumber} --repo ${repo} --json headRefName --jq '.headRefName'`,
    ).trim();
  } catch {
    return null;
  }
}

export function postPRComment(
  repo: string,
  prNumber: number,
  body: string,
): void {
  execSync(
    `gh api repos/${repo}/issues/${prNumber}/comments --method POST --field body=@-`,
    { input: body, encoding: "utf-8", timeout: 30000 },
  );
}

export function replyToReviewComment(
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
): void {
  execSync(
    `gh api repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies --method POST --field body=@-`,
    { input: body, encoding: "utf-8", timeout: 30000 },
  );
}

export function getPRDiff(repo: string, prNumber: number): string | null {
  try {
    return gh(`pr diff ${prNumber} --repo ${repo}`);
  } catch {
    return null;
  }
}

export function fetchConfidenceScore(
  repo: string,
  prNumber: number,
): number | null {
  try {
    const raw = gh(
      `api repos/${repo}/pulls/${prNumber}/reviews --jq '[.[] | select(.user.login == "greptile-apps[bot]") | .body] | last'`,
    );
    const match = raw.match(/Confidence:\s*(\d)\/5/i);
    if (match) return parseInt(match[1], 10);
    return null;
  } catch {
    return null;
  }
}
