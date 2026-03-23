import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";

const MACHINE_STALE_AFTER_MS = 2 * 60_000;

export const listForWorkspace = query({
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

export const upsert = mutation({
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

    const existing = await ctx.db
      .query("repos")
      .withIndex("by_workspaceId_label", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("label", label),
      )
      .unique();

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

export const remove = mutation({
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

export const listMachineConfigsForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const configs = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const hydrated = await Promise.all(
      configs.map(async (config) => {
        const repo = await ctx.db.get(config.repoId);
        if (!repo || repo.workspaceId !== args.workspaceId || repo.archivedAt) {
          return null;
        }

        const machine = await ctx.db
          .query("machines")
          .withIndex("by_workspaceId_slug", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("slug", config.machineSlug),
          )
          .unique();

        return {
          ...config,
          repoLabel: repo.label,
          repoOwner: repo.owner,
          repoName: repo.repo,
          machineName: machine?.name ?? config.machineSlug,
          machineStatus:
            machine && Date.now() - Date.parse(machine.lastHeartbeatAt) <= MACHINE_STALE_AFTER_MS
              ? machine.status
              : "offline",
        };
      }),
    );

    return hydrated
      .filter((config) => config !== null)
      .sort((a, b) => a.repoLabel.localeCompare(b.repoLabel));
  },
});

export const upsertMachineConfig = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    repoId: v.id("repos"),
    machineSlug: v.string(),
    localPath: v.string(),
    skipTypecheck: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

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
      throw new Error("Machine not found.");
    }

    const now = nowIso();
    const existing = await ctx.db
      .query("repoMachineConfigs")
      .withIndex("by_repoId_machineSlug", (q) =>
        q.eq("repoId", args.repoId).eq("machineSlug", args.machineSlug),
      )
      .unique();

    const nextFields = {
      workspaceId: args.workspaceId,
      machineSlug: args.machineSlug,
      localPath: args.localPath.trim(),
      skipTypecheck: args.skipTypecheck ?? false,
      lastSeenAt: now,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, nextFields);
      return await ctx.db.get(existing._id);
    }

    const configId = await ctx.db.insert("repoMachineConfigs", {
      repoId: args.repoId,
      ...nextFields,
      createdAt: now,
    });

    return await ctx.db.get(configId);
  },
});
