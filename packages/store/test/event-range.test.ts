/**
 * `EventStore.readRange` (#208): a page of a run's log, by sequence number, without reading
 * the log. The contract is stated as "equal to slicing `read()`", so every case here is
 * checked against a slice computed in the test rather than against the other store - and
 * both stores are checked against the same expectation, because a page must not depend on
 * which store is underneath.
 *
 * The two `stops` tests are the reason the method exists. They poison the part of the file
 * a correct scan never reaches with a record that is well-formed JSON but not an event:
 * `read()` throws on it (a schema failure is not a torn line), so a ranged read that
 * succeeds is a ranged read that did not go there.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, type OrcaEvent, type OrcaEventInput } from "@orca/core";
import { InMemoryEventStore, JsonlEventStore, type EventRange, type EventStore } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const RUN = "run_x";

async function jsonlDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "orca-range-"));
  dirs.push(d);
  return d;
}

/** A log with three step runs, run-level events among them, and `agent.update` as the bulk. */
function script(): OrcaEventInput[] {
  const out: OrcaEventInput[] = [
    {
      type: "run.created",
      runId: RUN,
      payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
    },
    { type: "run.started", runId: RUN, payload: {} },
  ];
  for (const stepRunId of ["s1", "s2", "s3"]) {
    out.push({ type: "step.started", runId: RUN, payload: { stepRunId, inputArtifactIds: [] } });
    for (let i = 0; i < 5; i++)
      out.push({
        type: "agent.update",
        runId: RUN,
        payload: { stepRunId, sessionId: `sess-${stepRunId}`, update: { kind: "agent_message_chunk", text: `${i}` } },
      });
    out.push({
      type: "step.completed",
      runId: RUN,
      payload: { stepRunId, result: { artifactIds: [], data: {} } },
    });
  }
  out.push({ type: "run.completed", runId: RUN, payload: { outcome: "success" } });
  return out;
}

async function fill(store: EventStore): Promise<void> {
  for (const input of script()) await store.append(input);
}

function stepRunIdOf(e: OrcaEvent): string | undefined {
  const id = (e.payload as { stepRunId?: unknown }).stepRunId;
  return typeof id === "string" ? id : undefined;
}

/** What `readRange` must equal: filter the whole log, then cut the page off the right end. */
function slice(all: OrcaEvent[], range: EventRange): OrcaEvent[] {
  const matching = all.filter(
    (e) => (!range.types?.length || range.types.includes(e.type)) && (!range.match || range.match(e)),
  );
  if (range.before !== undefined) {
    const earlier = matching.filter((e) => e.seq < range.before!);
    return range.limit === undefined ? earlier : earlier.slice(Math.max(0, earlier.length - range.limit));
  }
  const later = range.after === undefined ? matching : matching.filter((e) => e.seq > range.after!);
  return range.limit === undefined ? later : later.slice(0, range.limit);
}

const CASES: [string, EventRange][] = [
  ["everything", {}],
  ["a forward page from the start", { limit: 4 }],
  ["a forward page from a cursor", { after: 6, limit: 4 }],
  ["a forward page that runs out", { after: 18, limit: 10 }],
  ["a forward page from past the end", { after: 999, limit: 4 }],
  ["a backward page from past the end", { before: 9_007_199_254_740_991, limit: 4 }],
  ["a backward page from a cursor", { before: 12, limit: 5 }],
  ["a backward page that runs out", { before: 3, limit: 10 }],
  ["a backward page from the very start", { before: 0, limit: 4 }],
  ["a type filter", { types: ["step.started", "step.completed"], limit: 4 }],
  ["a type filter backwards", { types: ["step.started", "step.completed"], before: 20, limit: 3 }],
  ["a type nothing emits", { types: ["nope.not.a.type"], limit: 4 }],
  ["a step filter", { match: (e) => stepRunIdOf(e) === "s2", limit: 4 }],
  ["a step filter backwards", { match: (e) => stepRunIdOf(e) === "s2", before: 20, limit: 3 }],
  ["both filters", { types: ["agent.update"], match: (e) => stepRunIdOf(e) === "s3", limit: 3 }],
  ["a filter and a cursor", { types: ["agent.update"], after: 10, limit: 3 }],
  ["no limit at all", { after: 15 }],
];

describe("event store ranged reads", () => {
  for (const [storeName, make] of [
    ["memory", async () => ({ store: new InMemoryEventStore(new FakeClock()) as EventStore, dir: undefined })],
    [
      "jsonl",
      async () => {
        const dir = await jsonlDir();
        return { store: new JsonlEventStore(dir, new FakeClock()) as EventStore, dir };
      },
    ],
  ] as const) {
    // A torn tail on one of them and not the other would make the two stores answer
    // differently by construction, so the jsonl log grows one here and the expectation is
    // still `read()`'s: whatever `read()` skips, a page must skip too.
    for (const torn of [false, true]) {
      if (torn && storeName === "memory") continue;
      const suffix = torn ? " over a torn tail" : "";
      describe(`${storeName}${suffix}`, () => {
        for (const [name, range] of CASES) {
          it(`${name} equals slicing read()`, async () => {
            const { store, dir } = await make();
            await fill(store);
            if (torn)
              await writeFile(
                logFile(dir!),
                '{"type":"run.started","runId":"run_x","payload":{},"id":"evt_t","seq":99,"at":"2',
                { flag: "a" },
              );
            const all = await store.read(RUN);
            expect(await store.readRange(RUN, range)).toEqual(slice(all, range));
          });
        }

        it("reports the last seq without the log", async () => {
          const { store } = await make();
          await fill(store);
          const all = await store.read(RUN);
          expect(await store.lastSeq(RUN)).toBe(all[all.length - 1]!.seq);
        });
      });
    }

    it(`${storeName}: an unknown run has no page and no last seq`, async () => {
      const { store } = await make();
      expect(await store.readRange("run_missing", { limit: 4 })).toEqual([]);
      expect(await store.lastSeq("run_missing")).toBeUndefined();
    });
  }

  it("a forward page stops at the limit instead of reading to the end", async () => {
    const d = await jsonlDir();
    const store = new JsonlEventStore(d, new FakeClock());
    await fill(store);
    await poison(d, "after");
    await expect(store.read(RUN)).rejects.toThrow();
    expect((await store.readRange(RUN, { limit: 3 })).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("a backward page stops at the limit instead of reading to the start", async () => {
    const d = await jsonlDir();
    const store = new JsonlEventStore(d, new FakeClock());
    await fill(store);
    await poison(d, "before");
    await expect(store.read(RUN)).rejects.toThrow();
    const page = await store.readRange(RUN, { before: 21, limit: 3 });
    expect(page.map((e) => e.seq)).toEqual([18, 19, 20]);
    expect(await store.lastSeq(RUN)).toBe(23);
  });
});

/**
 * Put a record that parses as JSON but is not an event where the scan must not go: at the
 * end of the log for a forward test, at the front for a backward one. It is not a torn line
 * - a schema failure throws - so reaching it is what fails the test.
 */
async function poison(dir: string, where: "after" | "before"): Promise<void> {
  const file = logFile(dir);
  const bad = `${JSON.stringify({ seq: -1, nonsense: true })}\n`;
  if (where === "after") return writeFile(file, bad, { flag: "a" });
  await writeFile(file, bad + (await readFile(file, "utf8")));
}

function logFile(dir: string): string {
  return join(dir, "runs", `${RUN}.jsonl`);
}
