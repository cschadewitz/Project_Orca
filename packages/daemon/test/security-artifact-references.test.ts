/** Artifact-reference permissions over real HTTP/WS reads and both socket delivery paths. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { type PlanEventInput } from "@orca/core";
import { CredentialStore, OwnershipStore, orchestratorResolver, startDaemon } from "@orca/daemon";
import {
  EventAppendedParamsSchema,
  JournalListResultSchema,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  type RunsEventsResult,
  type RunsGetResult,
} from "@orca/protocol";
import { harness, recordGateArtifact, type Harness } from "./security-harness.js";
import { planFixture } from "./plan-fixture.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

type Frame = {
  kind: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: { seq: number; event?: RunsEventsResult["events"][number] };
};

class Client {
  readonly frames: Frame[] = [];
  private nextId = 0;
  private waiters: (() => void)[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.frames.push(
        JSON.parse(
          (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString(
            "utf8",
          ),
        ) as Frame,
      );
      for (const wake of this.waiters.splice(0)) wake();
    });
  }
  static async open(h: Pick<Harness, "daemon">, token: string): Promise<Client> {
    const ws = new WebSocket(h.daemon.socketUrl!, { headers: { authorization: `Bearer ${token}` } });
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    closers.push(async () => ws.close());
    return client;
  }
  async waitFor(predicate: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  async call(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ kind: "request", id, method, params }));
    const frame = await this.waitFor((f) => f.kind === "response" && f.id === id);
    expect(frame.ok, JSON.stringify(frame.error)).toBe(true);
    return frame.result;
  }
  events(): RunsEventsResult["events"] {
    return this.frames.flatMap((f) =>
      f.method === "event.appended" ? [EventAppendedParamsSchema.parse(f.params).event] : [],
    );
  }
}

const ARTIFACT_ID = "private-artifact-reference";
const STEP_ID = "reference-step";

async function recordReferences(h: Harness): Promise<{ started: number; completed: number; hidden: number }> {
  await recordGateArtifact(h, ARTIFACT_ID);
  const hidden = (await h.stores.events.read(h.runs.alice)).at(-1)!.seq;
  await h.append({
    type: "step.scheduled",
    runId: h.runs.alice,
    payload: { stepRunId: STEP_ID, nodeId: "reference-node", nodeType: "agent", attempt: 1 },
  });
  const started = await h.append({
    type: "step.started",
    runId: h.runs.alice,
    payload: { stepRunId: STEP_ID, inputArtifactIds: [ARTIFACT_ID] },
  });
  const completed = await h.append({
    type: "step.completed",
    runId: h.runs.alice,
    payload: { stepRunId: STEP_ID, result: { artifactIds: [ARTIFACT_ID], data: { kept: true }, choice: "continue" } },
  });
  return { started, completed, hidden };
}

function expectLifecycle(events: RunsEventsResult["events"], ids: string[]): void {
  expect(events.find((e) => e.type === "step.started" && e.payload.stepRunId === STEP_ID)).toMatchObject({
    payload: { inputArtifactIds: ids },
  });
  expect(events.find((e) => e.type === "step.completed" && e.payload.stepRunId === STEP_ID)).toMatchObject({
    payload: { result: { artifactIds: ids, data: { kept: true }, choice: "continue" } },
  });
}

describe("artifact-reference projections", () => {
  it.each(["owned", "all"] as const)(
    "withholds IDs with %s run scope over HTTP/WS/live/replay without changing durable history",
    async (runs) => {
      const dir = await mkdtemp(join(tmpdir(), "orca-artifact-references-"));
      closers.push(() => rm(dir, { recursive: true, force: true }));
      const h = await harness({}, fileStores(dir));
      closers.push(() => h.close());
      const token = (
        await h.credentials.issue({ principal: "alice", permissions: ["runs.read"], scope: { workflows: "*", runs } })
      ).token;
      const allowedToken = runs === "owned" ? h.tokens.alice : h.tokens.owner;
      // The restricted listener goes first: mutating a shared event would break the reader after it.
      const restricted = await Client.open(h, token);
      const allowed = await Client.open(h, allowedToken);
      for (const c of [restricted, allowed]) await c.call("subscribe", { runId: h.runs.alice });
      const seq = await recordReferences(h);
      for (const c of [restricted, allowed])
        await c.waitFor((f) => f.method === "event.appended" && f.params?.seq === seq.completed);
      const historyFile = join(dir, "runs", `${h.runs.alice}.jsonl`);
      const durableBefore = await readFile(historyFile, "utf8");
      expect(durableBefore).toContain(ARTIFACT_ID);
      const historyBefore = await h.stores.events.read(h.runs.alice);
      expectLifecycle(historyBefore, [ARTIFACT_ID]);

      const http = (credential: string) => async (method: string, params: unknown) => {
        const reply = (await h.rpc(credential, method, params)).body;
        expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
        return reply.result;
      };
      for (const [read, full] of [
        [http(token), http(allowedToken)],
        [restricted.call.bind(restricted), allowed.call.bind(allowed)],
      ]) {
        const params = { runId: h.runs.alice };
        const view = RunsGetResultSchema.parse(await read!("runs.get", params));
        const fullView = RunsGetResultSchema.parse(await full!("runs.get", params));
        expect(fullView.steps.find((step) => step.id === STEP_ID)).toMatchObject({
          inputArtifactIds: [ARTIFACT_ID],
          outputArtifactIds: [ARTIFACT_ID],
        });
        expect(fullView.artifacts.map((artifact) => artifact.id)).toContain(ARTIFACT_ID);
        expect(view).toEqual({
          ...fullView,
          artifacts: [],
          steps: fullView.steps.map((step) => ({ ...step, inputArtifactIds: [], outputArtifactIds: [] })),
        });
        expect(JSON.stringify(view)).not.toContain(ARTIFACT_ID);
        const inputs = await read!("inputs.list", params);
        expect(JSON.stringify(inputs)).not.toContain(ARTIFACT_ID);
        expect(JSON.stringify(await full!("inputs.list", params))).toContain(ARTIFACT_ID);
        const events = RunsEventsResultSchema.parse(await read!("runs.events", params));
        const fullEvents = RunsEventsResultSchema.parse(await full!("runs.events", params));
        expectLifecycle(events.events, []);
        expectLifecycle(fullEvents.events, [ARTIFACT_ID]);
        expect(JSON.stringify(events)).not.toContain(ARTIFACT_ID);
        expect(events).toMatchObject({
          nextCursor: fullEvents.nextCursor,
          prevCursor: fullEvents.prevCursor,
          hasMore: fullEvents.hasMore,
          lastSeq: fullEvents.lastSeq,
        });
        for (const cursor of [{ after: seq.hidden - 1 }, { before: seq.hidden + 1 }]) {
          const page = RunsEventsResultSchema.parse(await read!("runs.events", { ...params, ...cursor, limit: 1 }));
          const fullPage = RunsEventsResultSchema.parse(await full!("runs.events", { ...params, ...cursor, limit: 1 }));
          expect(page).toEqual({ ...fullPage, events: [] });
          expect(page.nextCursor).toBe(seq.hidden);
          expect(page.prevCursor).toBe(seq.hidden);
          expect(page.lastSeq).toBe(seq.completed);
        }
      }
      expectLifecycle(restricted.events(), []);
      expectLifecycle(allowed.events(), [ARTIFACT_ID]);
      expect(JSON.stringify(restricted.frames)).not.toContain(ARTIFACT_ID);
      // Replay the same durable events after restricted live delivery and both read paths.
      const replay = await Client.open(h, token);
      const fullReplay = await Client.open(h, allowedToken);
      for (const c of [replay, fullReplay]) await c.call("subscribe", { runId: h.runs.alice, since: 0 });
      expectLifecycle(replay.events(), []);
      expectLifecycle(fullReplay.events(), [ARTIFACT_ID]);
      expect(JSON.stringify(replay.frames)).not.toContain(ARTIFACT_ID);
      expect(replay.events().map((event) => event.seq)).toEqual(
        fullReplay
          .events()
          .filter((event) => !["artifact.recorded", "step.inputs"].includes(event.type))
          .map((event) => event.seq),
      );
      expect(await readFile(historyFile, "utf8")).toBe(durableBefore);
      expect(await h.stores.events.read(h.runs.alice)).toEqual(historyBefore);
      const state = await h.orchestrator.getState(h.runs.alice);
      expect(state.steps[STEP_ID]?.inputArtifactIds).toEqual([ARTIFACT_ID]);
      expect(state.steps[STEP_ID]?.result?.artifactIds).toEqual([ARTIFACT_ID]);
      const finalView = (await h.rpc(allowedToken, "runs.get", { runId: h.runs.alice })).body.result as RunsGetResult;
      expect(finalView.steps.find((step) => step.id === STEP_ID)?.outputArtifactIds).toEqual([ARTIFACT_ID]);
    },
  );
});

describe("plan journal artifact-reference projections", () => {
  it("projects only typed artifact links and summaries over HTTP/WS, preserving journal entries and cursors", async () => {
    const fixture = await planFixture();
    const credentials = new CredentialStore();
    const reader = await credentials.issue({
      principal: "planner",
      permissions: ["plan.read"],
      scope: { workflows: "*", runs: "all" },
    });
    const owner = await credentials.issue({ principal: "owner", preset: "owner" });
    const daemon = await startDaemon({
      orcaVersion: "artifact-test",
      capabilities: ["plan.read"],
      reads: fixture.reads,
      source: fixture.orchestrator,
      auth: {
        mode: "token",
        credentials,
        ownership: new OwnershipStore(),
        resolver: orchestratorResolver(fixture.orchestrator),
      },
    });
    closers.push(() => daemon.close());
    const origin = { kind: "artifact" as const, artifactId: ARTIFACT_ID, runId: "origin-run", actor: "planner" };
    const original = await fixture.plan.journalOf(fixture.planId);
    const add = async (input: Omit<PlanEventInput, "origin" | "planId">) =>
      fixture.stores.plan.journal.append({ ...input, planId: fixture.planId, origin } as PlanEventInput);
    const item = original.find((entry) => entry.type === "work-item.added")!;
    if (item.type !== "work-item.added") throw new Error("missing work item");
    await add({
      type: "work-item.added",
      payload: { workItem: { ...item.payload.workItem, produced: { spec: ARTIFACT_ID } } },
    });
    const updated = await add({
      type: "work-item.updated",
      payload: { workItemId: item.payload.workItem.id, changes: { status: "done", produced: { spec: ARTIFACT_ID } } },
    });
    for (const entry of original) {
      if (entry.type === "dependency.added") {
        await add({ type: entry.type, payload: { dependency: { ...entry.payload.dependency, origin } } });
        break;
      }
    }
    const risk = original.find((entry) => entry.type === "risk.raised")!;
    if (risk.type !== "risk.raised") throw new Error("missing risk");
    await add({ type: risk.type, payload: { risk: { ...risk.payload.risk, origin } } });
    await add({
      type: "risk.updated",
      payload: { riskId: risk.payload.risk.id, changes: { origin, status: "mitigated" } },
    });
    const decision = original.find((entry) => entry.type === "decision.opened")!;
    if (decision.type !== "decision.opened") throw new Error("missing decision");
    await add({ type: decision.type, payload: { decision: { ...decision.payload.decision, origin } } });
    await add({
      type: "decision.updated",
      payload: { decisionId: decision.payload.decision.id, changes: { origin, title: "kept title" } },
    });
    // These arbitrary patch fields are not schema-defined artifact links and must survive.
    await add({
      type: "work-item.updated",
      payload: {
        workItemId: item.payload.workItem.id,
        changes: { custom: { artifactId: "user-value", produced: { custom: "value" } } },
      },
    });
    const hidden = await add({
      type: "signals.rejected",
      payload: { artifactId: ARTIFACT_ID, issues: [`Rejected ${ARTIFACT_ID}`] },
    });
    const before = structuredClone(await fixture.plan.journalOf(fixture.planId));
    const http =
      (token: string) =>
      async (method: string, params: unknown): Promise<unknown> => {
        const response = await fetch(`${daemon.url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ kind: "request", id: 1, method, params }),
        });
        const frame = (await response.json()) as Frame;
        expect(frame.ok, JSON.stringify(frame.error)).toBe(true);
        return frame.result;
      };
    const restricted = await Client.open({ daemon }, reader.token);
    const allowed = await Client.open({ daemon }, owner.token);
    for (const [read, full] of [
      [http(reader.token), http(owner.token)],
      [restricted.call.bind(restricted), allowed.call.bind(allowed)],
    ]) {
      const params = { planId: fixture.planId, limit: 500 };
      const page = JournalListResultSchema.parse(await read!("journal.list", params));
      const fullPage = JournalListResultSchema.parse(await full!("journal.list", params));
      expect(fullPage).toEqual(await fixture.plans.journalList(params));
      expect(JSON.stringify(fullPage)).toContain(ARTIFACT_ID);
      expect(JSON.stringify(page)).not.toContain(ARTIFACT_ID);
      expect(page).toMatchObject({
        nextCursor: fullPage.nextCursor,
        prevCursor: fullPage.prevCursor,
        hasMore: fullPage.hasMore,
        lastSeq: fullPage.lastSeq,
      });
      expect(page.entries.find((entry) => entry.seq === updated.seq)).toMatchObject({
        origin: { kind: "artifact", runId: "origin-run", actor: "planner" },
        payload: { changes: { status: "done", produced: {} } },
        summary: `${item.payload.workItem.slug} {"status":"done","produced":{}}`,
      });
      expect(page.entries.find((entry) => entry.seq === hidden.seq - 1)?.payload).toMatchObject({
        changes: { custom: { artifactId: "user-value", produced: { custom: "value" } } },
      });
      for (const cursor of [{ after: hidden.seq - 1 }, { before: hidden.seq + 1 }]) {
        const query = { planId: fixture.planId, ...cursor, limit: 1 };
        const empty = JournalListResultSchema.parse(await read!("journal.list", query));
        const fullHidden = JournalListResultSchema.parse(await full!("journal.list", query));
        expect(empty).toEqual({ ...fullHidden, entries: [] });
        expect(empty.nextCursor).toBe(hidden.seq);
        expect(empty.prevCursor).toBe(hidden.seq);
      }
    }
    expect(await fixture.plan.journalOf(fixture.planId)).toEqual(before);
  });
});
