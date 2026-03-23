import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

const NEW_PR_COORDINATOR_GRACE_MS = 60_000;

function normalizeCommentStatus(status: string | undefined) {
  return status ?? "new";
}

type SyncSnapshotComment = {
  githubCommentId: number;
  type: "inline" | "review" | "issue_comment";
  user: string;
  body: string;
  path?: string;
  line?: number;
  diffHunk?: string;
  githubUrl?: string;
  createdAt: string;
  updatedAt: string;
};

type SyncSnapshotPr = {
  number: number;
  title: string;
  body?: string;
  url: string;
  headRefName?: string;
  baseRefName?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus?:
    | "BEHIND"
    | "BLOCKED"
    | "CLEAN"
    | "DIRTY"
    | "DRAFT"
    | "HAS_HOOKS"
    | "UNKNOWN"
    | "UNSTABLE";
  author: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitCount?: number;
  files?: Array<{
    path: string;
    additions: number;
    deletions: number;
  }>;
  comments?: SyncSnapshotComment[];
  createdAt: string;
  updatedAt: string;
};

async function upsertPrSnapshot(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    repo: Doc<"repos">;
    machineSlug: string;
    incomingPr: SyncSnapshotPr;
    eventType?: string;
  },
) {
  const { workspaceId, repo, machineSlug, incomingPr, eventType } = params;
  const now = nowIso();
  const existing = await ctx.db
    .query("prs")
    .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", incomingPr.number))
    .unique();

  const nextFields = {
    workspaceId,
    repoId: repo._id,
    repoLabel: repo.label,
    prNumber: incomingPr.number,
    title: incomingPr.title,
    body: incomingPr.body,
    url: incomingPr.url,
    author: incomingPr.author,
    headRefName: incomingPr.headRefName,
    baseRefName: incomingPr.baseRefName,
    mergeable: incomingPr.mergeable,
    mergeStateStatus: incomingPr.mergeStateStatus,
    phase: existing?.phase ?? "polled",
    reviewCycle: existing?.reviewCycle ?? 0,
    confidenceScore: existing?.confidenceScore,
    additions: incomingPr.additions,
    deletions: incomingPr.deletions,
    changedFiles: incomingPr.changedFiles,
    commitCount: incomingPr.commitCount,
    files: incomingPr.files,
    coordinatorReadyAt:
      existing?.coordinatorReadyAt ??
      new Date(Date.now() + NEW_PR_COORDINATOR_GRACE_MS).toISOString(),
    lastFixedAt: existing?.lastFixedAt,
    lastReReviewAt: existing?.lastReReviewAt,
    updatedAt: incomingPr.updatedAt,
  };

  const prId = existing
    ? existing._id
    : await ctx.db.insert("prs", {
        ...nextFields,
        createdAt: incomingPr.createdAt,
      });

  if (existing) {
    await ctx.db.patch(existing._id, nextFields);
  }

  const existingComments = await ctx.db
    .query("githubComments")
    .withIndex("by_prId", (q) => q.eq("prId", prId))
    .collect();
  const incomingComments = incomingPr.comments ?? [];
  const incomingCommentIds = new Set(incomingComments.map((comment) => comment.githubCommentId));

  for (const incomingComment of incomingComments) {
    const existingComment = existingComments.find(
      (comment) => comment.githubCommentId === incomingComment.githubCommentId,
    );

    const nextCommentFields = {
      workspaceId,
      repoId: repo._id,
      prId,
      repoLabel: repo.label,
      githubCommentId: incomingComment.githubCommentId,
      type: incomingComment.type,
      user: incomingComment.user,
      body: incomingComment.body,
      path: incomingComment.path,
      line: incomingComment.line,
      diffHunk: incomingComment.diffHunk,
      status: normalizeCommentStatus(existingComment?.status),
      analysisCategory: existingComment?.analysisCategory,
      analysisReasoning: existingComment?.analysisReasoning,
      analysisDetails: existingComment?.analysisDetails,
      fixCommitHash: existingComment?.fixCommitHash,
      fixCommitMessage: existingComment?.fixCommitMessage,
      fixFilesChanged: existingComment?.fixFilesChanged,
      fixFixedAt: existingComment?.fixFixedAt,
      repliedAt: existingComment?.repliedAt,
      replyBody: existingComment?.replyBody,
      githubUrl: incomingComment.githubUrl,
      createdAt: incomingComment.createdAt,
      updatedAt: incomingComment.updatedAt,
    };

    if (existingComment) {
      await ctx.db.patch(existingComment._id, nextCommentFields);
      continue;
    }

    await ctx.db.insert("githubComments", nextCommentFields);
  }

  for (const existingComment of existingComments) {
    if (incomingCommentIds.has(existingComment.githubCommentId)) {
      continue;
    }

    await ctx.db.delete(existingComment._id);
  }

  if (eventType) {
    await ctx.db.insert("timelineEvents", {
      workspaceId,
      prId,
      eventType,
      detail: {
        repoLabel: repo.label,
        prNumber: incomingPr.number,
        machineSlug,
        commentCount: incomingComments.length,
        changedFiles: incomingPr.changedFiles ?? 0,
      },
      createdAt: now,
    });
  }

  return prId;
}

