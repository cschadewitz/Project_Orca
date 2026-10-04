/** Policy-neutral child-process crash probe for disposable synthetic profiles only. */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withSyntheticProfile<T>(run: (profile: string) => Promise<T>): Promise<T> {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "orca-recovery-synthetic-")));
  try {
    return await run(profile);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

export interface CrashBoundaryOptions {
  /** Absolute path to a synthetic Node child. It receives the profile as argv[2]. */
  entry: string;
  profile: string;
  boundary: string;
  timeoutMs?: number;
}

/**
 * Kill a child after it announces a boundary over IPC. The child must hold at that
 * boundary until killed. This proves process termination, not power-loss durability.
 * Child output is ignored so a future fixture cannot leak into a test log.
 */
export async function killAtBoundary({
  entry,
  profile,
  boundary,
  timeoutMs = 5_000,
}: CrashBoundaryOptions): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid crash timeout");
  const child = spawn(process.execPath, [entry, profile], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    // Intentionally omit the invoking process's environment and any real profile path.
    env: {},
  });

  return new Promise((resolve, reject) => {
    let reached = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("message", (message: unknown) => {
      if (
        !reached &&
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "boundary" &&
        "name" in message &&
        message.name === boundary
      ) {
        reached = true;
        if (!child.kill("SIGKILL")) {
          clearTimeout(timer);
          reject(new Error("Child exited before the crash signal"));
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Child did not reach boundary ${boundary}`));
      else if (!reached) reject(new Error(`Child exited before boundary ${boundary}`));
      else resolve({ code, signal });
    });
  });
}
