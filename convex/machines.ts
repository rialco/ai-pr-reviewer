import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

const MACHINE_STALE_AFTER_MS = 2 * 60_000;

function makeSecretToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

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

    return machines
      .sort((a, b) => b.lastHeartbeatAt.localeCompare(a.lastHeartbeatAt))
      .map(({ authToken: _authToken, ...machine }) => ({
        ...machine,
        status:
          Date.now() - Date.parse(machine.lastHeartbeatAt) > MACHINE_STALE_AFTER_MS
            ? "offline"
            : machine.status,
      }));
  },
});

export const listEnrollmentTokensForWorkspace = query({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);

    const now = nowIso();
    const tokens = await ctx.db
      .query("machineEnrollmentTokens")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    return tokens
      .filter((token) => !token.revokedAt && !token.claimedAt && token.expiresAt > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

export const createEnrollmentToken = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    label: v.optional(v.string()),
    ttlMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireWorkspaceAccess(ctx, args.workspaceId);
    const now = nowIso();
    const ttlMinutes = Math.max(5, Math.min(args.ttlMinutes ?? 30, 24 * 60));
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const token = makeSecretToken("enroll");

    const tokenId = await ctx.db.insert("machineEnrollmentTokens", {
      workspaceId: args.workspaceId,
      token,
      label: args.label?.trim() || undefined,
      createdByUserId: user._id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(tokenId);
  },
});

export const revokeEnrollmentToken = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    tokenId: v.id("machineEnrollmentTokens"),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspaceId);
    const token = await ctx.db.get(args.tokenId);
    if (!token || token.workspaceId !== args.workspaceId) {
      throw new Error("Enrollment token not found.");
    }

    await ctx.db.patch(args.tokenId, {
      revokedAt: nowIso(),
      updatedAt: nowIso(),
    });

    return { ok: true };
  },
});

export const registerWithEnrollmentToken = mutation({
  args: {
    enrollmentToken: v.string(),
    machineSlug: v.string(),
    machineName: v.string(),
    hostname: v.optional(v.string()),
    platform: v.optional(v.string()),
    version: v.optional(v.string()),
    capabilities: v.object({
      git: v.boolean(),
      gh: v.boolean(),
      claude: v.boolean(),
      codex: v.boolean(),
    }),
  },
  handler: async (ctx, args) => {
    const now = nowIso();
    const enrollment = await ctx.db
      .query("machineEnrollmentTokens")
      .withIndex("by_token", (q) => q.eq("token", args.enrollmentToken))
      .unique();

    if (!enrollment) {
      throw new Error("Enrollment token is invalid.");
    }
    if (enrollment.revokedAt) {
      throw new Error("Enrollment token was revoked.");
    }
    if (enrollment.claimedAt) {
      throw new Error("Enrollment token was already used.");
    }
    if (enrollment.expiresAt <= now) {
      throw new Error("Enrollment token expired.");
    }

    const machineToken = makeSecretToken("machine");
    const existing = await ctx.db
      .query("machines")
      .withIndex("by_workspaceId_slug", (q) =>
        q.eq("workspaceId", enrollment.workspaceId).eq("slug", args.machineSlug),
      )
      .unique();

    let machineId = existing?._id;

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.machineName,
        authToken: machineToken,
        hostname: args.hostname,
        platform: args.platform,
        version: args.version,
        status: "idle",
        capabilities: args.capabilities,
        lastHeartbeatAt: now,
        updatedAt: now,
      });
    } else {
      machineId = await ctx.db.insert("machines", {
        workspaceId: enrollment.workspaceId,
        slug: args.machineSlug,
        name: args.machineName,
        authToken: machineToken,
        hostname: args.hostname,
        platform: args.platform,
        version: args.version,
        status: "idle",
        capabilities: args.capabilities,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!machineId) {
      throw new Error("Failed to register machine.");
    }

    await ctx.db.patch(enrollment._id, {
      claimedMachineId: machineId,
      claimedAt: now,
      updatedAt: now,
    });

    const machine = await ctx.db.get(machineId);
    if (!machine) {
      throw new Error("Registered machine could not be loaded.");
    }

    return {
      machineId,
      machineToken,
      workspaceId: enrollment.workspaceId,
      machine: {
        ...machine,
        authToken: undefined,
      },
    };
  },
});

export const heartbeat = mutation({
  args: {
    machineToken: v.string(),
    status: v.union(v.literal("offline"), v.literal("idle"), v.literal("busy"), v.literal("error")),
    currentJobLabel: v.optional(v.string()),
    version: v.optional(v.string()),
    capabilities: v.optional(
      v.object({
        git: v.boolean(),
        gh: v.boolean(),
        claude: v.boolean(),
        codex: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const now = nowIso();
    await ctx.db.patch(machine._id, {
      status: args.status,
      currentJobLabel: args.currentJobLabel,
      version: args.version ?? machine.version,
      capabilities: args.capabilities ?? machine.capabilities,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    return {
      ok: true,
      machineId: machine._id,
      workspaceId: machine.workspaceId,
      lastHeartbeatAt: now,
    };
  },
});
