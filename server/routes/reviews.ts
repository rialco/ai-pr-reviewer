import { Router } from "express";
import {
  getRepo,
  getLatestReviewPerReviewer,
  getReviewsByPR,
  getReviewCommentsByReviewer,
  getPendingReviewComments,
  getPublishableReviewCommentsByReviewer,
  getAllReviewComments,
  markReviewCommentsPublished,
  getLatestReview,
  updateLocalCommentAnalysis,
  updateLocalCommentStatus,
  updateLocalCommentCategory,
  deleteLocalComment,
  getFixableLocalComments,
  updateLocalCommentFix,
  resetStaleLocalComments,
  recordTimelineEvent,
  updateTimelineEventDebug,
  getPRState,
  upsertPRState,
  getSettings,
} from "../services/db.js";
import { getReviewService } from "../infrastructure/reviewers/registry.js";
import { listOpenPRs, submitPRReview } from "../services/github.js";
import { pollPR } from "../services/poller.js";
import { startJob, updateJobStep, completeJob, failJob } from "../services/jobs.js";
import { formatGitHubCommentBody } from "../infrastructure/reviewers/reviewPrompt.js";
import { fixComments, isFixerAgentAvailable, type FixerAgent } from "../services/fixer.js";
import { RunHistoryTracker } from "../services/runHistory.js";
import {
  analyzeComments,
  getAnalyzerAgentLabel,
  isAnalyzerAgentAvailable,
  type AnalyzerAgent,
  type AnalysisProgressEvent,
} from "../services/analyzer.js";
import type { BotComment, CommentState } from "../types.js";
import type { ReviewProgress, ReviewerId } from "../domain/review/types.js";

const router = Router();

function pickLocalReviewAnalyzer(reviewerId?: ReviewerId): AnalyzerAgent | null {
  const settings = getSettings();
  if (isAnalyzerAgentAvailable(settings.defaultAnalyzerAgent)) {
    return settings.defaultAnalyzerAgent;
  }

  const preferred = reviewerId === "codex" ? "claude" : "codex";
  if (isAnalyzerAgentAvailable(preferred)) return preferred;
  if (reviewerId && (reviewerId === "claude" || reviewerId === "codex") && isAnalyzerAgentAvailable(reviewerId)) {
    return reviewerId;
  }
  if (isAnalyzerAgentAvailable("claude")) return "claude";
  if (isAnalyzerAgentAvailable("codex")) return "codex";
  return null;
}

function mapLocalCommentsToBotComments(
  comments: ReturnType<typeof getPendingReviewComments>,
  pr: { number: number; title: string; url: string },
): BotComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    prNumber: comment.prNumber,
    prTitle: pr.title,
    prUrl: pr.url,
    repo: comment.repo,
    path: comment.path,
    line: comment.line,
    diffHunk: null,
    body: comment.reviewDetails
      ? `${comment.body}

Reviewer metadata:
- Severity: ${comment.reviewDetails.severity ?? "unknown"}
- Confidence: ${comment.reviewDetails.confidence ?? "unknown"}
- Files read: ${comment.reviewDetails.evidence?.filesRead.join(", ") || "none"}
- Changed lines checked: ${comment.reviewDetails.evidence?.changedLinesChecked.join(", ") || "none"}
- Risk summary: ${comment.reviewDetails.evidence?.riskSummary ?? "none"}`
      : comment.body,
    user: comment.reviewerId,
    createdAt: comment.createdAt,
    url: null,
    type: "inline",
  }));
}

