import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

const MACHINE_STALE_AFTER_MS = 2 * 60_000;

const machineJobStepValidator = v.array(
  v.object({
    step: v.string(),
    detail: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("done"), v.literal("error")),
    ts: v.string(),
  }),
);

function isHeartbeatStale(lastHeartbeatAt: string): boolean {
  return Date.now() - Date.parse(lastHeartbeatAt) > MACHINE_STALE_AFTER_MS;
}

async function recoverStaleClaims(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  const now = nowIso();
  const machines = await ctx.db
    .query("machines")
    .withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId))
    .collect();

  const staleMachineIds = new Set<string>();

  for (const machine of machines) {
    if (!isHeartbeatStale(machine.lastHeartbeatAt)) {
      continue;
    }

    staleMachineIds.add(machine._id);
    await ctx.db.patch(machine._id, {
      status: "offline",
      currentJobId: undefined,
      currentJobLabel: undefined,
      updatedAt: now,
    });
  }

  if (staleMachineIds.size === 0) {
    return;
  }

  const runningJobs = await ctx.db
    .query("jobs")
    .withIndex("by_workspaceId_status_createdAt", (q) =>
      q.eq("workspaceId", workspaceId).eq("status", "running"),
    )
    .collect();
  const claimedJobs = await ctx.db
    .query("jobs")
    .withIndex("by_workspaceId_status_createdAt", (q) =>
      q.eq("workspaceId", workspaceId).eq("status", "claimed"),
    )
    .collect();

  for (const job of [...runningJobs, ...claimedJobs]) {
    if (!job.claimedByMachineId || !staleMachineIds.has(job.claimedByMachineId)) {
      continue;
    }

    await ctx.db.patch(job._id, {
      status: "queued",
      claimedByMachineId: undefined,
      claimedAt: undefined,
      startedAt: undefined,
      errorMessage: undefined,
      updatedAt: now,
    });

    const runs = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
      .collect();
    const runningRun = runs.find((run) => run.status === "running");

    if (runningRun) {
      await ctx.db.patch(runningRun._id, {
        status: "error",
        steps: [
          ...runningRun.steps.filter((step) => step.status !== "active"),
          {
            step: "recovered",
            detail: "Job returned to queue after machine heartbeat timed out",
            status: "error",
            ts: now,
          },
        ],
        output: [
          ...runningRun.output,
          "[recovery] returned to queue after machine heartbeat timeout",
        ],
        finishedAt: now,
      });
    }
  }
}

export const listForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_workspaceId_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

export const listRunsForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const runs = await ctx.db
      .query("jobRuns")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },
});

export const listFeedForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const [jobs, runs] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_workspaceId_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
      ctx.db
        .query("jobRuns")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
    ]);

    const latestRunsByJobId = new Map<string, (typeof runs)[number]>();
    for (const run of runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      if (!latestRunsByJobId.has(run.jobId)) {
        latestRunsByJobId.set(run.jobId, run);
      }
    }

    const feed = await Promise.all(
      jobs.map(async (job) => {
        const repo = job.repoId ? await ctx.db.get(job.repoId) : null;
        const pr = job.prId ? await ctx.db.get(job.prId) : null;
        const payload =
          job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
            ? (job.payload as Record<string, unknown>)
            : null;

        return {
          ...job,
          repoLabel:
            repo?.label ?? (typeof payload?.repoLabel === "string" ? payload.repoLabel : null),
          prNumber:
            pr?.prNumber ?? (typeof payload?.prNumber === "number" ? payload.prNumber : null),
          latestRun: latestRunsByJobId.get(job._id) ?? null,
        };
      }),
    );

    return feed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

