import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";

const MACHINE_STALE_AFTER_MS = 2 * 60_000;
const COORDINATOR_INTERVAL_SECONDS = 30;
const MAX_ACTIONS_PER_PASS = 6;

type SupportedAgent = "claude" | "codex";
type CoordinatorTrigger = "manual" | "scheduled";
type CoordinatorJobKind =
  | "refresh_pr"
  | "analyze_comments"
  | "fix_comments"
  | "request_review"
  | "publish_review"
  | "reply_comment";

type CoordinatorActionRecord = {
  kind: CoordinatorJobKind;
  repoLabel: string;
  prNumber: number;
  machineSlug: string;
  reason: string;
};

type CoordinatorSettings = {
  autoReReview: boolean;
  coordinatorEnabled: boolean;
  coordinatorAgent: SupportedAgent;
  defaultAnalyzerAgent: SupportedAgent;
  defaultFixerAgent: SupportedAgent;
  defaultReviewerIds: SupportedAgent[];
};

const DEFAULT_SETTINGS: CoordinatorSettings = {
  autoReReview: false,
  coordinatorEnabled: false,
  coordinatorAgent: "claude",
  defaultAnalyzerAgent: "claude",
  defaultFixerAgent: "claude",
  defaultReviewerIds: ["claude", "codex"],
};

function isMachineLive(machine: Doc<"machines">): boolean {
  return Date.now() - Date.parse(machine.lastHeartbeatAt) <= MACHINE_STALE_AFTER_MS;
}

function isSupportedAgent(value: string): value is SupportedAgent {
  return value === "claude" || value === "codex";
}

function machineSortValue(machine: Doc<"machines">): number {
  if (machine.status === "idle") return 0;
  if (machine.status === "busy") return 1;
  if (machine.status === "error") return 2;
  return 3;
}

function addSkipReason(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function isActionableCategory(category: string | undefined) {
  return category === "MUST_FIX" || category === "SHOULD_FIX";
}

function shouldRequestReview(params: {
  reviewerId: SupportedAgent;
  latestReview: Doc<"reviews"> | null;
  pr: Doc<"prs">;
  reviewComments: Doc<"reviewComments">[];
  autoReReview: boolean;
}) {
  const { reviewerId, latestReview, pr, reviewComments, autoReReview } = params;
  const activeReviewerComments = reviewComments.filter(
    (comment) => comment.reviewerId === reviewerId && !comment.supersededAt,
  );

  if (activeReviewerComments.some((comment) => !comment.publishedAt && comment.status !== "superseded")) {
    return false;
  }

  if (!latestReview) {
    return true;
  }

  if (!autoReReview || !pr.lastFixedAt) {
    return false;
  }

  return latestReview.updatedAt < pr.lastFixedAt;
}

function pickMachineConfig(params: {
  configs: Doc<"repoMachineConfigs">[];
  machinesBySlug: Map<string, Doc<"machines">>;
  needsGh?: boolean;
  needsGit?: boolean;
  requiredAgent?: SupportedAgent;
}) {
  const { configs, machinesBySlug, needsGh = false, needsGit = false, requiredAgent } = params;

  return configs
    .map((config) => ({ config, machine: machinesBySlug.get(config.machineSlug) ?? null }))
    .filter((entry): entry is { config: Doc<"repoMachineConfigs">; machine: Doc<"machines"> } => !!entry.machine)
    .filter(({ machine }) => isMachineLive(machine))
    .filter(({ machine }) => (!needsGh || machine.capabilities.gh) && (!needsGit || machine.capabilities.git))
    .filter(({ machine }) => !requiredAgent || machine.capabilities[requiredAgent])
    .sort((left, right) => {
      const statusCompare = machineSortValue(left.machine) - machineSortValue(right.machine);
      if (statusCompare !== 0) {
        return statusCompare;
      }
      return right.config.updatedAt.localeCompare(left.config.updatedAt);
    })[0] ?? null;
}

async function getWorkspaceSettings(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">) {
  const settings = await ctx.db
    .query("workspaceSettings")
    .withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId))
    .unique();

  return {
    autoReReview: settings?.autoReReview ?? DEFAULT_SETTINGS.autoReReview,
    coordinatorEnabled: settings?.coordinatorEnabled ?? DEFAULT_SETTINGS.coordinatorEnabled,
    coordinatorAgent: settings?.coordinatorAgent ?? DEFAULT_SETTINGS.coordinatorAgent,
    defaultAnalyzerAgent: settings?.defaultAnalyzerAgent ?? DEFAULT_SETTINGS.defaultAnalyzerAgent,
    defaultFixerAgent: settings?.defaultFixerAgent ?? DEFAULT_SETTINGS.defaultFixerAgent,
    defaultReviewerIds:
      settings?.defaultReviewerIds.filter(isSupportedAgent) ?? DEFAULT_SETTINGS.defaultReviewerIds,
  };
}