async function analyzeLocalReviewComments(options: {
  repoLabel: string;
  prNumber: number;
  pr: { number: number; title: string; url: string };
  repoConfig: NonNullable<ReturnType<typeof getRepo>>;
  reviewerId?: ReviewerId;
  commentIds?: number[];
  analyzerAgent?: AnalyzerAgent;
  onProgress?: (event: AnalysisProgressEvent) => void;
  onDebug?: (debugDetail: Record<string, unknown>) => void;
}): Promise<{ analyzed: number; analyzerAgent: AnalyzerAgent | null }> {
  const pending = getPendingReviewComments(
    options.repoLabel,
    options.prNumber,
    options.reviewerId,
    options.commentIds,
  );

  if (pending.length === 0) {
    return { analyzed: 0, analyzerAgent: null };
  }

  const analyzerAgent = options.analyzerAgent ?? pickLocalReviewAnalyzer(options.reviewerId);
  if (!analyzerAgent) {
    return { analyzed: 0, analyzerAgent: null };
  }

  const analyzerLabel = getAnalyzerAgentLabel(analyzerAgent);
  const analysisRequestedEventId = recordTimelineEvent(
    options.repoLabel,
    options.prNumber,
    "analysis_requested",
    {
      commentCount: pending.length,
      commentIds: pending.map((comment) => comment.id),
      analyzerAgent,
      analyzerName: analyzerLabel,
      source: "local_review_comments",
      reviewerId: options.reviewerId ?? null,
    },
    {
      analyzerAgent,
      analyzerName: analyzerLabel,
      repo: options.repoLabel,
      prNumber: options.prNumber,
      prTitle: options.pr.title,
      commentCount: pending.length,
      commentIds: pending.map((comment) => comment.id),
      reviewerId: options.reviewerId ?? null,
      requestSource: "local_review_comments",
    },
  );
  const timelineHistory = new RunHistoryTracker({
    detail: `${analyzerLabel} triaging ${pending.length} local review comment(s)`,
    onUpdate: (history) => {
      updateTimelineEventDebug(analysisRequestedEventId, { history });
    },
  });
  timelineHistory.publish();

  const previousStatuses = new Map(pending.map((comment) => [comment.id, comment.status]));
  for (const comment of pending) {
    updateLocalCommentStatus(comment.id, "analyzing");
  }

  try {
    const results = await analyzeComments(
      mapLocalCommentsToBotComments(pending, options.pr),
      options.repoConfig,
      analyzerAgent,
      (event) => {
        options.onProgress?.(event);
        if (event.type !== "progress") return;
        if (event.step === "claude_output" || event.step === "codex_output") {
          timelineHistory.output(event.message);
          return;
        }
        timelineHistory.step(event.message, event.detail);
      },
      (debugDetail) => {
        updateTimelineEventDebug(analysisRequestedEventId, debugDetail);
        options.onDebug?.(debugDetail);
      },
    );

    for (const result of results) {
      updateLocalCommentAnalysis(result.commentId, result);
    }

    const categoryCounts: Record<string, number> = {};
    for (const result of results) {
      categoryCounts[result.category] = (categoryCounts[result.category] ?? 0) + 1;
    }

    recordTimelineEvent(options.repoLabel, options.prNumber, "comments_analyzed", {
      count: results.length,
      categories: categoryCounts,
      analyzerAgent,
      analyzerName: analyzerLabel,
      source: "local_review_comments",
      reviewerId: options.reviewerId ?? null,
    });
    timelineHistory.complete(`${analyzerLabel} triaged ${results.length} local review comment(s)`);

    return { analyzed: results.length, analyzerAgent };
  } catch (error) {
    for (const comment of pending) {
      updateLocalCommentStatus(comment.id, previousStatuses.get(comment.id) ?? "new");
    }
    timelineHistory.fail(String(error));
    throw error;
  }
}

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

  const reviewRequestedEventId = recordTimelineEvent(
    repoLabel,
    prNumber,
    "review_requested",
    {
      reviewerId,
      reviewerName: reviewer.displayName,
    },
    {
      reviewerId,
      reviewerName: reviewer.displayName,
      repo: repoLabel,
      prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      source: reviewer.type,
    },
  );

  // Track in the global job system
  const jobId = startJob("review", repoLabel, {
    prNumber,
    reviewerId,
    detail: `${reviewer.displayName} reviewing PR #${prNumber}`,
  });
  const timelineHistory = new RunHistoryTracker({
    detail: `${reviewer.displayName} reviewing PR #${prNumber}`,
    onUpdate: (history) => {
      updateTimelineEventDebug(reviewRequestedEventId, { history });
    },
  });
  timelineHistory.publish();

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
          return;
        } else {
          updateJobStep(jobId, event.message, event.detail);
          timelineHistory.step(event.message, event.detail);
        }
      },
      (debugDetail) => {
        updateTimelineEventDebug(reviewRequestedEventId, debugDetail);
      },
    );

    if (reviewer.type === "local-ai") {
      const analyzerAgent = pickLocalReviewAnalyzer(reviewerId as ReviewerId);

      if (review.comments?.length && analyzerAgent) {
        const analyzerLabel = getAnalyzerAgentLabel(analyzerAgent);
        sendEvent({
          type: "progress",
          step: "triaging_review_comments",
          message: `Triaging ${review.comments.length} local review comment(s) with ${analyzerLabel}...`,
          progress: 92,
          detail: "Filtering out stale, already-addressed, and low-value comments before they become actionable.",
        });
        updateJobStep(jobId, `Triaging ${review.comments.length} local review comment(s)`, analyzerLabel);
        timelineHistory.step(`Triaging ${review.comments.length} local review comment(s)`, analyzerLabel);

        try {
          await analyzeLocalReviewComments({
            repoLabel,
            prNumber,
            pr,
            repoConfig: repo,
            reviewerId: reviewerId as ReviewerId,
            analyzerAgent,
            onProgress: (event) => {
              if (event.type !== "progress") return;
              const scaledProgress = Math.min(99, 92 + Math.round((event.progress / 100) * 7));
              sendEvent({
                ...event,
                step: `local_review_${event.step}`,
                message:
                  event.step === "claude_output" || event.step === "codex_output"
                    ? `[${analyzerLabel}] ${event.message}`
                    : event.message,
                progress: scaledProgress,
              });

              if (event.step === "claude_output" || event.step === "codex_output") {
                return;
              }
              updateJobStep(jobId, event.message, event.detail);
              timelineHistory.step(event.message, event.detail);
            },
            onDebug: (debugDetail) => {
              updateTimelineEventDebug(reviewRequestedEventId, {
                localReviewAnalysis: debugDetail,
              });
            },
          });
        } catch (analysisError) {
          sendEvent({
            type: "progress",
            step: "triaging_failed",
            message: `Automatic triage failed: ${String(analysisError)}`,
            progress: 96,
          });
        }
      } else if (review.comments?.length) {
        sendEvent({
          type: "progress",
          step: "triaging_skipped",
          message: "No analyzer CLI available to triage local review comments automatically.",
          progress: 95,
        });
      }
    }

    const score = review.confidenceScore !== null ? ` — ${review.confidenceScore}/5` : "";
    completeJob(jobId, `${reviewer.displayName} review complete${score}`);
    timelineHistory.complete(`${reviewer.displayName} review complete${score}`);

    recordTimelineEvent(repoLabel, prNumber, "review_completed", {
      reviewerId,
      reviewerName: reviewer.displayName,
      confidenceScore: review.confidenceScore,
      commentCount: review.comments?.length ?? 0,
    });

    sendEvent({ type: "complete", review });
    res.end();
  } catch (err) {
    failJob(jobId, String(err));
    timelineHistory.fail(String(err));

    recordTimelineEvent(repoLabel, prNumber, "review_failed", {
      reviewerId,
      reviewerName: reviewer.displayName,
      error: String(err),
    });

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

    recordTimelineEvent(repoLabel, prNumber, "score_refreshed", {
      reviewerId,
      confidenceScore: review?.confidenceScore ?? null,
    });

    res.json(review);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get local review comments for a PR (all reviewers or specific)
router.get("/:repo/:prNumber/comments", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const reviewerId = req.query.reviewerId as string | undefined;

  if (reviewerId) {
    res.json(getReviewCommentsByReviewer(repoLabel, prNumber, reviewerId as ReviewerId));
  } else {
    res.json(getAllReviewComments(repoLabel, prNumber));
  }
});

