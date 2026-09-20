// @vitest-environment happy-dom
/**
 * The fake bridge, and the fixtures behind it.
 *
 * The first block is the one that keeps the rest honest: every fixture is parsed through the
 * protocol's own schema, so the day a result grows a required field this file fails rather
 * than a screen test that was asserting on a shape the daemon no longer sends. The rest is
 * the fake's own contract — paging, filtering, holds, failures and notifications — because a
 * test seam nobody tests is a test seam that lies.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaimsListResultSchema,
  AgentsListResultSchema,
  HelloResultSchema,
  InputsAnswerResultSchema,
  InputsListResultSchema,
  RunsCancelResultSchema,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  RunsListResultSchema,
  RunsResumeResultSchema,
} from "@orca/protocol";
import { fakeBridge, type FakeBridge } from "./fake-bridge.js";
import { DEFAULT_PREFERENCES } from "../../src/preferences/schema.js";

const teardown: (() => void)[] = [];
afterEach(() => {
  while (teardown.length) teardown.pop()?.();
});

function bridge(): FakeBridge {
  const fake = fakeBridge();
  teardown.push(fake.install());
  return fake;
}

/** Unwrap a successful answer, failing loudly with the protocol error when it is not one. */
async function result<T>(
  answer: Promise<{ ok: true; result: T } | { ok: false; error: { code: string } }>,
): Promise<T> {
  const r = await answer;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
}

describe("fixtures", () => {
  it("are what @orca/protocol says a result is", async () => {
    const { bridge: b } = bridge();
    HelloResultSchema.parse(await result(b.hello()));
    RunsListResultSchema.parse(await result(b.runs.list()));
    RunsGetResultSchema.parse(await result(b.runs.get({ runId: "run-parent" })));
    RunsGetResultSchema.parse(await result(b.runs.get({ runId: "run-gate" })));
    RunsEventsResultSchema.parse(await result(b.runs.events({ runId: "run-parent" })));
    RunsEventsResultSchema.parse(await result(b.runs.events({ runId: "run-gate" })));
    InputsListResultSchema.parse(await result(b.inputs.list()));
    InputsAnswerResultSchema.parse(await result(b.inputs.answer({ requestId: "hi-1", optionId: "approve" })));
    RunsCancelResultSchema.parse(await result(b.runs.cancel({ runId: "run-parent" })));
    RunsResumeResultSchema.parse(await result(b.runs.resume({ runId: "run-gate" })));
    ClaimsListResultSchema.parse(await result(b.claims.list()));
    AgentsListResultSchema.parse(await result(b.agents.list()));
  });

  it("cover a live run, a finished one, a run asking for a person and a run nobody is driving", async () => {
    const list = await result(bridge().bridge.runs.list());
    expect(list.runs.map((r) => [r.id, r.status])).toEqual([
      ["run-old", "failed"],
      ["run-lost", "stale"],
      ["run-gate", "waiting"],
      ["run-child-ok", "succeeded"],
      ["run-parent", "running"],
    ]);
  });
});

