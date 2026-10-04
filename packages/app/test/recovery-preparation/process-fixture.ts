/** Bounded real-adapter subprocess runner; synthetic disposable profiles only. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compiledFixtureHelper } from "./implementation-fixture.js";

export async function crashImplementationAt(
  profile: string,
  boundary: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const entry = fileURLToPath(new URL("./implementation-child.ts", import.meta.url));
  const helper = await compiledFixtureHelper();
  const child = spawn(process.execPath, ["--import", "tsx", entry, profile, boundary, helper], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { TMPDIR: profile, TSX_DISABLE_CACHE: "1" },
  });
  return new Promise((resolve, reject) => {
    let reached = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.on("message", (message: unknown) => {
      if (
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "boundary" &&
        "name" in message &&
        message.name === boundary &&
        !reached
      ) {
        reached = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Implementation did not reach ${boundary}`));
      else if (!reached) reject(new Error(`Implementation exited before ${boundary}`));
      else resolve({ code, signal });
    });
  });
}
