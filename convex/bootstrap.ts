import { mutation, query } from "./_generated/server";
import {
  displayNameFromIdentity,
  nowIso,
  requireIdentity,
  workspaceNameFromIdentity,
  workspaceSlugFromIdentity,
} from "./lib/auth";

export const ensureCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const now = nowIso();

    let user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    const nextUserFields = {
      clerkSubject: identity.subject,
      tokenIdentifier: identity.tokenIdentifier,
      email: identity.email,
      name: displayNameFromIdentity(identity),
      imageUrl: identity.pictureUrl,
      lastSeenAt: now,
      updatedAt: now,
    };

    if (user) {
      await ctx.db.patch(user._id, nextUserFields);
    } else {
      const userId = await ctx.db.insert("users", {
        ...nextUserFields,
        createdAt: now,
      });
      user = await ctx.db.get(userId);
    }

    if (!user) {
      throw new Error("Failed to create or load the current user.");
    }

    const workspaceSlug = workspaceSlugFromIdentity(identity);
    let workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", workspaceSlug))
      .unique();

    if (!workspace) {
      const workspaceId = await ctx.db.insert("workspaces", {
        slug: workspaceSlug,
        name: workspaceNameFromIdentity(identity),
        kind: "personal",
        ownerUserId: user._id,
        createdAt: now,
        updatedAt: now,
      });
      workspace = await ctx.db.get(workspaceId);
    }

    if (!workspace) {
      throw new Error("Failed to create or load the default workspace.");
    }

    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspace._id))
      .collect();

    const membership = memberships.find((entry) => entry.userId === user._id);

    if (!membership) {
      await ctx.db.insert("workspaceMembers", {
        workspaceId: workspace._id,
        userId: user._id,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      user,
      workspace,
    };
  },
});

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (!user) {
      return {
        identity,
        user: null,
        workspaces: [],
      };
    }

    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();

    const workspaces = await Promise.all(
      memberships.map(async (membership) => {
        const workspace = await ctx.db.get(membership.workspaceId);
        if (!workspace) {
          return null;
        }

        return {
          ...workspace,
          role: membership.role,
        };
      }),
    );

    return {
      identity,
      user,
      workspaces: workspaces.filter((workspace) => workspace !== null),
    };
  },
});