async function deletePrCascade(
  ctx: MutationCtx,
  params: {
    workspaceId: Id<"workspaces">;
    pr: Doc<"prs">;
  },
) {
  const { workspaceId, pr } = params;
  const [githubComments, reviewComments, reviews, timelineEvents, jobs] = await Promise.all([
    ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect(),
    ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect(),
    ctx.db
      .query("reviews")
      .withIndex("by_prId_reviewer", (q) => q.eq("prId", pr._id))
      .collect(),
    ctx.db
      .query("timelineEvents")
      .withIndex("by_prId_createdAt", (q) => q.eq("prId", pr._id))
      .collect(),
    ctx.db
      .query("jobs")
      .withIndex("by_workspaceId_createdAt", (q) => q.eq("workspaceId", workspaceId))
      .collect(),
  ]);

  const prJobs = jobs.filter((job) => job.prId === pr._id);
  const activeJob = prJobs.find(
    (job) => job.status === "queued" || job.status === "claimed" || job.status === "running",
  );

  if (activeJob) {
    throw new Error(`Cannot reset PR while job "${activeJob.title}" is still ${activeJob.status}.`);
  }

  for (const githubComment of githubComments) {
    await ctx.db.delete(githubComment._id);
  }

  for (const reviewComment of reviewComments) {
    await ctx.db.delete(reviewComment._id);
  }

  for (const review of reviews) {
    await ctx.db.delete(review._id);
  }

  for (const event of timelineEvents) {
    await ctx.db.delete(event._id);
  }

  for (const job of prJobs) {
    const jobRuns = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
      .collect();

    for (const jobRun of jobRuns) {
      await ctx.db.delete(jobRun._id);
    }

    await ctx.db.delete(job._id);
  }

  await ctx.db.delete(pr._id);

  return {
    githubCommentCount: githubComments.length,
    reviewCommentCount: reviewComments.length,
    reviewCount: reviews.length,
    timelineEventCount: timelineEvents.length,
    jobCount: prJobs.length,
  };
}

export const listForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const [repos, prs] = await Promise.all([
      ctx.db
        .query("repos")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
      ctx.db
        .query("prs")
        .withIndex("by_workspaceId_updatedAt", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
    ]);
    const activeRepoIds = new Set(repos.filter((repo) => !repo.archivedAt).map((repo) => repo._id));
    const activePrs = prs.filter((pr) => activeRepoIds.has(pr.repoId));

    return activePrs.sort((a, b) => {
      const repoCompare = a.repoLabel.localeCompare(b.repoLabel);
      if (repoCompare !== 0) {
        return repoCompare;
      }

      return b.updatedAt.localeCompare(a.updatedAt);
    });
  },
});

export const getDetailForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      return null;
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      return null;
    }

    const comments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    return {
      repoBotUsers: repo.botUsers,
      pr: {
        ...pr,
        body: pr.body ?? "",
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changedFiles ?? 0,
        commitCount: pr.commitCount ?? 0,
        files: pr.files ?? [],
      },
      comments: comments
        .map((comment) => ({
          ...comment,
          status: normalizeCommentStatus(comment.status),
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  },
});

export const listTimelineForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const repo = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", args.repoLabel),
      )
      .unique();

    if (!repo || repo.archivedAt) {
      return [];
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      return [];
    }

    const events = await ctx.db
      .query("timelineEvents")
      .withIndex("by_prId_createdAt", (q) => q.eq("prId", pr._id))
      .collect();

    return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

export const getTimelineEventForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
    eventId: v.id("timelineEvents"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const event = await ctx.db.get(args.eventId);
    if (!event || event.workspaceId !== args.workspaceId) {
      return null;
    }

    return event;
  },
});

