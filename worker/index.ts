import os from "os";
import { ConvexClient } from "convex/browser";
import { loadWorkerConfig } from "./config";

async function main() {
  const config = loadWorkerConfig();
  const client = new ConvexClient(config.convexUrl);

  console.log("[worker] Cloud worker scaffold initialized");
  console.log(`[worker] machine=${config.machineName} slug=${config.machineSlug}`);
  console.log(`[worker] hostname=${os.hostname()} workspace=${config.workspaceId}`);
  console.log(
    "[worker] Enrollment, authenticated job claiming, and heartbeat mutations are the next implementation slice.",
  );

  client.close();
}

main().catch((error) => {
  console.error("[worker] Failed to start worker scaffold");
  console.error(error);
  process.exitCode = 1;
});