// Analyze local review comments before they become actionable
router.post("/:repo/:prNumber/local-comments/analyze", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const { commentIds, analyzerAgent: requestedAnalyzerAgent, reviewerId } = (req.body ?? {}) as {
    commentIds?: number[];
    analyzerAgent?: string;
    reviewerId?: string;
  };
  const analyzerAgent =
    requestedAnalyzerAgent === "codex" || requestedAnalyzerAgent === "claude"
      ? requestedAnalyzerAgent
      : pickLocalReviewAnalyzer(reviewerId as ReviewerId | undefined);

  if (!analyzerAgent) {
    res.status(400).json({ error: "No analyzer CLI is available" });
    return;
  }

  if (!isAnalyzerAgentAvailable(analyzerAgent)) {
    res.status(400).json({ error: `${getAnalyzerAgentLabel(analyzerAgent)} is not available` });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((item) => item.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found or not open" });
    return;
  }

  const pending = getPendingReviewComments(
    repoLabel,
    prNumber,
    reviewerId ? (reviewerId as ReviewerId) : undefined,
    commentIds,
  );

  if (pending.length === 0) {
    res.json({ analyzed: 0, analyzerAgent, results: [] });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });

  const sendEvent = (data: AnalysisProgressEvent | Record<string, unknown>) => {
    res.write(JSON.stringify(data) + "\n");
  };

  try {
    const result = await analyzeLocalReviewComments({
      repoLabel,
      prNumber,
      pr,
      repoConfig: repo,
      reviewerId: reviewerId ? (reviewerId as ReviewerId) : undefined,
      commentIds,
      analyzerAgent,
      onProgress: (event) => {
        sendEvent(event);
      },
    });

    sendEvent({
      type: "complete",
      step: "done",
      message: `Triage complete with ${getAnalyzerAgentLabel(analyzerAgent)}`,
      progress: 100,
      analyzed: result.analyzed,
    });
    res.end();
  } catch (error) {
    sendEvent({ type: "error", message: String(error) });
    res.end();
  }
});

