export interface WorkerConfig {
  convexUrl: string;
  workspaceId: string;
  machineName: string;
  machineSlug: string;
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
  };
}
