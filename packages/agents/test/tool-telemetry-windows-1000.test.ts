/**
 * Tool-call diagnostics on a real Windows host (#1000): the checks they rest on (`O_NOFOLLOW`,
 * POSIX owners and modes) have no equivalent there, so the store and the hook's spool must
 * refuse, and nothing may be written. This runs only on Windows, in the native Windows job
 * (`.github/workflows/windows-tool-telemetry.yml`); elsewhere it is skipped.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileStores, fileToolTelemetryStore, FileToolTelemetryStore, toolTelemetrySupported } from "@orca/store";
import { openHookTelemetrySpool, recordHookTelemetry, sweepHookTelemetrySpools } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Every file and directory under `dir`, relative to it. */
async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

describe.runIf(process.platform === "win32")("tool-call diagnostics on Windows", () => {
  const refused = { code: "NOT_SUPPORTED", message: expect.stringContaining("not supported on Windows") };

  it("keeps no store, and a file store made anyway refuses everything and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-1000-win-"));
    dirs.push(dir);
    expect(toolTelemetrySupported()).toBe(false);
    expect(fileToolTelemetryStore(dir)).toBeUndefined();
    expect(fileStores(dir).toolTelemetry).toBeUndefined();
    const store = new FileToolTelemetryStore(dir);
    const record = {
      v: 1 as const,
      id: "s:0",
      runId: "run_a",
      sessionId: "s",
      agentId: "claude",
      seq: 0,
      source: "hook-reported" as const,
      receivedAt: "2026-11-23T10:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      reportedAt: "2026-11-23T10:00:00.000Z",
      tool: { text: "Bash", length: 4 },
      decision: "allow" as const,
      latencyMs: 1,
    };
    const before = await tree(dir);
    await expect(store.append([record])).rejects.toMatchObject(refused);
    await expect(store.list({ runId: "run_a" })).rejects.toMatchObject(refused);
    await expect(store.runs()).rejects.toMatchObject(refused);
    await expect(store.delete({ runId: "run_a" })).rejects.toMatchObject(refused);
    await expect(store.prune(new Date())).rejects.toMatchObject(refused);
    expect(await tree(dir)).toEqual(before);
    expect(before.some((p) => p.startsWith("diagnostics"))).toBe(false);
  });

  it("makes, sweeps and writes no spool", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-1000-win-"));
    dirs.push(root);
    const dir = join(root, "private-execution", "tool-hooks");
    await mkdir(dir, { recursive: true });
    const protectedPaths = { readOnly: [], noAccess: [join(root, "private-execution")] };
    await expect(openHookTelemetrySpool({ dir, protectedPaths })).rejects.toMatchObject(refused);
    await expect(sweepHookTelemetrySpools({ dir, protectedPaths })).rejects.toMatchObject(refused);
    const target = { file: join(dir, "tool-calls-1-00000000-0000-4000-8000-000000000000.spool"), dev: "0", ino: "0" };
    expect(
      recordHookTelemetry(target, {
        v: 1,
        at: "2026-11-23T10:00:00.000Z",
        tool: "Bash",
        decision: "allow",
        latencyMs: 1,
      }),
    ).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});
