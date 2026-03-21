import { Router } from "express";
import { getRepo, getLatestReviewPerReviewer, getReviewsByPR } from "../services/db.js";
import { getReviewService } from "../infrastructure/reviewers/registry.js";
import { listOpenPRs } from "../services/github.js";
import { pollPR } from "../services/poller.js";
import { startJob, updateJobStep, completeJob, failJob } from "../services/jobs.js";
import type { ReviewProgress } from "../domain/review/types.js";

const router = Router();

// List available reviewers
router.get("/reviewers", (_req, res) => {
  const service = getReviewService();
  res.json(service.getAvailableReviewers());
});

// Get latest review per reviewer for a PR.
// Auto-fetches from remote reviewers (Greptile) if no DB record exists yet.
router.get("/:repo/:prNumber", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  let reviews = getLatestReviewPerReviewer(repoLabel, prNumber);

  // Seed remote reviewers that have no DB record yet
  const service = getReviewService();
  const existingIds = new Set(reviews.map((r) => r.reviewerId));
  const remoteReviewers = service
    .getAvailableReviewers()
    .filter((r) => r.type === "bot" && !existingIds.has(r.id));

  if (remoteReviewers.length > 0) {
    for (const reviewer of remoteReviewers) {
      try {
        const adapter = service.getReviewer(reviewer.id as "greptile" | "claude" | "codex");
        adapter?.fetchLatestReview(repoLabel, prNumber);
      } catch {
        // Non-critical
      }
    }
    // Re-fetch after seeding
    reviews = getLatestReviewPerReviewer(repoLabel, prNumber);
  }

  res.json(reviews);
});

// Get all reviews for a PR (history)
router.get("/:repo/:prNumber/history", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const reviews = getReviewsByPR(repoLabel, prNumber);
  res.json(reviews);
});

// Request a new review (streams NDJSON progress)
router.post("/:repo/:prNumber/request", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const { reviewerId } = (req.body ?? {}) as { reviewerId: string };

  if (!reviewerId) {
    res.status(400).json({ error: "reviewerId required" });
    return;
  }

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const service = getReviewService();
  const reviewer = service.getReviewer(reviewerId as "greptile" | "claude" | "codex");
  if (!reviewer) {
    res.status(400).json({ error: `Unknown reviewer: ${reviewerId}` });
    return;
  }

  if (!reviewer.canRequestReview()) {
    res.status(400).json({ error: `Reviewer ${reviewerId} is not available` });
    return;
  }

  // Find the PR to get branch info
  const prs = await listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found or not open" });
    return;
  }

  // Track in the global job system
  const jobId = startJob("review", repoLabel, {
    prNumber,
    reviewerId,
    detail: `${reviewer.displayName} reviewing PR #${prNumber}`,
  });

  // Set up NDJSON streaming
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });

  const sendEvent = (data: ReviewProgress | Record<string, unknown>) => {
    res.write(JSON.stringify(data) + "\n");
  };

  try {
    const review = await reviewer.requestReview(
      {
        repo: repoLabel,
        prNumber,
        prTitle: pr.title,
        branch: pr.headRefName,
        localPath: repo.localPath,
      },
      (event) => {
        sendEvent(event);
        // Mirror to job tracker
        if (event.step === "claude_output" || event.step === "codex_output") {
          // skip verbose output for job tracker
        } else {
          updateJobStep(jobId, event.message, event.detail);
        }
      },
    );

    const score = review.confidenceScore !== null ? ` — ${review.confidenceScore}/5` : "";
    completeJob(jobId, `${reviewer.displayName} review complete${score}`);
    sendEvent({ type: "complete", review });
    res.end();
  } catch (err) {
    failJob(jobId, String(err));
    sendEvent({ type: "error", message: String(err) });
    res.end();
  }
});

// Fetch latest review from a specific reviewer (refreshes from source).
// For remote reviewers (Greptile), this first re-fetches comments from GitHub
// so we pick up any updated score in the same comment.
router.post("/:repo/:prNumber/fetch/:reviewerId", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const reviewerId = req.params.reviewerId;

  const service = getReviewService();
  const reviewer = service.getReviewer(reviewerId as "greptile" | "claude" | "codex");
  if (!reviewer) {
    res.status(400).json({ error: `Unknown reviewer: ${reviewerId}` });
    return;
  }

  try {
    // For remote reviewers, refresh comments from GitHub first
    // so we get the updated body (Greptile updates the same review in-place)
    if (reviewer.type === "bot") {
      const repo = getRepo(repoLabel);
      if (repo) {
        const prs = await listOpenPRs(repo);
        const pr = prs.find((p) => p.number === prNumber);
        if (pr) {
          await pollPR(repoLabel, prNumber, pr.title, pr.url);
        }
      }
    }

    const review = await reviewer.fetchLatestReview(repoLabel, prNumber);
    res.json(review);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
