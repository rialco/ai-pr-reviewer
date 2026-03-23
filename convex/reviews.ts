import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

async function getPrForWorkspace(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  repoLabel: string,
  prNumber: number,
) {
  const repo = await ctx.db
    .query("repos")
    .withIndex("by_workspaceId_label", (q) => q.eq("workspaceId", workspaceId).eq("label", repoLabel))
    .unique();

  if (!repo || repo.archivedAt) {
    return { repo: null, pr: null };
  }

  const pr = await ctx.db
    .query("prs")
    .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", prNumber))
    .unique();

  return { repo, pr };
}

export const listForPr = query({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const { pr } = await getPrForWorkspace(ctx, args.workspaceId, args.repoLabel, args.prNumber);

    if (!pr) {
      return [];
    }

    const [reviews, comments] = await Promise.all([
      ctx.db
        .query("reviews")
        .withIndex("by_prId_reviewer", (q) => q.eq("prId", pr._id))
        .collect(),
      ctx.db
        .query("reviewComments")
        .withIndex("by_prId", (q) => q.eq("prId", pr._id))
        .collect(),
    ]);

    const latestByReviewer = new Map<string, (typeof reviews)[number]>();
    for (const review of reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (!latestByReviewer.has(review.reviewerId)) {
        latestByReviewer.set(review.reviewerId, review);
      }
    }

    return [...latestByReviewer.values()]
      .map((review) => ({
        ...review,
        commentCount: comments.filter(
          (comment) => comment.reviewId === review._id && !comment.supersededAt,
        ).length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
});

export const listCommentsForPr = query({
  args: {
    workspaceId: v.id("workspaces"),
    repoLabel: v.string(),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const { pr } = await getPrForWorkspace(ctx, args.workspaceId, args.repoLabel, args.prNumber);

    if (!pr) {
      return [];
    }

    const comments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    return comments
      .filter((comment) => !comment.supersededAt)
      .sort((a, b) => {
        const reviewerCompare = a.reviewerId.localeCompare(b.reviewerId);
        if (reviewerCompare !== 0) return reviewerCompare;
        const pathCompare = a.path.localeCompare(b.path);
        if (pathCompare !== 0) return pathCompare;
        return a.line - b.line;
      });
  },
});

export const upsertReviewResult = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
    source: v.union(v.literal("local"), v.literal("remote")),
    confidenceScore: v.optional(v.number()),
    summary: v.optional(v.string()),
    rawOutput: v.optional(v.string()),
    comments: v.array(
      v.object({
        path: v.string(),
        line: v.number(),
        body: v.string(),
        suggestion: v.optional(v.string()),
        severity: v.optional(v.union(v.literal("critical"), v.literal("major"), v.literal("minor"))),
        confidence: v.optional(v.number()),
        evidence: v.optional(
          v.object({
            filesRead: v.array(v.string()),
            changedLinesChecked: v.array(v.string()),
            ruleReferences: v.array(v.string()),
            riskSummary: v.optional(v.string()),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const repo = await ctx.db.get(args.repoId);

    if (!repo || repo.workspaceId !== machine.workspaceId || repo.archivedAt) {
      throw new Error("Repo not found for this machine workspace.");
    }

    const pr = await ctx.db
      .query("prs")
      .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", args.prNumber))
      .unique();

    if (!pr) {
      throw new Error("PR not found for this repo.");
    }

    const now = nowIso();
    const reviewId = await ctx.db.insert("reviews", {
      workspaceId: machine.workspaceId,
      prId: pr._id,
      reviewerId: args.reviewerId,
      source: args.source,
      confidenceScore: args.confidenceScore,
      summary: args.summary,
      rawOutput: args.rawOutput,
      createdAt: now,
      updatedAt: now,
    });

    const existingComments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    for (const comment of existingComments.filter((comment) => comment.reviewerId === args.reviewerId && !comment.supersededAt)) {
      await ctx.db.patch(comment._id, {
        status: "superseded",
        supersededAt: now,
        updatedAt: now,
      });
    }

    for (const comment of args.comments) {
      await ctx.db.insert("reviewComments", {
        workspaceId: machine.workspaceId,
        prId: pr._id,
        reviewId,
        reviewerId: args.reviewerId,
        path: comment.path,
        line: comment.line,
        body: comment.body,
        status: "new",
        analysisCategory: "UNTRIAGED",
        analysisReasoning: undefined,
        suggestion: comment.suggestion,
        publishedAt: undefined,
        supersededAt: undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.insert("timelineEvents", {
      workspaceId: machine.workspaceId,
      prId: pr._id,
      eventType: "review_completed",
      detail: {
        reviewerId: args.reviewerId,
        machineSlug: machine.slug,
        confidenceScore: args.confidenceScore ?? null,
        commentCount: args.comments.length,
      },
      createdAt: now,
    });

    await ctx.db.patch(pr._id, {
      updatedAt: now,
    });

    return await ctx.db.get(reviewId);
  },
});
