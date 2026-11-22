/** `orca store format | carry-forward | sqlite` and the startup refusal that points to it (#566, #339). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("sqlite import, verify, backup and restore round-trip a store's metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-sqlite-command-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);

    const imported = ctx(dir, ["sqlite", "import"]);
    expect(await storeCommand(imported)).toBe(0);
    expect(imported.lines.join("\n")).toContain("runs       1 (1 new events)");
    const verify = ctx(dir, ["sqlite", "verify"]);
    expect(await storeCommand(verify)).toBe(0);
    expect(verify.lines.at(-1)).toBe("ok");

    const backup = join(dir, "metadata-backup.sqlite");
    expect(await storeCommand(ctx(dir, ["sqlite", "backup", backup]))).toBe(0);
    const fresh = await mkdtemp(join(tmpdir(), "orca-store-sqlite-restore-"));
    dirs.push(fresh);
    await writeFile(join(fresh, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    expect(await storeCommand(ctx(fresh, ["sqlite", "restore", backup]))).toBe(0);
    const restored = ctx(fresh, ["sqlite", "verify"]);
    expect(await storeCommand(restored)).toBe(0);
    expect(restored.lines.find((l) => l.startsWith("counts"))).toContain("runs 1, events 1");
    await expect(storeCommand(ctx(dir, ["sqlite", "nope"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
