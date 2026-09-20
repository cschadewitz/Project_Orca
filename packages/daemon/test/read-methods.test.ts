/**
 * The seven read methods against a fixture store - once through the `ReadModel` for the
 * projection itself, and once over `dispatch` so the method table, the params schemas and
 * the error mapping are exercised the way a client reaches them.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { OrcaError } from "@orca/core";
import {
  ArtifactsGetResultSchema,
  ArtifactsListResultSchema,
  ClaimsListResultSchema,
  HelloResultSchema,
  InputsListResultSchema,
  PROTOCOL_VERSION,
  READ_METHODS,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  RunsListResultSchema,
} from "@orca/protocol";
import { ReadModel, dispatch, methods, type MethodContext } from "@orca/daemon";
import { artifactFixture, emptyFixture, fixture, STEP_MS, type Fixture } from "./fixture.js";

let f: Fixture;
let reads: ReadModel;
let ctx: MethodContext;

beforeAll(async () => {
  f = await fixture();
  reads = new ReadModel({ orchestrator: f.orchestrator });
  ctx = { orcaVersion: "0.2.0-test", capabilities: ["runs.read"], storeDir: "/work/orca/.orca", reads };
});

async function call(method: string, params?: unknown) {
  const res = await dispatch(JSON.stringify({ kind: "request", id: 7, method, params }), methods, ctx);
  return res as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
}

describe("runs.list", () => {
  it("returns every run with a log, newest first, named and folded to a display status", async () => {
    const r = RunsListResultSchema.parse((await call("runs.list")).result);
    expect(r.asOf).toBe(f.asOf);
    expect(r.total).toBe(5);
    expect(r.runs.map((x) => x.id)).toEqual(["run-old", "run-lost", "run-gate", "run-child-ok", "run-parent"]);
    expect(r.runs.map((x) => [x.id, x.status])).toEqual([
      ["run-old", "failed"],
      // Says it is running; nothing is heartbeating for it.
      ["run-lost", "stale"],
      ["run-gate", "waiting"],
      ["run-child-ok", "succeeded"],
      // Waiting on its children, with a live lease: that is a run working, not a run stuck.
      ["run-parent", "running"],
    ]);
    // The child spawned by run-parent whose log is gone is not invented into the listing.
    expect(r.runs.map((x) => x.id)).not.toContain("run-child-gone");
  });

  it("names a run after its work item, then its request, then its workflow", async () => {
    const r = await reads.runsList({ limit: 100, offset: 0 });
    const name = (id: string) => r.runs.find((x) => x.id === id)?.name;
    expect(name("run-parent")).toBe("Add the SSO callback");
    expect(name("run-old")).toBe("SSO rollout");
    expect(name("run-lost")).toBe("sdlc");
  });

  it("carries what a row shows: work item, agent, wait, error and duration", async () => {
    const r = await reads.runsList({ limit: 100, offset: 0 });
    const parent = r.runs.find((x) => x.id === "run-parent")!;
    expect(parent.workItem).toEqual({
      id: "wi-1",
      slug: "auth-api",
      title: "Add the SSO callback",
      status: "in-progress",
    });
    expect(parent.agentId).toBe("claude");
    expect(parent.waitingOn).toBe("child-run");
    expect(parent.waitingDetail).toBe("run-child-ok,run-child-gone");
    // A live run's duration is measured to the result's own `asOf`.
    expect(parent.durationMs).toBe(Date.parse(f.asOf) - Date.parse(parent.startedAt!));

    const old = r.runs.find((x) => x.id === "run-old")!;
    expect(old.error).toEqual({ code: "STEP_TIMEOUT", message: "the build never finished" });
    expect(old.durationMs).toBe(STEP_MS);
    expect(old.waitingOn).toBeUndefined();

    const child = r.runs.find((x) => x.id === "run-child-ok")!;
    expect(child.outcome).toBe("success");
    expect(child.parentRunId).toBe("run-parent");
  });

  it("filters by display status, parent and work item, and pages", async () => {
    expect((await reads.runsList({ status: ["waiting"], limit: 100, offset: 0 })).runs.map((x) => x.id)).toEqual([
      "run-gate",
    ]);
    expect((await reads.runsList({ parentRunId: "run-parent", limit: 100, offset: 0 })).runs.map((x) => x.id)).toEqual([
      "run-child-ok",
    ]);
    expect((await reads.runsList({ roots: true, limit: 100, offset: 0 })).runs.map((x) => x.id)).not.toContain(
      "run-child-ok",
    );
    expect((await reads.runsList({ workItemId: "wi-3", limit: 100, offset: 0 })).runs.map((x) => x.id)).toEqual([
      "run-gate",
    ]);
    const page = await reads.runsList({ limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.runs.map((x) => x.id)).toEqual(["run-gate", "run-child-ok"]);
  });

  it("is empty, not an error, on a store with no runs", async () => {
    const empty = emptyFixture();
    const model = new ReadModel({ orchestrator: empty.orchestrator });
    expect(await model.runsList({ limit: 100, offset: 0 })).toEqual({ runs: [], total: 0, asOf: empty.asOf });
    expect(await model.inputsList({})).toEqual({ inputs: [], waiting: 0, asOf: empty.asOf });
    expect(await model.claimsList({})).toEqual({ claims: [], asOf: empty.asOf });
  });
});

describe("runs.get", () => {
  it("returns the tree: every attempt, its children and the branch that never ran", async () => {
    const r = RunsGetResultSchema.parse((await call("runs.get", { runId: "run-parent" })).result);
    expect(r.run.status).toBe("running");
    expect(r.workspace.cwd).toBe("/work/orca");
    expect(r.vars).toEqual({ branch: "feat/sso" });
    expect(r.steps.map((s) => [s.nodeId, s.attempt, s.status])).toEqual([
      ["build", 1, "failed"],
      ["build", 2, "succeeded"],
      // Waiting on child runs is the run working, not a person being asked.
      ["fanout", 1, "running"],
    ]);

    const first = r.steps[0]!;
    expect(first.error).toEqual({ code: "AGENT_TRANSPORT", message: "agent went away" });
    expect(first.agentId).toBe("claude");
    expect(first.agentSessionId).toBe("sess-1");
    expect(first.durationMs).toBe(2 * STEP_MS);

    const built = r.steps[1]!;
    expect(built.outputArtifactIds).toEqual(["art-spec"]);

    const fan = r.steps[2]!;
    expect(fan.children).toEqual([
      {
        runId: "run-child-ok",
        name: "Wire the login button",
        status: "succeeded",
        outcome: "success",
        branch: "auth-ui",
        workItemId: "wi-2",
      },
      // Spawned, and its log is gone: shown as stale under its id rather than dropped.
      { runId: "run-child-gone", name: "run-child-gone", status: "stale", branch: "auth-docs" },
    ]);
    expect(fan.skippedBranches).toEqual([{ branch: "auth-perf", reason: "dependency" }]);
    expect(fan.durationMs).toBe(Date.parse(f.asOf) - Date.parse(fan.startedAt!));

    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]).toMatchObject({
      id: "art-spec",
      kind: "spec",
      version: 1,
      producedByStepRunId: "s-build-2",
    });
    expect(r.lastSeq).toBe(16);
  });

  it("answers RUN_NOT_FOUND for a run the store has never had", async () => {
    const r = await call("runs.get", { runId: "run-nope" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("RUN_NOT_FOUND");
  });
});

describe("runs.events", () => {
  it("pages forward from a sequence number", async () => {
    const first = RunsEventsResultSchema.parse((await call("runs.events", { runId: "run-parent", limit: 5 })).result);
    expect(first.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(first.hasMore).toBe(true);
    expect(first.lastSeq).toBe(16);
    expect(first.nextCursor).toBe(4);

    const next = await reads.runsEvents({ runId: "run-parent", after: first.nextCursor!, limit: 5 });
    expect(next.events.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);

    const tail = await reads.runsEvents({ runId: "run-parent", after: 13, limit: 5 });
    expect(tail.events.map((e) => e.seq)).toEqual([14, 15, 16]);
    expect(tail.hasMore).toBe(false);
  });

  it("pages backward to the events immediately before a sequence number, still oldest first", async () => {
    const page = await reads.runsEvents({ runId: "run-parent", before: 16, limit: 3 });
    expect(page.events.map((e) => e.seq)).toEqual([13, 14, 15]);
    expect(page.hasMore).toBe(true);
    expect(page.prevCursor).toBe(13);

    const head = await reads.runsEvents({ runId: "run-parent", before: 2, limit: 5 });
    expect(head.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(head.hasMore).toBe(false);
  });

  it("filters by type, and an unknown type matches nothing", async () => {
    const steps = await reads.runsEvents({ runId: "run-parent", types: ["step.scheduled"], limit: 100 });
    expect(steps.events.map((e) => e.type)).toEqual(["step.scheduled", "step.scheduled", "step.scheduled"]);
    // `lastSeq` is the run's, not the filtered page's: it is the cursor the whole UI shows.
    expect(steps.lastSeq).toBe(16);
    const none = await reads.runsEvents({ runId: "run-parent", types: ["no.such.event"], limit: 100 });
    expect(none.events).toEqual([]);
    expect(none.hasMore).toBe(false);
  });

  it("narrows to one step run - which is what a step's output pane reads", async () => {
    const step = RunsEventsResultSchema.parse(
      (await call("runs.events", { runId: "run-parent", stepRunId: "s-build-1" })).result,
    );
    expect(step.events.map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    expect(step.events.map((e) => e.type)).toEqual([
      "step.scheduled",
      "step.started",
      "agent.session.opened",
      "step.failed",
    ]);
    // The run's high-water mark, not the filtered page's: one cursor for the whole surface.
    expect(step.lastSeq).toBe(16);
    expect(step.hasMore).toBe(false);

    const unknown = await reads.runsEvents({ runId: "run-parent", stepRunId: "s-nope", limit: 100 });
    expect(unknown.events).toEqual([]);
    expect(unknown.lastSeq).toBe(16);
  });

  it("ANDs the step filter with the type filter, and run-level events are about no step", async () => {
    const failed = await reads.runsEvents({
      runId: "run-parent",
      stepRunId: "s-build-1",
      types: ["step.failed"],
      limit: 100,
    });
    expect(failed.events.map((e) => e.seq)).toEqual([5]);
    // `step.failed` happened and `run.started` happened; no event is both, so this is empty.
    const neither = await reads.runsEvents({
      runId: "run-parent",
      stepRunId: "s-build-1",
      types: ["run.started"],
      limit: 100,
    });
    expect(neither.events).toEqual([]);
    // A run-level event has no `stepRunId`, so no step filter can reach it.
    const runLevel = await reads.runsEvents({ runId: "run-parent", types: ["run.created"], limit: 100 });
    expect(runLevel.events.map((e) => e.seq)).toEqual([0]);
  });

  it("pages a step-filtered log both ways, on cursors that are still the run's sequence numbers", async () => {
    const first = await reads.runsEvents({ runId: "run-parent", stepRunId: "s-fan", limit: 2 });
    expect(first.events.map((e) => e.seq)).toEqual([11, 12]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(12);

    const second = await reads.runsEvents({
      runId: "run-parent",
      stepRunId: "s-fan",
      after: first.nextCursor!,
      limit: 2,
    });
    expect(second.events.map((e) => e.seq)).toEqual([13, 14]);
    expect(second.prevCursor).toBe(13);

    // Back from where the second page starts lands on the first: no gap and no duplicate,
    // even though the sequence numbers in between belong to other steps.
    const back = await reads.runsEvents({
      runId: "run-parent",
      stepRunId: "s-fan",
      before: second.prevCursor!,
      limit: 2,
    });
    expect(back.events.map((e) => e.seq)).toEqual([11, 12]);
    expect(back.hasMore).toBe(false);

    const tail = await reads.runsEvents({ runId: "run-parent", stepRunId: "s-fan", after: 14, limit: 10 });
    expect(tail.events.map((e) => e.seq)).toEqual([15, 16]);
    expect(tail.hasMore).toBe(false);
  });

  it("refuses a page anchored in both directions", async () => {
    const r = await call("runs.events", { runId: "run-parent", after: 1, before: 5 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PROTOCOL_MESSAGE");
  });

  it("answers RUN_NOT_FOUND for an empty log", async () => {
    await expect(reads.runsEvents({ runId: "run-nope", limit: 10 })).rejects.toThrow(OrcaError);
  });
});

describe("inputs.list", () => {
  it("returns the open gate with where it came from, how long it has waited and what it is about", async () => {
    const r = InputsListResultSchema.parse((await call("inputs.list")).result);
    expect(r.waiting).toBe(1);
    const gate = r.inputs[0]!;
    expect(gate).toMatchObject({
      id: "hi-1",
      kind: "decision",
      question: "Ship the rollout?",
      // The whole option (protocol 1.4): the id an answer carries, the label a card draws,
      // and the consequence clause the design requires before offering a choice.
      options: [
        { id: "approve", label: "Approve and ship" },
        { id: "hold", label: "Hold for now", consequence: "The rollout stays parked until someone answers again." },
      ],
      runId: "run-gate",
      runName: "Document the rollout",
      stepRunId: "s-gate",
      nodeId: "approve",
    });
    expect(gate.workItem?.slug).toBe("auth-docs");
    expect(gate.waitingMs).toBe(Date.parse(f.asOf) - Date.parse(gate.requestedAt));
    // The design forbids offering an answer without showing its basis, so the artifacts travel with it.
    expect(gate.artifacts.map((a) => a.id)).toEqual(["art-review"]);
  });

  it("scopes to one run and filters by kind", async () => {
    expect((await reads.inputsList({ runId: "run-parent" })).inputs).toEqual([]);
    expect((await reads.inputsList({ runId: "run-gate" })).inputs.map((i) => i.id)).toEqual(["hi-1"]);
    expect((await reads.inputsList({ kind: ["permission"] })).inputs).toEqual([]);
    expect((await reads.inputsList({ kind: ["decision"] })).inputs.map((i) => i.id)).toEqual(["hi-1"]);
  });
});

describe("claims.list", () => {
  it("says who holds each work item and whether that run is still alive", async () => {
    const r = ClaimsListResultSchema.parse((await call("claims.list")).result);
    expect(r.claims).toHaveLength(2);
    const [live, orphan] = r.claims;
    expect(live).toMatchObject({
      workItemId: "wi-2",
      branch: "auth-ui",
      stepRunId: "s-fan",
      owner: {
        runId: "run-parent",
        name: "Add the SSO callback",
        status: "running",
        missing: false,
        releasable: false,
      },
    });
    expect(live!.workItem?.title).toBe("Wire the login button");
    // The owner's log is gone: `stale`, and releasable without an operator forcing it.
    expect(orphan).toMatchObject({
      workItemId: "wi-3",
      owner: { runId: "run-vanished", status: "stale", missing: true, releasable: true },
    });
  });

  it("scopes to one run", async () => {
    expect((await reads.claimsList({ runId: "run-parent" })).claims.map((c) => c.workItemId)).toEqual(["wi-2"]);
  });
});

describe("artifacts.list", () => {
  let art: Fixture;
  let artReads: ReadModel;

  beforeAll(async () => {
    art = await artifactFixture();
    artReads = new ReadModel({ orchestrator: art.orchestrator });
  });

  it("lists what the index holds, grouped by name and oldest version first", async () => {
    const r = ArtifactsListResultSchema.parse((await call("artifacts.list")).result);
    expect(r.asOf).toBe(f.asOf);
    expect(r.total).toBe(2);
    expect(r.artifacts.map((a) => [a.id, a.name, a.version, a.producedByStepRunId])).toEqual([
      ["art-review", "review", 1, "s-write"],
      ["art-spec", "spec", 1, "s-build-2"],
    ]);
  });

  it("scopes to a run, a name, a kind and a producing step", async () => {
    expect(
      (await reads.artifactsList({ runId: "run-gate", limit: 200, offset: 0 })).artifacts.map((a) => a.id),
    ).toEqual(["art-review"]);
    expect((await reads.artifactsList({ kind: "spec", limit: 200, offset: 0 })).artifacts.map((a) => a.id)).toEqual([
      "art-spec",
    ]);
    expect(
      (await reads.artifactsList({ producedByStepRunId: "s-build-2", limit: 200, offset: 0 })).artifacts.map(
        (a) => a.id,
      ),
    ).toEqual(["art-spec"]);
    expect((await reads.artifactsList({ name: "nothing", limit: 200, offset: 0 })).artifacts).toEqual([]);
  });

  it("is a version list when it is asked for one name, and pages against the whole match", async () => {
    const versions = await artReads.artifactsList({ runId: "run-art", name: "spec", limit: 200, offset: 0 });
    expect(versions.artifacts.map((a) => a.version)).toEqual([1, 2, 3]);
    expect(versions.total).toBe(3);

    const page = await artReads.artifactsList({ runId: "run-art", name: "spec", limit: 2, offset: 1 });
    expect(page.artifacts.map((a) => a.version)).toEqual([2, 3]);
    expect(page.total).toBe(3);
  });

  it("is empty, not an error, on a store with no artifacts", async () => {
    const empty = emptyFixture();
    const model = new ReadModel({ orchestrator: empty.orchestrator });
    expect(await model.artifactsList({ limit: 200, offset: 0 })).toEqual({
      artifacts: [],
      total: 0,
      asOf: empty.asOf,
    });
  });
});

describe("artifacts.get", () => {
  let art: Fixture;
  let artReads: ReadModel;

  beforeAll(async () => {
    art = await artifactFixture();
    artReads = new ReadModel({ orchestrator: art.orchestrator });
  });

  it("serves a body by id", async () => {
    const r = ArtifactsGetResultSchema.parse((await call("artifacts.get", { artifactId: "art-spec" })).result);
    expect(r.artifact).toMatchObject({ id: "art-spec", name: "spec", version: 1, producedByStepRunId: "s-build-2" });
    expect(r.text).toBe("# Spec\n\nThe SSO callback, as designed.\n");
    expect(r.omitted).toBeUndefined();
  });

  it("addresses a version by run and name, and answers the latest without one", async () => {
    const v2 = await artReads.artifactsGet({ runId: "run-art", name: "spec", version: 2, maxBytes: 1_000_000 });
    expect(v2.artifact.id).toBe("art-spec-v2");
    expect(v2.text).toBe("# Spec v2\n");

    const latest = await artReads.artifactsGet({ runId: "run-art", name: "spec", maxBytes: 1_000_000 });
    expect(latest.artifact.version).toBe(3);
    expect(latest.text).toBe("# Spec v3\n");
  });

  it("declines a body that is not text, and says why rather than failing", async () => {
    const r = await artReads.artifactsGet({ artifactId: "art-shot", maxBytes: 1_000_000 });
    expect(r.text).toBeUndefined();
    expect(r.omitted?.reason).toBe("binary");
    // The panel can still draw the chip and the header: size travels on the view.
    expect(r.artifact).toMatchObject({ name: "screenshot", mediaType: "image/png", size: 4096 });
  });

  it("declines a body past `maxBytes` the same way", async () => {
    const r = await reads.artifactsGet({ artifactId: "art-spec", maxBytes: 8 });
    expect(r.text).toBeUndefined();
    expect(r.omitted?.reason).toBe("tooLarge");
  });

  it("answers ARTIFACT_MISSING for an artifact the store has never had", async () => {
    const byId = await call("artifacts.get", { artifactId: "art-nope" });
    expect(byId.ok).toBe(false);
    expect(byId.error?.code).toBe("ARTIFACT_MISSING");

    const byVersion = await call("artifacts.get", { runId: "run-parent", name: "spec", version: 9 });
    expect(byVersion.ok).toBe(false);
    expect(byVersion.error?.code).toBe("ARTIFACT_MISSING");

    await expect(artReads.artifactsGet({ runId: "run-art", name: "nothing", maxBytes: 1 })).rejects.toThrow(OrcaError);
  });

  it("refuses a request that addresses nothing, or both ways at once", async () => {
    expect((await call("artifacts.get", {})).error?.code).toBe("PROTOCOL_MESSAGE");
    expect((await call("artifacts.get", { runId: "run-parent" })).error?.code).toBe("PROTOCOL_MESSAGE");
    expect(
      (await call("artifacts.get", { artifactId: "art-spec", runId: "run-parent", name: "spec" })).error?.code,
    ).toBe("PROTOCOL_MESSAGE");
  });
});

describe("hello", () => {
  it("reports the read methods it serves", async () => {
    const r = HelloResultSchema.parse((await call("hello", { client: "test/1", protocol: PROTOCOL_VERSION })).result);
    expect(r.capabilities).toEqual(["runs.read"]);
    expect(r.methods).toEqual(["hello", ...READ_METHODS]);
    expect(r.storeDir).toBe("/work/orca/.orca");
  });

  it("offers `hello` alone when the daemon serves no store", async () => {
    const bare: MethodContext = { orcaVersion: "0.2.0-test", capabilities: [] };
    const res = await dispatch(
      JSON.stringify({ kind: "request", id: 1, method: "hello", params: { client: "c", protocol: PROTOCOL_VERSION } }),
      { hello: methods.hello! },
      bare,
    );
    expect(HelloResultSchema.parse((res as { result: unknown }).result).methods).toEqual(["hello"]);
    const refused = await dispatch(
      JSON.stringify({ kind: "request", id: 2, method: "runs.list", params: {} }),
      methods,
      bare,
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "NOT_SUPPORTED" } });
  });
});
