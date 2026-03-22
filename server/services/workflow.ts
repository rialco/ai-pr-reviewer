import {
  getCommentsByPR,
  getAllReviewComments,
  getLatestReviewPerReviewer,
  getTimeline,
  getRepos,
  getSettings,
  getCoordinatorPRPreference,
} from "./db.js";
import { getAllJobs, markScheduledEventRan, registerScheduledEvent, startJob, updateJobStep, completeJob, failJob } from "./jobs.js";
import { listOpenPRs } from "./github.js";
import { getReviewService } from "../infrastructure/reviewers/registry.js";
import { isAnalyzerAgentAvailable, type AnalyzerAgent } from "./analyzer.js";
import { isFixerAgentAvailable } from "./fixer.js";
import type { Review } from "../domain/review/types.js";
import type { AppSettings } from "../types.js";

export type WorkflowAction =
  | "ignored"
  | "busy"
  | "merge_ready"
  | "analyze_github"
  | "analyze_local"
  | "fix_github"
  | "fix_local"
  | "publish_review"
  | "reply_comments"
  | "request_review"
  | "idle";

export interface WorkflowSuggestion {
  action: WorkflowAction;
  title: string;
  description: string;
  tone: "warning" | "info" | "success" | "neutral";
  canExecute: boolean;
  reviewerId?: string;
  reviewerIds?: string[];
  agent?: AnalyzerAgent;
  blockingJobId?: string;
}

const COORDINATOR_SCHEDULE_ID = "workflow-coordinator";
const INTERNAL_API_BASE = process.env.PR_REVIEWER_INTERNAL_BASE_URL ?? "http://127.0.0.1:3847";
const REVIEW_CHANGE_EVENT_TYPES = new Set([
  "fix_completed",
  "local_fix_completed",
  "fix_reverted",
  "comments_replied",
  "review_published",
  "comments_fetched",
]);

let coordinatorInterval: ReturnType<typeof setInterval> | null = null;

function getBlockingJob(repo: string, prNumber: number) {
  return getAllJobs().find(
    (job) =>
      job.status === "running" &&
      job.type !== "coordinator" &&
      job.repo === repo &&
      (job.prNumber == null || job.prNumber === prNumber),
  );
}

function pickAvailableAnalyzer(preferred: AnalyzerAgent): AnalyzerAgent | null {
  if (preferred === "codex" && isAnalyzerAgentAvailable("codex")) {
    return "codex";
  }
  if (preferred === "claude" && isAnalyzerAgentAvailable("claude")) {
    return "claude";
  }
  if (isAnalyzerAgentAvailable("claude")) return "claude";
  if (isAnalyzerAgentAvailable("codex")) return "codex";
  return null;
}

function pickAvailableFixer(preferred: AnalyzerAgent): AnalyzerAgent | null {
  if (preferred === "codex" && isFixerAgentAvailable("codex")) {
    return "codex";
  }
  if (preferred === "claude" && isFixerAgentAvailable("claude")) {
    return "claude";
  }
  if (isFixerAgentAvailable("claude")) return "claude";
  if (isFixerAgentAvailable("codex")) return "codex";
  return null;
}

function reviewerDisplayName(reviewerId: string, availableReviewers: Array<{ id: string; displayName: string }>): string {
  return availableReviewers.find((reviewer) => reviewer.id === reviewerId)?.displayName ?? reviewerId;
}