// Publish local review comments to GitHub as a formal PR review
router.post("/:repo/:prNumber/:reviewerId/publish", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const reviewerId = req.params.reviewerId as ReviewerId;

  const comments = getPublishableReviewCommentsByReviewer(repoLabel, prNumber, reviewerId);
  if (comments.length === 0) {
    res.status(400).json({ error: "No local comments to publish" });
    return;
  }

  const review = getLatestReview(repoLabel, prNumber, reviewerId);
  const score = review?.confidenceScore ?? null;
  const summary = review?.summary ?? "";
  const displayName = reviewerId.charAt(0).toUpperCase() + reviewerId.slice(1);

  const event = score !== null && score < 2 ? "REQUEST_CHANGES" as const : "COMMENT" as const;

  try {
    await submitPRReview(repoLabel, prNumber, {
      body: `## ${displayName} Review${score !== null ? ` — Confidence: ${score}/5` : ""}\n\n${summary}`,
      event,
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: formatGitHubCommentBody({ path: c.path, line: c.line, body: c.body, suggestion: c.suggestion ?? undefined }),
      })),
    });

    markReviewCommentsPublished(repoLabel, prNumber, reviewerId);

    recordTimelineEvent(repoLabel, prNumber, "review_published", {
      reviewerId,
      commentCount: comments.length,
      event,
    });

    res.json({ published: comments.length });
  } catch (err) {
    res.status(500).json({ error: `Failed to publish to GitHub: ${err}` });
  }
});

// Dismiss a local review comment
router.post("/:repo/:prNumber/local-comments/:id/dismiss", (req, res) => {
  const id = parseInt(req.params.id, 10);
  updateLocalCommentStatus(id, "dismissed");
  res.json({ ok: true });
});

// Delete a local review comment when it has not been addressed/fixed/published
router.delete("/:repo/:prNumber/local-comments/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = deleteLocalComment(id);
  if (deleted === 0) {
    res.status(400).json({ error: "Only unresolved, unpublished local comments can be deleted" });
    return;
  }
  res.json({ ok: true });
});

// Recategorize a local review comment
router.post("/:repo/:prNumber/local-comments/:id/recategorize", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { category } = (req.body ?? {}) as { category: string };
  if (!category) {
    res.status(400).json({ error: "category required" });
    return;
  }
  updateLocalCommentCategory(id, category);
  res.json({ ok: true });
});

