import fs from "fs";
import path from "path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: path.resolve(process.cwd(), ".env.local"), override: false });

export interface WorkerConfig {
  convexUrl: string;
  workspaceId: string;
  machineName: string;
  machineSlug: string;
  enrollmentToken?: string;
  version: string;
  sessionPath: string;
  heartbeatIntervalMs: number;
}

export interface WorkerSession {
  machineId: string;
  machineToken: string;
  workspaceId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to start the worker scaffold.`);
  }
  return value;
}

export function loadWorkerConfig(): WorkerConfig {
  return {
    convexUrl: requireEnv("CONVEX_URL"),
    workspaceId: requireEnv("WORKER_WORKSPACE_ID"),
    machineName: process.env.WORKER_MACHINE_NAME ?? "Unnamed Machine",
    machineSlug: process.env.WORKER_MACHINE_SLUG ?? "unnamed-machine",
    enrollmentToken: process.env.WORKER_ENROLLMENT_TOKEN,
    version: "0.1.0",
    sessionPath: path.resolve(process.cwd(), "worker/.machine-session.json"),
    heartbeatIntervalMs: Number(process.env.WORKER_HEARTBEAT_MS ?? "30000"),
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
