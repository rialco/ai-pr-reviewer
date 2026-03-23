import os from "os";
import { execFileSync } from "child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import {
  loadWorkerConfig,
  readWorkerSession,
  writeWorkerSession,
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

async function main() {
  const config = loadWorkerConfig();
  const client = new ConvexHttpClient(config.convexUrl);
  let session = readWorkerSession(config.sessionPath);

  console.log("[worker] Starting cloud worker");
  console.log(`[worker] machine=${config.machineName} slug=${config.machineSlug}`);
  console.log(`[worker] hostname=${os.hostname()} workspace=${config.workspaceId}`);

  if (!session) {
    const registered = await registerMachine(client, config);
    console.log("[worker] Machine registered with Convex");
    console.log(`[worker] registeredMachineId=${registered.machineId}`);
    session = readWorkerSession(config.sessionPath);
  }

  if (!session) {
    throw new Error("Worker session was not persisted after registration.");
  }

  await sendHeartbeat(client, session.machineToken, "idle", config.version, "Awaiting jobs");
  console.log("[worker] Initial heartbeat sent");
  console.log(`[worker] sessionPath=${config.sessionPath}`);

  const interval = setInterval(() => {
    void sendHeartbeat(client, session!.machineToken, "idle", config.version, "Awaiting jobs")
      .then(() => {
        console.log(`[worker] heartbeat ${new Date().toISOString()}`);
      })
      .catch((error) => {
        console.error("[worker] Heartbeat failed");
        console.error(error);
      });
  }, config.heartbeatIntervalMs);

  const shutdown = async () => {
    clearInterval(interval);
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
