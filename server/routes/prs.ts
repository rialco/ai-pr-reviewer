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
} from "../services/db.js";
import {
  listOpenPRs,
  fetchConfidenceScore,
  replyToReviewComment,
  postPRComment,
} from "../services/github.js";
import {
  analyzeComments,
  type AnalysisProgressEvent,
} from "../services/analyzer.js";
import {
  fixAndPostReReview,
  getFixProgress,
  clearFixProgress,
  getFixHistory,
  getWorkDir,
} from "../services/fixer.js";
import { pollPR, syncRepo } from "../services/poller.js";
import {
  startAnalysisJob,
  updateAnalysisStep,
  addAnalysisOutput,
  completeAnalysisJob,
  failAnalysisJob,
  getAllJobs,
} from "../services/jobs.js";

const router = Router();

// List open PRs for all repos
router.get("/", (_req, res) => {
  const repos = getRepos();
  const allPRs = repos.flatMap((repo) => listOpenPRs(repo));
  res.json(allPRs);
});

// Sync a specific repo: list PRs, fetch comments, clean up stale data
router.post("/sync/:repo", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const { prs, newCount, cleaned } = syncRepo(repo);
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

// Refresh comments for a specific PR from GitHub
router.post("/:repo/:prNumber/refresh", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found or not open" });
    return;
  }

  const { newCount } = pollPR(repoLabel, prNumber, pr.title, pr.url);
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
  const { commentIds } = (req.body ?? {}) as { commentIds?: number[] };
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
  startAnalysisJob(repoLabel, prNumber, toAnalyze.length);

  try {
    const results = await analyzeComments(toAnalyze, repo, (event) => {
      sendEvent(event);
      // Mirror progress to the server-side job tracker
      if (event.step === "claude_output") {
        addAnalysisOutput(repoLabel, prNumber, event.message);
      } else {
        updateAnalysisStep(repoLabel, prNumber, event.message, event.detail);
      }
    });

    // Save results
    for (const r of results) {
      updateCommentAnalysis(repoLabel, r.commentId, r);
    }

    completeAnalysisJob(repoLabel, prNumber);
    sendEvent({ type: "complete", analyzed: results.length, results });
    res.end();
  } catch (err) {
    // Roll back to 'new' on failure
    for (const c of toAnalyze) {
      updateCommentStatus(repoLabel, c.id, "new");
    }
    failAnalysisJob(repoLabel, prNumber, String(err));
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
router.post("/:repo/:prNumber/fix", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  const prs = listOpenPRs(repo);
  const pr = prs.find((p) => p.number === prNumber);
  if (!pr) {
    res.status(404).json({ error: "PR not found" });
    return;
  }

  const { commentIds, requestReReview } = (req.body ?? {}) as {
    commentIds?: number[];
    requestReReview?: boolean;
  };

  const settings = getSettings();
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
    repo: repoLabel,
    prNumber,
    reviewCycle: existingPR?.reviewCycle ?? 0,
    confidenceScore: existingPR?.confidenceScore ?? null,
    phase: "fixing",
    lastFixedAt: existingPR?.lastFixedAt ?? null,
    lastReReviewAt: existingPR?.lastReReviewAt ?? null,
    fixResults: existingPR?.fixResults ?? [],
  });

  // Respond 202 immediately
  res.status(202).json({ fixing: fixable.length });

  // Run fix in background (async — does not block the event loop)
  fixAndPostReReview({
    repo,
    branch: pr.headRefName,
    prNumber,
    prTitle: pr.title,
    comments: fixable,
    commentStates: fixableStates,
    requestReReview: shouldReReview,
  })
    .then((results) => {
      if (results.length > 0) {
        for (const r of results) {
          updateCommentFix(repoLabel, r.commentId, r);
        }

        const now = new Date().toISOString();
        const currentPR = getPRState(repoLabel, prNumber);
        upsertPRState({
          repo: repoLabel,
          prNumber,
          reviewCycle: (currentPR?.reviewCycle ?? 0) + 1,
          confidenceScore: currentPR?.confidenceScore ?? null,
          phase: shouldReReview ? "re_review_requested" : "fixed",
          lastFixedAt: now,
          lastReReviewAt: shouldReReview
            ? now
            : (currentPR?.lastReReviewAt ?? null),
          fixResults: [...(currentPR?.fixResults ?? []), ...results],
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

  const prs = listOpenPRs(repo);
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

  res.json({ ok: true, revertedComments: reverted, gitReverted });
});

// Reply to fixed comments on GitHub
router.post("/:repo/:prNumber/reply", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);
  const { replies } = (req.body ?? {}) as {
    replies: Array<{ commentId: number; body: string }>;
  };

  if (!replies?.length) {
    res.status(400).json({ error: "replies required" });
    return;
  }

  const results: Array<{ commentId: number; ok: boolean; error?: string }> = [];

  for (const r of replies) {
    try {
      replyToReviewComment(repoLabel, prNumber, r.commentId, r.body);
      markCommentReplied(repoLabel, r.commentId, r.body);
      results.push({ commentId: r.commentId, ok: true });
    } catch (err) {
      results.push({ commentId: r.commentId, ok: false, error: String(err) });
    }
  }

  res.json({ results });
});

// Request re-review from Greptile
router.post("/:repo/:prNumber/re-review", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const repo = getRepo(repoLabel);
  if (!repo) {
    res.status(404).json({ error: "Repo not configured" });
    return;
  }

  try {
    // Build summary from fixed comments — only include those fixed since the last re-review
    const comments = getCommentsByPR(repoLabel, prNumber);
    const prState = getPRState(repoLabel, prNumber);
    const lastReReviewAt = prState?.lastReReviewAt ?? null;

    const fixedComments = comments.filter((c) => {
      if (c.status !== "fixed" || !c.fixResult) return false;
      // Only include comments fixed after the last re-review
      if (lastReReviewAt && c.fixResult.fixedAt <= lastReReviewAt) return false;
      return true;
    });

    const allFixResults = prState?.fixResults ?? [];
    const fixResults = lastReReviewAt
      ? allFixResults.filter((r) => r.fixedAt > lastReReviewAt)
      : allFixResults;

    let body: string;
    if (fixedComments.length > 0) {
      const commitHashes = [...new Set(fixResults.map((r) => r.commitHash))];
      const allFiles = [...new Set(fixResults.flatMap((r) => r.filesChanged))];

      const addressedList = fixedComments.map((c) => {
        const category = c.analysis?.category ?? "SHOULD_FIX";
        const file = c.path ? `\`${c.path}\`` : "general";
        const bodyText = c.body
          .replace(/<[^>]*>/g, "")
          .trim()
          .split("\n")[0]
          .slice(0, 100);
        return `- **[${category}]** ${file}: ${bodyText}`;
      });

      body = `@greptileai Please re-review this PR.

## Summary of Fixes

${fixedComments.length} review comment${fixedComments.length !== 1 ? "s" : ""} addressed in ${commitHashes.length} commit${commitHashes.length !== 1 ? "s" : ""} (${commitHashes.join(", ")}).

### Addressed Comments
${addressedList.join("\n")}

### Modified Files
${allFiles.map((f) => `- \`${f}\``).join("\n")}

Please include an updated **Confidence: X/5** score in your review.`;
    } else {
      body =
        "@greptileai Please re-review this PR.\n\nPlease include an updated **Confidence: X/5** score in your review.";
    }

    postPRComment(repoLabel, prNumber, body);

    const now = new Date().toISOString();
    if (prState) {
      upsertPRState({
        ...prState,
        phase: "re_review_requested",
        lastReReviewAt: now,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get PR lifecycle status
router.get("/:repo/:prNumber/status", (req, res) => {
  const repoLabel = decodeURIComponent(req.params.repo);
  const prNumber = parseInt(req.params.prNumber, 10);

  const prState = getPRState(repoLabel, prNumber);
  const fixableCount = getFixableCount(repoLabel, prNumber);

  // Fetch live confidence score
  const confidenceScore = fetchConfidenceScore(repoLabel, prNumber);

  // Update stored confidence if we got a fresh one
  if (prState && confidenceScore !== null) {
    upsertPRState({ ...prState, confidenceScore });
  }

  const fixProgress = getFixProgress(repoLabel, prNumber);
  const phase = prState?.phase ?? "polled";

  // Clear fix progress once the fix is no longer in progress
  if (fixProgress && phase !== "fixing") {
    // Keep it around briefly so the UI can show the final state
    const allDone = fixProgress.steps.every((s) => s.status !== "active");
    if (allDone) {
      clearFixProgress(repoLabel, prNumber);
    }
  }

  res.json({
    phase,
    reviewCycle: prState?.reviewCycle ?? 0,
    confidenceScore: confidenceScore ?? prState?.confidenceScore ?? null,
    lastFixedAt: prState?.lastFixedAt ?? null,
    lastReReviewAt: prState?.lastReReviewAt ?? null,
    fixResults: prState?.fixResults ?? [],
    fixableCount,
    fixProgress: fixProgress ?? null,
    fixHistory: getFixHistory(repoLabel, prNumber),
  });
});

// Get dashboard summary
router.get("/summary", (_req, res) => {
  res.json(getSummary());
});

// Get all active/recent jobs across all PRs
router.get("/jobs", (_req, res) => {
  res.json(getAllJobs());
});

export default router;
