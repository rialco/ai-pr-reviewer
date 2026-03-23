import { Router } from "express";
import {
  getRepos,
  getRepo,
  getCommentsByPR,
  getUnanalyzedComments,
  getFixableComments,
  getCommentStatesForFix,
  updateCommentStatus,
  updateCommentAnalysis,
  updateCommentFix,
  reopenComment,
  updateCommentCategory,
  revertCommentFix,
  markCommentReplied,
  getPRState,
  upsertPRState,
  getSettings,
  getFixableCount,
  getSummary,
  updateLastPoll,
  getLatestReviewPerReviewer,
  recordTimelineEvent,
  getTimeline,
  getTimelineEvent,
  updateTimelineEventDebug,
  getCoordinatorPRPreference,
  updateCoordinatorPRPreference,
  syncPRStateMetadata,
} from "../services/db.js";
import {
  listOpenPRs,
  getPROverview,
  replyToReviewComment,
} from "../services/github.js";
import {
  analyzeComments,
  getAnalyzerAgentLabel,
  isAnalyzerAgentAvailable,
  type AnalyzerAgent,
  type AnalysisProgressEvent,
} from "../services/analyzer.js";
import {
  fixAndPostReReview,
  getFixProgress,
  clearFixProgress,
  getFixHistory,
  getWorkDir,
  isFixerAgentAvailable,
  resolveMergeConflict,
  type FixerAgent,
} from "../services/fixer.js";
import { pollPR, syncRepo } from "../services/poller.js";
import {
  startAnalysisJob,
  updateAnalysisStep,
  addAnalysisOutput,
  completeAnalysisJob,
  failAnalysisJob,
  getActivityFeed,
} from "../services/jobs.js";
import { RunHistoryTracker } from "../services/runHistory.js";
import { executeSuggestedNextStep, getSuggestedNextStep } from "../services/workflow.js";

const router = Router();

// List open PRs for all repos
router.get("/", async (_req, res) => {
  const repos = getRepos();
  const results = await Promise.all(repos.map((repo) => listOpenPRs(repo)));
  res.json(results.flat());
});

// Sync a specific repo: list PRs, fetch comments, clean up stale data
router.post("/sync/:repo", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const { prs, newCount, cleaned } = await syncRepo(repo);
  updateLastPoll();
  res.json({ prs: prs.length, newComments: newCount, cleaned });
});

// Get all comments for a specific PR (served from SQLite)
router.get("/:repo/:prNumber/comments", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const comments = getCommentsByPR(repoLabel, prNumber);

  // Map to frontend shape
  const enriched = comments.map((c) => ({
    id: c.id,
    prNumber: c.prNumber,
    prTitle: c.prTitle,
    prUrl: c.prUrl,
    repo: c.repo,
    path: c.path,
    line: c.line,
    diffHunk: c.diffHunk,
    body: c.body,
    user: c.user,
    createdAt: c.createdAt,
    url: c.url,
    type: c.type,
    status: c.status,
    analysis: c.analysis,
    fixResult: c.fixResult,
    repliedAt: c.repliedAt,
    replyBody: c.replyBody,
  }));

  res.json(enriched);
});

// Get overview metadata for a PR
router.get("/:repo/:prNumber/overview", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const overview = await getPROverview(repoLabel, prNumber);
  if (!overview) {
    res.status(404).json({ error: "PR overview not found" });
    return;
  }

  syncPRStateMetadata({
    number: overview.number,
    title: overview.title,
    url: overview.url,
    headRefName: overview.headRefName,
    baseRefName: overview.baseRefName,
    mergeable: overview.mergeable,
    mergeStateStatus: overview.mergeStateStatus,
    author: overview.author,
    repo: repoLabel,
    createdAt: overview.createdAt,
    updatedAt: overview.updatedAt,
  });

  res.json(overview);
});

router.get("/:repo/:prNumber/coordinator-preference", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  res.json(getCoordinatorPRPreference(repoLabel, prNumber));
});

router.patch("/:repo/:prNumber/coordinator-preference", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const ignored = Boolean(req.body?.ignored);

  res.json(updateCoordinatorPRPreference(repoLabel, prNumber, ignored));
});

