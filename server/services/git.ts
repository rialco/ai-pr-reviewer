import { exec } from "child_process";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

const fetchChains = new Map<string, Promise<void>>();

const LOCKED_REMOTE_REF_PATTERN = /cannot lock ref '([^']+)': is at [0-9a-f]+ but expected [0-9a-f]+/i;
const UNABLE_TO_UPDATE_LOCAL_REF_PATTERN = /unable to update local ref/i;

function getErrorOutput(error: unknown): string {
  if (error instanceof Error) {
    const stderr =
      "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    return [error.message, stderr].filter(Boolean).join("\n");
  }

  return String(error);
}

async function getGitRepoKey(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git rev-parse --git-common-dir", {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
    });
    const gitCommonDir = stdout.trim();
    return gitCommonDir ? path.resolve(cwd, gitCommonDir) : path.resolve(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function getLockedRemoteRef(error: unknown): string | null {
  const output = getErrorOutput(error);
  if (!UNABLE_TO_UPDATE_LOCAL_REF_PATTERN.test(output)) return null;

  const match = output.match(LOCKED_REMOTE_REF_PATTERN);
  if (!match) return null;

  const ref = match[1];
  return ref.startsWith("refs/remotes/origin/") ? ref : null;
}

async function runFetch(cwd: string, timeout: number): Promise<void> {
  await execAsync("git fetch origin", {
    cwd,
    encoding: "utf-8",
    timeout,
  });
}

async function withFetchLock<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const repoKey = await getGitRepoKey(cwd);
  const previous = fetchChains.get(repoKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(() => undefined, () => undefined);

  fetchChains.set(repoKey, tail);

  try {
    return await run;
  } finally {
    if (fetchChains.get(repoKey) === tail) {
      fetchChains.delete(repoKey);
    }
  }
}

export async function fetchOrigin(cwd: string, timeout = 60000): Promise<void> {
  await withFetchLock(cwd, async () => {
    try {
      await runFetch(cwd, timeout);
      return;
    } catch (error) {
      const lockedRemoteRef = getLockedRemoteRef(error);
      if (!lockedRemoteRef) throw error;

      try {
        await execAsync(`git update-ref -d ${JSON.stringify(lockedRemoteRef)}`, {
          cwd,
          encoding: "utf-8",
          timeout,
        });
      } catch {
        // Best effort: if another process already fixed the ref, the retry fetch can still succeed.
      }

      await runFetch(cwd, timeout);
    }
  });
}