// Fix local review comments (bridges them into the fix pipeline)
router.post("/:repo/:prNumber/local-comments/fix", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const { commentIds, fixerAgent } = (req.body ?? {}) as {
    commentIds?: number[];
    fixerAgent?: FixerAgent;
  };
  const selectedFixer =
    fixerAgent === "codex" || fixerAgent === "claude" ? fixerAgent : getSettings().defaultFixerAgent;

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  if (!isFixerAgentAvailable(selectedFixer)) {
    res.status(400).json({ error: `${selectedFixer} CLI is not available` });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found or not open" });
    return;
  }

  const fixable = getFixableLocalComments(repoLabel, prNumber, commentIds);
  if (fixable.length === 0) {
    res.json({ fixing: 0 });
    return;
  }

  // Convert local review comments to BotComment format for the fixer
  const botComments: BotComment[] = fixable.map((c) => ({
    id: c.id,
    prNumber: c.prNumber,
    prTitle: pr.title,
    prUrl: pr.url,
    repo: c.repo,
    path: c.path,
    line: c.line,
    diffHunk: null,
    body: c.suggestion
      ? `${c.body}\n\nSuggested fix:\n\`\`\`\n${c.suggestion}\n\`\`\``
      : c.body,
    user: c.reviewerId,
    createdAt: c.createdAt,
    url: null,
    type: "inline" as const,
  }));

  const commentStates: CommentState[] = fixable.map((c) => ({
    commentId: c.id,
    repo: c.repo,
    prNumber: c.prNumber,
    status: "analyzed" as const,
    analysis: {
      commentId: c.id,
      category: c.analysisCategory as NonNullable<CommentState["analysis"]>["category"],
      reasoning: c.analysisReasoning ?? c.body,
      verdict: c.analysisDetails?.verdict,
      severity: c.analysisDetails?.severity ?? null,
      confidence: c.analysisDetails?.confidence ?? null,
      accessMode: c.analysisDetails?.accessMode,
      evidence: c.analysisDetails?.evidence ?? null,
    },
    seenAt: c.createdAt,
  }));

  // Mark as fixing
  for (const c of fixable) {
    updateLocalCommentStatus(c.id, "fixing");
  }

  const localFixStartedEventId = recordTimelineEvent(
    repoLabel,
    prNumber,
    "local_fix_started",
    {
      commentCount: fixable.length,
      commentIds: fixable.map((c) => c.id),
      reviewerIds: [...new Set(fixable.map((c) => c.reviewerId))],
      fixerAgent: selectedFixer,
    },
    {
      fixerAgent: selectedFixer,
      repo: repoLabel,
      prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      commentIds: fixable.map((c) => c.id),
      commentCount: fixable.length,
      reviewerIds: [...new Set(fixable.map((c) => c.reviewerId))],
      requestSource: "local_review_comments",
    },
  );

  res.status(202).json({ fixing: fixable.length });

  // Run fix in background
  fixComments({
    fixerAgent: selectedFixer,
    repo,
    branch: pr.headRefName,
    prNumber,
    prTitle: pr.title,
    comments: botComments,
    commentStates,
    onDebug: (debugDetail) => {
      updateTimelineEventDebug(localFixStartedEventId, debugDetail);
    },
    onHistoryUpdate: (history) => {
      updateTimelineEventDebug(localFixStartedEventId, { history });
    },
  })
    .then((results) => {
      if (results.length > 0) {
        const commitHash = results[0].commitHash;
        const filesChanged = results[0].filesChanged;
        for (const c of fixable) {
          updateLocalCommentFix(c.id, commitHash, filesChanged);
        }

        // Update PR state — increment cycle for local fixes too
        const currentPR = getPRState(repoLabel, prNumber);
        const newCycle = (currentPR?.reviewCycle ?? 0) + 1;
        upsertPRState({
          ...currentPR,
          repo: repoLabel,
          prNumber,
          reviewCycle: newCycle,
          confidenceScore: currentPR?.confidenceScore ?? null,
          phase: "fixed",
          lastFixedAt: new Date().toISOString(),
          lastReReviewAt: currentPR?.lastReReviewAt ?? null,
          fixResults: [...(currentPR?.fixResults ?? []), ...results],
        });

        recordTimelineEvent(repoLabel, prNumber, "local_fix_completed", {
          commitHash,
          filesChanged,
          commentCount: fixable.length,
          cycle: newCycle,
          reviewerIds: [...new Set(fixable.map((c) => c.reviewerId))],
          fixerAgent: selectedFixer,
        });
      } else {
        for (const c of fixable) {
          updateLocalCommentStatus(c.id, "analyzed");
        }
        recordTimelineEvent(repoLabel, prNumber, "local_fix_no_changes", {
          commentCount: fixable.length,
          fixerAgent: selectedFixer,
        });
      }
    })
    .catch((err) => {
      console.error("Local comment fix failed:", err);
      for (const c of fixable) {
        updateLocalCommentStatus(c.id, "fix_failed");
      }
      recordTimelineEvent(repoLabel, prNumber, "local_fix_failed", {
        error: String(err),
        commentCount: fixable.length,
        fixerAgent: selectedFixer,
      });
    });
});

// Reset stuck local review comments from "fixing" back to "analyzed"
router.post("/:repo/:prNumber/local-comments/reset", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const count = resetStaleLocalComments(repoLabel, prNumber);
  res.json({ reset: count });
});

export default router;
