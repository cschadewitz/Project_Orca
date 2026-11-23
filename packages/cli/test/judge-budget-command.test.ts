/** `orca judge budget status | init | reset` (#701): the owner's steps for the judge's durable daily budget. */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUDGE_BUDGET_FILENAME, judgeBudgetKey } from "@orca/agents";
import { qualifiedJudgeBudget } from "@orca/daemon";
import { workspaceIdentity } from "@orca/store";
import { judgeCommand } from "../src/commands/judge.js";
import type { CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
function ctx(cwd: string, positionals: string[]): CommandContext & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { cwd, flags: {}, positionals, out: (l) => lines.push(l), err: (l) => errors.push(l), lines, errors };
}

let home: string;
let workspace: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "orca-judge-home-"));
  workspace = await mkdtemp(join(tmpdir(), "orca-judge-ws-"));
  dirs.push(home, workspace);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
  await writeFile(join(workspace, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe.runIf(process.platform === "win32")("orca judge budget on Windows", () => {
  it("is unavailable, and says the judge is not supported there", async () => {
    await mkdir(join(workspace, ".orca"));
    const status = ctx(workspace, ["budget", "status"]);
    expect(await judgeCommand(status)).toBe(1);
    expect(status.errors.join("\n")).toMatch(/Windows is not supported/);
  });
});

describe.skipIf(process.platform === "win32")("orca judge budget", () => {
  it("needs a store; status reports durable with the anchor outside it; init once; reset replaces, spent", async () => {
    const missing = ctx(workspace, ["budget", "status"]);
    expect(await judgeCommand(missing)).toBe(1);
    expect(missing.errors[0]).toMatch(/There is no store/);

    await mkdir(join(workspace, ".orca"));
    const noIdentity = ctx(workspace, ["budget"]);
    expect(await judgeCommand(noIdentity)).toBe(1);
    expect(noIdentity.errors[0]).toMatch(/no workspace identity yet/);
    const id = await workspaceIdentity(join(workspace, ".orca"));
    const storeEntries = await readdir(join(workspace, ".orca"));

    // Read-only: reports eligibility and an uninitialized budget, creating neither the anchor nor the ledger.
    const status = ctx(workspace, ["budget"]);
    expect(await judgeCommand(status)).toBe(0);
    const text = status.lines.join("\n");
    expect(text).toContain(join("orca-judge-budget-anchors", id));
    expect(text).toMatch(/\(not created yet\)/);
    expect(text).toMatch(/storage eligible/);
    expect(text).toMatch(/not created: run `orca judge budget init`/);
    expect(await readdir(join(workspace, ".orca"))).toEqual(storeEntries);
    await expect(readdir(join(home, "state"))).rejects.toMatchObject({ code: "ENOENT" });

    const init = ctx(workspace, ["budget", "init"]);
    expect(await judgeCommand(init)).toBe(0);
    expect(init.lines.at(-1)).toMatch(/^created for \d{4}-\d{2}-\d{2} \(UTC\)\. That day counts as fully spent/);
    const before = await readFile(join(workspace, ".orca", JUDGE_BUDGET_FILENAME), "utf8");

    const again = ctx(workspace, ["budget", "init"]);
    expect(await judgeCommand(again)).toBe(1);
    expect(again.errors[0]).toMatch(/already exists, so nothing was changed/);
    expect(await readFile(join(workspace, ".orca", JUDGE_BUDGET_FILENAME), "utf8")).toBe(before);

    const ready = ctx(workspace, ["budget", "status"]);
    expect(await judgeCommand(ready)).toBe(0);
    expect(ready.lines.join("\n")).toMatch(/budget {2}ready: started \d{4}-\d{2}-\d{2}/);

    // A budget restored from an earlier copy: status reports it refused, reset replaces it under the lock.
    await writeFile(join(workspace, ".orca", JUDGE_BUDGET_FILENAME), "{");
    const broken = ctx(workspace, ["budget", "status"]);
    expect(await judgeCommand(broken)).toBe(1);
    expect(broken.lines.join("\n")).toMatch(/budget {2}refused: .*orca judge budget reset/);

    const reset = ctx(workspace, ["budget", "reset"]);
    expect(await judgeCommand(reset)).toBe(0);
    expect(reset.lines.at(-1)).toMatch(/^replaced for/);
    expect(await readFile(join(workspace, ".orca", JUDGE_BUDGET_FILENAME), "utf8")).not.toBe("{");

    // The daemon's qualified budget sees the same files: durable, and today is spent.
    const q = await qualifiedJudgeBudget({ storeDir: join(workspace, ".orca"), workspaceId: id });
    expect(q.status).toBe("durable");
    if (q.status === "durable")
      expect(await q.budget.reserve(judgeBudgetKey("https://j.example/", "secret:k"), 5)).toBe(false);
  });

  it("refuses to change the desktop app's own store", async () => {
    await mkdir(join(workspace, ".orca"));
    await mkdir(join(workspace, ".orca-first-run-ownership"), { mode: 0o700 });
    const init = ctx(workspace, ["budget", "init"]);
    expect(await judgeCommand(init)).toBe(1);
    expect(init.errors[0]).toMatch(/desktop app's workspace/);
  });

  it("rejects unknown steps", async () => {
    await expect(judgeCommand(ctx(workspace, ["budget", "spend"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(judgeCommand(ctx(workspace, ["key"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
