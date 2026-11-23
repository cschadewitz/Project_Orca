/** `orca diagnostics tool-calls`: list, export, delete and expire tool-call records (#1000). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolCallTelemetry } from "@orca/core";
import { protectedPathFor } from "@orca/agents";
import { FileToolTelemetryStore } from "@orca/store";
import { orcaProtectedPaths } from "../src/bootstrap.js";
import { commands, type CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(cwd: string, positionals: string[], flags: CommandContext["flags"] = {}) {
  const lines: string[] = [];
  return {
    cwd,
    flags,
    positionals,
    out: (l: string) => lines.push(l),
    err: () => undefined,
    lines,
  } satisfies CommandContext & { lines: string[] };
}

const record = (runId: string, sessionId: string, seq: number, expiresAt: string): ToolCallTelemetry => ({
  v: 1,
  id: `${sessionId}:${seq}`,
  runId,
  sessionId,
  agentId: "claude",
  seq,
  source: "hook-reported",
  receivedAt: "2026-11-01T00:00:00.000Z",
  expiresAt,
  reportedAt: "2026-11-01T00:00:00.000Z",
  tool: { text: "Bash", length: 4 },
  decision: "allow",
  latencyMs: 1,
});

describe.runIf(process.platform !== "win32")("orca diagnostics tool-calls", () => {
  it("lists runs, exports JSON lines, deletes a session or run, and prunes expired records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-diagnostics-cli-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    const run = (positionals: string[], flags: CommandContext["flags"] = {}) => {
      const c = ctx(dir, positionals, flags);
      return commands.diagnostics!.run(c).then((code) => ({ code, lines: c.lines }));
    };
    // The first command opens (and marks) the store, as ORCA always has before a session runs.
    expect((await run(["tool-calls", "runs"])).lines).toEqual(["no run has tool-call records"]);
    // The same files `bootstrap` opens (storeDir defaults to `.orca`).
    const store = new FileToolTelemetryStore(join(dir, ".orca"));
    await store.append([record("run_a", "sess_1", 0, "2099-01-01T00:00:00.000Z")]);
    await store.append([record("run_a", "sess_2", 0, "2099-01-01T00:00:00.000Z")]);
    await store.append([record("run_b", "sess_3", 0, "2000-01-01T00:00:00.000Z")]);

    // run_b's only record has expired: it is not listed or exported even before a sweep.
    expect(await run(["tool-calls", "runs"])).toEqual({ code: 0, lines: ["run_a"] });
    expect((await run(["tool-calls", "export", "run_b"])).lines).toEqual([]);
    const exported = await run(["tool-calls", "export", "run_a"]);
    expect(exported.lines.map((l) => (JSON.parse(l) as ToolCallTelemetry).id)).toEqual(["sess_1:0", "sess_2:0"]);
    expect((await run(["tool-calls", "export", "run_a", "sess_2"])).lines).toHaveLength(1);

    expect(await run(["tool-calls", "delete", "run_a", "sess_1"])).toEqual({
      code: 0,
      lines: ["removed 1 tool-call record"],
    });
    expect(await run(["tool-calls", "prune"], { json: true })).toEqual({ code: 0, lines: ['{"removed":1}'] });
    expect(await run(["tool-calls", "runs"], { json: true })).toEqual({ code: 0, lines: ['["run_a"]'] });
    expect(await run(["tool-calls", "delete", "run_a"])).toEqual({ code: 0, lines: ["removed 1 tool-call record"] });
    expect((await run(["tool-calls", "runs"])).lines).toEqual(["no run has tool-call records"]);

    await expect(run(["tool-calls", "export"])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(run(["tool-calls", "shred"])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(run(["everything"])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("keeps the records where no agent tool may read or write them", () => {
    const dir = join(tmpdir(), "orca-diagnostics-boundary");
    const paths = orcaProtectedPaths({ configDir: dir, storeDir: ".orca" });
    const file = join(dir, ".orca", "diagnostics", "tool-calls", "run_a", "sess_1.jsonl");
    expect(protectedPathFor(file, "read", paths)).toBe(join(dir, ".orca", "diagnostics"));
    expect(protectedPathFor(file, "write", paths)).toBe(join(dir, ".orca", "diagnostics"));
  });
});
