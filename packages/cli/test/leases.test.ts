/** `orca leases`: who is interpreting which run, and freeing a run whose interpreter is gone. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileLeaseStore } from "@orca/store";
import { commands, type CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(
  cwd: string,
  positionals: string[],
  flags: CommandContext["flags"] = {},
): CommandContext & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    cwd,
    flags: { quiet: true, ...flags },
    positionals,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    lines,
    errors,
  };
}

describe("orca leases", () => {
  it("lists live and lapsed leases and only breaks a live one with --force", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-leases-cli-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: [gated.yaml]\ntemplates: []\n", "utf8");
    await writeFile(
      join(dir, "gated.yaml"),
      `
id: gated
name: gated
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  shipped: { type: end }
edges:
  - { from: s, to: gate }
  - { from: gate, to: shipped }
`,
      "utf8",
    );
    // The same files `bootstrap` opens (storeDir defaults to `.orca`).
    const leases = new FileLeaseStore(join(dir, ".orca"));

    const empty = ctx(dir, []);
    expect(await commands.leases!.run(empty)).toBe(0);
    expect(empty.lines).toEqual(["no run is leased"]);

    // A run parked at a gate: its interpreter has detached, so nothing is leased.
    const run = ctx(dir, ["gated"]);
    expect(await commands.run!.run(run)).toBe(3);
    const runId = /^run (run_\S+)/m.exec(run.lines.join("\n"))![1]!;
    expect(await leases.get(`run:${runId}`)).toBeUndefined();

    // Another process attached to it and is still heartbeating.
    await leases.acquire({ resource: `run:${runId}`, holder: "orc_elsewhere", ttlMs: 3_600_000, note: "gated" });
    const listed = ctx(dir, []);
    expect(await commands.leases!.run(listed)).toBe(0);
    expect(listed.lines).toHaveLength(1);
    expect(listed.lines[0]).toMatch(new RegExp(`^${runId}\\s+live\\s+pid=${process.pid}@${hostname()}`));

    await expect(commands.leases!.run(ctx(dir, ["break", runId]))).rejects.toMatchObject({ code: "RUN_STATE" });
    const forced = ctx(dir, ["break", runId], { force: true });
    expect(await commands.leases!.run(forced)).toBe(0);
    expect(forced.lines[0]).toMatch(new RegExp(`^freed ${runId} `));
    expect(forced.errors.join("\n")).toContain("one heartbeat");
    expect(await leases.get(`run:${runId}`)).toBeUndefined();

    // A holder that stopped heartbeating is `lapsed`, and breaking it needs no force.
    await leases.acquire({ resource: `run:${runId}`, holder: "orc_dead", ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const stale = ctx(dir, []);
    expect(await commands.leases!.run(stale)).toBe(0);
    expect(stale.lines[0]).toMatch(new RegExp(`^${runId}\\s+lapsed\\s`));
    const broken = ctx(dir, ["break", runId]);
    expect(await commands.leases!.run(broken)).toBe(0);
    expect(broken.errors).toEqual([]);

    await expect(commands.leases!.run(ctx(dir, ["break", runId]))).rejects.toMatchObject({
      code: "LEASE_NOT_FOUND",
    });
    await expect(commands.leases!.run(ctx(dir, ["break"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(commands.leases!.run(ctx(dir, ["steal", runId]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    const json = ctx(dir, [], { json: true });
    expect(await commands.leases!.run(json)).toBe(0);
    expect(JSON.parse(json.lines.join("\n"))).toEqual([]);
  });
});
