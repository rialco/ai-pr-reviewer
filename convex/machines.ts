import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireWorkspaceAccess } from "./lib/auth";

export const listForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const machines = await ctx.db
      .query("machines")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    return machines.sort((a, b) => b.lastHeartbeatAt.localeCompare(a.lastHeartbeatAt));
  },
});
