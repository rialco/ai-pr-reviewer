import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

async function getRepoAndPrForMachine(
  ctx: QueryCtx | MutationCtx,
  machineToken: string,
  repoId: Id<"repos">,
  prNumber: number,
) {
  const machine = await requireMachineByToken(ctx, machineToken);
  const repo = await ctx.db.get(repoId);

  if (!repo || repo.workspaceId !== machine.workspaceId || repo.archivedAt) {
    throw new Error("Repo not found for this machine workspace.");
  }

  const pr = await ctx.db
    .query("prs")
    .withIndex("by_repoId_prNumber", (q) => q.eq("repoId", repo._id).eq("prNumber", prNumber))
    .unique();

  if (!pr) {
    throw new Error("PR not found for this repo.");
  }

  return { machine, repo, pr };
}

function isBotComment(comment: { user: string }, botUsers: string[]) {
  return botUsers.includes(comment.user);
}

export const listPendingForMachine = query({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    const { repo, pr } = await getRepoAndPrForMachine(ctx, args.machineToken, args.repoId, args.prNumber);
    const comments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    return comments
      .filter(
        (comment) =>
          isBotComment(comment, repo.botUsers) &&
          (comment.status === undefined || comment.status === "new" || comment.status === "analyzing"),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
});

export const listFixableForMachine = query({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    const { repo, pr } = await getRepoAndPrForMachine(ctx, args.machineToken, args.repoId, args.prNumber);
    const comments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    return comments
      .filter(
        (comment) =>
          isBotComment(comment, repo.botUsers) &&
          comment.status === "fixing" &&
          (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX"),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
});

export const listReplyableForMachine = query({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    const { repo, pr } = await getRepoAndPrForMachine(ctx, args.machineToken, args.repoId, args.prNumber);
    const comments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();

    return comments
      .filter(
        (comment) =>
          isBotComment(comment, repo.botUsers) &&
          comment.type === "inline" &&
          comment.status === "fixed" &&
          !comment.repliedAt &&
          !!comment.fixCommitHash,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
});

export const applyAnalysisResults = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    analyzerAgent: v.union(v.literal("claude"), v.literal("codex")),
    results: v.array(
      v.object({
        commentId: v.id("githubComments"),
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
    const { machine, pr } = await getRepoAndPrForMachine(ctx, args.machineToken, args.repoId, args.prNumber);
    const now = nowIso();

    for (const result of args.results) {
      const target = await ctx.db.get(result.commentId);
      if (!target || target.prId !== pr._id) {
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
        analyzerAgent: args.analyzerAgent,
        machineSlug: machine.slug,
        count: args.results.length,
        categories: args.results.reduce<Record<string, number>>((acc, result) => {
          acc[result.category] = (acc[result.category] ?? 0) + 1;
          return acc;
        }, {}),
        source: "github_comments",
      },
      createdAt: now,
    });

    return { ok: true, analyzed: args.results.length };
  },
});

export const finalizeFixResults = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    fixerAgent: v.union(v.literal("claude"), v.literal("codex")),
    results: v.array(
      v.object({
        commentId: v.id("githubComments"),
        filesChanged: v.array(v.string()),
        commitHash: v.string(),
        commitMessage: v.string(),
        fixedAt: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { machine, repo, pr } = await getRepoAndPrForMachine(ctx, args.machineToken, args.repoId, args.prNumber);
    const comments = await ctx.db
      .query("githubComments")
      .withIndex("by_prId", (q) => q.eq("prId", pr._id))
      .collect();
    const activeFixingComments = comments.filter(
      (comment) =>
        isBotComment(comment, repo.botUsers) &&
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
        eventType: "fix_no_changes",
        detail: {
          fixerAgent: args.fixerAgent,
          machineSlug: machine.slug,
          commentCount: activeFixingComments.length,
          source: "github_comments",
        },
        createdAt: now,
      });

      return { ok: true, fixed: 0 };
    }

    for (const result of args.results) {
      const target = await ctx.db.get(result.commentId);
      if (!target || target.prId !== pr._id) {
        continue;
      }

      await ctx.db.patch(target._id, {
        status: "fixed",
        fixFilesChanged: result.filesChanged,
        fixCommitHash: result.commitHash,
        fixCommitMessage: result.commitMessage,
        fixFixedAt: result.fixedAt,
        updatedAt: result.fixedAt,
      });
    }

    const primaryResult = args.results[0];
    await ctx.db.insert("timelineEvents", {
      workspaceId: machine.workspaceId,
      prId: pr._id,
      eventType: "fix_completed",
      detail: {
        fixerAgent: args.fixerAgent,
        machineSlug: machine.slug,
        commentCount: args.results.length,
        commitHash: primaryResult.commitHash,
        filesChanged: primaryResult.filesChanged,
        source: "github_comments",
      },
      createdAt: primaryResult.fixedAt,
    });

    await ctx.db.patch(pr._id, {
      phase: "fixed",
      lastFixedAt: primaryResult.fixedAt,
      updatedAt: primaryResult.fixedAt,
      reviewCycle: (pr.reviewCycle ?? 0) + 1,
    });

    return { ok: true, fixed: args.results.length };
  },
});

export const markReplied = mutation({
  args: {
    machineToken: v.string(),
    repoId: v.id("repos"),
    prNumber: v.number(),
    replies: v.array(
      v.object({
        commentId: v.id("githubComments"),
        body: v.string(),
        repliedAt: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { machine, pr } = await getRepoAndPrForMachine(ctx, args.machineToken, args.repoId, args.prNumber);

    for (const reply of args.replies) {
      const target = await ctx.db.get(reply.commentId);
      if (!target || target.prId !== pr._id) {
        continue;
      }

      await ctx.db.patch(target._id, {
        repliedAt: reply.repliedAt,
        replyBody: reply.body,
        updatedAt: reply.repliedAt,
      });
    }

    const now = args.replies[0]?.repliedAt ?? nowIso();
    await ctx.db.insert("timelineEvents", {
      workspaceId: machine.workspaceId,
      prId: pr._id,
      eventType: "comments_replied",
      detail: {
        machineSlug: machine.slug,
        count: args.replies.length,
        commentIds: args.replies.map((reply) => reply.commentId),
        source: "github_comments",
      },
      createdAt: now,
    });

    await ctx.db.patch(pr._id, {
      updatedAt: now,
    });

    return { ok: true, replied: args.replies.length };
  },
});

export const recategorizeForWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    commentId: v.id("githubComments"),
    category: v.union(
      v.literal("MUST_FIX"),
      v.literal("SHOULD_FIX"),
      v.literal("NICE_TO_HAVE"),
      v.literal("DISMISS"),
      v.literal("ALREADY_ADDRESSED"),
    ),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const comment = await ctx.db.get(args.commentId);

    if (!comment || comment.workspaceId !== args.workspaceId) {
      throw new Error("Comment not found.");
    }

    const now = nowIso();
    await ctx.db.patch(comment._id, {
      status: "analyzed",
      analysisCategory: args.category,
      updatedAt: now,
    });

    await ctx.db.insert("timelineEvents", {
      workspaceId: args.workspaceId,
      prId: comment.prId,
      eventType: "comment_recategorized",
      detail: {
        commentId: comment._id,
        githubCommentId: comment.githubCommentId,
        category: args.category,
        source: "github_comments",
      },
      createdAt: now,
    });

    return { ok: true };
  },
});
