/**
 * The operations view's history (#340): `runs.list` over a large store, paged by `cursor`
 * (protocol 2.8) rather than read whole - on the in-memory, file and SQLite stores alike.
 *
 * - Pages concatenate to the whole ordered list, with no row twice and none missing, ties
 *   included.
 * - Runs created while someone pages back do not shift the next page onto rows already shown
 *   (the thing `offset` gets wrong), and `total` keeps counting the whole filter.
 * - A cursor handed out before a daemon restart continues the same walk after it.
 * - Every request is bounded: a page is at most `limit` rows, and the operations facts are read
 *   for the rows a page returns and for no other run in the store.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { FakeClock, TemplateRegistry, WorkflowRegistry, silentLogger, type Workspace } from "@orca/core";
import { Orchestrator } from "@orca/engine";
import { fileStores, memoryStores, sqliteStores, type Stores } from "@orca/store";
import {
  RunsListParamsSchema,
  compareRunsListOrder,
  parseRunsListCursor,
  runsListCursor,
  type RunsListParams,
} from "@orca/protocol";
import { ReadModel } from "../src/index.js";
import { START } from "./fixture.js";

const workspace: Workspace = { hostId: "local", cwd: "/work/orca", repo: "orca", branch: "main" };

/**
 * Runs in the large fixture: enough that a page is a small slice of the store. Each `runs.list`
 * still reads every run's listing facts to sort them (the file store has no run index; durable
 * indexing is #339/#341's), so the walks below use pages that keep the file store's run short.
 */
const HISTORY = 1_000;
const PAGE = 250;
/** A file-store page over this fixture reads a thousand small logs; give the walks room. */
const SLOW = 120_000;

const dirs: string[] = [];
const opened: Stores[] = [];
afterEach(async () => {
  for (const stores of opened.splice(0)) stores.close?.();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Kind = "memory" | "file" | "sqlite";

async function openStores(kind: Kind, clock: FakeClock): Promise<() => Stores> {
  if (kind === "memory") {
    const stores = memoryStores(clock);
    return () => stores;
  }
  const dir = await mkdtemp(join(tmpdir(), `orca-history-${kind}-`));
  dirs.push(dir);
  return () => {
    const stores = kind === "file" ? fileStores(dir, clock) : sqliteStores(dir, { clock });
    opened.push(stores);
    return stores;
  };
}

function readModel(stores: Stores, clock: FakeClock): ReadModel {
  const orchestrator = new Orchestrator({
    stores,
    clock,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry(),
    templates: new TemplateRegistry(),
    logger: silentLogger,
  });
  return new ReadModel({ orchestrator, clock });
}

/**
 * `count` finished runs of two workflows, created a second apart in pairs: every second run
 * shares its creation instant with the one before, so the id is what orders them.
 */
async function seed(stores: Stores, clock: FakeClock, count: number, prefix = "run"): Promise<void> {
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) clock.advance(1_000);
    const runId = `${prefix}-${String(i).padStart(5, "0")}`;
    await stores.events.append({
      type: "run.created",
      runId,
      payload: { workflowId: i % 3 === 0 ? "nightly" : "build", workflowVersion: "1", workspace, vars: {} },
    });
    await stores.events.append({ type: "run.started", runId, payload: {} });
    await stores.events.append({
      type: "run.completed",
      runId,
      payload: { outcome: i % 5 === 0 ? "failure" : "success" },
    });
  }
}

const list = (reads: ReadModel, params: Partial<RunsListParams>) => reads.runsList(RunsListParamsSchema.parse(params));

/** Walk every page from the newest by cursor; the ids in the order they were shown. */
async function walk(reads: ReadModel, params: Partial<RunsListParams>, limit = PAGE): Promise<string[]> {
  const shown: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(HISTORY); // never loops on one page
    const page = await list(reads, { ...params, limit, ...(cursor ? { cursor } : {}) });
    expect(page.runs.length).toBeLessThanOrEqual(limit);
    shown.push(...page.runs.map((r) => r.id));
    if (!page.nextCursor) break;
    expect(page.runs.length).toBe(limit);
    cursor = page.nextCursor;
  }
  return shown;
}

describe("the runs.list cursor", () => {
  it("is the row's place in the order, and refuses text no daemon handed out", () => {
    const row = { createdAt: "2026-03-01T09:00:00.000Z", id: "run|with|bars" };
    expect(parseRunsListCursor(runsListCursor(row))).toEqual(row);
    for (const bad of ["", "no-bar", "|run-1", "2026-03-01T09:00:00.000Z|", "yesterday|run-1"]) {
      expect(parseRunsListCursor(bad)).toBeUndefined();
      expect(RunsListParamsSchema.safeParse({ cursor: bad }).success).toBe(false);
    }
    // A page is bounded on the wire too.
    expect(RunsListParamsSchema.safeParse({ limit: 501 }).success).toBe(false);
  });
});

