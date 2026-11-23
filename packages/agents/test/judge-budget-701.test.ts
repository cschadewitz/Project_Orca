/**
 * #701 the plain-rule judge's daily budget: one per daemon, committed before acknowledged, shared, never silently
 * recovered, and unqualified for activation until a reviewed daemon integration enforces its storage prerequisites. Real
 * temporary files; an injected file-system layer checks the commit order and its failures. No network.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  daemonJudgeBudget,
  JUDGE_BUDGET_ANCHOR_FILENAME,
  JUDGE_BUDGET_FILENAME,
  judgeBudgetKey,
  memoryJudgeBudget,
  type JudgeBudgetIo,
} from "../src/review-judge/judge-budget.js";

let dir: string;
let anchorDir: string;
let file: string;
let anchorFile: string;
let now: number;
const clock = () => now;
const KEY = judgeBudgetKey("https://judge.example/v1/messages", "secret:judge-key");
const DAY1 = Date.parse("2026-11-22T10:00:00Z");
const DAY2 = Date.parse("2026-11-23T10:00:00Z");
const DAY3 = Date.parse("2026-11-24T10:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-701-budget-"));
  anchorDir = mkdtempSync(join(tmpdir(), "orca-701-anchor-"));
  file = join(dir, JUDGE_BUDGET_FILENAME);
  anchorFile = join(anchorDir, JUDGE_BUDGET_ANCHOR_FILENAME);
  now = DAY1;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(anchorDir, { recursive: true, force: true });
});

const dirs = () => ({ stateDir: dir, anchorDir });
const elsewhere = () => ({
  stateDir: mkdtempSync(join(tmpdir(), "orca-701-budget-other-")),
  anchorDir: mkdtempSync(join(tmpdir(), "orca-701-anchor-other-")),
});
const budget = (io?: JudgeBudgetIo) => daemonJudgeBudget(dirs(), { now: clock, ...(io ? { io } : {}) });
const read = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
async function initializedYesterday() {
  now = DAY1;
  expect(await budget().initialize()).toEqual({ status: "initialized", day: "2026-11-22" });
  now = DAY2;
}

describe("#701 judge budget: no silent recovery", () => {
  it("a missing budget refuses; only initialize creates one, and never over an existing file", async () => {
    now = DAY2;
    expect(await budget().reserve(KEY, 3)).toBe(false);
    expect(await budget().initialize()).toMatchObject({ status: "initialized" });
    expect(await budget().initialize()).toEqual({ status: "refused", reason: "exists" });
  });

  it("a freshly initialized budget is fully spent for its first day", async () => {
    now = DAY2;
    await budget().initialize();
    expect(await budget().reserve(KEY, 3)).toBe(false);
    now = DAY3;
    expect(await budget().reserve(KEY, 3)).toBe(true);
  });

  it("is shared by every instance on the same state directory and survives a restart", async () => {
    await initializedYesterday();
    const a = budget();
    const b = budget();
    expect(await a.reserve(KEY, 3)).toBe(true);
    expect(await b.reserve(KEY, 3)).toBe(true);
    expect(await budget().reserve(KEY, 3)).toBe(true);
    expect(await a.reserve(KEY, 3)).toBe(false);
    expect(read()).toMatchObject({ day: "2026-11-23", counts: { [KEY]: 3 }, sequence: 3 });
    // Without injected options the daemon gets one object per file.
    expect(daemonJudgeBudget(dirs())).toBe(daemonJudgeBudget(dirs()));
  });

  it("counts keys apart, starts each UTC day afresh, and the key names no value", async () => {
    await initializedYesterday();
    const other = judgeBudgetKey("https://judge.example/v1/messages", "secret:other");
    expect(KEY).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await budget().reserve(KEY, 1)).toBe(true);
    expect(await budget().reserve(KEY, 1)).toBe(false);
    expect(await budget().reserve(other, 1)).toBe(true);
    now = DAY3;
    expect(await budget().reserve(KEY, 1)).toBe(true);
    expect(read()).toMatchObject({ day: "2026-11-24", counts: { [KEY]: 1 } });
  });

  it("refuses rather than resets when the clock moves back or is not a number", async () => {
    await initializedYesterday();
    await budget().reserve(KEY, 3);
    now = DAY1;
    expect(await budget().reserve(KEY, 3)).toBe(false);
    now = Number.NaN;
    expect(await budget().reserve(KEY, 3)).toBe(false);
    expect(await budget().initialize()).toEqual({ status: "refused", reason: "clock" });
  });

  it("a file rolled back or replaced while the process runs is refused until initialized again", async () => {
    await initializedYesterday();
    const b = budget();
    const backup = join(dir, "backup.json");
    copyFileSync(file, backup);
    expect(await b.reserve(KEY, 3)).toBe(true);
    expect(await b.reserve(KEY, 3)).toBe(true);
    // Restore the earlier copy: fewer calls counted, a lower sequence.
    copyFileSync(backup, file);
    expect(await b.reserve(KEY, 3)).toBe(false);
    expect(await b.reserve(KEY, 3)).toBe(false);
    // A different budget put in its place is refused too.
    rmSync(file);
    now = DAY1;
    const other = daemonJudgeBudget(elsewhere(), { now: clock });
    await other.initialize();
    now = DAY2;
    expect(await b.reserve(KEY, 3)).toBe(false);
    // Only an owner initialize clears it, and that spends the day.
    rmSync(file, { force: true });
    expect(await b.initialize()).toMatchObject({ status: "initialized" });
    expect(await b.reserve(KEY, 3)).toBe(false);
    now = DAY3;
    expect(await b.reserve(KEY, 3)).toBe(true);
  });

  it("fails closed on a file it cannot read, parse or trust, and never repairs it", async () => {
    await initializedYesterday();
    const good = read();
    const bad = [
      "not json",
      "[]",
      JSON.stringify({ ...good, version: 1 }),
      JSON.stringify({ ...good, budgetId: "x" }),
      JSON.stringify({ ...good, sequence: -1 }),
      JSON.stringify({ ...good, day: "23/11/2026" }),
      JSON.stringify({ ...good, initializedDay: "2026-12-01" }),
      JSON.stringify({ ...good, counts: { [KEY]: 1.5 } }),
      JSON.stringify({ ...good, counts: [] }),
      JSON.stringify({ ...good, extra: true }),
      JSON.stringify({ version: good.version, budgetId: good.budgetId, day: good.day, counts: {} }),
    ];
    for (const text of bad) {
      writeFileSync(file, text);
      expect(await daemonJudgeBudget(elsewhere(), { now: clock }).reserve(KEY, 3)).toBe(false);
      expect(await budget().reserve(KEY, 3)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
    rmSync(file);
    mkdirSync(file);
    expect(await budget().reserve(KEY, 3)).toBe(false);
  });

  it("refuses an invalid key or limit", async () => {
    await initializedYesterday();
    for (const [key, limit] of [
      ["", 3],
      [KEY, 0],
      [KEY, 1.5],
      [KEY, 1_000_000],
    ] as const) {
      expect(await budget().reserve(key, limit)).toBe(false);
    }
  });
});

describe("#701 judge budget: rollback across restarts", () => {
  /** A fresh copy of the module: what a restarted daemon sees, with no memory of this process. */
  async function restarted() {
    vi.resetModules();
    const fresh = await import("../src/review-judge/judge-budget.js");
    return fresh.daemonJudgeBudget(dirs(), { now: clock });
  }

  it("a budget file restored from a backup is refused after a restart, until initialized again", async () => {
    await initializedYesterday();
    const backup = join(dir, "backup.json");
    copyFileSync(file, backup);
    expect(await budget().reserve(KEY, 3)).toBe(true);
    expect(await budget().reserve(KEY, 3)).toBe(true);
    copyFileSync(backup, file);
    const after = await restarted();
    expect(await after.reserve(KEY, 3)).toBe(false);
    expect(await (await restarted()).reserve(KEY, 3)).toBe(false);
    rmSync(file);
    expect(await after.initialize()).toMatchObject({ status: "initialized" });
    expect(await after.reserve(KEY, 3)).toBe(false);
    now = DAY3;
    expect(await (await restarted()).reserve(KEY, 3)).toBe(true);
  });

  it("a whole state directory restored without its anchor is refused after a restart", async () => {
    await initializedYesterday();
    const saved = mkdtempSync(join(tmpdir(), "orca-701-saved-"));
    try {
      copyFileSync(file, join(saved, "budget.json"));
      expect(await budget().reserve(KEY, 3)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "review-judge"), { recursive: true });
      copyFileSync(join(saved, "budget.json"), file);
      expect(await (await restarted()).reserve(KEY, 3)).toBe(false);
    } finally {
      rmSync(saved, { recursive: true, force: true });
    }
  });

  it("refuses a budget with no anchor, an unreadable anchor, or another budget's anchor", async () => {
    await initializedYesterday();
    const good = readFileSync(anchorFile, "utf8");
    rmSync(anchorFile);
    expect(await (await restarted()).reserve(KEY, 3)).toBe(false);
    for (const text of ["not json", JSON.stringify({ ...JSON.parse(good), extra: 1 })]) {
      writeFileSync(anchorFile, text);
      expect(await (await restarted()).reserve(KEY, 3)).toBe(false);
    }
    writeFileSync(
      anchorFile,
      JSON.stringify({ ...JSON.parse(good), budgetId: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(await (await restarted()).reserve(KEY, 3)).toBe(false);
    writeFileSync(anchorFile, good);
    expect(await (await restarted()).reserve(KEY, 3)).toBe(true);
    expect(JSON.parse(readFileSync(anchorFile, "utf8"))).toMatchObject({ sequence: 1 });
  });

  it("requires the anchor directory outside the state directory", () => {
    expect(() => daemonJudgeBudget({ stateDir: dir, anchorDir: dir })).toThrow(/outside/);
    expect(() => daemonJudgeBudget({ stateDir: dir, anchorDir: join(dir, "anchor") })).toThrow(/outside/);
    expect(() => daemonJudgeBudget({ stateDir: join(anchorDir, "state"), anchorDir })).toThrow(/outside/);
  });

  it("is unqualified: it never signals activation readiness on its own", async () => {
    // Path checks cannot show physical separation, restore exclusion or a verified platform (Windows).
    expect(daemonJudgeBudget(dirs()).durable).toBe(false);
    await initializedYesterday();
    const b = budget();
    expect(await b.reserve(KEY, 3)).toBe(true);
    expect(b.durable).toBe(false);
  });
});

describe("#701 judge budget: durable commit before acknowledgement", () => {
  function recording(fail?: "write" | "rename" | "dir") {
    const steps: string[] = [];
    const io: JudgeBudgetIo = {
      writeSynced: async (path, text) => {
        if (fail === "write") throw new Error("ENOSPC");
        const { open } = await import("node:fs/promises");
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(text);
        await handle.sync();
        await handle.close();
        steps.push("write+sync");
      },
      rename: async (from, to) => {
        if (fail === "rename") throw new Error("EXDEV");
        await rename(from, to);
        steps.push("rename");
      },
      syncDirectory: async () => {
        if (fail === "dir") throw new Error("EIO");
        steps.push("sync-dir");
      },
    };
    return { io, steps };
  }

  it("acknowledges only after write, file sync, rename and directory sync, in that order", async () => {
    await initializedYesterday();
    const { io, steps } = recording();
    let acknowledged = false;
    const pending = budget(io)
      .reserve(KEY, 3)
      .then((ok) => {
        acknowledged = ok;
        return ok;
      });
    expect(await pending).toBe(true);
    expect(acknowledged).toBe(true);
    // The budget, then its anchor: each written, synced, renamed and its directory synced.
    expect(steps).toEqual(["write+sync", "rename", "sync-dir", "write+sync", "rename", "sync-dir"]);
  });

  it.each(["write", "rename", "dir"] as const)("a failed %s step is not acknowledged", async (step) => {
    await initializedYesterday();
    const before = readFileSync(file, "utf8");
    const { io } = recording(step);
    expect(await budget(io).reserve(KEY, 3)).toBe(false);
    if (step !== "dir") expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("parallel reservations never exceed the limit", async () => {
    await initializedYesterday();
    const results = await Promise.all(Array.from({ length: 12 }, () => budget().reserve(KEY, 5)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(read()).toMatchObject({ counts: { [KEY]: 5 }, sequence: 5 });
  });

  it("the in-memory budget is labelled not durable", async () => {
    const memory = memoryJudgeBudget({ now: clock });
    expect(memory.durable).toBe(false);
    expect(await memory.reserve(KEY, 1)).toBe(true);
    expect(await memory.reserve(KEY, 1)).toBe(false);
  });
});