// Refresh comments for a specific PR from GitHub
router.post("/:repo/:prNumber/refresh", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found or not open" });
    return;
  }
  syncPRStateMetadata(pr);

  const { newCount } = await pollPR(repoLabel, prNumber, pr.title, pr.url);
  if (newCount > 0) {
    recordTimelineEvent(repoLabel, prNumber, "comments_fetched", { newCount, source: "refresh" });
  }
  res.json({ newComments: newCount });
});

// Analyze comments for a PR (streams NDJSON progress events)
router.post("/:repo/:prNumber/analyze", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  // Get unanalyzed comments from DB
  const { commentIds, analyzerAgent: requestedAnalyzerAgent } = (req.body ?? {}) as {
    commentIds?: number[];
    analyzerAgent?: string;
  };
  const settings = getSettings();
  const analyzerAgent: AnalyzerAgent =
    requestedAnalyzerAgent === "codex" || requestedAnalyzerAgent === "claude"
      ? requestedAnalyzerAgent
      : settings.defaultAnalyzerAgent;
  const analyzerLabel = getAnalyzerAgentLabel(analyzerAgent);

  if (!isAnalyzerAgentAvailable(analyzerAgent)) {
    res.status(400).json({ error: `${analyzerLabel} is not available` });
    return;
  }

  let toAnalyze;
  if (commentIds) {
    // Re-analyze specific comments
    const all = getCommentsByPR(repoLabel, prNumber);
    toAnalyze = all
      .filter((c) => commentIds.includes(c.id))
      .map((c) => ({
        id: c.id,
        prNumber: c.prNumber,
        prTitle: c.prTitle,
        prUrl: c.prUrl,
        repo: c.repo,
        path: c.path,
        line: c.line,
        diffHunk: c.diffHunk,
        body: c.body,
        user: c.user,
        createdAt: c.createdAt,
        url: c.url,
        type: c.type,
      }));
  } else {
    toAnalyze = getUnanalyzedComments(repoLabel, prNumber);
  }

  if (toAnalyze.length === 0) {
    res.json({ analyzed: 0, results: [] });
    return;
  }

  // Set up NDJSON streaming
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });

  const sendEvent = (data: AnalysisProgressEvent | Record<string, unknown>) => {
    res.write(JSON.stringify(data) + "\n");
  };

  // Mark as analyzing
  for (const c of toAnalyze) {
    updateCommentStatus(repoLabel, c.id, "analyzing");
  }

  // Track in the global job system
  const jobId = startAnalysisJob(
    repoLabel,
    prNumber,
    toAnalyze.length,
    analyzerAgent,
    `${analyzerLabel} analyzing ${toAnalyze.length} comment(s)`,
  );
  let timelineHistory: RunHistoryTracker | null = null;

  try {
    const analysisRequestedEventId = recordTimelineEvent(
      repoLabel,
      prNumber,
      "analysis_requested",
      {
        commentCount: toAnalyze.length,
        commentIds: toAnalyze.map((c) => c.id),
        analyzerAgent,
        analyzerName: analyzerLabel,
      },
      {
        analyzerAgent,
        analyzerName: analyzerLabel,
        repo: repoLabel,
        prNumber,
        prTitle: toAnalyze[0]?.prTitle ?? "",
        commentCount: toAnalyze.length,
        commentIds: toAnalyze.map((c) => c.id),
      },
    );
    timelineHistory = new RunHistoryTracker({
      detail: `${analyzerLabel} analyzing ${toAnalyze.length} comment(s)`,
      onUpdate: (history) => {
        updateTimelineEventDebug(analysisRequestedEventId, { history });
      },
    });
    timelineHistory.publish();

    const results = await analyzeComments(
      toAnalyze,
      repo,
      analyzerAgent,
      (event) => {
        sendEvent(event);
        // Mirror progress to the server-side job tracker
        if (event.step === "claude_output" || event.step === "codex_output") {
          addAnalysisOutput(jobId, repoLabel, prNumber, event.message);
          timelineHistory?.output(event.message);
        } else {
          updateAnalysisStep(jobId, repoLabel, prNumber, event.message, event.detail);
          timelineHistory?.step(event.message, event.detail);
        }
      },
      (debugDetail) => {
        updateTimelineEventDebug(analysisRequestedEventId, debugDetail);
      },
    );

    // Save results
    for (const r of results) {
      updateCommentAnalysis(repoLabel, r.commentId, r);
    }

    const categoryCounts: Record<string, number> = {};
    for (const r of results) {
      categoryCounts[r.category] = (categoryCounts[r.category] ?? 0) + 1;
    }
    recordTimelineEvent(repoLabel, prNumber, "comments_analyzed", {
      count: results.length,
      categories: categoryCounts,
      analyzerAgent,
      analyzerName: analyzerLabel,
    });

    completeAnalysisJob(jobId);
    timelineHistory?.complete(`${analyzerLabel} analyzed ${results.length} comment(s)`);
    sendEvent({ type: "complete", analyzed: results.length, results });
    res.end();
  } catch (err) {
    // Roll back to 'new' on failure
    for (const c of toAnalyze) {
      updateCommentStatus(repoLabel, c.id, "new");
    }
    failAnalysisJob(jobId, String(err));
    timelineHistory?.fail(String(err));
    sendEvent({ type: "error", message: String(err) });
    res.end();
  }
});

