import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";

export const listForWorkspace = queryGeneric({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const repos = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    return repos
      .filter((repo) => !repo.archivedAt)
      .sort((a, b) => a.label.localeCompare(b.label));
  },
});

export const upsert = mutationGeneric({
  args: {
    workspaceId: v.id("workspaces"),
    owner: v.string(),
    repo: v.string(),
    botUsers: v.optional(v.array(v.string())),
    defaultBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const now = nowIso();
    const label = `${args.owner}/${args.repo}`;

    const existingRepos = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const existing = existingRepos.find((repo) => repo.label === label);

    const nextFields = {
      workspaceId: args.workspaceId,
      owner: args.owner,
      repo: args.repo,
      label,
      botUsers: args.botUsers ?? [],
      defaultBranch: args.defaultBranch,
      updatedAt: now,
      archivedAt: undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, nextFields);
      return await ctx.db.get(existing._id);
    }

    const repoId = await ctx.db.insert("repos", {
      ...nextFields,
      createdByUserId: user._id,
      createdAt: now,
    });
    return await ctx.db.get(repoId);
  },
});

export const remove = mutationGeneric({
  args: {
    workspaceId: v.id("workspaces"),
    repoId: v.id("repos"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const repo = await ctx.db.get(args.repoId);
    if (!repo || repo.workspaceId !== args.workspaceId) {
      throw new Error("Repo not found.");
    }

    const now = nowIso();
    await ctx.db.patch(args.repoId, {
      archivedAt: now,
      updatedAt: now,
    });

    return { ok: true };
  },
});
