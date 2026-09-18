/** `orca claims`: list who owns which work item, and release a dead run's claim from a fresh process. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileClaimStore } from "@orca/store";
import { commands, type CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(cwd: string, positionals: string[], flags: CommandContext["flags"] = {}): CommandContext & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { cwd, flags: { quiet: true, ...flags }, positionals, out: (l) => lines.push(l), err: (l) => errors.push(l), lines, errors };
}

describe("orca claims", () => {
  it("lists claims with their owner's status and releases only what a dead run holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-claims-"));
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
    // The same files `bootstrap` opens (storeDir defaults to `.orca`); claims written here are what the CLI sees.
    const claims = new FileClaimStore(join(dir, ".orca"));

    const empty = ctx(dir, []);
    expect(await commands.claims!.run(empty)).toBe(0);
    expect(empty.lines).toEqual(["no claims held"]);

    // A claim whose run's log is gone (store rolled back under it): dead, releasable as is.
    await claims.claim({ workItemId: "wi_ghost", runId: "run_ghost", branch: "ghost", at: "2026-01-01T00:00:00.000Z" });
    const ghost = ctx(dir, []);
    expect(await commands.claims!.run(ghost)).toBe(0);
    expect(ghost.lines).toHaveLength(1);
    expect(ghost.lines[0]).toMatch(/^wi_ghost\s+run=run_ghost\s+owner=missing\s+branch=ghost/);
    const releaseGhost = ctx(dir, ["release", "wi_ghost"]);
    expect(await commands.claims!.run(releaseGhost)).toBe(0);
    expect(releaseGhost.lines).toEqual(["released wi_ghost from run run_ghost (missing, branch ghost)"]);
    expect(await claims.get("wi_ghost")).toBeUndefined();

    // A run parked at a gate could still resume: its claim is refused without --force.
    const run = ctx(dir, ["gated"]);
    expect(await commands.run!.run(run)).toBe(3);
    const runId = /^run (run_\S+)/m.exec(run.lines.join("\n"))![1]!;
    await claims.claim({ workItemId: "wi_paused", runId, branch: "paused", at: "2026-01-01T00:00:00.000Z" });
    const byRun = ctx(dir, [], { run: runId });
    expect(await commands.claims!.run(byRun)).toBe(0);
    expect(byRun.lines).toHaveLength(1);
    expect(byRun.lines[0]).toMatch(new RegExp(`^wi_paused\\s+run=${runId}\\s+owner=paused`));
    const other = ctx(dir, [], { run: "run_other" });
    expect(await commands.claims!.run(other)).toBe(0);
    expect(other.lines).toEqual(["run run_other holds no claims"]);

    await expect(commands.claims!.run(ctx(dir, ["release", "wi_paused"]))).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(await claims.get("wi_paused")).toMatchObject({ runId });

    const forced = ctx(dir, ["release", "wi_paused"], { force: true });
    expect(await commands.claims!.run(forced)).toBe(0);
    expect(forced.lines).toEqual([`released wi_paused from run ${runId} (paused, branch paused)`]);
    expect(await claims.get("wi_paused")).toBeUndefined();

    await expect(commands.claims!.run(ctx(dir, ["release", "wi_paused"]))).rejects.toMatchObject({ code: "CLAIM_NOT_FOUND" });
    await expect(commands.claims!.run(ctx(dir, ["release"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(commands.claims!.run(ctx(dir, ["drop", "wi_paused"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    const json = ctx(dir, [], { json: true });
    expect(await commands.claims!.run(json)).toBe(0);
    expect(JSON.parse(json.lines.join("\n"))).toEqual([]);
  });
});
