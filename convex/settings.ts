import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";

const MACHINE_STALE_AFTER_MS = 2 * 60_000;

const DEFAULT_SETTINGS = {
  autoReReview: false,
  coordinatorEnabled: false,
  coordinatorAgent: "claude" as const,
  defaultAnalyzerAgent: "claude" as const,
  defaultFixerAgent: "claude" as const,
  defaultReviewerIds: ["claude", "codex"],
};

async function getOrDefaultSettings(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
) {
  const settings = await ctx.db
    .query("workspaceSettings")
    .withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId))
    .unique();

  if (!settings) {
    return {
      workspaceId,
      ...DEFAULT_SETTINGS,
      createdAt: null,
      updatedAt: null,
    };
  }

  return settings;
}

export const getForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    return getOrDefaultSettings(ctx, args.workspaceId);
  },
});

export const updateForWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    autoReReview: v.optional(v.boolean()),
    coordinatorEnabled: v.optional(v.boolean()),
    coordinatorAgent: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    defaultAnalyzerAgent: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    defaultFixerAgent: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    defaultReviewerIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const now = nowIso();
    const existing = await ctx.db
      .query("workspaceSettings")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    const nextFields = {
      autoReReview: args.autoReReview ?? existing?.autoReReview ?? DEFAULT_SETTINGS.autoReReview,
      coordinatorEnabled:
        args.coordinatorEnabled ?? existing?.coordinatorEnabled ?? DEFAULT_SETTINGS.coordinatorEnabled,
      coordinatorAgent:
        args.coordinatorAgent ?? existing?.coordinatorAgent ?? DEFAULT_SETTINGS.coordinatorAgent,
      defaultAnalyzerAgent:
        args.defaultAnalyzerAgent ??
        existing?.defaultAnalyzerAgent ??
        DEFAULT_SETTINGS.defaultAnalyzerAgent,
      defaultFixerAgent:
        args.defaultFixerAgent ?? existing?.defaultFixerAgent ?? DEFAULT_SETTINGS.defaultFixerAgent,
      defaultReviewerIds:
        (args.defaultReviewerIds?.length ? args.defaultReviewerIds : undefined) ??
        existing?.defaultReviewerIds ??
        DEFAULT_SETTINGS.defaultReviewerIds,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, nextFields);
      return await ctx.db.get(existing._id);
    }

    const settingsId = await ctx.db.insert("workspaceSettings", {
      workspaceId: args.workspaceId,
      ...nextFields,
      createdAt: now,
    });
    return await ctx.db.get(settingsId);
  },
});

export const listAvailableReviewers = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const machines = await ctx.db
      .query("machines")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const availableMachines = machines.filter(
      (machine) => Date.now() - Date.parse(machine.lastHeartbeatAt) <= MACHINE_STALE_AFTER_MS,
    );

    const hasClaude = availableMachines.some((machine) => machine.capabilities.claude);
    const hasCodex = availableMachines.some((machine) => machine.capabilities.codex);

    return [
      {
        id: "claude",
        displayName: "Claude Code",
        type: "local-ai" as const,
        available: hasClaude,
      },
      {
        id: "codex",
        displayName: "Codex",
        type: "local-ai" as const,
        available: hasCodex,
      },
      {
        id: "greptile",
        displayName: "Greptile",
        type: "bot" as const,
        available: false,
      },
    ];
  },
});