function reviewerDisplayList(
  reviewerIds: string[],
  availableReviewers: Array<{ id: string; displayName: string }>,
): string {
  const names = reviewerIds.map((reviewerId) => reviewerDisplayName(reviewerId, availableReviewers));
  if (names.length <= 1) return names[0] ?? "selected reviewers";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function pickPreferredReviewers(
  settings: AppSettings,
  availableReviewers: Array<{ id: string; displayName: string; type: "bot" | "local-ai"; available: boolean }>,
) {
  const availableLocalReviewers = availableReviewers.filter((reviewer) => reviewer.type === "local-ai");
  const availableBotReviewers = availableReviewers.filter((reviewer) => reviewer.type === "bot");
  const selectedAvailable = settings.defaultReviewerIds
    .map((reviewerId) => availableReviewers.find((reviewer) => reviewer.id === reviewerId))
    .filter((reviewer): reviewer is (typeof availableReviewers)[number] => Boolean(reviewer?.available));
  const selectedLocalReviewers = selectedAvailable.filter((reviewer) => reviewer.type === "local-ai");
  const selectedBotReviewers = selectedAvailable.filter((reviewer) => reviewer.type === "bot");

  return (
    selectedLocalReviewers.length > 0
      ? selectedLocalReviewers
      : availableLocalReviewers.length > 0
        ? availableLocalReviewers
        : selectedBotReviewers.length > 0
          ? selectedBotReviewers
          : availableBotReviewers
  ).filter((reviewer) => reviewer.available);
}

function getLowestScoredReview(reviews: Review[]): (Review & { confidenceScore: number }) | null {
  return reviews
    .filter((review): review is Review & { confidenceScore: number } => review.confidenceScore !== null)
    .reduce<(Review & { confidenceScore: number }) | null>(
      (lowest, review) => (!lowest || review.confidenceScore < lowest.confidenceScore ? review : lowest),
      null,
    );
}

function selectDecisionReviews(
  reviews: Review[],
  preferredReviewerIds: string[],
): Review[] {
  if (preferredReviewerIds.length === 0) return reviews;

  const preferredSet = new Set(preferredReviewerIds);
  const preferredReviews = reviews.filter((review) => preferredSet.has(review.reviewerId));
  return preferredReviews.length > 0 ? preferredReviews : [];
}

export function getSuggestedNextStep(
  repo: string,
  prNumber: number,
): WorkflowSuggestion {
  const settings = getSettings();
  const coordinatorPreference = getCoordinatorPRPreference(repo, prNumber);

  if (coordinatorPreference.ignored) {
    return {
      action: "ignored",
      title: "Ignored by coordinator",
      description: "This PR is excluded from the coordinator checklist until you re-enable it.",
      tone: "neutral",
      canExecute: false,
    };
  }

  const blockingJob = getBlockingJob(repo, prNumber);
  if (blockingJob) {
    return {
      action: "busy",
      title: "Work already in progress",
      description: blockingJob.detail ?? blockingJob.currentStep ?? "Another job is already running on this PR.",
      tone: "neutral",
      canExecute: false,
      blockingJobId: blockingJob.id,
    };
  }

  const analyzerAgent = pickAvailableAnalyzer(settings.defaultAnalyzerAgent);
  const fixerAgent = pickAvailableFixer(settings.defaultFixerAgent);
  const githubComments = getCommentsByPR(repo, prNumber);
  const localComments = getAllReviewComments(repo, prNumber);
  const reviews = getLatestReviewPerReviewer(repo, prNumber);
  const timeline = getTimeline(repo, prNumber, 100);
  const availableReviewers = getReviewService().getAvailableReviewers().filter((reviewer) => reviewer.available);
  const preferredReviewers = pickPreferredReviewers(settings, availableReviewers);
  const preferredReviewerIds = preferredReviewers.map((reviewer) => reviewer.id);
  const decisionReviews = selectDecisionReviews(reviews, preferredReviewerIds);

  const unanalyzed = githubComments.filter((comment) => comment.status === "new" || (!comment.analysis && comment.status !== "dismissed"));
  const analyzedNotActioned = githubComments.filter(
    (comment) => comment.analysis && !["fixed", "fixing", "fix_failed", "dismissed"].includes(comment.status),
  );
  const mustFix = analyzedNotActioned.filter((comment) => comment.analysis?.category === "MUST_FIX");
  const shouldFix = analyzedNotActioned.filter((comment) => comment.analysis?.category === "SHOULD_FIX");
  const fixFailedComments = githubComments.filter((comment) => comment.status === "fix_failed");
  const fixedComments = githubComments.filter((comment) => comment.status === "fixed");

  const localPending = localComments.filter((comment) => comment.status === "new" || comment.status === "analyzing");
  const localAnalyzed = localComments.filter((comment) => comment.status === "analyzed" && !comment.supersededAt);
  const localMustFix = localAnalyzed.filter((comment) => comment.analysisCategory === "MUST_FIX");
  const localShouldFix = localAnalyzed.filter((comment) => comment.analysisCategory === "SHOULD_FIX");
  const localFixFailed = localComments.filter((comment) => comment.status === "fix_failed");
  const publishable = localComments.filter(
    (comment) =>
      !comment.publishedAt &&
      comment.status === "analyzed" &&
      !comment.supersededAt &&
      !["DISMISS", "ALREADY_ADDRESSED"].includes(comment.analysisCategory),
  );

  const unrepliedFixed = fixedComments.filter((comment) => comment.type === "inline" && !comment.repliedAt && comment.fixResult);
  const blockingGithubFixFailed = fixFailedComments.filter((comment) => comment.analysis?.category !== "SHOULD_FIX");
  const blockingLocalFixFailed = localFixFailed.filter((comment) => comment.analysisCategory !== "SHOULD_FIX");
  const unresolvedMustCount = mustFix.length + localMustFix.length + blockingGithubFixFailed.length + blockingLocalFixFailed.length;
  const unresolvedGithubCount = mustFix.length + shouldFix.length + fixFailedComments.length;
  const unresolvedLocalCount = localMustFix.length + localShouldFix.length + localFixFailed.length;
  const unresolvedTotal = unresolvedGithubCount + unresolvedLocalCount;
  const lowestScoredReview = getLowestScoredReview(decisionReviews);
  const mergeReadyScore = lowestScoredReview !== null && lowestScoredReview.confidenceScore >= 4;
  const scoreNeedsAttention =
    lowestScoredReview !== null &&
    (lowestScoredReview.confidenceScore <= 2 ||
      (lowestScoredReview.confidenceScore <= 3 &&
        (unresolvedTotal > 0 || localComments.length + githubComments.length >= 6)));
  const reviewChangedSinceLastScore =
    lowestScoredReview !== null &&
    timeline.some(
      (event) =>
        REVIEW_CHANGE_EVENT_TYPES.has(event.eventType) &&
        new Date(event.createdAt).getTime() > new Date(lowestScoredReview.createdAt).getTime(),
    );

  if (unanalyzed.length > 0) {
    return {
      action: "analyze_github",
      title: `Analyze ${unanalyzed.length} untriaged GitHub comment${unanalyzed.length === 1 ? "" : "s"}`,
      description: "Classify the new review comments before deciding what to fix.",
      tone: "info",
      canExecute: analyzerAgent !== null,
      agent: analyzerAgent ?? settings.defaultAnalyzerAgent,
    };
  }

  if (localPending.length > 0) {
    return {
      action: "analyze_local",
      title: `Triage ${localPending.length} local review comment${localPending.length === 1 ? "" : "s"}`,
      description: "Filter local reviewer comments before they become actionable work.",
      tone: "info",
      canExecute: analyzerAgent !== null,
      agent: analyzerAgent ?? settings.defaultAnalyzerAgent,
    };
  }

  if (mergeReadyScore && unresolvedMustCount === 0) {
    const deferredShouldFixCount = unresolvedTotal - unresolvedMustCount;
    const deferredPublishableCount = publishable.length;
    const deferredReplyCount = unrepliedFixed.length;
    const deferredWorkCount = deferredShouldFixCount + deferredPublishableCount + deferredReplyCount;
    const baseDescription =
      deferredWorkCount > 0
        ? `Latest score is ${lowestScoredReview.confidenceScore}/5 and only non-blocking follow-up remains. The coordinator will pause on SHOULD_FIX work unless a new MUST_FIX appears.`
        : `Latest score is ${lowestScoredReview.confidenceScore}/5 and there are no blocking follow-ups. The coordinator will resume only if new MUST_FIX work appears.`;

    return {
      action: "merge_ready",
      title: "Merge-ready threshold reached",
      description: baseDescription,
      tone: "success",
      canExecute: false,
    };
  }

  if (unresolvedGithubCount > 0) {
    return {
      action: "fix_github",
      title: `Address ${unresolvedGithubCount} actionable GitHub issue${unresolvedGithubCount === 1 ? "" : "s"}`,
      description: "Fix the actionable GitHub comments before asking for another review.",
      tone: "warning",
      canExecute: fixerAgent !== null,
      agent: fixerAgent ?? settings.defaultFixerAgent,
    };
  }

  if (unresolvedLocalCount > 0) {
    return {
      action: "fix_local",
      title: `Address ${unresolvedLocalCount} actionable local issue${unresolvedLocalCount === 1 ? "" : "s"}`,
      description: "The local reviewer comments are already triaged and ready to be fixed.",
      tone: "warning",
      canExecute: fixerAgent !== null,
      agent: fixerAgent ?? settings.defaultFixerAgent,
    };
  }

  if (publishable.length > 0) {
    const reviewerIds = [...new Set(publishable.map((comment) => comment.reviewerId))];
    return {
      action: "publish_review",
      title: `Publish ${publishable.length} local review comment${publishable.length === 1 ? "" : "s"}`,
      description: "Push the local review comments to GitHub so the feedback loop stays visible.",
      tone: "info",
      canExecute: reviewerIds.length > 0,
      reviewerIds,
    };
  }

  if (unrepliedFixed.length > 0) {
    return {
      action: "reply_comments",
      title: `Reply to ${unrepliedFixed.length} fixed inline comment${unrepliedFixed.length === 1 ? "" : "s"}`,
      description: "Post the fix commit references back on GitHub to close the loop with reviewers.",
      tone: "info",
      canExecute: true,
    };
  }

  if (scoreNeedsAttention && preferredReviewerIds.length > 0 && reviewChangedSinceLastScore) {
    return {
      action: "request_review",
      title: `Request fresh score${preferredReviewerIds.length === 1 ? "" : "s"} from ${reviewerDisplayList(preferredReviewerIds, availableReviewers)}`,
      description: `The latest score is ${lowestScoredReview?.confidenceScore}/5 and the PR changed after that review.`,
      tone: "warning",
      canExecute: true,
      reviewerId: preferredReviewerIds[0],
      reviewerIds: preferredReviewerIds,
    };
  }

  if (!decisionReviews.length && preferredReviewerIds.length > 0) {
    return {
      action: "request_review",
      title: `Request review${preferredReviewerIds.length === 1 ? "" : "s"} from ${reviewerDisplayList(preferredReviewerIds, availableReviewers)}`,
      description: "There is no score yet from the reviewers driving this PR's merge-ready decision.",
      tone: "info",
      canExecute: true,
      reviewerId: preferredReviewerIds[0],
      reviewerIds: preferredReviewerIds,
    };
  }

  return {
    action: "idle",
    title: "No urgent next step",
    description: "Everything actionable looks handled for now.",
    tone: "neutral",
    canExecute: false,
  };
}

async function callInternalApi(
  path: string,
  init?: RequestInit,
  options?: { waitForCompletion?: boolean },
): Promise<void> {
  const response = await fetch(`${INTERNAL_API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }

  if (options?.waitForCompletion === false) {
    void response.body?.cancel().catch(() => {});
    return;
  }

  await response.text();
}

export async function executeSuggestedNextStep(
  repo: string,
  prNumber: number,
  suggestion?: WorkflowSuggestion,
  options?: { waitForCompletion?: boolean },
): Promise<WorkflowSuggestion> {
  const settings = getSettings();
  const step = suggestion ?? getSuggestedNextStep(repo, prNumber);
  if (!step.canExecute) return step;

  const encodedRepo = encodeURIComponent(repo);
  const waitForCompletion = options?.waitForCompletion ?? true;

  switch (step.action) {
    case "analyze_github":
      await callInternalApi(`/api/prs/${encodedRepo}/${prNumber}/analyze`, {
        method: "POST",
        body: JSON.stringify({ analyzerAgent: step.agent ?? settings.defaultAnalyzerAgent }),
      }, { waitForCompletion });
      break;
    case "analyze_local":
      await callInternalApi(`/api/reviews/${encodedRepo}/${prNumber}/local-comments/analyze`, {
        method: "POST",
        body: JSON.stringify({ analyzerAgent: step.agent ?? settings.defaultAnalyzerAgent }),
      }, { waitForCompletion });
      break;
    case "fix_github":
      await callInternalApi(`/api/prs/${encodedRepo}/${prNumber}/fix`, {
        method: "POST",
        body: JSON.stringify({ fixerAgent: step.agent ?? settings.defaultFixerAgent }),
      }, { waitForCompletion });
      break;
    case "fix_local":
      await callInternalApi(`/api/reviews/${encodedRepo}/${prNumber}/local-comments/fix`, {
        method: "POST",
        body: JSON.stringify({ fixerAgent: step.agent ?? settings.defaultFixerAgent }),
      }, { waitForCompletion });
      break;
    case "publish_review":
      for (const reviewerId of step.reviewerIds ?? []) {
        await callInternalApi(`/api/reviews/${encodedRepo}/${prNumber}/${reviewerId}/publish`, {
          method: "POST",
          body: JSON.stringify({}),
        }, { waitForCompletion });
      }
      break;
    case "reply_comments": {
      const replies = getCommentsByPR(repo, prNumber)
        .filter((comment) => comment.type === "inline" && !comment.repliedAt && comment.fixResult)
        .map((comment) => ({
          commentId: comment.id,
          body: `Addressed in ${comment.fixResult!.commitHash}`,
        }));

      if (replies.length === 0) return step;

      await callInternalApi(`/api/prs/${encodedRepo}/${prNumber}/reply`, {
        method: "POST",
        body: JSON.stringify({ replies }),
      }, { waitForCompletion });
      break;
    }
    case "request_review":
      for (const reviewerId of step.reviewerIds ?? (step.reviewerId ? [step.reviewerId] : [])) {
        await callInternalApi(`/api/reviews/${encodedRepo}/${prNumber}/request`, {
          method: "POST",
          body: JSON.stringify({ reviewerId }),
        }, { waitForCompletion });
      }
      break;
    case "busy":
    case "merge_ready":
    case "ignored":
    case "idle":
      break;
  }

  return step;
}

async function runCoordinatorPass(): Promise<void> {
  markScheduledEventRan(COORDINATOR_SCHEDULE_ID);

  const settings = getSettings();
  if (!settings.coordinatorEnabled) return;

  const jobId = startJob("coordinator", "system", {
    detail: `Scanning open PRs with ${settings.coordinatorAgent}`,
  });

  try {
    const repos = getRepos();
    let triggeredCount = 0;

    for (const repoConfig of repos) {
      updateJobStep(jobId, `Listing PRs for ${repoConfig.label}`);
      const prs = await listOpenPRs(repoConfig);

      for (const pr of prs) {
        const suggestion = getSuggestedNextStep(repoConfig.label, pr.number);
        if (suggestion.action === "busy" || !suggestion.canExecute) continue;

        updateJobStep(jobId, `${repoConfig.label} #${pr.number}`, suggestion.title);
        await executeSuggestedNextStep(repoConfig.label, pr.number, suggestion, { waitForCompletion: false });
        triggeredCount += 1;
      }
    }

    completeJob(jobId, triggeredCount > 0 ? `Triggered ${triggeredCount} next step(s)` : "No coordinator actions needed");
  } catch (error) {
    failJob(jobId, String(error));
    throw error;
  }
}

export function startWorkflowCoordinator(intervalMs = 3 * 60 * 1000): void {
  registerScheduledEvent(
    COORDINATOR_SCHEDULE_ID,
    "coordinator",
    "AI coordinator (next-step execution)",
    intervalMs,
  );

  runCoordinatorPass().catch((error) => {
    console.error("Initial workflow coordinator pass failed:", error);
  });

  coordinatorInterval = setInterval(() => {
    runCoordinatorPass().catch((error) => {
      console.error("Workflow coordinator pass failed:", error);
    });
  }, intervalMs);
}

export function stopWorkflowCoordinator(): void {
  if (coordinatorInterval) {
    clearInterval(coordinatorInterval);
    coordinatorInterval = null;
  }
}
