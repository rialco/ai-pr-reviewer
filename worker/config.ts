import fs from "fs";
import path from "path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: path.resolve(process.cwd(), ".env.local"), override: false });

export interface WorkerConfig {
  convexUrl: string;
  machineName: string;
  machineSlug: string;
  enrollmentToken?: string;
  version: string;
  sessionPath: string;
  heartbeatIntervalMs: number;
  jobPollIntervalMs: number;
}

export interface WorkerSession {
  machineId: string;
  machineToken: string;
  workspaceId: string;
}

function requireFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  throw new Error(`${names.join(" or ")} is required to start the worker scaffold.`);
}

export function loadWorkerConfig(): WorkerConfig {
  return {
    convexUrl: requireFirstEnv(["CONVEX_URL", "VITE_CONVEX_URL"]),
    machineName: process.env.WORKER_MACHINE_NAME ?? "Unnamed Machine",
    machineSlug: process.env.WORKER_MACHINE_SLUG ?? "unnamed-machine",
    enrollmentToken: process.env.WORKER_ENROLLMENT_TOKEN,
    version: "0.1.0",
    sessionPath: path.resolve(process.cwd(), "worker/.machine-session.json"),
    heartbeatIntervalMs: Number(process.env.WORKER_HEARTBEAT_MS ?? "30000"),
    jobPollIntervalMs: Number(process.env.WORKER_JOB_POLL_MS ?? "5000"),
  };
}

export function readWorkerSession(sessionPath: string): WorkerSession | null {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    return JSON.parse(raw) as WorkerSession;
  } catch {
    return null;
  }
}

export function writeWorkerSession(sessionPath: string, session: WorkerSession): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf-8");
}
