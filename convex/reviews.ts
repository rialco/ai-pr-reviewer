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

export const listCommentsForMachine = query({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
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

    const comments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    return comments
      .filter(
        (comment) =>
          comment.reviewerId === args.reviewerId &&
          !comment.supersededAt &&
          (comment.status === "new" || comment.status === "analyzing"),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
});

export const listFixableCommentsForMachine = query({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
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

    const comments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    return comments
      .filter(
        (comment) =>
          comment.reviewerId === args.reviewerId &&
          !comment.supersededAt &&
          comment.status === "fixing" &&
          (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX"),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
});

export const getPublishableReviewBundleForMachine = query({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
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

    const [reviews, comments] = await Promise.all([
      ctx.db
        .query("reviews")
        .withIndex("by_prId_reviewer", (q) => q.eq("prId", pr._id).eq("reviewerId", args.reviewerId))
        .collect(),
      ctx.db
        .query("reviewComments")
        .withIndex("by_prId", (q) => q.eq("prId", pr._id))
        .collect(),
    ]);
    const latestReview = reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    const publishableComments = comments
      .filter(
        (comment) =>
          comment.reviewerId === args.reviewerId &&
          !comment.supersededAt &&
          !comment.publishedAt &&
          comment.status === "analyzed" &&
          comment.analysisCategory !== "DISMISS" &&
          comment.analysisCategory !== "ALREADY_ADDRESSED",
      )
      .sort((a, b) => {
        const pathCompare = a.path.localeCompare(b.path);
        if (pathCompare !== 0) return pathCompare;
        return a.line - b.line;
      });

    return {
      review: latestReview,
      comments: publishableComments,
    };
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
        reviewSeverity: comment.severity,
        reviewConfidence: comment.confidence,
        reviewEvidence: comment.evidence,
        analysisCategory: "UNTRIAGED",
        analysisReasoning: undefined,
        analysisDetails: undefined,
        suggestion: comment.suggestion,
        publishedAt: undefined,
        supersededAt: undefined,
        fixCommitHash: undefined,
        fixFilesChanged: undefined,
        fixFixedAt: undefined,
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

export const applyReviewCommentAnalysisResults = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
    analyzerAgent: v.union(v.literal("claude"), v.literal("codex")),
    results: v.array(
      v.object({
        commentId: v.id("reviewComments"),
        category: v.union(
          v.literal("MUST_FIX"),
          v.literal("SHOULD_FIX"),
          v.literal("NICE_TO_HAVE"),
          v.literal("DISMISS"),
          v.literal("ALREADY_ADDRESSED"),
        ),
        reasoning: v.string(),
        verdict: v.optional(
          v.union(v.literal("ACTIONABLE"), v.literal("DISMISS"), v.literal("ALREADY_ADDRESSED")),
        ),
        severity: v.optional(
          v.union(v.literal("MUST_FIX"), v.literal("SHOULD_FIX"), v.literal("NICE_TO_HAVE"), v.null()),
        ),
        confidence: v.optional(v.union(v.number(), v.null())),
        accessMode: v.optional(v.union(v.literal("FULL_CODEBASE"), v.literal("DIFF_ONLY"))),
        evidence: v.optional(
          v.union(
            v.object({
              filesRead: v.array(v.string()),
              symbolsChecked: v.array(v.string()),
              callersChecked: v.array(v.string()),
              testsChecked: v.array(v.string()),
              riskSummary: v.optional(v.string()),
              validationNotes: v.optional(v.string()),
            }),
            v.null(),
          ),
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
    for (const result of args.results) {
      const target = await ctx.db.get(result.commentId);

      if (!target || target.prId !== pr._id || target.reviewerId !== args.reviewerId || target.supersededAt) {
        continue;
      }

      await ctx.db.patch(target._id, {
        status: "analyzed",
        analysisCategory: result.category,
        analysisReasoning: result.reasoning,
        analysisDetails: {
          verdict: result.verdict,
          severity: result.severity,
          confidence: result.confidence,
          accessMode: result.accessMode,
          evidence: result.evidence,
        },
        updatedAt: now,
      });
    }

    await ctx.db.insert("timelineEvents", {
      workspaceId: machine.workspaceId,
      prId: pr._id,
      eventType: "comments_analyzed",
      detail: {
        reviewerId: args.reviewerId,
        analyzerAgent: args.analyzerAgent,
        machineSlug: machine.slug,
        count: args.results.length,
        categories: args.results.reduce<Record<string, number>>((acc, result) => {
          acc[result.category] = (acc[result.category] ?? 0) + 1;
          return acc;
        }, {}),
        source: "local_review_comments",
      },
      createdAt: now,
    });

    return { ok: true, analyzed: args.results.length };
  },
});

export const finalizeReviewCommentFixResults = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
    fixerAgent: v.union(v.literal("claude"), v.literal("codex")),
    results: v.array(
      v.object({
        commentId: v.id("reviewComments"),
        filesChanged: v.array(v.string()),
        commitHash: v.string(),
        commitMessage: v.string(),
        fixedAt: v.string(),
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

    const comments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const activeFixingComments = comments.filter(
      (comment) =>
        comment.reviewerId === args.reviewerId &&
        !comment.supersededAt &&
        comment.status === "fixing",
    );

    if (args.results.length === 0) {
      const now = nowIso();
      for (const comment of activeFixingComments) {
        await ctx.db.patch(comment._id, {
          status: "analyzed",
          updatedAt: now,
        });
      }

      await ctx.db.insert("timelineEvents", {
        workspaceId: machine.workspaceId,
        prId: pr._id,
        eventType: "local_fix_no_changes",
        detail: {
          reviewerId: args.reviewerId,
          fixerAgent: args.fixerAgent,
          machineSlug: machine.slug,
          commentCount: activeFixingComments.length,
        },
        createdAt: now,
      });

      return { ok: true, fixed: 0 };
    }

    const primaryResult = args.results[0];
    for (const comment of activeFixingComments) {
      await ctx.db.patch(comment._id, {
        status: "fixed",
        fixCommitHash: primaryResult.commitHash,
        fixFilesChanged: primaryResult.filesChanged,
        fixFixedAt: primaryResult.fixedAt,
        updatedAt: primaryResult.fixedAt,
      });
    }

    await ctx.db.insert("timelineEvents", {
      workspaceId: machine.workspaceId,
      prId: pr._id,
      eventType: "local_fix_completed",
      detail: {
        reviewerId: args.reviewerId,
        fixerAgent: args.fixerAgent,
        machineSlug: machine.slug,
        commentCount: activeFixingComments.length,
        commitHash: primaryResult.commitHash,
        filesChanged: primaryResult.filesChanged,
      },
      createdAt: primaryResult.fixedAt,
    });

    await ctx.db.patch(pr._id, {
      phase: "fixed",
      lastFixedAt: primaryResult.fixedAt,
      updatedAt: primaryResult.fixedAt,
      reviewCycle: (pr.reviewCycle ?? 0) + 1,
    });

    return { ok: true, fixed: activeFixingComments.length };
  },
});

export const markReviewCommentsPublished = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    reviewerId: v.union(v.literal("claude"), v.literal("codex")),
    event: v.union(v.literal("COMMENT"), v.literal("REQUEST_CHANGES")),
    publishedAt: v.string(),
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

    const comments = await ctx.db
      .query("reviewComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const publishableComments = comments.filter(
      (comment) =>
        comment.reviewerId === args.reviewerId &&
        !comment.supersededAt &&
        !comment.publishedAt &&
        comment.status === "analyzed" &&
        comment.analysisCategory !== "DISMISS" &&
        comment.analysisCategory !== "ALREADY_ADDRESSED",
    );

    for (const comment of publishableComments) {
      await ctx.db.patch(comment._id, {
        publishedAt: args.publishedAt,
        updatedAt: args.publishedAt,
      });
    }

    await ctx.db.insert("timelineEvents", {
      workspaceId: machine.workspaceId,
      prId: pr._id,
      eventType: "review_published",
      detail: {
        reviewerId: args.reviewerId,
        machineSlug: machine.slug,
        commentCount: publishableComments.length,
        event: args.event,
      },
      createdAt: args.publishedAt,
    });

    await ctx.db.patch(pr._id, {
      updatedAt: args.publishedAt,
    });

    return { ok: true, published: publishableComments.length };
  },
});
