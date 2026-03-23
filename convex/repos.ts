import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

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

export const requestCheckoutProbe = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    machineSlug: v.string(),
    requestedPath: v.string(),
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
      throw new Error("Machine not found.");
    }

    const requestedPath = args.requestedPath.trim();
    if (!requestedPath) {
      throw new Error("A local path is required.");
    }

    const now = nowIso();
    const probeId = await ctx.db.insert("checkoutProbes", {
      workspaceId: args.workspaceId,
      machineSlug: args.machineSlug,
      requestedPath,
      status: "queued",
      createdByUserId: user._id,
      createdAt: now,
      updatedAt: now,
    });

    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      createdByUserId: user._id,
      kind: "machine_command",
      status: "queued",
      targetMachineSlug: args.machineSlug,
      title: `Inspect checkout ${requestedPath}`,
      payload: {
        command: "probe_checkout",
        probeId,
        requestedPath,
      },
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(probeId, {
      jobId,
      updatedAt: now,
    });

    return await ctx.db.get(probeId);
  },
});

export const getCheckoutProbe = query({
  args: {
    workspaceId: v.id("workspaces"),
    probeId: v.id("checkoutProbes"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const probe = await ctx.db.get(args.probeId);
    if (!probe || probe.workspaceId !== args.workspaceId) {
      return null;
    }
    return probe;
  },
});

export const markCheckoutProbeRunning = mutation({
  args: {
    machineToken: v.string(),
    probeId: v.id("checkoutProbes"),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const probe = await ctx.db.get(args.probeId);

    if (!probe || probe.workspaceId !== machine.workspaceId || probe.machineSlug !== machine.slug) {
      throw new Error("Checkout probe not found for this machine.");
    }

    await ctx.db.patch(probe._id, {
      status: "running",
      errorMessage: undefined,
      updatedAt: nowIso(),
    });

    return { ok: true };
  },
});

export const completeCheckoutProbe = mutation({
  args: {
    machineToken: v.string(),
    probeId: v.id("checkoutProbes"),
    normalizedPath: v.string(),
    owner: v.string(),
    repo: v.string(),
    remoteUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const probe = await ctx.db.get(args.probeId);

    if (!probe || probe.workspaceId !== machine.workspaceId || probe.machineSlug !== machine.slug) {
      throw new Error("Checkout probe not found for this machine.");
    }

    await ctx.db.patch(probe._id, {
      normalizedPath: args.normalizedPath,
      owner: args.owner,
      repo: args.repo,
      remoteUrl: args.remoteUrl,
      status: "ready",
      errorMessage: undefined,
      updatedAt: nowIso(),
    });

    return await ctx.db.get(probe._id);
  },
});

export const failCheckoutProbe = mutation({
  args: {
    machineToken: v.string(),
    probeId: v.id("checkoutProbes"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const probe = await ctx.db.get(args.probeId);

    if (!probe || probe.workspaceId !== machine.workspaceId || probe.machineSlug !== machine.slug) {
      throw new Error("Checkout probe not found for this machine.");
    }

    await ctx.db.patch(probe._id, {
      status: "error",
      errorMessage: args.errorMessage,
      updatedAt: nowIso(),
    });

    return await ctx.db.get(probe._id);
  },
});
