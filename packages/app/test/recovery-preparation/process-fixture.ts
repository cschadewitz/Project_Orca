/** Bounded real-adapter subprocess runner; synthetic disposable profiles only. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childBundle } from "../../../testing/src/child-bundle.js";
import { compiledFixtureHelper } from "./implementation-fixture.js";

export interface OptOutCrashEvidence {
  publishedText: string;
  acknowledgedId: string;
  unresolvedId?: string;
}

export async function crashImplementationAt(
  profile: string,
  boundary: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; evidence?: OptOutCrashEvidence }> {
  const entry = fileURLToPath(new URL("./implementation-child.ts", import.meta.url));
  const helper = await compiledFixtureHelper();
  // Under the test runner the child is built once for the run and started with plain node: still a
  // fresh process that is killed at a real mutation boundary, without tsx transpiling the controller
  // and disk modules again for each of the two dozen crashes. It takes its profile and helper as
  // arguments, so nothing in it looks for a file beside itself. With no run directory it starts
  // through tsx as before, and only that path has a tsx cache to keep out of the synthetic profile;
  // a bundle writes none.
  const bundled = childBundle("recovery-implementation-child", { entries: { child: entry } })?.child;
  const child = spawn(
    process.execPath,
    bundled ? [bundled, profile, boundary, helper] : ["--import", "tsx", entry, profile, boundary, helper],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: bundled ? { TMPDIR: profile } : { TMPDIR: profile, TSX_DISABLE_CACHE: "1" },
    },
  );
  return new Promise((resolve, reject) => {
    let reached = false;
    let timedOut = false;
    let evidence: OptOutCrashEvidence | undefined;
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
        if ("evidence" in message && validEvidence(message.evidence)) evidence = message.evidence;
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
      else resolve({ code, signal, ...(evidence ? { evidence } : {}) });
    });
  });
}

function validEvidence(value: unknown): value is OptOutCrashEvidence {
  if (value === null || typeof value !== "object") return false;
  return (
    "publishedText" in value &&
    typeof value.publishedText === "string" &&
    Buffer.byteLength(value.publishedText) <= 1_048_576 &&
    "acknowledgedId" in value &&
    typeof value.acknowledgedId === "string" &&
    /^[0-9a-f-]{36}$/.test(value.acknowledgedId) &&
    (!("unresolvedId" in value) ||
      (typeof value.unresolvedId === "string" && /^[0-9a-f-]{36}$/.test(value.unresolvedId)))
  );
}