// Dismiss a comment
router.post("/:repo/:prNumber/dismiss/:commentId", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const commentId = parseInt(req.params.commentId, 10);

  updateCommentStatus(repoLabel, commentId, "dismissed");
  res.json({ ok: true });
});

// Reopen a dismissed comment
router.post("/:repo/:prNumber/reopen/:commentId", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const commentId = parseInt(req.params.commentId, 10);

  reopenComment(repoLabel, commentId);
  res.json({ ok: true });
});

// Override a comment's analysis category
router.post("/:repo/:prNumber/recategorize/:commentId", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const commentId = parseInt(req.params.commentId, 10);
  const { category } = req.body as { category: string };

  const valid = [
    "MUST_FIX",
    "SHOULD_FIX",
    "NICE_TO_HAVE",
    "DISMISS",
    "ALREADY_ADDRESSED",
  ];
  if (!valid.includes(category)) {
    res
      .status(400)
      .json({ error: `Invalid category. Must be one of: ${valid.join(", ")}` });
    return;
  }

  updateCommentCategory(repoLabel, commentId, category);
  res.json({ ok: true });
});

// Fix comments for a PR
router.post("/:repo/:prNumber/fix", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found" });
    return;
  }
  syncPRStateMetadata(pr);

  const { commentIds, requestReReview, fixerAgent: requestedFixerAgent } = (req.body ?? {}) as {
    commentIds?: number[];
    requestReReview?: boolean;
    fixerAgent?: FixerAgent;
  };
  const settings = getSettings();
  const fixerAgent = requestedFixerAgent === "codex" || requestedFixerAgent === "claude"
    ? requestedFixerAgent
    : settings.defaultFixerAgent;

  if (!isFixerAgentAvailable(fixerAgent)) {
    res.status(400).json({ error: `${fixerAgent} CLI is not available` });
    return;
  }

  const shouldReReview = requestReReview ?? settings.autoReReview;
  const fixable = getFixableComments(repoLabel, prNumber, commentIds);

  if (fixable.length === 0) {
    res.json({ fixing: 0 });
    return;
  }

  const fixableStates = getCommentStatesForFix(
    repoLabel,
    fixable.map((c) => c.id),
  );

  // Mark as fixing
  for (const c of fixable) {
    updateCommentStatus(repoLabel, c.id, "fixing");
  }

  // Update PR state
  const existingPR = getPRState(repoLabel, prNumber);
  upsertPRState({
    ...existingPR,
    repo: repoLabel,
    prNumber,
    reviewCycle: existingPR?.reviewCycle ?? 0,
    confidenceScore: existingPR?.confidenceScore ?? null,
    phase: "fixing",
    lastFixedAt: existingPR?.lastFixedAt ?? null,
    lastReReviewAt: existingPR?.lastReReviewAt ?? null,
    fixResults: existingPR?.fixResults ?? [],
  });

  const fixStartedEventId = recordTimelineEvent(
    repoLabel,
    prNumber,
    "fix_started",
    {
      commentCount: fixable.length,
      commentIds: fixable.map((c) => c.id),
      fixerAgent,
    },
    {
      fixerAgent,
      repo: repoLabel,
      prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      commentIds: fixable.map((c) => c.id),
      commentCount: fixable.length,
      requestReReview: shouldReReview,
      requestSource: "github_comments",
    },
  );

  // Respond 202 immediately
  res.status(202).json({ fixing: fixable.length });

  // Run fix in background (async — does not block the event loop)
  fixAndPostReReview({
    fixerAgent,
    repo,
    branch: pr.headRefName,
    prNumber,
    prTitle: pr.title,
    comments: fixable,
    commentStates: fixableStates,
    requestReReview: shouldReReview,
    onDebug: (debugDetail) => {
      updateTimelineEventDebug(fixStartedEventId, debugDetail);
    },
    onHistoryUpdate: (history) => {
      updateTimelineEventDebug(fixStartedEventId, { history });
    },
  })
    .then((results) => {
      if (results.length > 0) {
        for (const r of results) {
          updateCommentFix(repoLabel, r.commentId, r);
        }

        const now = new Date().toISOString();
        const currentPR = getPRState(repoLabel, prNumber);
        const newCycle = (currentPR?.reviewCycle ?? 0) + 1;
        upsertPRState({
          ...currentPR,
          repo: repoLabel,
          prNumber,
          reviewCycle: newCycle,
          confidenceScore: currentPR?.confidenceScore ?? null,
          phase: shouldReReview ? "re_review_requested" : "fixed",
          lastFixedAt: now,
          lastReReviewAt: shouldReReview
            ? now
            : (currentPR?.lastReReviewAt ?? null),
          fixResults: [...(currentPR?.fixResults ?? []), ...results],
        });

        recordTimelineEvent(repoLabel, prNumber, "fix_completed", {
          commitHash: results[0].commitHash,
          filesChanged: results[0].filesChanged,
          commentCount: results.length,
          cycle: newCycle,
          fixerAgent,
        });
      } else {
        // No changes — roll back
        for (const c of fixable) {
          updateCommentStatus(repoLabel, c.id, "analyzed");
        }
        const currentPR = getPRState(repoLabel, prNumber);
        if (currentPR) {
          upsertPRState({ ...currentPR, phase: "analyzed" });
        }
        recordTimelineEvent(repoLabel, prNumber, "fix_no_changes", {
          commentCount: fixable.length,
          fixerAgent,
        });
      }
  })
    .catch((err) => {
      console.error("Fix failed:", err);
      for (const c of fixable) {
        updateCommentStatus(repoLabel, c.id, "fix_failed");
      }
      const currentPR = getPRState(repoLabel, prNumber);
      if (currentPR) {
        upsertPRState({ ...currentPR, phase: "analyzed" });
      }
      recordTimelineEvent(repoLabel, prNumber, "fix_failed", {
        error: String(err),
        commentCount: fixable.length,
        fixerAgent,
      });
    });
});

