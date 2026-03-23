import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { nowIso, requireWorkspaceAccess } from "./lib/auth";
import { requireMachineByToken } from "./lib/machineAuth";

const machineJobStepValidator = v.array(
  v.object({
    step: v.string(),
    detail: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("done"), v.literal("error")),
    ts: v.string(),
  }),
);

export const listForWorkspace = query({
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

export const enqueue = mutation({
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

export const enqueueMachineSelfCheck = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    machineSlug: v.string(),
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
      throw new Error("Machine not found in this workspace.");
    }

    const now = nowIso();
    const jobId = await ctx.db.insert("jobs", {
      workspaceId: args.workspaceId,
      createdByUserId: user._id,
      kind: "machine_command",
      status: "queued",
      targetMachineSlug: machine.slug,
      title: `Self-check ${machine.name}`,
      payload: {
        command: "self_check",
      },
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(jobId);
  },
});

export const claimNextForMachine = mutation({
  args: {
    machineToken: v.string(),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const now = nowIso();

    if (machine.currentJobId) {
      const currentJob = await ctx.db.get(machine.currentJobId);

      if (
        currentJob &&
        currentJob.claimedByMachineId === machine._id &&
        (currentJob.status === "claimed" || currentJob.status === "running")
      ) {
        await ctx.db.patch(machine._id, {
          status: "busy",
          currentJobId: currentJob._id,
          currentJobLabel: currentJob.title,
          lastHeartbeatAt: now,
          updatedAt: now,
        });
        return currentJob;
      }

      await ctx.db.patch(machine._id, {
        currentJobId: undefined,
        currentJobLabel: undefined,
        status: "idle",
        updatedAt: now,
      });
    }

    const queuedJobs = await ctx.db
      .query("jobs")
      .withIndex("by_workspaceId_status_createdAt", (q) =>
        q.eq("workspaceId", machine.workspaceId).eq("status", "queued"),
      )
      .collect();

    const nextJob = queuedJobs
      .filter((job) => !job.targetMachineSlug || job.targetMachineSlug === machine.slug)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

    if (!nextJob) {
      return null;
    }

    await ctx.db.patch(nextJob._id, {
      status: "running",
      claimedByMachineId: machine._id,
      claimedAt: now,
      startedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    });

    await ctx.db.patch(machine._id, {
      status: "busy",
      currentJobId: nextJob._id,
      currentJobLabel: nextJob.title,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    const existingRuns = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", nextJob._id))
      .collect();
    const runningRun = existingRuns.find((run) => run.status === "running");

    if (runningRun) {
      await ctx.db.patch(runningRun._id, {
        machineSlug: machine.slug,
        status: "running",
        steps: [
          {
            step: "claim",
            detail: `Claimed by ${machine.name}`,
            status: "done",
            ts: now,
          },
          {
            step: "dispatch",
            detail: nextJob.title,
            status: "active",
            ts: now,
          },
        ],
        output: [],
        startedAt: now,
      });
    } else {
      await ctx.db.insert("jobRuns", {
        workspaceId: machine.workspaceId,
        jobId: nextJob._id,
        machineSlug: machine.slug,
        status: "running",
        steps: [
          {
            step: "claim",
            detail: `Claimed by ${machine.name}`,
            status: "done",
            ts: now,
          },
          {
            step: "dispatch",
            detail: nextJob.title,
            status: "active",
            ts: now,
          },
        ],
        output: [],
        startedAt: now,
      });
    }

    return await ctx.db.get(nextJob._id);
  },
});

export const completeMachineJob = mutation({
  args: {
    machineToken: v.string(),
    jobId: v.id("jobs"),
    output: v.array(v.string()),
    steps: machineJobStepValidator,
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const job = await ctx.db.get(args.jobId);

    if (!job || job.workspaceId !== machine.workspaceId) {
      throw new Error("Job not found for this machine.");
    }

    if (job.claimedByMachineId !== machine._id) {
      throw new Error("Job is not claimed by this machine.");
    }

    const now = nowIso();
    await ctx.db.patch(args.jobId, {
      status: "done",
      finishedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    });

    await ctx.db.patch(machine._id, {
      status: "idle",
      currentJobId: undefined,
      currentJobLabel: undefined,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    const runs = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const currentRun = runs.find((run) => run.status === "running") ?? runs[0];

    if (currentRun) {
      await ctx.db.patch(currentRun._id, {
        machineSlug: machine.slug,
        status: "done",
        steps: args.steps,
        output: args.output,
        finishedAt: now,
      });
    }

    return {
      ok: true,
      finishedAt: now,
    };
  },
});

export const failMachineJob = mutation({
  args: {
    machineToken: v.string(),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
    output: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const machine = await requireMachineByToken(ctx, args.machineToken);
    const job = await ctx.db.get(args.jobId);

    if (!job || job.workspaceId !== machine.workspaceId) {
      throw new Error("Job not found for this machine.");
    }

    if (job.claimedByMachineId !== machine._id) {
      throw new Error("Job is not claimed by this machine.");
    }

    const now = nowIso();
    await ctx.db.patch(args.jobId, {
      status: "error",
      finishedAt: now,
      errorMessage: args.errorMessage,
      updatedAt: now,
    });

    await ctx.db.patch(machine._id, {
      status: "idle",
      currentJobId: undefined,
      currentJobLabel: undefined,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    const runs = await ctx.db
      .query("jobRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const currentRun = runs.find((run) => run.status === "running") ?? runs[0];

    if (currentRun) {
      await ctx.db.patch(currentRun._id, {
        machineSlug: machine.slug,
        status: "error",
        steps: [
          ...currentRun.steps.filter((step) => step.status !== "active"),
          {
            step: "error",
            detail: args.errorMessage,
            status: "error",
            ts: now,
          },
        ],
        output: args.output ?? [],
        finishedAt: now,
      });
    }

    return {
      ok: true,
      finishedAt: now,
    };
  },
});
