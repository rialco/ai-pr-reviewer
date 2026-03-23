import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

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
    prs: v.array(
      v.object({
        number: v.number(),
        title: v.string(),
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
      const existing = repoPrs.find((pr) => pr.prNumber === incomingPr.number);

      const nextFields = {
        workspaceId: machine.workspaceId,
        repoId: repo._id,
        repoLabel: repo.label,
        prNumber: incomingPr.number,
        title: incomingPr.title,
        url: incomingPr.url,
        author: incomingPr.author,
        headRefName: incomingPr.headRefName,
        baseRefName: incomingPr.baseRefName,
        mergeable: incomingPr.mergeable,
        mergeStateStatus: incomingPr.mergeStateStatus,
        phase: existing?.phase ?? "polled",
        reviewCycle: existing?.reviewCycle ?? 0,
        confidenceScore: existing?.confidenceScore,
        lastFixedAt: existing?.lastFixedAt,
        lastReReviewAt: existing?.lastReReviewAt,
        updatedAt: incomingPr.updatedAt,
      };

      if (existing) {
        await ctx.db.patch(existing._id, nextFields);
      } else {
        await ctx.db.insert("prs", {
          ...nextFields,
          createdAt: incomingPr.createdAt,
        });
      }
    }

    for (const existing of repoPrs) {
      if (incomingByNumber.has(existing.prNumber)) {
        continue;
      }

      await ctx.db.delete(existing._id);
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