router.post("/:repo/:prNumber/resolve-conflicts", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((candidate) => candidate.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found" });
    return;
  }
  syncPRStateMetadata(pr);

  const { fixerAgent: requestedFixerAgent } = (req.body ?? {}) as {
    fixerAgent?: FixerAgent;
  };
  const settings = getSettings();
  const fixerAgent = requestedFixerAgent === "codex" || requestedFixerAgent === "claude"
    ? requestedFixerAgent
    : settings.defaultFixerAgent;

  if (!isFixerAgentAvailable(fixerAgent)) {
    res.status(400).json({ error: `${fixerAgent} CLI is not available` });
    return;
  }

  const existingPR = getPRState(repoLabel, prNumber);
  const previousPhase = existingPR?.phase ?? "polled";
  upsertPRState({
    repo: repoLabel,
    prNumber,
    reviewCycle: existingPR?.reviewCycle ?? 0,
    confidenceScore: existingPR?.confidenceScore ?? null,
    phase: "fixing",
    lastFixedAt: existingPR?.lastFixedAt ?? null,
    lastReReviewAt: existingPR?.lastReReviewAt ?? null,
    fixResults: existingPR?.fixResults ?? [],
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
  });

  const mergeConflictEventId = recordTimelineEvent(
    repoLabel,
    prNumber,
    "merge_conflict_resolution_started",
    {
      fixerAgent,
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
    },
    {
      fixerAgent,
      repo: repoLabel,
      prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
    },
  );

  res.status(202).json({ resolving: true });

  resolveMergeConflict({
    fixerAgent,
    repo,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    prNumber,
    prTitle: pr.title,
    mergeStateStatus: pr.mergeStateStatus,
    onDebug: (debugDetail) => {
      updateTimelineEventDebug(mergeConflictEventId, debugDetail);
    },
    onHistoryUpdate: (history) => {
      updateTimelineEventDebug(mergeConflictEventId, { history });
    },
  })
    .then((result) => {
      if (!result) {
        const currentPR = getPRState(repoLabel, prNumber);
        if (currentPR) {
          upsertPRState({ ...currentPR, phase: previousPhase });
        }
        recordTimelineEvent(repoLabel, prNumber, "merge_conflict_up_to_date", {
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          fixerAgent,
        });
        return;
      }

      const now = new Date().toISOString();
      const currentPR = getPRState(repoLabel, prNumber);
      const newCycle = (currentPR?.reviewCycle ?? 0) + 1;
      upsertPRState({
        ...currentPR,
        repo: repoLabel,
        prNumber,
        reviewCycle: newCycle,
        confidenceScore: currentPR?.confidenceScore ?? null,
        phase: "fixed",
        lastFixedAt: now,
        lastReReviewAt: currentPR?.lastReReviewAt ?? null,
        fixResults: currentPR?.fixResults ?? [],
        mergeable: currentPR?.mergeable ?? pr.mergeable,
        mergeStateStatus: currentPR?.mergeStateStatus ?? pr.mergeStateStatus,
        headRefName: currentPR?.headRefName ?? pr.headRefName,
        baseRefName: currentPR?.baseRefName ?? pr.baseRefName,
      });

      recordTimelineEvent(repoLabel, prNumber, "merge_conflict_resolved", {
        commitHash: result.commitHash,
        filesChanged: result.filesChanged,
        cycle: newCycle,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        fixerAgent,
      });
    })
    .catch((err) => {
      console.error("Merge conflict resolution failed:", err);
      const currentPR = getPRState(repoLabel, prNumber);
      if (currentPR) {
        upsertPRState({ ...currentPR, phase: previousPhase });
      }
      recordTimelineEvent(repoLabel, prNumber, "merge_conflict_resolution_failed", {
        error: String(err),
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        fixerAgent,
      });
    });
});

