/**
 * #701 the plain-rule judge's shared, durable daily budget. Real temporary files; no network.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileJudgeBudget,
  judgeBudgetKey,
  JUDGE_BUDGET_FILE_VERSION,
  memoryJudgeBudget,
} from "../src/review-judge/judge-budget.js";

let dir: string;
let file: string;
let now: number;
const clock = () => now;
const KEY = judgeBudgetKey("https://judge.example/v1/messages", "secret:judge-key");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-701-budget-"));
  file = join(dir, "state", "judge-budget.json");
  now = Date.parse("2026-11-23T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const reserveN = async (budget: ReturnType<typeof fileJudgeBudget>, n: number, key = KEY, limit = 3) => {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(await budget.reserve(key, limit));
  return out;
};

describe("#701 durable judge budget", () => {
  it("is shared by every instance on the same file and survives a restart", async () => {
    const a = fileJudgeBudget(file, { now: clock });
    const b = fileJudgeBudget(file, { now: clock });
    expect(a.durable).toBe(true);
    expect(await a.reserve(KEY, 3)).toBe(true);
    expect(await b.reserve(KEY, 3)).toBe(true);
    // A "restart": a fresh instance reads the same count.
    const c = fileJudgeBudget(file, { now: clock });
    expect(await reserveN(c, 2)).toEqual([true, false]);
    expect(await a.reserve(KEY, 3)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: JUDGE_BUDGET_FILE_VERSION,
      day: "2026-11-23",
      counts: { [KEY]: 3 },
    });
  });

  it("counts each key apart, and the key names no secret value", async () => {
    const budget = fileJudgeBudget(file, { now: clock });
    const other = judgeBudgetKey("https://judge.example/v1/messages", "secret:other-key");
    expect(other).not.toBe(KEY);
    expect(KEY).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await reserveN(budget, 4)).toEqual([true, true, true, false]);
    expect(await budget.reserve(other, 3)).toBe(true);
  });

  it("starts a new count each UTC day and drops the old day's", async () => {
    const budget = fileJudgeBudget(file, { now: clock });
    expect(await reserveN(budget, 4)).toEqual([true, true, true, false]);
    now = Date.parse("2026-11-24T00:00:00Z");
    expect(await budget.reserve(KEY, 3)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ day: "2026-11-24", counts: { [KEY]: 1 } });
  });

  it("refuses rather than resets when the clock moved back before the file's day", async () => {
    const budget = fileJudgeBudget(file, { now: clock });
    await budget.reserve(KEY, 3);
    now = Date.parse("2026-11-22T23:00:00Z");
    expect(await budget.reserve(KEY, 3)).toBe(false);
    now = Number.NaN;
    expect(await budget.reserve(KEY, 3)).toBe(false);
  });

  it("parallel reservations never exceed the limit", async () => {
    const budgets = [fileJudgeBudget(file, { now: clock }), fileJudgeBudget(file, { now: clock })];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => budgets[i % 2]!.reserve(KEY, 5)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(JSON.parse(readFileSync(file, "utf8")).counts[KEY]).toBe(5);
  });

  it("fails closed on a file it cannot read, parse or trust, and never repairs it", async () => {
    const budget = fileJudgeBudget(file, { now: clock });
    mkdirSync(join(dir, "state"), { recursive: true });
    const bad = [
      "not json",
      "[]",
      JSON.stringify({ version: 2, day: "2026-11-23", counts: {} }),
      JSON.stringify({ version: 1, day: "23/11/2026", counts: {} }),
      JSON.stringify({ version: 1, day: "2026-11-23", counts: { [KEY]: -1 } }),
      JSON.stringify({ version: 1, day: "2026-11-23", counts: { [KEY]: 1.5 } }),
      JSON.stringify({ version: 1, day: "2026-11-23", counts: [] }),
      JSON.stringify({ version: 1, day: "2026-11-23", counts: {}, extra: true }),
    ];
    for (const text of bad) {
      writeFileSync(file, text);
      expect(await budget.reserve(KEY, 3)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
    // A directory where the file should be.
    rmSync(file);
    mkdirSync(file);
    expect(await budget.reserve(KEY, 3)).toBe(false);
  });

  const posixOnly = it.skipIf(process.platform === "win32" || process.getuid?.() === 0);
  posixOnly("fails closed when the file cannot be written", async () => {
    const budget = fileJudgeBudget(file, { now: clock });
    expect(await budget.reserve(KEY, 3)).toBe(true);
    chmodSync(join(dir, "state"), 0o500);
    try {
      expect(await budget.reserve(KEY, 3)).toBe(false);
    } finally {
      chmodSync(join(dir, "state"), 0o700);
    }
  });

  it("refuses an invalid key or limit", async () => {
    const budget = fileJudgeBudget(file, { now: clock });
    for (const [key, limit] of [
      ["", 3],
      [KEY, 0],
      [KEY, -1],
      [KEY, 1.5],
      [KEY, 1_000_000],
    ] as const) {
      expect(await budget.reserve(key, limit)).toBe(false);
    }
  });

  it("the in-memory budget is labelled not durable and counts per day", async () => {
    const budget = memoryJudgeBudget({ now: clock });
    expect(budget.durable).toBe(false);
    expect(await budget.reserve(KEY, 1)).toBe(true);
    expect(await budget.reserve(KEY, 1)).toBe(false);
    now = Date.parse("2026-11-24T00:00:00Z");
    expect(await budget.reserve(KEY, 1)).toBe(true);
  });
});