describe("the read methods", () => {
  it("filters runs by status, parent and root-ness", async () => {
    const { bridge: b } = bridge();
    expect((await result(b.runs.list({ status: ["stale"] }))).runs.map((r) => r.id)).toEqual(["run-lost"]);
    expect((await result(b.runs.list({ parentRunId: "run-parent" }))).runs.map((r) => r.id)).toEqual(["run-child-ok"]);
    expect((await result(b.runs.list({ roots: true }))).runs.map((r) => r.id)).not.toContain("run-child-ok");
  });

  it("pages, and reports the total against the filter rather than the page", async () => {
    const { bridge: b } = bridge();
    const page = await result(b.runs.list({ limit: 2, offset: 1 }));
    expect(page.runs.map((r) => r.id)).toEqual(["run-lost", "run-gate"]);
    expect(page.total).toBe(5);
  });

  it("answers for a run it has never heard of with a protocol error, not a rejection", async () => {
    const answer = await bridge().bridge.runs.get({ runId: "run-nope" });
    expect(answer.ok).toBe(false);
    expect(answer.ok || answer.error.code).toBe("RUN_NOT_FOUND");
  });

  it("walks a run's log forward and backward, and refuses both anchors at once", async () => {
    const { bridge: b } = bridge();

    const first = await result(b.runs.events({ runId: "run-gate", limit: 4 }));
    expect(first.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(first.hasMore).toBe(true);
    expect(first.lastSeq).toBe(11);

    const next = await result(b.runs.events({ runId: "run-gate", after: first.nextCursor, limit: 4 }));
    expect(next.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);

    // Backward is the events *immediately* before the cursor, still oldest first.
    const back = await result(b.runs.events({ runId: "run-gate", before: 11, limit: 3 }));
    expect(back.events.map((e) => e.seq)).toEqual([8, 9, 10]);

    const both = await b.runs.events({ runId: "run-gate", after: 1, before: 5 });
    expect(both.ok).toBe(false);
  });

  it("filters the log by event type without changing lastSeq", async () => {
    const page = await result(bridge().bridge.runs.events({ runId: "run-parent", types: ["child.spawned"] }));
    expect(page.events.map((e) => e.seq)).toEqual([13, 14]);
    expect(page.lastSeq).toBe(16);
  });

  it("lists the open input with the artifact its decision is about", async () => {
    const { bridge: b } = bridge();
    const open = await result(b.inputs.list());
    expect(open.waiting).toBe(1);
    expect(open.inputs[0]?.artifacts.map((a) => a.id)).toEqual(["art-review"]);
    expect((await result(b.inputs.list({ kind: ["permission"] }))).inputs).toEqual([]);
    expect((await result(b.inputs.list({ runId: "run-parent" }))).inputs).toEqual([]);
  });

  it("lists claims, including one whose owning run's log is gone", async () => {
    const { bridge: b } = bridge();
    const all = await result(b.claims.list());
    expect(all.claims.map((c) => [c.workItemId, c.owner.missing, c.owner.releasable])).toEqual([
      ["wi-2", false, false],
      ["wi-3", true, true],
    ]);
    expect((await result(b.claims.list({ runId: "run-parent" }))).claims).toHaveLength(1);
  });

  it("lists every configured agent, both hosts and all four health states", async () => {
    const { bridge: b } = bridge();
    const list = await result(b.agents.list());
    expect(list.agents.map((a) => [a.id, a.hostId, a.hostType, a.state])).toEqual([
      ["claude", "local", "local", "ok"],
      ["codex", "local", "local", "unknown"],
      ["gemini", "build-box", "ssh", "degraded"],
      ["sandbox", "build-box", "ssh", "down"],
    ]);
    // An agent nothing has contacted has no timestamps rather than invented ones (#222).
    expect(list.agents[1]!.lastHandshakeAt).toBeUndefined();
    expect(list.agents[1]!.lastSeenAt).toBeUndefined();
    // `consecutiveFailures` is non-zero exactly while `down`.
    expect(list.agents.map((a) => a.consecutiveFailures)).toEqual([0, 0, 0, 3]);
    // The claims travel with the list, and are the same ones `claims.list` projects.
    expect(list.claims).toEqual((await result(b.claims.list())).claims);
  });
});

describe("scripting", () => {
  it("records every call in order, with its params", async () => {
    const fake = bridge();
    await fake.bridge.hello();
    await fake.bridge.runs.list({ roots: true });
    expect(fake.calls).toEqual([
      { method: "hello", params: undefined },
      { method: "runs.list", params: { roots: true } },
    ]);
  });

  it("replaces a method's answer", async () => {
    const fake = bridge();
    fake.script({
      "runs.list": () => ({ ok: true, result: { runs: [], total: 0, asOf: "2026-03-01T09:00:00.000Z" } }),
    });
    expect((await result(fake.bridge.runs.list())).runs).toEqual([]);
  });

  it("fails a method the way the real bridge reports a dead daemon: a result, never a rejection", async () => {
    const fake = bridge();
    fake.fail("hello", { code: "AGENT_TRANSPORT", message: "no daemon" });
    const answer = await fake.bridge.hello();
    expect(answer).toEqual({ ok: false, error: { code: "AGENT_TRANSPORT", message: "no daemon" } });
  });

  it("holds a call pending until it is released, so a loading state can be asserted", async () => {
    const fake = bridge();
    const release = fake.hold("runs.list");
    let settled = false;
    const pending = fake.bridge.runs.list().then((r) => {
      settled = true;
      return r;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    // The call is recorded when it is made, not when it answers: a screen under test has asked.
    expect(fake.calls).toHaveLength(1);

    release();
    expect((await result(pending)).total).toBe(5);
  });
});

describe("notifications", () => {
  it("delivers to every subscriber and stops on unsubscribe", () => {
    const fake = bridge();
    const seen: string[] = [];
    const off = fake.bridge.notifications.subscribe((n) => seen.push(n.method));
    fake.bridge.notifications.subscribe((n) => seen.push(`second:${n.method}`));
    expect(fake.subscribers).toBe(2);

    fake.notify({ kind: "notification", method: "runs.changed", params: { runId: "run-parent" } });
    expect(seen).toEqual(["runs.changed", "second:runs.changed"]);

    off();
    fake.notify({ kind: "notification", method: "inputs.changed" });
    expect(fake.subscribers).toBe(1);
    expect(seen).toEqual(["runs.changed", "second:runs.changed", "second:inputs.changed"]);
  });
});

describe("installation", () => {
  it("is what window.orca is, and puts back what was there before", async () => {
    expect((window as { orca?: unknown }).orca).toBeUndefined();
    const fake = fakeBridge({ platform: "linux" });
    const restore = fake.install();
    expect(window.orca.platform).toBe("linux");
    expect(await result(Promise.resolve(window.orca.preferences.write({ theme: "dark" })))).toEqual({
      theme: "dark",
      density: {},
      alerts: DEFAULT_PREFERENCES.alerts,
    });
    expect(window.orca.preferences.read().theme).toBe("dark");
    restore();
    expect((window as { orca?: unknown }).orca).toBeUndefined();
  });
});
