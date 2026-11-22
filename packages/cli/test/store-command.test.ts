/** `orca store format | carry-forward` and the startup refusal that points to it (#566). */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { silentLogger } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";
import { storeCommand } from "../src/commands/store.js";
import type { CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
function ctx(cwd: string, positionals: string[]): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return { cwd, flags: {}, positionals, out: (l) => lines.push(l), err: () => {}, lines };
}
const LOG =
  [
    {
      id: "evt_0",
      seq: 0,
      runId: "run_old",
      at: "2026-01-02T03:04:00.000Z",
      type: "run.created",
      payload: { workflowId: "tiny", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";

describe("orca store", () => {
  it("refuses an older store at startup until carry-forward converts it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-command-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);

    await expect(bootstrap({ cwd: dir, logger: silentLogger })).rejects.toMatchObject({
      code: "STORE_FORMAT",
      details: { reason: "CARRYOVER_REQUIRED" },
    });
    const format = ctx(dir, ["format"]);
    expect(await storeCommand(format)).toBe(1);
    expect(format.lines.join("\n")).toContain("orca store carry-forward");

    const carry = ctx(dir, ["carry-forward"]);
    expect(await storeCommand(carry)).toBe(0);
    expect(carry.lines[0]).toMatch(/^carried .* forward from unmarked to .*; backup in .*format-backups/);
    expect(await readFile(join(dir, ".orca", "runs", "run_old.jsonl"), "utf8")).toBe(LOG);
    await bootstrap({ cwd: dir, logger: silentLogger });
    const again = ctx(dir, ["carry-forward"]);
    expect(await storeCommand(again)).toBe(0);
    expect(again.lines[0]).toContain("nothing to do");
  });

  it("refuses to carry forward a desktop app's own store, whose write fence it cannot hold (#897)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-command-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);
    // The app's first-run ownership journal marks the workspace as the app's.
    await mkdir(join(dir, ".orca-first-run-ownership"), { mode: 0o700 });
    await expect(storeCommand(ctx(dir, ["carry-forward"]))).rejects.toMatchObject({
      code: "STORE_FORMAT",
      details: { reason: "APP_OWNED" },
    });
    expect(await readdir(join(dir, ".orca"))).toEqual(["runs"]);
    expect(await readFile(join(dir, ".orca", "runs", "run_old.jsonl"), "utf8")).toBe(LOG);
  });
});
