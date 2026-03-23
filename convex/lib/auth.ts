import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { UserIdentity } from "convex/server";
import type { Id } from "../_generated/dataModel";

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function displayNameFromIdentity(identity: UserIdentity): string {
  return identity.name ?? identity.email ?? identity.nickname ?? identity.subject;
}

export function workspaceNameFromIdentity(identity: UserIdentity): string {
  return `${displayNameFromIdentity(identity)}'s Workspace`;
}

export function workspaceSlugFromIdentity(identity: UserIdentity): string {
  const base =
    identity.email?.split("@")[0] ??
    identity.nickname ??
    identity.givenName ??
    identity.subject;
  return slugify(base) || "workspace";
}

export async function requireIdentity(ctx: QueryCtx | MutationCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }
  return identity;
}

export async function requireWorkspaceAccess(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
) {
  const identity = await requireIdentity(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();

  if (!user) {
    throw new Error("Current user is not initialized in Convex.");
  }

  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspaceId_userId", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", user._id),
    )
    .unique();

  if (!membership) {
    throw new Error("Forbidden");
  }

  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  return { identity, user, membership, workspace };
}