export const enqueue = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoId: v.optional(v.id("repos")),
    prId: v.optional(v.id("prs")),
    kind: v.union(
      v.literal("sync_repo"),
      v.literal("refresh_pr"),
      v.literal("analyze_comments"),
      v.literal("fix_comments"),
      v.literal("request_review"),
      v.literal("publish_review"),
      v.literal("reply_comment"),
      v.literal("machine_command"),
    ),
    targetMachineSlug: v.optional(v.string()),
    title: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const now = nowIso();

    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: args.repoId,
      prId: args.prId,
      createdByUserId: user._id,
      kind: args.kind,
      status: "queued",
      targetMachineSlug: args.targetMachineSlug,
      title: args.title,
      payload: args.payload,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueRepoSync = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoId: v.id("repos"),
    machineSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db.get(args.repoId);

    if (!repo || repo.workspaceId !== args.workspaceId || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const machine = await ctx.db
      .query("machines")
      .withIndex("by_workspaceId_slug", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("slug", args.machineSlug),
      )
      .unique();

    if (!machine) {
      throw new Error("Machine not found in this workspace.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const now = nowIso();
    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      createdByUserId: user._id,
      kind: "sync_repo",
      status: "queued",
      targetMachineSlug: machine.slug,
      title: `Sync ${repo.label}`,
      payload: {
        repoId: repo._id,
        repoLabel: repo.label,
        owner: repo.owner,
        repo: repo.repo,
        botUsers: repo.botUsers,
        localPath: machineConfig.localPath,
        skipTypecheck: machineConfig.skipTypecheck,
      },
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueuePrRefresh = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const now = nowIso();
    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "refresh_pr",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Refresh ${repo.label} #${pr.prNumber}`,
      payload: {
        repoId: repo._id,
        prId: pr._id,
        repoLabel: repo.label,
        owner: repo.owner,
        repo: repo.repo,
        prNumber: pr.prNumber,
        localPath: machineConfig.localPath,
        skipTypecheck: machineConfig.skipTypecheck,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: pr._id,
      eventType: "refresh_requested",
      detail: {
        machineSlug: args.machineSlug,
        repoLabel: repo.label,
        prNumber: pr.prNumber,
      },
      createdAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueGithubCommentAnalysis = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
    analyzerAgent: v.union(v.literal("claude"), v.literal("codex")),
    reanalyze: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const now = nowIso();
    const githubComments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const shouldReanalyze = args.reanalyze === true;
    const pendingComments = githubComments.filter(
      (comment) =>
        (comment.status === undefined ||
          comment.status === "new" ||
          comment.status === "analyzing" ||
          (shouldReanalyze &&
            (comment.status === "analyzed" ||
              comment.status === "fix_failed" ||
              comment.status === "fixed"))),
    );

    if (pendingComments.length === 0) {
      throw new Error(`No ${shouldReanalyze ? "eligible" : "pending"} GitHub review comments are available to analyze.`);
    }

    for (const comment of pendingComments) {
      await ctx.db.patch(comment._id, {
        status: "analyzing",
        updatedAt: now,
      });
    }

    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "analyze_comments",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Analyze ${repo.label} #${pr.prNumber} GitHub comments with ${args.analyzerAgent}`,
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
        analyzerAgent: args.analyzerAgent,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: pr._id,
      eventType: "analysis_requested",
      detail: {
        analyzerAgent: args.analyzerAgent,
        machineSlug: args.machineSlug,
        count: pendingComments.length,
        source: "github_comments",
      },
      createdAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueReviewRequest = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const now = nowIso();
    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "request_review",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Review ${repo.label} #${pr.prNumber} with ${args.reviewerId}`,
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
        reviewerId: args.reviewerId,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: pr._id,
      eventType: "review_requested",
      detail: {
        reviewerId: args.reviewerId,
        machineSlug: args.machineSlug,
      },
      createdAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueReviewCommentAnalysis = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
    analyzerAgent: v.union(v.literal("claude"), v.literal("codex")),
    reanalyze: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const now = nowIso();
    const reviewComments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const shouldReanalyze = args.reanalyze === true;
    const pendingCount = reviewComments.filter(
      (comment) =>
        comment.reviewerId === args.reviewerId &&
        !comment.supersededAt &&
        (comment.status === "new" ||
          comment.status === "analyzing" ||
          (shouldReanalyze &&
            (comment.status === "analyzed" ||
              comment.status === "fix_failed" ||
              comment.status === "fixed"))),
    ).length;

    if (pendingCount === 0) {
      throw new Error(`No ${shouldReanalyze ? "eligible" : "pending"} review comments are available to analyze.`);
    }

    for (const comment of reviewComments) {
      if (
        comment.reviewerId === args.reviewerId &&
        !comment.supersededAt &&
        (comment.status === "new" ||
          comment.status === "analyzing" ||
          (shouldReanalyze &&
            (comment.status === "analyzed" ||
              comment.status === "fix_failed" ||
              comment.status === "fixed")))
      ) {
        await ctx.db.patch(comment._id, {
          status: "analyzing",
          updatedAt: now,
        });
      }
    }

    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "analyze_comments",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Analyze ${repo.label} #${pr.prNumber} review comments with ${args.analyzerAgent}`,
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
        reviewerId: args.reviewerId,
        analyzerAgent: args.analyzerAgent,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: pr._id,
      eventType: "analysis_requested",
      detail: {
        reviewerId: args.reviewerId,
        analyzerAgent: args.analyzerAgent,
        machineSlug: args.machineSlug,
        count: pendingCount,
        source: "local_review_comments",
      },
      createdAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueGithubCommentFix = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
    fixerAgent: v.union(v.literal("claude"), v.literal("codex")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const now = nowIso();
    const githubComments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const fixableComments = githubComments.filter(
      (comment) =>
        (comment.status === "analyzed" || comment.status === "fix_failed") &&
        (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX"),
    );

    if (fixableComments.length === 0) {
      throw new Error("No actionable GitHub review comments are available to fix.");
    }

    for (const comment of fixableComments) {
      await ctx.db.patch(comment._id, {
        status: "fixing",
        updatedAt: now,
      });
    }

    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "fix_comments",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Fix ${repo.label} #${pr.prNumber} GitHub comments with ${args.fixerAgent}`,
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
        fixerAgent: args.fixerAgent,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: pr._id,
      eventType: "fix_started",
      detail: {
        fixerAgent: args.fixerAgent,
        machineSlug: args.machineSlug,
        commentCount: fixableComments.length,
        source: "github_comments",
      },
      createdAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueGithubCommentReply = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const githubComments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const replyableComments = githubComments.filter(
      (comment) =>
        comment.type === "inline" &&
        comment.status === "fixed" &&
        !comment.repliedAt &&
        !!comment.fixCommitHash,
    );

    if (replyableComments.length === 0) {
      throw new Error("No fixed GitHub inline comments are ready for replies.");
    }

    const now = nowIso();
    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "reply_comment",
      status: "queued",
      targetMachineSlug: args.machineSlug,
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

    return await ctx.db.get(jobId);
  },
});

export const enqueueReviewCommentFix = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
    fixerAgent: v.union(v.literal("claude"), v.literal("codex")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const now = nowIso();
    const reviewComments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const fixableComments = reviewComments.filter(
      (comment) =>
        comment.reviewerId === args.reviewerId &&
        !comment.supersededAt &&
        (comment.status === "analyzed" || comment.status === "fix_failed") &&
        (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX"),
    );

    if (fixableComments.length === 0) {
      throw new Error("No actionable triaged review comments are available to fix.");
    }

    for (const comment of fixableComments) {
      await ctx.db.patch(comment._id, {
        status: "fixing",
        updatedAt: now,
      });
    }

    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "fix_comments",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Fix ${repo.label} #${pr.prNumber} review comments with ${args.fixerAgent}`,
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
        reviewerId: args.reviewerId,
        fixerAgent: args.fixerAgent,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: pr._id,
      eventType: "local_fix_started",
      detail: {
        reviewerId: args.reviewerId,
        fixerAgent: args.fixerAgent,
        machineSlug: args.machineSlug,
        commentCount: fixableComments.length,
        source: "local_review_comments",
      },
      createdAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueReviewPublish = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
    machineSlug: v.string(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      throw new Error("Repo not found.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const machineConfig = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", repo._id).eq("machineSlug", args.machineSlug),
      )
      .unique();

    if (!machineConfig) {
      throw new Error("No checkout is registered for this repo on that machine.");
    }

    const reviewComments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const publishableCount = reviewComments.filter(
      (comment) =>
        comment.reviewerId === args.reviewerId &&
        !comment.supersededAt &&
        !comment.publishedAt &&
        comment.status === "analyzed" &&
        comment.analysisCategory !== "DISMISS" &&
        comment.analysisCategory !== "ALREADY_ADDRESSED",
    ).length;

    if (publishableCount === 0) {
      throw new Error("No local review comments are ready to publish.");
    }

    const now = nowIso();
    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      repoId: repo._id,
      prId: pr._id,
      createdByUserId: user._id,
      kind: "publish_review",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Publish ${repo.label} #${pr.prNumber} ${args.reviewerId} review`,
      payload: {
        source: "local_review_comments",
        repoId: repo._id,
        prId: pr._id,
        repoLabel: repo.label,
        prNumber: pr.prNumber,
        reviewerId: args.reviewerId,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: pr._id,
      eventType: "review_publish_requested",
      detail: {
        reviewerId: args.reviewerId,
        machineSlug: args.machineSlug,
        commentCount: publishableCount,
        source: "local_review_comments",
      },
      createdAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const enqueueMachineSelfCheck = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    machineSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const machine = await ctx.db
      .query("machines")
      .withIndex("by_workspaceId_slug", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("slug", args.machineSlug),
      )
      .unique();

    if (!machine) {
      throw new Error("Machine not found in this workspace.");
    }

    const now = nowIso();
    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      createdByUserId: user._id,
      kind: "machine_command",
      status: "queued",
      targetMachineSlug: machine.slug,
      title: `Self-check ${machine.name}`,
      payload: {
        command: "self_check",
      },
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const claimNextForMachine = mutation({
  args: {
    machineToken: v.string(),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    await recoverStaleClaims(ctx, machine.workspaceId);
    const now = nowIso();

    if (machine.currentJobId) {
      const currentJob = await ctx.db.get(machine.currentJobId);

      if (
        currentJob &&
        currentJob.claimedByMachineId === machine._id &&
        (currentJob.status === "claimed" || currentJob.status === "running")
      ) {
        await ctx.db.patch(machine._id, {
          status: "busy",
          currentJobId: currentJob._id,
          currentJobLabel: currentJob.title,
          lastHeartbeatAt: now,
          updatedAt: now,
        });
        return currentJob;
      }

      await ctx.db.patch(machine._id, {
        currentJobId: undefined,
        currentJobLabel: undefined,
        status: "idle",
        updatedAt: now,
      });
    }

    const queuedJobs = await ctx.db
      .query("jobs")
      .withIndex("by_workspaceId_status_createdAt", (q) =>
        q.eq("workspaceId", machine.workspaceId).eq("status", "queued"),
      )
      .collect();

    const nextJob = queuedJobs
      .filter((job) => !job.targetMachineSlug || job.targetMachineSlug === machine.slug)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

    if (!nextJob) {
      return null;
    }

    await ctx.db.patch(nextJob._id, {
      status: "running",
      claimedByMachineId: machine._id,
      claimedAt: now,
      startedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    });

    await ctx.db.patch(machine._id, {
      status: "busy",
      currentJobId: nextJob._id,
      currentJobLabel: nextJob.title,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    const existingRuns = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", nextJob._id))
      .collect();
    const runningRun = existingRuns.find((run) => run.status === "running");

    if (runningRun) {
      await ctx.db.patch(runningRun._id, {
        machineSlug: machine.slug,
        status: "running",
        steps: [
          {
            step: "claim",
            detail: `Claimed by ${machine.name}`,
            status: "done",
            ts: now,
          },
          {
            step: "dispatch",
            detail: nextJob.title,
            status: "active",
            ts: now,
          },
        ],
        output: [],
        startedAt: now,
      });
    } else {
      await ctx.db.insert("jobRuns", {
        workspaceId: machine.workspaceId,
        jobId: nextJob._id,
        machineSlug: machine.slug,
        status: "running",
        steps: [
          {
            step: "claim",
            detail: `Claimed by ${machine.name}`,
            status: "done",
            ts: now,
          },
          {
            step: "dispatch",
            detail: nextJob.title,
            status: "active",
            ts: now,
          },
        ],
        output: [],
        startedAt: now,
      });
    }

    return await ctx.db.get(nextJob._id);
  },
});

export const completeMachineJob = mutation({
  args: {
    machineToken: v.string(),
    jobId: v.id("jobs"),
    output: v.array(v.string()),
    steps: machineJobStepValidator,
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const job = await ctx.db.get(args.jobId);

    if (!job || job.workspaceId !== machine.workspaceId) {
      throw new Error("Job not found for this machine.");
    }

    if (job.claimedByMachineId !== machine._id) {
      throw new Error("Job is not claimed by this machine.");
    }

    const now = nowIso();
    await ctx.db.patch(args.jobId, {
      status: "done",
      finishedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    });

    await ctx.db.patch(machine._id, {
      status: "idle",
      currentJobId: undefined,
      currentJobLabel: undefined,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    const runs = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const currentRun = runs.find((run) => run.status === "running") ?? runs[0];

    if (currentRun) {
      await ctx.db.patch(currentRun._id, {
        machineSlug: machine.slug,
        status: "done",
        steps: args.steps,
        output: args.output,
        finishedAt: now,
      });
    }

    return {
      ok: true,
      finishedAt: now,
    };
  },
});

export const failMachineJob = mutation({
  args: {
    machineToken: v.string(),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
    output: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const job = await ctx.db.get(args.jobId);

    if (!job || job.workspaceId !== machine.workspaceId) {
      throw new Error("Job not found for this machine.");
    }

    if (job.claimedByMachineId !== machine._id) {
      throw new Error("Job is not claimed by this machine.");
    }

    const now = nowIso();
    await ctx.db.patch(args.jobId, {
      status: "error",
      finishedAt: now,
      errorMessage: args.errorMessage,
      updatedAt: now,
    });

    await ctx.db.patch(machine._id, {
      status: "idle",
      currentJobId: undefined,
      currentJobLabel: undefined,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    const runs = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const currentRun = runs.find((run) => run.status === "running") ?? runs[0];

    if (currentRun) {
      await ctx.db.patch(currentRun._id, {
        machineSlug: machine.slug,
        status: "error",
        steps: [
          ...currentRun.steps.filter((step) => step.status !== "active"),
          {
            step: "error",
            detail: args.errorMessage,
            status: "error",
            ts: now,
          },
        ],
        output: args.output ?? [],
        finishedAt: now,
      });
    }

    if (job.kind === "refresh_pr" && job.prId) {
      await ctx.db.insert("timelineEvents", {
        workspaceId: job.workspaceId,
        prId: job.prId,
        eventType: "refresh_failed",
        detail: {
          machineSlug: machine.slug,
          jobId: job._id,
          errorMessage: args.errorMessage,
        },
        createdAt: now,
      });
    }

    if (job.kind === "request_review" && job.prId) {
      const payload =
        job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
          ? (job.payload as Record<string, unknown>)
          : null;
      await ctx.db.insert("timelineEvents", {
        workspaceId: job.workspaceId,
        prId: job.prId,
        eventType: "review_failed",
        detail: {
          reviewerId: typeof payload?.reviewerId === "string" ? payload.reviewerId : null,
          machineSlug: machine.slug,
          jobId: job._id,
          errorMessage: args.errorMessage,
        },
        createdAt: now,
      });
    }

    if (job.kind === "analyze_comments" && job.prId) {
      const payload =
        job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
          ? (job.payload as Record<string, unknown>)
          : null;
      if (
        typeof payload?.source === "string" &&
        payload.source === "local_review_comments" &&
        typeof payload.reviewerId === "string"
      ) {
        const reviewComments = await ctx.db
          .query("reviewComments")
          .withIndex("by_prId", (q) => q.eq("prId", job.prId!))
          .collect();
        for (const comment of reviewComments) {
          if (
            comment.reviewerId === payload.reviewerId &&
            !comment.supersededAt &&
            comment.status === "analyzing"
          ) {
            await ctx.db.patch(comment._id, {
              status: "new",
              updatedAt: now,
            });
          }
        }
      }
      if (typeof payload?.source === "string" && payload.source === "github_comments") {
        const githubComments = await ctx.db
          .query("githubComments")
          .withIndex("by_prId", (q) => q.eq("prId", job.prId!))
          .collect();
        for (const comment of githubComments) {
          if (comment.status === "analyzing") {
            await ctx.db.patch(comment._id, {
              status: "new",
              updatedAt: now,
            });
          }
        }
      }
      await ctx.db.insert("timelineEvents", {
        workspaceId: job.workspaceId,
        prId: job.prId,
        eventType: "analysis_failed",
        detail: {
          reviewerId: typeof payload?.reviewerId === "string" ? payload.reviewerId : null,
          analyzerAgent: typeof payload?.analyzerAgent === "string" ? payload.analyzerAgent : null,
          source: typeof payload?.source === "string" ? payload.source : null,
          machineSlug: machine.slug,
          jobId: job._id,
          errorMessage: args.errorMessage,
        },
        createdAt: now,
      });
    }

    if (job.kind === "fix_comments" && job.prId) {
      const payload =
        job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
          ? (job.payload as Record<string, unknown>)
          : null;
      if (
        typeof payload?.source === "string" &&
        payload.source === "local_review_comments" &&
        typeof payload.reviewerId === "string"
      ) {
        const reviewComments = await ctx.db
          .query("reviewComments")
          .withIndex("by_prId", (q) => q.eq("prId", job.prId!))
          .collect();
        for (const comment of reviewComments) {
          if (
            comment.reviewerId === payload.reviewerId &&
            !comment.supersededAt &&
            comment.status === "fixing"
          ) {
            await ctx.db.patch(comment._id, {
              status: "fix_failed",
              updatedAt: now,
            });
          }
        }
      }
      if (typeof payload?.source === "string" && payload.source === "github_comments") {
        const githubComments = await ctx.db
          .query("githubComments")
          .withIndex("by_prId", (q) => q.eq("prId", job.prId!))
          .collect();
        for (const comment of githubComments) {
          if (comment.status === "fixing") {
            await ctx.db.patch(comment._id, {
              status: "fix_failed",
              updatedAt: now,
            });
          }
        }
        await ctx.db.insert("timelineEvents", {
          workspaceId: job.workspaceId,
          prId: job.prId,
          eventType: "fix_failed",
          detail: {
            fixerAgent: typeof payload?.fixerAgent === "string" ? payload.fixerAgent : null,
            source: typeof payload?.source === "string" ? payload.source : null,
            machineSlug: machine.slug,
            jobId: job._id,
            errorMessage: args.errorMessage,
          },
          createdAt: now,
        });
      }
      await ctx.db.insert("timelineEvents", {
        workspaceId: job.workspaceId,
        prId: job.prId,
        eventType: "local_fix_failed",
        detail: {
          reviewerId: typeof payload?.reviewerId === "string" ? payload.reviewerId : null,
          fixerAgent: typeof payload?.fixerAgent === "string" ? payload.fixerAgent : null,
          source: typeof payload?.source === "string" ? payload.source : null,
          machineSlug: machine.slug,
          jobId: job._id,
          errorMessage: args.errorMessage,
        },
        createdAt: now,
      });
    }

    if (job.kind === "reply_comment" && job.prId) {
      const payload =
        job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
          ? (job.payload as Record<string, unknown>)
          : null;
      await ctx.db.insert("timelineEvents", {
        workspaceId: job.workspaceId,
        prId: job.prId,
        eventType: "comments_reply_failed",
        detail: {
          source: typeof payload?.source === "string" ? payload.source : null,
          machineSlug: machine.slug,
          jobId: job._id,
          errorMessage: args.errorMessage,
        },
        createdAt: now,
      });
    }

    if (job.kind === "publish_review" && job.prId) {
      const payload =
        job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
          ? (job.payload as Record<string, unknown>)
          : null;
      await ctx.db.insert("timelineEvents", {
        workspaceId: job.workspaceId,
        prId: job.prId,
        eventType: "review_publish_failed",
        detail: {
          reviewerId: typeof payload?.reviewerId === "string" ? payload.reviewerId : null,
          source: typeof payload?.source === "string" ? payload.source : null,
          machineSlug: machine.slug,
          jobId: job._id,
          errorMessage: args.errorMessage,
        },
        createdAt: now,
      });
    }

    return {
      ok: true,
      finishedAt: now,
    };
  },
});
