import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";

export const listForWorkspace = queryGeneric({
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

export const enqueue = mutationGeneric({
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