// Revert a fix commit and roll back comment states
router.post("/:repo/:prNumber/revert", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const { commitHash } = (req.body ?? {}) as { commitHash: string };

  if (!commitHash) {
    res.status(400).json({ error: "commitHash required" });
    return;
  }

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found" });
    return;
  }

  // Always roll back DB state regardless of git revert success
  const reverted = revertCommentFix(repoLabel, commitHash);
  const prState = getPRState(repoLabel, prNumber);
  if (prState) {
    upsertPRState({
      ...prState,
      phase: "analyzed",
      fixResults: prState.fixResults.filter((r) => r.commitHash !== commitHash),
    });
  }

  // Try to git revert — this may fail (conflicts, etc.) but DB is already rolled back
  let gitReverted = false;
  try {
    const { workDir, cleanup } = await getWorkDir(repo, pr.headRefName);
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      await execAsync(`git revert --no-edit ${commitHash}`, {
        cwd: workDir,
        timeout: 30000,
      });
      await execAsync(`git push origin HEAD:refs/heads/${pr.headRefName}`, {
        cwd: workDir,
        timeout: 60000,
      });
      gitReverted = true;
    } finally {
      await cleanup();
    }
  } catch (err) {
    console.error("Git revert failed (DB already rolled back):", err);
  }

  recordTimelineEvent(repoLabel, prNumber, "fix_reverted", {
    commitHash,
    revertedComments: reverted,
    gitReverted,
  });

  res.json({ ok: true, revertedComments: reverted, gitReverted });
});

// Reply to fixed comments on GitHub
router.post("/:repo/:prNumber/reply", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const { replies } = (req.body ?? {}) as {
    replies: Array<{ commentId: number; body: string }>;
  };

  if (!replies?.length) {
    res.status(400).json({ error: "replies required" });
    return;
  }

  // Post all replies in parallel
  const settled = await Promise.allSettled(
    replies.map(async (r) => {
      await replyToReviewComment(repoLabel, prNumber, r.commentId, r.body);
      markCommentReplied(repoLabel, r.commentId, r.body);
      return r.commentId;
    }),
  );

  const results = settled.map((s, i) => ({
    commentId: replies[i].commentId,
    ok: s.status === "fulfilled",
    ...(s.status === "rejected" ? { error: String(s.reason) } : {}),
  }));

  const successCount = results.filter((r) => r.ok).length;
  if (successCount > 0) {
    recordTimelineEvent(repoLabel, prNumber, "comments_replied", {
      count: successCount,
      commentIds: results.filter((r) => r.ok).map((r) => r.commentId),
    });
  }

  res.json({ results });
});