describe.each(["memory", "file", "sqlite"] as const)("history on %s stores", (kind) => {
  it(
    "pages a large history by cursor: the whole ordered list, nothing twice, ties by id",
    async () => {
      const clock = new FakeClock(START);
      const open = await openStores(kind, clock);
      const stores = open();
      await seed(stores, clock, HISTORY);
      const reads = readModel(stores, clock);

      const shown = await walk(reads, {});
      expect(shown).toHaveLength(HISTORY);
      expect(new Set(shown).size).toBe(HISTORY);
      // Newest first; runs sharing an instant are ordered by id, descending, as the daemon sorts.
      expect(shown.slice(0, 4)).toEqual(["run-00999", "run-00998", "run-00997", "run-00996"]);
      expect(shown.at(-1)).toBe("run-00000");

      // The same walk under a filter, with a page size that does not divide it.
      const nightly = await walk(reads, { workflowId: "nightly", outcome: ["failure"] }, 19);
      const expected = shown.filter((id) => {
        const i = Number(id.slice(4));
        return i % 3 === 0 && i % 5 === 0;
      });
      expect(nightly).toEqual(expected);
      const first = await list(reads, { workflowId: "nightly", outcome: ["failure"], limit: 19 });
      expect(first.total).toBe(expected.length);
    },
    SLOW,
  );

  it("is not shifted by runs created while someone pages back, and total counts them", async () => {
    const clock = new FakeClock(START);
    const open = await openStores(kind, clock);
    const stores = open();
    await seed(stores, clock, 300);
    const reads = readModel(stores, clock);

    const first = await list(reads, { limit: 50 });
    expect(first.total).toBe(300);
    const second = await list(reads, { limit: 50, cursor: first.nextCursor! });
    // Twenty runs start between the second page and the third.
    await seed(stores, clock, 20, "new");
    const third = await list(reads, { limit: 50, cursor: second.nextCursor! });
    expect(third.total).toBe(320);
    const ids = [...first.runs, ...second.runs, ...third.runs].map((r) => r.id);
    expect(new Set(ids).size).toBe(150);
    expect(ids).toEqual([...ids].sort((a, b) => b.localeCompare(a)));
    expect(third.runs[0]!.id).toBe("run-00199");
    // `offset` would have shown twenty rows again: the cursor is what keeps the walk honest.
    const byOffset = await list(reads, { limit: 50, offset: 100 });
    expect(byOffset.runs[0]!.id).toBe("run-00219");
  });

  it("continues a walk across a daemon restart from the cursor it handed out", async () => {
    const clock = new FakeClock(START);
    const open = await openStores(kind, clock);
    let stores = open();
    await seed(stores, clock, 250);
    let reads = readModel(stores, clock);
    const whole = await walk(reads, {}, 40);

    const before = await list(reads, { limit: 40 });
    if (kind !== "memory") {
      // A new daemon over the same store: nothing of the old one survives but the files.
      stores.close?.();
      stores = open();
      reads = readModel(stores, clock);
    }
    const rest: string[] = before.runs.map((r) => r.id);
    let cursor = before.nextCursor;
    while (cursor) {
      const page = await list(reads, { limit: 40, cursor });
      rest.push(...page.runs.map((r) => r.id));
      cursor = page.nextCursor;
    }
    expect(rest).toEqual(whole);
    // And each row's links are the canonical ids the store holds, not page positions.
    const got = await reads.runsGet({ runId: rest[137]! });
    expect(got.run.id).toBe(rest[137]);
  });

  it("bounds each request: operations are read for the page's rows and no other run", async () => {
    const clock = new FakeClock(START);
    const open = await openStores(kind, clock);
    const stores = open();
    await seed(stores, clock, 400);
    const reads = readModel(stores, clock);

    const events = stores.events;
    const readRange = events.readRange.bind(events);
    const tails: string[] = [];
    events.readRange = async (runId, range) => {
      if (range?.before === Number.MAX_SAFE_INTEGER) tails.push(runId);
      return readRange(runId, range);
    };
    try {
      const first = await list(reads, { operations: true, limit: 25 });
      const second = await list(reads, { operations: true, limit: 25, cursor: first.nextCursor! });
      expect(second.runs.every((r) => r.operations !== undefined)).toBe(true);
      expect(tails).toEqual([...first.runs, ...second.runs].map((r) => r.id));
    } finally {
      events.readRange = readRange;
    }
  });

  it("orders a page the way the shared comparator says, so a client can merge pages", async () => {
    const clock = new FakeClock(START);
    const open = await openStores(kind, clock);
    const stores = open();
    await seed(stores, clock, 60);
    const reads = readModel(stores, clock);
    const page = await list(reads, { limit: 60 });
    expect(page.runs).toEqual([...page.runs].sort(compareRunsListOrder));
    expect(page.nextCursor).toBeUndefined();
  });
});
