import type { MutationCtx } from "../_generated/server";

export async function requireMachineByToken(ctx: MutationCtx, machineToken: string) {
  const machine = await ctx.db
    .query("machines")
    .withIndex("by_authToken", (q) => q.eq("authToken", machineToken))
    .unique();

  if (!machine) {
    throw new Error("Machine token is invalid.");
  }

  return machine;
}