// Re-review requests are now handled via /api/reviews/:repo/:prNumber/request
// with reviewerId: "greptile" (or "claude", "codex").

// Get PR lifecycle status
router.get("/:repo/:prNumber/status", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((candidate) => candidate.number === prNumber);
  if (pr) {
    syncPRStateMetadata(pr);
  }

  const prState = getPRState(repoLabel, prNumber);
  const fixableCount = getFixableCount(repoLabel, prNumber);
  const nextStep = getSuggestedNextStep(repoLabel, prNumber);

  // Confidence scores now come from the reviews table via /api/reviews endpoints.
  // The old prs.confidence_score column is no longer the source of truth.

  const fixProgress = getFixProgress(repoLabel, prNumber);
  const phase =
    nextStep.action === "merge_ready"
      ? "merge_ready"
      : nextStep.action === "resolve_merge_conflict"
        ? "blocked"
        : (prState?.phase ?? "polled");

  // Clear fix progress once the fix is no longer in progress
  if (fixProgress && phase !== "fixing") {
    // Keep it around briefly so the UI can show the final state
    const allDone = fixProgress.steps.every((s) => s.status !== "active");
    if (allDone) {
      clearFixProgress(repoLabel, prNumber);
    }
  }

  // Build a reviewScores map from the reviews table
  const latestReviews = getLatestReviewPerReviewer(repoLabel, prNumber);
  const reviewScores: Record<string, number | null> = {};
  for (const r of latestReviews) {
    reviewScores[r.reviewerId] = r.confidenceScore;
  }

  res.json({
    phase,
    reviewCycle: prState?.reviewCycle ?? 0,
    reviewScores,
    lastFixedAt: prState?.lastFixedAt ?? null,
    lastReReviewAt: prState?.lastReReviewAt ?? null,
    fixResults: prState?.fixResults ?? [],
    mergeable: prState?.mergeable ?? pr?.mergeable ?? null,
    mergeStateStatus: prState?.mergeStateStatus ?? pr?.mergeStateStatus ?? null,
    headRefName: prState?.headRefName ?? pr?.headRefName ?? null,
    baseRefName: prState?.baseRefName ?? pr?.baseRefName ?? null,
    needsConflictResolution: nextStep.action === "resolve_merge_conflict",
    blockedReason: nextStep.action === "resolve_merge_conflict" ? nextStep.description : null,
    fixableCount,
    fixProgress: fixProgress ?? null,
    fixHistory: getFixHistory(repoLabel, prNumber),
  });
});

// Get PR timeline
router.get("/:repo/:prNumber/timeline", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const limit = parseInt(req.query.limit as string, 10) || 100;

  res.json(getTimeline(repoLabel, prNumber, limit));
});

router.get("/:repo/:prNumber/timeline/:eventId", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const eventId = parseInt(req.params.eventId, 10);

  const event = getTimelineEvent(repoLabel, prNumber, eventId);
  if (!event) {
    res.status(404).json({ error: "Timeline event not found" });
    return;
  }

  res.json(event);
});

router.get("/:repo/:prNumber/next-step", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((candidate) => candidate.number === prNumber);
  if (pr) {
    syncPRStateMetadata(pr);
  }

  res.json(getSuggestedNextStep(repoLabel, prNumber));
});

router.post("/:repo/:prNumber/next-step/execute", async (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = await listOpenPRs(repo);
  const pr = prs.find((candidate) => candidate.number === prNumber);
  if (pr) {
    syncPRStateMetadata(pr);
  }

  const step = await executeSuggestedNextStep(repoLabel, prNumber);
  res.json({ executed: step.canExecute && step.action !== "busy" && step.action !== "idle", step });
});

// Get dashboard summary
router.get("/summary", (_req, res) => {
  res.json(getSummary());
});

// Get all activity: running/recent jobs + scheduled events
router.get("/jobs", (_req, res) => {
  res.json(getActivityFeed());
});

export default router;
