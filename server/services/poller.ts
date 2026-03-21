import { getRepos, upsertGitHubComments, updateLastPoll, cleanupClosedPRComments } from "./db.js";
import { listOpenPRs, fetchBotComments } from "./github.js";
import type { RepoConfig, PRInfo } from "../types.js";
import { getReviewService } from "../infrastructure/reviewers/registry.js";
import { startJob, updateJobStep, completeJob, failJob, registerScheduledEvent, markScheduledEventRan } from "./jobs.js";

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function pollAllRepos(): Promise<void> {
  markScheduledEventRan("background-poll");

  const repos = getRepos();

  // Poll all repos in parallel
  const results = await Promise.allSettled(
    repos.map((repo) => syncRepo(repo)),
  );

  let totalNew = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      totalNew += result.value.newCount;
    }
    // Failures are logged inside syncRepo via failJob
  }

  updateLastPoll();
  if (totalNew > 0) {
    console.log(`Background poll: found ${totalNew} new comment(s)`);
  }
}

/**
 * Sync a single repo: list open PRs, fetch bot comments, extract review scores, clean up stale data.
 */
export async function syncRepo(repo: RepoConfig): Promise<{ prs: PRInfo[]; newCount: number; cleaned: number }> {
  const jobId = startJob("sync", repo.label, { detail: `Syncing ${repo.label}` });

  try {
    updateJobStep(jobId, `Listing open PRs for ${repo.label}`);
    const prs = await listOpenPRs(repo);
    let newCount = 0;

    // Fetch comments for all PRs in parallel
    updateJobStep(jobId, `Fetching comments for ${prs.length} PR(s)`);
    const commentResults = await Promise.allSettled(
      prs.map((pr) => fetchBotComments(repo, pr.number, pr.title, pr.url)),
    );

    for (const result of commentResults) {
      if (result.status === "fulfilled" && result.value.length > 0) {
        const upsertResult = upsertGitHubComments(result.value);
        newCount += upsertResult.newCount;
      }
    }

    // Extract Greptile scores from the comments we just fetched
    updateJobStep(jobId, "Extracting review scores");
    syncReviewScoresFromComments(repo.label, prs);

    // Clean up comments from PRs that are no longer open
    const openPRNumbers = prs.map((pr) => pr.number);
    const cleaned = cleanupClosedPRComments(repo.label, openPRNumbers);

    const summary = `${prs.length} PR(s), ${newCount} new comment(s)${cleaned > 0 ? `, ${cleaned} cleaned` : ""}`;
    completeJob(jobId, summary);

    return { prs, newCount, cleaned };
  } catch (err) {
    failJob(jobId, String(err));
    throw err;
  }
}

function syncReviewScoresFromComments(repoLabel: string, prs: PRInfo[]): void {
  const service = getReviewService();
  const greptile = service.getReviewer("greptile");
  if (!greptile) return;

  for (const pr of prs) {
    try {
      greptile.fetchLatestReview(repoLabel, pr.number);
    } catch {
      // Non-critical
    }
  }
}

export function startBackgroundPoller(intervalMs = 5 * 60 * 1000): void {
  // Register in the scheduler so it shows in the activity feed
  registerScheduledEvent(
    "background-poll",
    "poll",
    "Sync all repos (PRs, comments, scores)",
    intervalMs,
  );

  pollAllRepos().catch((err) => {
    console.error("Initial poll failed:", err);
  });

  pollInterval = setInterval(() => {
    pollAllRepos().catch((err) => {
      console.error("Background poll error:", err);
    });
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
export async function pollPR(repoLabel: string, prNumber: number, prTitle: string, prUrl: string): Promise<{ newCount: number }> {
  const jobId = startJob("refresh", repoLabel, {
    prNumber,
    detail: `Refreshing PR #${prNumber}`,
  });

  try {
    const repos = getRepos();
    const repo = repos.find((r) => r.label === repoLabel);
    if (!repo) {
      completeJob(jobId, "Repo not found");
      return { newCount: 0 };
    }

    updateJobStep(jobId, "Fetching comments from GitHub");
    const comments = await fetchBotComments(repo, prNumber, prTitle, prUrl);
    if (comments.length === 0) {
      completeJob(jobId, "No comments found");
      return { newCount: 0 };
    }

    const result = upsertGitHubComments(comments);

    // Extract Greptile score from the comments we just fetched
    updateJobStep(jobId, "Extracting review scores");
    try {
      const service = getReviewService();
      const greptile = service.getReviewer("greptile");
      greptile?.fetchLatestReview(repoLabel, prNumber);
    } catch {
      // Non-critical
    }

    completeJob(jobId, `${comments.length} comment(s), ${result.newCount} new`);
    return result;
  } catch (err) {
    failJob(jobId, String(err));
    throw err;
  }
}
