import { getRepos, upsertGitHubComments, updateLastPoll, cleanupClosedPRComments } from "./db.js";
import { listOpenPRs, fetchBotComments } from "./github.js";
import type { RepoConfig, PRInfo } from "../types.js";

let pollInterval: ReturnType<typeof setInterval> | null = null;

function pollAllRepos(): void {
  const repos = getRepos();
  let totalNew = 0;

  for (const repo of repos) {
    try {
      const { newCount } = syncRepo(repo);
      totalNew += newCount;
    } catch (err) {
      console.error(`Background poll failed for ${repo.label}:`, err);
    }
  }

  updateLastPoll();
  if (totalNew > 0) {
    console.log(`Background poll: found ${totalNew} new comment(s)`);
  }
}

/**
 * Sync a single repo: list open PRs, fetch bot comments, clean up stale data.
 */
export function syncRepo(repo: RepoConfig): { prs: PRInfo[]; newCount: number; cleaned: number } {
  const prs = listOpenPRs(repo);
  let newCount = 0;

  for (const pr of prs) {
    const comments = fetchBotComments(repo, pr.number, pr.title, pr.url);
    if (comments.length > 0) {
      const result = upsertGitHubComments(comments);
      newCount += result.newCount;
    }
  }

  // Clean up comments from PRs that are no longer open
  const openPRNumbers = prs.map((pr) => pr.number);
  const cleaned = cleanupClosedPRComments(repo.label, openPRNumbers);
  if (cleaned > 0) {
    console.log(`Cleaned ${cleaned} stale comment(s) for ${repo.label}`);
  }

  return { prs, newCount, cleaned };
}

export function startBackgroundPoller(intervalMs = 5 * 60 * 1000): void {
  // Do an initial poll on startup
  try {
    pollAllRepos();
  } catch (err) {
    console.error("Initial poll failed:", err);
  }

  pollInterval = setInterval(() => {
    try {
      pollAllRepos();
    } catch (err) {
      console.error("Background poll error:", err);
    }
  }, intervalMs);

  console.log(`Background poller started (every ${intervalMs / 1000}s)`);
}

export function stopBackgroundPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Manual poll for a specific PR — called by the refresh/poll endpoints.
 */
export function pollPR(repoLabel: string, prNumber: number, prTitle: string, prUrl: string): { newCount: number } {
  const repos = getRepos();
  const repo = repos.find((r) => r.label === repoLabel);
  if (!repo) return { newCount: 0 };

  const comments = fetchBotComments(repo, prNumber, prTitle, prUrl);
  if (comments.length === 0) return { newCount: 0 };

  return upsertGitHubComments(comments);
}