async function createCoordinatorRun(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    initiatedByUserId?: Id<"users">;
    trigger: CoordinatorTrigger;
    plannerAgent: SupportedAgent;
    startedAt: string;
  },
) {
  return await ctx.db.insert("coordinatorRuns", {
    workspaceId: params.workspaceId,
    initiatedByUserId: params.initiatedByUserId,
    trigger: params.trigger,
    plannerAgent: params.plannerAgent,
    status: "running",
    scannedPrCount: 0,
    queuedJobCount: 0,
    skippedPrCount: 0,
    summary: "Coordinator pass started.",
    actions: [],
    skippedReasons: [],
    startedAt: params.startedAt,
    updatedAt: params.startedAt,
  });
}

async function getLatestCoordinatorRun(ctx: QueryCtx | MutationCtx, workspaceId: Id<"workspaces">) {
  const runs = await ctx.db
    .query("coordinatorRuns")
    .withIndex("by_workspaceId_startedAt", (q) => q.eq("workspaceId", workspaceId))
    .collect();

  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

async function enqueueReviewRequestJob(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    createdByUserId: Id<"users">;
    repo: Doc<"repos">;
    pr: Doc<"prs">;
    machineConfig: Doc<"repoMachineConfigs">;
    reviewerId: SupportedAgent;
    now: string;
  },
) {
  const { workspaceId, createdByUserId, repo, pr, machineConfig, reviewerId, now } = params;

  if (!pr.headRefName) {
    return null;
  }

  const jobId = await ctx.db.insert("jobs", {
    workspaceId,
    repoId: repo._id,
    prId: pr._id,
    createdByUserId,
    kind: "request_review",
    status: "queued",
    targetMachineSlug: machineConfig.machineSlug,
    title: `Review ${repo.label} #${pr.prNumber} with ${reviewerId}`,
    payload: {
      repoId: repo._id,
      prId: pr._id,
      repoLabel: repo.label,
      owner: repo.owner,
      repo: repo.repo,
      prNumber: pr.prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      localPath: machineConfig.localPath,
      reviewerId,
    },
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("timelineEvents", {
    workspaceId,
    prId: pr._id,
    eventType: "review_requested",
    detail: {
      reviewerId,
      machineSlug: machineConfig.machineSlug,
      source: "coordinator",
    },
    createdAt: now,
  });

  return jobId;
}

async function enqueueGithubAnalysisJob(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    createdByUserId: Id<"users">;
    repo: Doc<"repos">;
    pr: Doc<"prs">;
    machineConfig: Doc<"repoMachineConfigs">;
    analyzerAgent: SupportedAgent;
    githubComments: Doc<"githubComments">[];
    now: string;
  },
) {
  const { workspaceId, createdByUserId, repo, pr, machineConfig, analyzerAgent, githubComments, now } = params;

  if (!pr.headRefName) {
    return null;
  }

  const pendingComments = githubComments.filter(
    (comment) =>
      repo.botUsers.includes(comment.user) &&
      (comment.status === undefined || comment.status === "new" || comment.status === "analyzing"),
  );

  if (pendingComments.length === 0) {
    return null;
  }

  for (const comment of pendingComments) {
    await ctx.db.patch(comment._id, {
      status: "analyzing",
      updatedAt: now,
    });
  }

  const jobId = await ctx.db.insert("jobs", {
    workspaceId,
    repoId: repo._id,
    prId: pr._id,
    createdByUserId,
    kind: "analyze_comments",
    status: "queued",
    targetMachineSlug: machineConfig.machineSlug,
    title: `Analyze ${repo.label} #${pr.prNumber} GitHub comments with ${analyzerAgent}`,
    payload: {
      source: "github_comments",
      repoId: repo._id,
      prId: pr._id,
      repoLabel: repo.label,
      owner: repo.owner,
      repo: repo.repo,
      prNumber: pr.prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      localPath: machineConfig.localPath,
      analyzerAgent,
    },
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("timelineEvents", {
    workspaceId,
    prId: pr._id,
    eventType: "analysis_requested",
    detail: {
      analyzerAgent,
      machineSlug: machineConfig.machineSlug,
      count: pendingComments.length,
      source: "github_comments",
      requestedBy: "coordinator",
    },
    createdAt: now,
  });

  return jobId;
}

async function enqueueGithubFixJob(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    createdByUserId: Id<"users">;
    repo: Doc<"repos">;
    pr: Doc<"prs">;
    machineConfig: Doc<"repoMachineConfigs">;
    fixerAgent: SupportedAgent;
    githubComments: Doc<"githubComments">[];
    now: string;
  },
) {
  const { workspaceId, createdByUserId, repo, pr, machineConfig, fixerAgent, githubComments, now } = params;

  if (!pr.headRefName) {
    return null;
  }

  const fixableComments = githubComments.filter(
    (comment) =>
      repo.botUsers.includes(comment.user) &&
      (comment.status === "analyzed" || comment.status === "fix_failed") &&
      isActionableCategory(comment.analysisCategory),
  );

  if (fixableComments.length === 0) {
    return null;
  }

  for (const comment of fixableComments) {
    await ctx.db.patch(comment._id, {
      status: "fixing",
      updatedAt: now,
    });
  }

  const jobId = await ctx.db.insert("jobs", {
    workspaceId,
    repoId: repo._id,
    prId: pr._id,
    createdByUserId,
    kind: "fix_comments",
    status: "queued",
    targetMachineSlug: machineConfig.machineSlug,
    title: `Fix ${repo.label} #${pr.prNumber} GitHub comments with ${fixerAgent}`,
    payload: {
      source: "github_comments",
      repoId: repo._id,
      prId: pr._id,
      repoLabel: repo.label,
      owner: repo.owner,
      repo: repo.repo,
      prNumber: pr.prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      localPath: machineConfig.localPath,
      skipTypecheck: machineConfig.skipTypecheck,
      fixerAgent,
    },
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("timelineEvents", {
    workspaceId,
    prId: pr._id,
    eventType: "fix_started",
    detail: {
      fixerAgent,
      machineSlug: machineConfig.machineSlug,
      commentCount: fixableComments.length,
      source: "github_comments",
      requestedBy: "coordinator",
    },
    createdAt: now,
  });

  return jobId;
}

async function enqueueGithubReplyJob(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    createdByUserId: Id<"users">;
    repo: Doc<"repos">;
    pr: Doc<"prs">;
    machineConfig: Doc<"repoMachineConfigs">;
    now: string;
  },
) {
  const { workspaceId, createdByUserId, repo, pr, machineConfig, now } = params;
  const jobId = await ctx.db.insert("jobs", {
    workspaceId,
    repoId: repo._id,
    prId: pr._id,
    createdByUserId,
    kind: "reply_comment",
    status: "queued",
    targetMachineSlug: machineConfig.machineSlug,
    title: `Reply to ${repo.label} #${pr.prNumber} addressed comments`,
    payload: {
      source: "github_comments",
      repoId: repo._id,
      prId: pr._id,
      repoLabel: repo.label,
      prNumber: pr.prNumber,
    },
    createdAt: now,
    updatedAt: now,
  });

  return jobId;
}

async function enqueueReviewCommentAnalysisJob(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    createdByUserId: Id<"users">;
    repo: Doc<"repos">;
    pr: Doc<"prs">;
    machineConfig: Doc<"repoMachineConfigs">;
    reviewerId: SupportedAgent;
    analyzerAgent: SupportedAgent;
    reviewComments: Doc<"reviewComments">[];
    now: string;
  },
) {
  const {
    workspaceId,
    createdByUserId,
    repo,
    pr,
    machineConfig,
    reviewerId,
    analyzerAgent,
    reviewComments,
    now,
  } = params;

  if (!pr.headRefName) {
    return null;
  }

  const pendingComments = reviewComments.filter(
    (comment) =>
      comment.reviewerId === reviewerId &&
      !comment.supersededAt &&
      (comment.status === "new" || comment.status === "analyzing"),
  );

  if (pendingComments.length === 0) {
    return null;
  }

  for (const comment of pendingComments) {
    await ctx.db.patch(comment._id, {
      status: "analyzing",
      updatedAt: now,
    });
  }

  const jobId = await ctx.db.insert("jobs", {
    workspaceId,
    repoId: repo._id,
    prId: pr._id,
    createdByUserId,
    kind: "analyze_comments",
    status: "queued",
    targetMachineSlug: machineConfig.machineSlug,
    title: `Analyze ${repo.label} #${pr.prNumber} review comments with ${analyzerAgent}`,
    payload: {
      source: "local_review_comments",
      repoId: repo._id,
      prId: pr._id,
      repoLabel: repo.label,
      owner: repo.owner,
      repo: repo.repo,
      prNumber: pr.prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      localPath: machineConfig.localPath,
      reviewerId,
      analyzerAgent,
    },
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("timelineEvents", {
    workspaceId,
    prId: pr._id,
    eventType: "analysis_requested",
    detail: {
      reviewerId,
      analyzerAgent,
      machineSlug: machineConfig.machineSlug,
      count: pendingComments.length,
      source: "local_review_comments",
      requestedBy: "coordinator",
    },
    createdAt: now,
  });

  return jobId;
}

async function enqueueReviewCommentFixJob(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    createdByUserId: Id<"users">;
    repo: Doc<"repos">;
    pr: Doc<"prs">;
    machineConfig: Doc<"repoMachineConfigs">;
    reviewerId: SupportedAgent;
    fixerAgent: SupportedAgent;
    reviewComments: Doc<"reviewComments">[];
    now: string;
  },
) {
  const { workspaceId, createdByUserId, repo, pr, machineConfig, reviewerId, fixerAgent, reviewComments, now } =
    params;

  if (!pr.headRefName) {
    return null;
  }

  const fixableComments = reviewComments.filter(
    (comment) =>
      comment.reviewerId === reviewerId &&
      !comment.supersededAt &&
      (comment.status === "analyzed" || comment.status === "fix_failed") &&
      isActionableCategory(comment.analysisCategory),
  );

  if (fixableComments.length === 0) {
    return null;
  }

  for (const comment of fixableComments) {
    await ctx.db.patch(comment._id, {
      status: "fixing",
      updatedAt: now,
    });
  }

  const jobId = await ctx.db.insert("jobs", {
    workspaceId,
    repoId: repo._id,
    prId: pr._id,
    createdByUserId,
    kind: "fix_comments",
    status: "queued",
    targetMachineSlug: machineConfig.machineSlug,
    title: `Fix ${repo.label} #${pr.prNumber} review comments with ${fixerAgent}`,
    payload: {
      source: "local_review_comments",
      repoId: repo._id,
      prId: pr._id,
      repoLabel: repo.label,
      owner: repo.owner,
      repo: repo.repo,
      prNumber: pr.prNumber,
      prTitle: pr.title,
      branch: pr.headRefName,
      localPath: machineConfig.localPath,
      skipTypecheck: machineConfig.skipTypecheck,
      reviewerId,
      fixerAgent,
    },
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("timelineEvents", {
    workspaceId,
    prId: pr._id,
    eventType: "local_fix_started",
    detail: {
      reviewerId,
      fixerAgent,
      machineSlug: machineConfig.machineSlug,
      commentCount: fixableComments.length,
      source: "local_review_comments",
      requestedBy: "coordinator",
    },
    createdAt: now,
  });

  return jobId;
}

async function enqueueReviewPublishJob(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    createdByUserId: Id<"users">;
    repo: Doc<"repos">;
    pr: Doc<"prs">;
    machineConfig: Doc<"repoMachineConfigs">;
    reviewerId: SupportedAgent;
    now: string;
  },
) {
  const { workspaceId, createdByUserId, repo, pr, machineConfig, reviewerId, now } = params;
  const jobId = await ctx.db.insert("jobs", {
    workspaceId,
    repoId: repo._id,
    prId: pr._id,
    createdByUserId,
    kind: "publish_review",
    status: "queued",
    targetMachineSlug: machineConfig.machineSlug,
    title: `Publish ${repo.label} #${pr.prNumber} ${reviewerId} review`,
    payload: {
      source: "local_review_comments",
      repoId: repo._id,
      prId: pr._id,
      repoLabel: repo.label,
      prNumber: pr.prNumber,
      reviewerId,
    },
    createdAt: now,
    updatedAt: now,
  });

  return jobId;
}

async function runCoordinatorPass(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    initiatedByUserId?: Id<"users">;
    createdByUserId: Id<"users">;
    trigger: CoordinatorTrigger;
    ignoreEnabledFlag?: boolean;
  },
) {
  const now = nowIso();
  const settings = await getWorkspaceSettings(ctx, params.workspaceId);
  const latestRun = await getLatestCoordinatorRun(ctx, params.workspaceId);

  if (
    latestRun &&
    latestRun.status === "running" &&
    Date.now() - Date.parse(latestRun.startedAt) < MACHINE_STALE_AFTER_MS
  ) {
    return {
      skipped: true,
      reason: "already_running",
      latestRun,
    };
  }

  if (!params.ignoreEnabledFlag && !settings.coordinatorEnabled) {
    return {
      skipped: true,
      reason: "disabled",
      latestRun: latestRun ?? null,
    };
  }

  const runId = await createCoordinatorRun(ctx, {
    workspaceId: params.workspaceId,
    initiatedByUserId: params.initiatedByUserId,
    trigger: params.trigger,
    plannerAgent: settings.coordinatorAgent,
    startedAt: now,
  });

  try {
    const [repos, prs, jobs, machines, repoMachineConfigs] = await Promise.all([
      ctx.db
        .query("repos")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", params.workspaceId))
        .collect(),
      ctx.db
        .query("prs")
        .withIndex("by_workspaceId_updatedAt", (q) => q.eq("workspaceId", params.workspaceId))
        .collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_workspaceId_createdAt", (q) => q.eq("workspaceId", params.workspaceId))
        .collect(),
      ctx.db
        .query("machines")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", params.workspaceId))
        .collect(),
      ctx.db
        .query("repoMachineConfigs")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", params.workspaceId))
        .collect(),
    ]);

    const activeRepos = repos.filter((repo) => !repo.archivedAt);
    const activeRepoIds = new Set(activeRepos.map((repo) => repo._id));
    const activePrs = prs
      .filter((pr) => activeRepoIds.has(pr.repoId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const activeJobs = jobs.filter(
      (job) => job.status === "queued" || job.status === "claimed" || job.status === "running",
    );
    const activeJobPrIds = new Set(activeJobs.flatMap((job) => (job.prId ? [job.prId] : [])));
    const activeRepoJobIds = new Set(activeJobs.flatMap((job) => (!job.prId && job.repoId ? [job.repoId] : [])));
    const repoById = new Map(activeRepos.map((repo) => [repo._id, repo]));
    const machinesBySlug = new Map(machines.map((machine) => [machine.slug, machine]));
    const configsByRepoId = new Map<string, Doc<"repoMachineConfigs">[]>();

    for (const config of repoMachineConfigs) {
      const existing = configsByRepoId.get(config.repoId) ?? [];
      existing.push(config);
      configsByRepoId.set(config.repoId, existing);
    }

    const actions: CoordinatorActionRecord[] = [];
    const skippedReasons = new Map<string, number>();

    for (const pr of activePrs) {
      if (actions.length >= MAX_ACTIONS_PER_PASS) {
        addSkipReason(skippedReasons, "pass_limit_reached");
        break;
      }

      if (pr.coordinatorReadyAt && pr.coordinatorReadyAt > now) {
        addSkipReason(skippedReasons, "pr_visibility_grace_period");
        continue;
      }

      const repo = repoById.get(pr.repoId);
      if (!repo) {
        addSkipReason(skippedReasons, "repo_missing");
        continue;
      }

      if (activeRepoJobIds.has(repo._id)) {
        addSkipReason(skippedReasons, "repo_job_active");
        continue;
      }

      if (activeJobPrIds.has(pr._id)) {
        addSkipReason(skippedReasons, "pr_job_active");
        continue;
      }

      const repoConfigs = configsByRepoId.get(repo._id) ?? [];
      if (repoConfigs.length === 0) {
        addSkipReason(skippedReasons, "no_checkout");
        continue;
      }

      const [githubComments, reviews, reviewComments] = await Promise.all([
        ctx.db
          .query("githubComments")
          .withIndex("by_prId", (q) => q.eq("prId", pr._id))
          .collect(),
        Promise.all(
          settings.defaultReviewerIds.map(async (reviewerId) => {
            const reviewerReviews = await ctx.db
              .query("reviews")
              .withIndex("by_prId_reviewer", (q) => q.eq("prId", pr._id).eq("reviewerId", reviewerId))
              .collect();
            return reviewerReviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
          }),
        ),
        ctx.db
          .query("reviewComments")
          .withIndex("by_prId", (q) => q.eq("prId", pr._id))
          .collect(),
      ]);

      const latestReviewsByReviewer = new Map<SupportedAgent, Doc<"reviews"> | null>();
      for (const [index, reviewerId] of settings.defaultReviewerIds.entries()) {
        latestReviewsByReviewer.set(reviewerId, reviews[index] ?? null);
      }

      const replyableGithubComments = githubComments.filter(
        (comment) =>
          repo.botUsers.includes(comment.user) &&
          comment.type === "inline" &&
          comment.status === "fixed" &&
          !comment.repliedAt &&
          !!comment.fixCommitHash,
      );
      if (replyableGithubComments.length > 0) {
        const target = pickMachineConfig({
          configs: repoConfigs,
          machinesBySlug,
          needsGh: true,
        });
        if (!target) {
          addSkipReason(skippedReasons, "no_machine_for_reply");
          continue;
        }
        await enqueueGithubReplyJob(ctx, {
          workspaceId: params.workspaceId,
          createdByUserId: params.createdByUserId,
          repo,
          pr,
          machineConfig: target.config,
          now,
        });
        actions.push({
          kind: "reply_comment",
          repoLabel: repo.label,
          prNumber: pr.prNumber,
          machineSlug: target.config.machineSlug,
          reason: `${replyableGithubComments.length} fixed GitHub comments are ready for replies`,
        });
        continue;
      }

      const fixableGithubComments = githubComments.filter(
        (comment) =>
          repo.botUsers.includes(comment.user) &&
          (comment.status === "analyzed" || comment.status === "fix_failed") &&
          isActionableCategory(comment.analysisCategory),
      );
      if (fixableGithubComments.length > 0) {
        const target = pickMachineConfig({
          configs: repoConfigs,
          machinesBySlug,
          needsGh: true,
          needsGit: true,
          requiredAgent: settings.defaultFixerAgent,
        });
        if (!target) {
          addSkipReason(skippedReasons, "no_machine_for_github_fix");
          continue;
        }
        await enqueueGithubFixJob(ctx, {
          workspaceId: params.workspaceId,
          createdByUserId: params.createdByUserId,
          repo,
          pr,
          machineConfig: target.config,
          fixerAgent: settings.defaultFixerAgent,
          githubComments,
          now,
        });
        actions.push({
          kind: "fix_comments",
          repoLabel: repo.label,
          prNumber: pr.prNumber,
          machineSlug: target.config.machineSlug,
          reason: `${fixableGithubComments.length} actionable GitHub comments need fixes`,
        });
        continue;
      }

      const pendingGithubComments = githubComments.filter(
        (comment) =>
          repo.botUsers.includes(comment.user) &&
          (comment.status === undefined || comment.status === "new" || comment.status === "analyzing"),
      );
      if (pendingGithubComments.length > 0) {
        const target = pickMachineConfig({
          configs: repoConfigs,
          machinesBySlug,
          needsGit: true,
          requiredAgent: settings.defaultAnalyzerAgent,
        });
        if (!target) {
          addSkipReason(skippedReasons, "no_machine_for_github_analysis");
          continue;
        }
        await enqueueGithubAnalysisJob(ctx, {
          workspaceId: params.workspaceId,
          createdByUserId: params.createdByUserId,
          repo,
          pr,
          machineConfig: target.config,
          analyzerAgent: settings.defaultAnalyzerAgent,
          githubComments,
          now,
        });
        actions.push({
          kind: "analyze_comments",
          repoLabel: repo.label,
          prNumber: pr.prNumber,
          machineSlug: target.config.machineSlug,
          reason: `${pendingGithubComments.length} new GitHub comments need triage`,
        });
        continue;
      }

      let prHandled = false;
      for (const reviewerId of settings.defaultReviewerIds) {
        const reviewerComments = reviewComments.filter(
          (comment) => comment.reviewerId === reviewerId && !comment.supersededAt,
        );
        const publishableComments = reviewerComments.filter(
          (comment) =>
            !comment.publishedAt &&
            comment.status === "analyzed" &&
            comment.analysisCategory !== "DISMISS" &&
            comment.analysisCategory !== "ALREADY_ADDRESSED",
        );
        if (publishableComments.length > 0) {
          const target = pickMachineConfig({
            configs: repoConfigs,
            machinesBySlug,
            needsGh: true,
          });
          if (!target) {
            addSkipReason(skippedReasons, "no_machine_for_review_publish");
            prHandled = true;
            break;
          }
          await enqueueReviewPublishJob(ctx, {
            workspaceId: params.workspaceId,
            createdByUserId: params.createdByUserId,
            repo,
            pr,
            machineConfig: target.config,
            reviewerId,
            now,
          });
          actions.push({
            kind: "publish_review",
            repoLabel: repo.label,
            prNumber: pr.prNumber,
            machineSlug: target.config.machineSlug,
            reason: `${publishableComments.length} ${reviewerId} review comments are ready to publish`,
          });
          prHandled = true;
          break;
        }

        const fixableReviewComments = reviewerComments.filter(
          (comment) =>
            (comment.status === "analyzed" || comment.status === "fix_failed") &&
            isActionableCategory(comment.analysisCategory),
        );
        if (fixableReviewComments.length > 0) {
          const target = pickMachineConfig({
            configs: repoConfigs,
            machinesBySlug,
            needsGit: true,
            requiredAgent: settings.defaultFixerAgent,
          });
          if (!target) {
            addSkipReason(skippedReasons, "no_machine_for_review_fix");
            prHandled = true;
            break;
          }
          await enqueueReviewCommentFixJob(ctx, {
            workspaceId: params.workspaceId,
            createdByUserId: params.createdByUserId,
            repo,
            pr,
            machineConfig: target.config,
            reviewerId,
            fixerAgent: settings.defaultFixerAgent,
            reviewComments,
            now,
          });
          actions.push({
            kind: "fix_comments",
            repoLabel: repo.label,
            prNumber: pr.prNumber,
            machineSlug: target.config.machineSlug,
            reason: `${fixableReviewComments.length} ${reviewerId} review comments need fixes`,
          });
          prHandled = true;
          break;
        }

        const pendingReviewComments = reviewerComments.filter(
          (comment) => comment.status === "new" || comment.status === "analyzing",
        );
        if (pendingReviewComments.length > 0) {
          const target = pickMachineConfig({
            configs: repoConfigs,
            machinesBySlug,
            needsGit: true,
            requiredAgent: settings.defaultAnalyzerAgent,
          });
          if (!target) {
            addSkipReason(skippedReasons, "no_machine_for_review_analysis");
            prHandled = true;
            break;
          }
          await enqueueReviewCommentAnalysisJob(ctx, {
            workspaceId: params.workspaceId,
            createdByUserId: params.createdByUserId,
            repo,
            pr,
            machineConfig: target.config,
            reviewerId,
            analyzerAgent: settings.defaultAnalyzerAgent,
            reviewComments,
            now,
          });
          actions.push({
            kind: "analyze_comments",
            repoLabel: repo.label,
            prNumber: pr.prNumber,
            machineSlug: target.config.machineSlug,
            reason: `${pendingReviewComments.length} ${reviewerId} review comments need triage`,
          });
          prHandled = true;
          break;
        }

        if (
          shouldRequestReview({
            reviewerId,
            latestReview: latestReviewsByReviewer.get(reviewerId) ?? null,
            pr,
            reviewComments,
            autoReReview: settings.autoReReview,
          })
        ) {
          const target = pickMachineConfig({
            configs: repoConfigs,
            machinesBySlug,
            needsGit: true,
            requiredAgent: reviewerId,
          });
          if (!target) {
            addSkipReason(skippedReasons, "no_machine_for_review_request");
            prHandled = true;
            break;
          }
          const jobId = await enqueueReviewRequestJob(ctx, {
            workspaceId: params.workspaceId,
            createdByUserId: params.createdByUserId,
            repo,
            pr,
            machineConfig: target.config,
            reviewerId,
            now,
          });
          if (!jobId) {
            addSkipReason(skippedReasons, "pr_branch_missing");
            prHandled = true;
            break;
          }
          actions.push({
            kind: "request_review",
            repoLabel: repo.label,
            prNumber: pr.prNumber,
            machineSlug: target.config.machineSlug,
            reason:
              latestReviewsByReviewer.get(reviewerId) === null
                ? `No ${reviewerId} review exists yet`
                : `${reviewerId} re-review is due after the latest fix`,
          });
          prHandled = true;
          break;
        }
      }

      if (!prHandled) {
        addSkipReason(skippedReasons, "no_action_needed");
      }
    }

    const skippedPrCount = [...skippedReasons.values()].reduce((sum, count) => sum + count, 0);
    const summary =
      actions.length > 0
        ? `Queued ${actions.length} coordinator job${actions.length === 1 ? "" : "s"} across ${Math.min(actions.length, activePrs.length)} PRs.`
        : `No next actions found across ${activePrs.length} scanned PR${activePrs.length === 1 ? "" : "s"}.`;

    await ctx.db.patch(runId, {
      status: "done",
      scannedPrCount: activePrs.length,
      queuedJobCount: actions.length,
      skippedPrCount,
      summary,
      actions,
      skippedReasons: [...skippedReasons.entries()].map(([key, count]) => ({ key, count })),
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    });

    return {
      skipped: false,
      runId,
      queuedJobCount: actions.length,
      scannedPrCount: activePrs.length,
      actions,
      summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = nowIso();
    await ctx.db.patch(runId, {
      status: "error",
      errorMessage: message,
      summary: "Coordinator pass failed.",
      finishedAt,
      updatedAt: finishedAt,
    });
    throw error;
  }
}

export const getStatusForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const latestRun = await getLatestCoordinatorRun(ctx, args.workspaceId);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_workspaceId_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const activeJobCount = jobs.filter(
      (job) => job.status === "queued" || job.status === "claimed" || job.status === "running",
    ).length;

    return {
      intervalSeconds: COORDINATOR_INTERVAL_SECONDS,
      activeJobCount,
      latestRun,
    };
  },
});

export const runNowForWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    return await runCoordinatorPass(ctx, {
      workspaceId: args.workspaceId,
      initiatedByUserId: user._id,
      createdByUserId: user._id,
      trigger: "manual",
      ignoreEnabledFlag: true,
    });
  },
});

export const runScheduledPass = internalMutation({
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.db.query("workspaceSettings").collect();
    const enabledSettings = settings.filter((entry) => entry.coordinatorEnabled);

    for (const entry of enabledSettings) {
      const workspace = await ctx.db.get(entry.workspaceId);
      if (!workspace) {
        continue;
      }

      try {
        await runCoordinatorPass(ctx, {
          workspaceId: entry.workspaceId,
          createdByUserId: workspace.ownerUserId,
          trigger: "scheduled",
        });
      } catch (error) {
        console.error(
          `[coordinator] scheduled pass failed for workspace ${entry.workspaceId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
});
