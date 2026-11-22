/**
 * Add a machine as a managed ORCA server in one step (#881): the client's side, shared by the
 * desktop app ("Add a machine") and `orca remote add`.
 *
 * The work happens on the server, in `tools/deploy/orca-server-setup.py`, which the app sends
 * over the profile's own pinned ssh as `python3 - ARGS` with the managed adapter
 * (`orca-release.py`) embedded ahead of it: nothing is copied by hand, and nothing but this
 * app's own two files ever runs. The setup installs exactly the documented bootstrap
 * (docs/UPDATING.md), staging the signed server bundle with the adapter's `stage --bundle`,
 * and reports each step as one `orca-setup: {json}` line. This module builds that program and
 * reads those lines; nothing else the server prints is shown or kept.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RemoteResult } from "./remote-access.js";

/** The two files, as shipped: `server-setup/` in a packaged app, `tools/deploy/` in a checkout. */
export const SETUP_SCRIPT = "orca-server-setup.py";
export const SETUP_ADAPTER = "orca-release.py";

/** Setup downloads and verifies a bundle and runs its checks: minutes, not seconds. */
export const SETUP_TIMEOUT_MS = 30 * 60_000;

const VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?$/;

/** The program `python3 -` runs: the adapter embedded, then the setup itself. */
export function setupProgram(dir: string): string {
  const adapter = readFileSync(join(dir, SETUP_ADAPTER));
  const setup = readFileSync(join(dir, SETUP_SCRIPT), "utf8");
  return `EMBEDDED_ADAPTER = "${adapter.toString("base64")}"\n${setup}`;
}

/** The server version to install: the app's own, so client and server are one release. */
export function setupCommand(version: string, port: number): string[] {
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  return ["python3", "-", "--version", version, "--port", String(port)];
}

export const SETUP_RESULTS = ["ok", "changed", "repaired", "warning", "refused", "failed"] as const;
const StepSchema = z.object({
  step: z.string().max(40),
  result: z.enum(SETUP_RESULTS),
  detail: z.string().max(4000).default(""),
});
export type SetupStep = z.infer<typeof StepSchema>;
const DoneSchema = z.object({
  done: z.literal(true),
  root: z.string().max(1024),
  command: z.string().max(1024),
  version: z.string().regex(VERSION),
  port: z.number().int().min(1024).max(65535),
});

/** What one run of the setup made of the server. */
export type SetupOutcome =
  | { kind: "ready"; steps: SetupStep[]; command: string; version: string; port: number }
  /** Something only the person can resolve (an unmanaged installation, say): nothing changed for it. */
  | { kind: "refused"; steps: SetupStep[]; step: string; detail: string }
  /** A step failed; what this run created was taken back. */
  | { kind: "failed"; steps: SetupStep[]; step: string; detail: string }
  /** No Python 3 on the server. */
  | { kind: "no-python"; steps: SetupStep[] }
  /** The setup did not report how it ended (the session was lost, say): run it again. */
  | { kind: "unknown"; steps: SetupStep[] };

/** Read the setup's own lines; anything else on its output is ignored. */
export function readSetup(result: RemoteResult): SetupOutcome {
  const steps: SetupStep[] = [];
  let done: z.infer<typeof DoneSchema> | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("orca-setup: ")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice("orca-setup: ".length));
    } catch {
      continue;
    }
    const step = StepSchema.safeParse(value);
    if (step.success) steps.push(step.data);
    const end = DoneSchema.safeParse(value);
    if (end.success) done = end.data;
  }
  const last = steps.at(-1);
  if (result.code === 0 && done && !steps.some((s) => s.result === "refused" || s.result === "failed"))
    return { kind: "ready", steps, command: done.command, version: done.version, port: done.port };
  if (last?.result === "refused") return { kind: "refused", steps, step: last.step, detail: last.detail };
  if (last?.result === "failed") return { kind: "failed", steps, step: last.step, detail: last.detail };
  // `python3` not found by the remote shell: 127, and nothing of ours was printed.
  if (!steps.length && result.code === 127) return { kind: "no-python", steps };
  return { kind: "unknown", steps };
}