export const resetForWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

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
      throw new Error("PR not found.");
    }

    const deleted = await deletePrCascade(ctx, {
      workspaceId: args.workspaceId,
      pr,
    });

    return {
      ok: true,
      repoLabel: repo.label,
      prNumber: args.prNumber,
      ...deleted,
    };
  },
});

export const dashboardSummary = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const [repos, prs, jobs, githubComments] = await Promise.all([
      ctx.db
        .query("repos")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
      ctx.db
        .query("prs")
        .withIndex("by_workspaceId_updatedAt", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_workspaceId_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
      ctx.db
        .query("githubComments")
        .collect(),
    ]);

    const activeRepos = repos.filter((repo) => !repo.archivedAt);
    const activeRepoIds = new Set(activeRepos.map((repo) => repo._id));
    const activePrs = prs.filter((pr) => activeRepoIds.has(pr.repoId));
    const workspaceComments = githubComments.filter((comment) => comment.workspaceId === args.workspaceId);
    const lastSyncJob = jobs
      .filter((job) => job.kind === "sync_repo" && job.status === "done")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const byStatus = activePrs.reduce<Record<string, number>>((counts, pr) => {
      const phase = pr.phase ?? "polled";
      counts[phase] = (counts[phase] ?? 0) + 1;
      return counts;
    }, {});

    return {
      repos: activeRepos.length,
      totalComments: workspaceComments.length,
      lastPollAt: lastSyncJob?.updatedAt ?? null,
      byStatus,
      byCategory: {},
    };
  },
});

export const upsertRepoSyncSnapshot = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    pruneMissing: v.optional(v.boolean()),
    eventType: v.optional(v.string()),
    prs: v.array(
      v.object({
        number: v.number(),
        title: v.string(),
        body: v.optional(v.string()),
        url: v.string(),
        headRefName: v.optional(v.string()),
        baseRefName: v.optional(v.string()),
        mergeable: v.optional(v.union(v.literal("MERGEABLE"), v.literal("CONFLICTING"), v.literal("UNKNOWN"))),
        mergeStateStatus: v.optional(
          v.union(
            v.literal("BEHIND"),
            v.literal("BLOCKED"),
            v.literal("CLEAN"),
            v.literal("DIRTY"),
            v.literal("DRAFT"),
            v.literal("HAS_HOOKS"),
            v.literal("UNKNOWN"),
            v.literal("UNSTABLE"),
          ),
        ),
        author: v.string(),
        additions: v.optional(v.number()),
        deletions: v.optional(v.number()),
        changedFiles: v.optional(v.number()),
        commitCount: v.optional(v.number()),
        files: v.optional(
          v.array(
            v.object({
              path: v.string(),
              additions: v.number(),
              deletions: v.number(),
            }),
          ),
        ),
        comments: v.optional(
          v.array(
            v.object({
              githubCommentId: v.number(),
              type: v.union(v.literal("inline"), v.literal("review"), v.literal("issue_comment")),
              user: v.string(),
              body: v.string(),
              path: v.optional(v.string()),
              line: v.optional(v.number()),
              diffHunk: v.optional(v.string()),
              githubUrl: v.optional(v.string()),
              createdAt: v.string(),
              updatedAt: v.string(),
            }),
          ),
        ),
        createdAt: v.string(),
        updatedAt: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const repo = await ctx.db.get(args.repoId);

    if (!repo || repo.workspaceId !== machine.workspaceId || repo.archivedAt) {
      throw new Error("Repo not found for this machine workspace.");
    }

    const now = nowIso();
    const existingPrs = await ctx.db
      .query("prs")
      .withIndex("by_workspaceId_updatedAt", (q) => q.eq("workspaceId", machine.workspaceId))
      .collect();
    const repoPrs = existingPrs.filter((pr) => pr.repoId === repo._id);
    const incomingByNumber = new Map(args.prs.map((pr) => [pr.number, pr]));

    for (const incomingPr of args.prs) {
      await upsertPrSnapshot(ctx, {
        workspaceId: machine.workspaceId,
        repo,
        machineSlug: machine.slug,
        incomingPr,
        eventType: args.eventType,
      });
    }

    if (args.pruneMissing ?? true) {
      for (const existing of repoPrs) {
        if (incomingByNumber.has(existing.prNumber)) {
          continue;
        }

        await deletePrCascade(ctx, {
          workspaceId: machine.workspaceId,
          pr: existing,
        });
      }
    }

    await ctx.db.patch(repo._id, {
      updatedAt: now,
    });

    return {
      ok: true,
      repoId: repo._id,
      prCount: args.prs.length,
      syncedAt: now,
    };
  },
});
