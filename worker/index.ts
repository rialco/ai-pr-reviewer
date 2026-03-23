import os from "os";
import { execFileSync } from "child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import {
  loadWorkerConfig,
  readWorkerSession,
  writeWorkerSession,
  type WorkerSession,
} from "./config";

function detectCapabilities() {
  const hasBinary = (binary: string) => {
    try {
      execFileSync("which", [binary], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  return {
    git: hasBinary("git"),
    gh: hasBinary("gh"),
    claude: hasBinary("claude"),
    codex: hasBinary("codex"),
  };
}

async function registerMachine(client: ConvexHttpClient, config: ReturnType<typeof loadWorkerConfig>) {
  if (!config.enrollmentToken) {
    throw new Error(
      "No machine session is stored and WORKER_ENROLLMENT_TOKEN is missing. Create an enrollment token in the app first.",
    );
  }

  const result = await client.mutation(api.machines.registerWithEnrollmentToken, {
    enrollmentToken: config.enrollmentToken,
    machineSlug: config.machineSlug,
    machineName: config.machineName,
    hostname: os.hostname(),
    platform: `${process.platform}/${process.arch}`,
    version: config.version,
    capabilities: detectCapabilities(),
  });

  writeWorkerSession(config.sessionPath, {
    machineId: result.machineId,
    machineToken: result.machineToken,
    workspaceId: result.workspaceId,
  });

  return result;
}

async function sendHeartbeat(
  client: ConvexHttpClient,
  machineToken: string,
  status: "idle" | "busy" | "error" | "offline",
  version: string,
  currentJobLabel?: string,
) {
  return client.mutation(api.machines.heartbeat, {
    machineToken,
    status,
    version,
    currentJobLabel,
    capabilities: detectCapabilities(),
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

interface ClaimedMachineJob {
  kind: string;
  payload: unknown;
}

async function executeJob(session: WorkerSession, job: ClaimedMachineJob) {
  if (job.kind !== "machine_command") {
    throw new Error(`Unsupported job kind: ${job.kind}`);
  }

  const payload =
    job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : null;
  const command = typeof payload?.command === "string" ? payload.command : null;

  if (command !== "self_check") {
    throw new Error(`Unsupported machine command: ${command ?? "unknown"}`);
  }

  const capabilities = detectCapabilities();
  const now = new Date().toISOString();

  return {
    output: [
      `[self-check] completed at ${now}`,
      `[self-check] machine=${session.machineId}`,
      `[self-check] workspace=${session.workspaceId}`,
      `[self-check] hostname=${os.hostname()}`,
      `[self-check] platform=${process.platform}/${process.arch}`,
      `[self-check] cwd=${process.cwd()}`,
      `[self-check] capabilities=${JSON.stringify(capabilities)}`,
    ],
    steps: [
      {
        step: "claim",
        detail: `Claimed by ${os.hostname()}`,
        status: "done" as const,
        ts: now,
      },
      {
        step: "self_check",
        detail: "Collected machine identity and local capability snapshot",
        status: "done" as const,
        ts: now,
      },
    ],
  };
}

async function main() {
  const config = loadWorkerConfig();
  const client = new ConvexHttpClient(config.convexUrl);
  let session = readWorkerSession(config.sessionPath);
  let currentStatus: "idle" | "busy" | "error" | "offline" = "idle";
  let currentJobLabel = "Awaiting jobs";
  let isExecutingJob = false;

  console.log("[worker] Starting cloud worker");
  console.log(`[worker] machine=${config.machineName} slug=${config.machineSlug}`);
  console.log(`[worker] hostname=${os.hostname()}`);

  if (!session) {
    const registered = await registerMachine(client, config);
    console.log("[worker] Machine registered with Convex");
    console.log(`[worker] registeredMachineId=${registered.machineId}`);
    session = readWorkerSession(config.sessionPath);
  }

  if (!session) {
    throw new Error("Worker session was not persisted after registration.");
  }

  console.log(`[worker] workspace=${session.workspaceId}`);

  const sendCurrentHeartbeat = async () => {
    await sendHeartbeat(client, session!.machineToken, currentStatus, config.version, currentJobLabel);
  };

  const pollForJobs = async () => {
    if (isExecutingJob) {
      return;
    }

    try {
      const claimedJob = await client.mutation(api.jobs.claimNextForMachine, {
        machineToken: session!.machineToken,
      });

      if (!claimedJob) {
        return;
      }

      isExecutingJob = true;
      currentStatus = "busy";
      currentJobLabel = claimedJob.title;

      console.log(`[worker] claimed job ${claimedJob._id} (${claimedJob.title})`);

      try {
        const result = await executeJob(session!, claimedJob);
        await client.mutation(api.jobs.completeMachineJob, {
          machineToken: session!.machineToken,
          jobId: claimedJob._id,
          output: result.output,
          steps: result.steps,
        });
        console.log(`[worker] completed job ${claimedJob._id}`);
      } catch (error) {
        const detail = formatError(error);
        await client.mutation(api.jobs.failMachineJob, {
          machineToken: session!.machineToken,
          jobId: claimedJob._id,
          errorMessage: detail,
          output: [detail],
        });
        console.error(`[worker] job failed ${claimedJob._id}`);
        console.error(detail);
      } finally {
        currentStatus = "idle";
        currentJobLabel = "Awaiting jobs";
        isExecutingJob = false;
      }
    } catch (error) {
      currentStatus = "error";
      currentJobLabel = "Claim loop error";
      console.error("[worker] Job poll failed");
      console.error(error);
    }
  };

  await sendCurrentHeartbeat();
  console.log("[worker] Initial heartbeat sent");
  console.log(`[worker] sessionPath=${config.sessionPath}`);

  const interval = setInterval(() => {
    void sendCurrentHeartbeat()
      .then(() => {
        console.log(`[worker] heartbeat ${new Date().toISOString()}`);
        if (currentStatus === "error") {
          currentStatus = "idle";
          currentJobLabel = "Awaiting jobs";
        }
      })
      .catch((error) => {
        console.error("[worker] Heartbeat failed");
        console.error(error);
      });
  }, config.heartbeatIntervalMs);

  const pollInterval = setInterval(() => {
    void pollForJobs();
  }, config.jobPollIntervalMs);

  await pollForJobs();

  const shutdown = async () => {
    clearInterval(interval);
    clearInterval(pollInterval);
    try {
      await sendHeartbeat(client, session!.machineToken, "offline", config.version, "Worker stopped");
      console.log("[worker] Offline heartbeat sent");
    } catch (error) {
      console.error("[worker] Failed to send offline heartbeat");
      console.error(error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("[worker] Failed to start worker scaffold");
  console.error(error);
  process.exitCode = 1;
});
