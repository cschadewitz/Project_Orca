import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENTS_LIST_METHOD,
  AgentsListParamsSchema,
  ARTIFACTS_GET_METHOD,
  ARTIFACTS_LIST_METHOD,
  ArtifactsGetParamsSchema,
  ArtifactsListParamsSchema,
  CLAIMS_LIST_METHOD,
  ClaimsListParamsSchema,
  HELLO_METHOD,
  INPUTS_ANSWER_METHOD,
  INPUTS_LIST_METHOD,
  InputsAnswerParamsSchema,
  InputsListParamsSchema,
  PROTOCOL_VERSION,
  RUNS_CANCEL_METHOD,
  RUNS_EVENTS_METHOD,
  RUNS_GET_METHOD,
  RUNS_LIST_METHOD,
  RUNS_RESUME_METHOD,
  RunsCancelParamsSchema,
  RunsEventsParamsSchema,
  RunsGetParamsSchema,
  RunsListParamsSchema,
  RunsResumeParamsSchema,
  SOCKET_PATH,
  CLAIMS_RELEASE_METHOD,
  ClaimsReleaseParamsSchema,
  CONFIG_GET_METHOD,
  CONFIG_SET_METHOD,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  DECISIONS_DECIDE_METHOD,
  DECISIONS_LIST_METHOD,
  DECISIONS_REOPEN_METHOD,
  DecisionsDecideParamsSchema,
  DecisionsListParamsSchema,
  DecisionsReopenParamsSchema,
  DEPENDENCIES_LIST_METHOD,
  DEPENDENCIES_WAIVE_METHOD,
  DependenciesListParamsSchema,
  DependenciesWaiveParamsSchema,
  ITEMS_LIST_METHOD,
  ItemsListParamsSchema,
  JOURNAL_LIST_METHOD,
  JournalListParamsSchema,
  PLAN_GET_METHOD,
  PLANS_LIST_METHOD,
  PlanGetParamsSchema,
  PlansListParamsSchema,
  RISKS_LIST_METHOD,
  RISKS_UPDATE_METHOD,
  RisksListParamsSchema,
  RisksUpdateParamsSchema,
  RUNS_START_METHOD,
  RunsStartParamsSchema,
  SCHEDULE_EXPLAIN_METHOD,
  SCHEDULE_GET_METHOD,
  ScheduleExplainParamsSchema,
  ScheduleGetParamsSchema,
  WORKFLOWS_GET_METHOD,
  WORKFLOWS_LIST_METHOD,
  WorkflowsGetParamsSchema,
  WorkflowsListParamsSchema,
} from "@orca/protocol";
import { hello, startDaemon, type DaemonHandle, type MethodTable } from "@orca/daemon";
/* The renderer's fixtures, read as data. They are protocol-shaped constants with no DOM in
   them — the plan ones came off a real `PlanModel` run — and `fake-bridge.test.ts` already
   parses each one through its schema, so this file borrows them rather than keeping a
   second set of plan, workflow and config views in step with the first. */
import { CLAIMS, AS_OF as PLAN_AS_OF } from "../renderer/test/fixtures.js";
import { CONFIG_GET } from "../renderer/test/fixtures-config.js";
import {
  DECISIONS,
  DEPENDENCIES,
  EXPLANATIONS,
  JOURNAL,
  PLAN,
  PLAN_ID,
  PLAN_ITEMS,
  PLANS,
  RISKS,
  SCHEDULE,
} from "../renderer/test/fixtures-plan.js";
import { AI_SDLC, WORKFLOWS } from "../renderer/test/fixtures-workflows.js";
import { DaemonClient, DaemonClientError, DEFAULT_DAEMON_URL } from "../src/client/daemon-client.js";

describe("DaemonClient", () => {
  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read"],
      auth: { mode: "loopback-unauthenticated" },
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("prepares admission through the typed client and refuses another updater's token", async () => {
    const client = new DaemonClient(d.url);
    expect(await client.maintenance({ action: "prepare", token: "owner" })).toEqual({ ready: true, active: [] });
    await expect(client.maintenance({ action: "resume", token: "other" })).rejects.toBeInstanceOf(DaemonClientError);
    expect((await client.hello("update-test")).methods).toContain("maintenance");
    expect(await client.maintenance({ action: "resume", token: "owner" })).toEqual({ ready: false, active: [] });
  });

  it("defaults to the local daemon URL", () => {
    expect(new DaemonClient().url).toBe(DEFAULT_DAEMON_URL);
  });

  it("completes the handshake against a real daemon", async () => {
    const hello = await new DaemonClient(d.url).hello("test/1");
    expect(hello.protocol).toEqual(PROTOCOL_VERSION);
    expect(hello.capabilities).toEqual(["runs.read"]);
  });

  it("surfaces a daemon error as DaemonClientError with the protocol code", async () => {
    await expect(new DaemonClient(d.url).call("runs.list", {}, z.unknown())).rejects.toMatchObject({
      name: "DaemonClientError",
      error: { code: "PROTOCOL_METHOD" },
    });
  });

  it("rejects a body that is not a response envelope", async () => {
    const fake: typeof fetch = async () => new Response(JSON.stringify({ nope: 1 }));
    const err = await new DaemonClient("http://x", fake).hello("t").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonClientError);
    expect((err as DaemonClientError).error.code).toBe("PROTOCOL_MESSAGE");
  });

  it("puts the socket beside the read endpoint, on the same host and port", () => {
    expect(new DaemonClient("http://10.0.0.2:6722").socketUrl).toBe(`ws://10.0.0.2:6722${SOCKET_PATH}`);
    expect(new DaemonClient("https://orca.example/").socketUrl).toBe(`wss://orca.example${SOCKET_PATH}`);
  });
});

/**
 * The five read methods over the wire. The daemon behind them answers from a stub table
 * rather than a `ReadModel`, because what is under test here is the client: that it names
 * the right method, passes its params through and parses the answer with the right schema.
 * The projection itself is `packages/daemon`'s test, and building one needs an engine, which
 * `packages/app` may not depend on (ADR 0008).
 */
describe("the read methods", () => {
  const asOf = "2026-03-01T09:00:00.000Z";
  const seen: { method: string; params: unknown }[] = [];

  /** Record the call, then answer with the emptiest thing each result schema accepts. */
  const answer = <P, R>(method: string, params: z.ZodType<P>, result: R) => ({
    params,
    handle: (p: P): R => {
      seen.push({ method, params: p });
      return result;
    },
  });

  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [RUNS_LIST_METHOD]: answer(RUNS_LIST_METHOD, RunsListParamsSchema, { runs: [], total: 0, asOf }),
    [RUNS_GET_METHOD]: answer(RUNS_GET_METHOD, RunsGetParamsSchema, {
      run: {
        id: "run-1",
        name: "A run",
        workflowId: "wf",
        workflowVersion: "1",
        status: "running" as const,
        createdAt: asOf,
      },
      workspace: { hostId: "local", cwd: "/work/orca" },
      vars: {},
      steps: [],
      artifacts: [],
      lastSeq: 0,
      asOf,
    }),
    [RUNS_EVENTS_METHOD]: answer(RUNS_EVENTS_METHOD, RunsEventsParamsSchema, {
      events: [],
      hasMore: false,
      lastSeq: 0,
      asOf,
    }),
    [INPUTS_LIST_METHOD]: answer(INPUTS_LIST_METHOD, InputsListParamsSchema, { inputs: [], waiting: 0, asOf }),
    [CLAIMS_LIST_METHOD]: answer(CLAIMS_LIST_METHOD, ClaimsListParamsSchema, { claims: [], asOf }),
  };

  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read"],
      auth: { mode: "loopback-unauthenticated" },
      methods: table,
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("calls each one by name and parses its result", async () => {
    const client = new DaemonClient(d.url);
    expect((await client.runsList({ roots: true })).total).toBe(0);
    expect((await client.runsGet({ runId: "run-1" })).run.id).toBe("run-1");
    expect((await client.runsEvents({ runId: "run-1", after: 3 })).lastSeq).toBe(0);
    expect((await client.inputsList({ kind: ["decision"] })).waiting).toBe(0);
    expect((await client.claimsList()).claims).toEqual([]);

    expect(seen.map((c) => c.method)).toEqual([
      RUNS_LIST_METHOD,
      RUNS_GET_METHOD,
      RUNS_EVENTS_METHOD,
      INPUTS_LIST_METHOD,
      CLAIMS_LIST_METHOD,
    ]);
    // Params travel as given, with the schema's paging defaults filled in by the daemon.
    expect(seen[0]!.params).toEqual({ roots: true, limit: 100, offset: 0 });
    expect(seen[2]!.params).toEqual({ runId: "run-1", after: 3, limit: 200 });
    expect(seen[3]!.params).toEqual({ kind: ["decision"] });
  });
});

/**
 * The two artifact reads (#159), in their own daemon because their results are the one pair
 * with a shape worth asserting: `list` never carries a body, and `get` may decline one with
 * a reason in words rather than answering with an error.
 */
describe("the artifact methods", () => {
  const asOf = "2026-03-01T09:00:00.000Z";
  const seen: { method: string; params: unknown }[] = [];
  const view = {
    id: "art-spec-v3",
    kind: "spec",
    name: "spec",
    version: 3,
    mediaType: "text/markdown",
    size: 128,
    createdAt: asOf,
  };

  const record = <P, R>(method: string, params: z.ZodType<P>, result: R) => ({
    params,
    handle: (p: P): R => {
      seen.push({ method, params: p });
      return result;
    },
  });

  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [ARTIFACTS_LIST_METHOD]: record(ARTIFACTS_LIST_METHOD, ArtifactsListParamsSchema, {
      artifacts: [view],
      total: 1,
      asOf,
    }),
    [ARTIFACTS_GET_METHOD]: record(ARTIFACTS_GET_METHOD, ArtifactsGetParamsSchema, {
      artifact: { ...view, name: "screenshot", mediaType: "image/png" },
      omitted: { reason: "binary" as const, detail: "image/png is not text" },
      asOf,
    }),
  };

  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read"],
      auth: { mode: "loopback-unauthenticated" },
      methods: table,
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("lists metadata only, and takes the step filter a row of chips needs", async () => {
    const page = await new DaemonClient(d.url).artifactsList({ runId: "run-art", producedByStepRunId: "s-spec-3" });
    expect(page.artifacts.map((a) => a.id)).toEqual(["art-spec-v3"]);
    expect(seen[0]).toEqual({
      method: ARTIFACTS_LIST_METHOD,
      params: { runId: "run-art", producedByStepRunId: "s-spec-3", limit: 200, offset: 0 },
    });
  });

  it("parses a declined body as an omission with its reason, not as an error", async () => {
    const answer = await new DaemonClient(d.url).artifactsGet({ runId: "run-art", name: "screenshot" });
    expect(answer.text).toBeUndefined();
    expect(answer.omitted).toEqual({ reason: "binary", detail: "image/png is not text" });
  });
});

/**
 * `agents.list` (#166), in its own daemon because the shape worth asserting is an agent
 * ORCA has *not* reached yet: health is in-process only, so a daemon that has just started
 * knows nothing about any agent, and the client must carry that absence through rather than
 * filling it in. An `unknown` agent with no timestamps is the common case on a cold daemon,
 * not an edge one.
 */
describe("the agents method", () => {
  const asOf = "2026-03-01T09:00:00.000Z";
  let seen: unknown;

  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [AGENTS_LIST_METHOD]: {
      params: AgentsListParamsSchema,
      handle: (p: unknown) => {
        seen = p;
        return {
          agents: [
            {
              id: "claude",
              hostId: "local",
              hostType: "local",
              roles: ["build"],
              state: "unknown",
              consecutiveFailures: 0,
            },
            {
              id: "codex",
              hostId: "builder",
              hostType: "ssh",
              roles: ["review"],
              state: "down",
              lastHandshakeAt: asOf,
              lastSeenAt: asOf,
              roundTripMs: 42,
              consecutiveFailures: 3,
              lastError: { code: "AGENT_TRANSPORT", message: "ssh: connect: connection refused" },
            },
          ],
          claims: [
            {
              workItemId: "wi-7",
              branch: "auth-ui",
              claimedAt: asOf,
              owner: { runId: "run-1", name: "sdlc", status: "running", missing: false, releasable: false },
            },
          ],
          asOf,
        };
      },
    },
  };

  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read"],
      auth: { mode: "loopback-unauthenticated" },
      methods: table,
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("takes no parameters, and keeps an uncontacted agent's absent times absent", async () => {
    const answer = await new DaemonClient(d.url).agentsList();
    expect(seen).toEqual({});

    const [cold, gone] = answer.agents;
    expect(cold).toMatchObject({ id: "claude", state: "unknown", consecutiveFailures: 0 });
    expect(cold?.lastHandshakeAt).toBeUndefined();
    expect(cold?.lastSeenAt).toBeUndefined();
    expect(cold?.roundTripMs).toBeUndefined();

    // A down agent keeps what it cost when it last worked, and says why it stopped.
    expect(gone).toMatchObject({ hostType: "ssh", state: "down", roundTripMs: 42, consecutiveFailures: 3 });
    expect(gone?.lastError?.code).toBe("AGENT_TRANSPORT");
  });

  it("carries the claims beside the agents, so one read answers both questions", async () => {
    const answer = await new DaemonClient(d.url).agentsList();
    expect(answer.claims.map((c) => c.workItemId)).toEqual(["wi-7"]);
    expect(answer.claims[0]?.owner.runId).toBe("run-1");
    expect(answer.asOf).toBe(asOf);
  });
});

/**
 * The three control methods (#160, #161): the calls that write.
 *
 * What the client has to get right about them is narrow and worth pinning. `resume` is the
 * daemon's default and not the client's, so an answer sent without it arrives as `true` —
 * the app never states it, and a client that filled it in itself would have to be changed
 * the day the default changes. And `permission` comes back verbatim, with `added`,
 * `alreadyPresent` and `refused` intact, because a button that promises "ORCA will not ask
 * again" reads all three before it says so.
 *
 * `runs.start` is absent from the client for the same reason it is absent from the bridge:
 * nothing in the app can pick a workflow to start yet (#178).
 */
describe("the control methods", () => {
  const asOf = "2026-03-01T09:00:00.000Z";
  const seen: { method: string; params: unknown }[] = [];
  const run = {
    id: "run-gate",
    name: "Document the rollout",
    workflowId: "sdlc",
    workflowVersion: "1",
    status: "waiting" as const,
    createdAt: asOf,
  };

  const record = <P, R>(method: string, params: z.ZodType<P>, result: R) => ({
    params,
    handle: (p: P): R => {
      seen.push({ method, params: p });
      return result;
    },
  });

  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [INPUTS_ANSWER_METHOD]: record(INPUTS_ANSWER_METHOD, InputsAnswerParamsSchema, {
      requestId: "hi-1",
      runId: "run-gate",
      answer: "allow_always",
      permission: {
        file: "/work/orca/orca.permissions.json",
        agentId: "claude",
        rules: [{ match: { kind: "execute" as const, path: "scripts/deploy.sh" }, decision: "allow" as const }],
        added: [{ match: { kind: "execute" as const, path: "scripts/deploy.sh" }, decision: "allow" as const }],
        alreadyPresent: [],
      },
      run: { ...run, status: "running" as const },
      asOf,
    }),
    [RUNS_RESUME_METHOD]: record(RUNS_RESUME_METHOD, RunsResumeParamsSchema, { run, asOf }),
    [RUNS_CANCEL_METHOD]: record(RUNS_CANCEL_METHOD, RunsCancelParamsSchema, {
      run: { ...run, status: "cancelled" as const },
      asOf,
    }),
  };

  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read", "runs.control"],
      auth: { mode: "loopback-unauthenticated" },
      methods: table,
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("answers an input by option id, and leaves `resume` to the daemon's default", async () => {
    const answered = await new DaemonClient(d.url).inputsAnswer({
      requestId: "hi-1",
      optionId: "allow_always",
      always: { decision: "allow" },
    });
    expect(answered.answer).toBe("allow_always");
    expect(answered.permission?.added).toHaveLength(1);
    expect(answered.permission?.refused).toBeUndefined();
    expect(seen[0]).toEqual({
      method: INPUTS_ANSWER_METHOD,
      params: { requestId: "hi-1", optionId: "allow_always", always: { decision: "allow" }, resume: true },
    });
  });

  it("resumes and cancels a run, and answers with the run as it stands", async () => {
    const client = new DaemonClient(d.url);
    expect((await client.runsResume({ runId: "run-gate" })).run.status).toBe("waiting");
    expect((await client.runsCancel({ runId: "run-gate", reason: "no longer needed" })).run.status).toBe("cancelled");
    expect(seen.slice(1)).toEqual([
      { method: RUNS_RESUME_METHOD, params: { runId: "run-gate" } },
      { method: RUNS_CANCEL_METHOD, params: { runId: "run-gate", reason: "no longer needed" } },
    ]);
  });
});

/**
 * The nine plan reads and the four plan writes (#169, #170, #178), plus `claims.release`
 * (#88) — every one of them a one-line delegation to `call`, which is exactly why they are
 * tested together and by table. What can go wrong in a line like that is the method name,
 * the params schema it is parsed against on the daemon's side, and the result schema it is
 * parsed with here; all three are what this asserts.
 *
 * The fixtures are the renderer's, not a second set written for this file. They are plain
 * protocol-shaped data — `fixtures-plan.ts` was taken off a real `PlanModel` run and
 * `fake-bridge.test.ts` already parses every constant in it through its protocol schema —
 * so a change to a view's shape breaks one fixture rather than two copies of it.
 */
describe("the plan methods", () => {
  const asOf = PLAN_AS_OF;
  const seen: { method: string; params: unknown }[] = [];

  const record = <P, R>(method: string, params: z.ZodType<P>, result: R) => ({
    params,
    handle: (p: P): R => {
      seen.push({ method, params: p });
      return result;
    },
  });

  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [PLANS_LIST_METHOD]: record(PLANS_LIST_METHOD, PlansListParamsSchema, { plans: [...PLANS], asOf }),
    [PLAN_GET_METHOD]: record(PLAN_GET_METHOD, PlanGetParamsSchema, { plan: PLAN, asOf }),
    [ITEMS_LIST_METHOD]: record(ITEMS_LIST_METHOD, ItemsListParamsSchema, {
      items: [...PLAN_ITEMS],
      total: PLAN_ITEMS.length,
      asOf,
    }),
    [SCHEDULE_GET_METHOD]: record(SCHEDULE_GET_METHOD, ScheduleGetParamsSchema, { schedule: SCHEDULE, asOf }),
    [SCHEDULE_EXPLAIN_METHOD]: record(SCHEDULE_EXPLAIN_METHOD, ScheduleExplainParamsSchema, {
      lines: [...(EXPLANATIONS["auth-api"] ?? [])],
      asOf,
    }),
    [DEPENDENCIES_LIST_METHOD]: record(DEPENDENCIES_LIST_METHOD, DependenciesListParamsSchema, {
      dependencies: [...DEPENDENCIES],
      asOf,
    }),
    [RISKS_LIST_METHOD]: record(RISKS_LIST_METHOD, RisksListParamsSchema, {
      risks: [...RISKS],
      matrix: PLAN.riskMatrix,
      appetite: PLAN.policy.riskAppetite,
      asOf,
    }),
    [DECISIONS_LIST_METHOD]: record(DECISIONS_LIST_METHOD, DecisionsListParamsSchema, {
      decisions: [...DECISIONS],
      asOf,
    }),
    [JOURNAL_LIST_METHOD]: record(JOURNAL_LIST_METHOD, JournalListParamsSchema, {
      entries: [...JOURNAL],
      nextCursor: JOURNAL[JOURNAL.length - 1]!.seq,
      hasMore: false,
      lastSeq: JOURNAL[JOURNAL.length - 1]!.seq,
      asOf,
    }),
    [DEPENDENCIES_WAIVE_METHOD]: record(DEPENDENCIES_WAIVE_METHOD, DependenciesWaiveParamsSchema, {
      dependency: { ...DEPENDENCIES[0]!, status: "waived" as const, resolution: "not needed for the pilot" },
      asOf,
    }),
    [DECISIONS_DECIDE_METHOD]: record(DECISIONS_DECIDE_METHOD, DecisionsDecideParamsSchema, {
      decision: { ...DECISIONS[0]!, status: "decided" as const, chosen: "postgres" },
      choice: "postgres",
      recommended: "postgres",
      asOf,
    }),
    [DECISIONS_REOPEN_METHOD]: record(DECISIONS_REOPEN_METHOD, DecisionsReopenParamsSchema, {
      decision: DECISIONS[0]!,
      reopenedDependencyIds: ["dep-store-decision"],
      asOf,
    }),
    [RISKS_UPDATE_METHOD]: record(RISKS_UPDATE_METHOD, RisksUpdateParamsSchema, {
      risk: { ...RISKS[0]!, status: "accepted" as const, open: false },
      asOf,
    }),
    [CLAIMS_RELEASE_METHOD]: record(CLAIMS_RELEASE_METHOD, ClaimsReleaseParamsSchema, {
      claim: CLAIMS[1]!,
      note: "wi-3 is still in-progress: its owning run's log never moved on",
      asOf,
    }),
  };

  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read", "runs.control", "plan.read", "plan.write"],
      auth: { mode: "loopback-unauthenticated" },
      methods: table,
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("reads the plan by name, and parses each answer with its own schema", async () => {
    const client = new DaemonClient(d.url);

    expect((await client.plansList()).plans.map((p) => p.id)).toEqual([PLAN_ID]);
    expect((await client.planGet({ planId: PLAN_ID })).plan.key).toBe("sso");
    expect((await client.itemsList({ planId: PLAN_ID, classification: ["ready"] })).total).toBe(PLAN_ITEMS.length);
    expect((await client.scheduleGet({ planId: PLAN_ID })).schedule.planId).toBe(PLAN_ID);
    // The explanation travels as the scheduler's own lines, in its order, unparsed.
    expect((await client.scheduleExplain({ planId: PLAN_ID, workItemId: "auth-api" })).lines).toEqual(
      EXPLANATIONS["auth-api"],
    );
    expect((await client.dependenciesList({ planId: PLAN_ID })).dependencies).toHaveLength(DEPENDENCIES.length);

    const risks = await client.risksList({ planId: PLAN_ID, status: ["open"] });
    expect(risks.appetite).toBe(PLAN.policy.riskAppetite);
    expect(risks.matrix.scale).toBe(PLAN.riskMatrix.scale);

    expect((await client.decisionsList({ planId: PLAN_ID })).decisions).toHaveLength(DECISIONS.length);

    const page = await client.journalList({ planId: PLAN_ID, after: 0 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(page.lastSeq);

    expect(seen.map((c) => c.method)).toEqual([
      PLANS_LIST_METHOD,
      PLAN_GET_METHOD,
      ITEMS_LIST_METHOD,
      SCHEDULE_GET_METHOD,
      SCHEDULE_EXPLAIN_METHOD,
      DEPENDENCIES_LIST_METHOD,
      RISKS_LIST_METHOD,
      DECISIONS_LIST_METHOD,
      JOURNAL_LIST_METHOD,
    ]);
    // Params travel as given, with the paging defaults the schema fills in on arrival.
    expect(seen[2]!.params).toEqual({ planId: PLAN_ID, classification: ["ready"], limit: 200, offset: 0 });
    expect(seen[6]!.params).toEqual({ planId: PLAN_ID, status: ["open"] });
    expect(seen[8]!.params).toEqual({ planId: PLAN_ID, after: 0, limit: 200 });
  });

  it("writes to the plan, and carries back what the write did beside what it wrote", async () => {
    const client = new DaemonClient(d.url);
    seen.length = 0;

    const waived = await client.dependenciesWaive({
      planId: PLAN_ID,
      dependencyId: "dep-legal-external",
      rationale: "not needed for the pilot",
    });
    expect(waived.dependency.status).toBe("waived");

    // `recommended` is what the matrix would have chosen: a person may decide against it,
    // and the client hands both to the caller rather than reconciling them.
    const decided = await client.decisionsDecide({ planId: PLAN_ID, key: "datastore", option: "postgres" });
    expect([decided.choice, decided.recommended]).toEqual(["postgres", "postgres"]);

    const reopened = await client.decisionsReopen({ planId: PLAN_ID, key: "datastore" });
    expect(reopened.reopenedDependencyIds).toEqual(["dep-store-decision"]);

    expect((await client.risksUpdate({ planId: PLAN_ID, key: "key-leak", status: "accepted" })).risk.open).toBe(false);

    // A release that could not fix the item's own status says so in words (#88).
    const released = await client.claimsRelease({ workItemId: "wi-3" });
    expect(released.claim.workItemId).toBe("wi-3");
    expect(released.note).toMatch(/still in-progress/);

    expect(seen.map((c) => c.method)).toEqual([
      DEPENDENCIES_WAIVE_METHOD,
      DECISIONS_DECIDE_METHOD,
      DECISIONS_REOPEN_METHOD,
      RISKS_UPDATE_METHOD,
      CLAIMS_RELEASE_METHOD,
    ]);
    // `force` is the daemon's default and not the client's, exactly as `resume` is above.
    expect(seen[4]!.params).toEqual({ workItemId: "wi-3", force: false });
  });
});

/**
 * The workflow reads (#177), the two configuration documents (#174, #266) and `runs.start`
 * (#178) — the calls the app grew in v0.5.0 outside the plan.
 */
describe("the workflow, config and start methods", () => {
  const asOf = "2026-03-01T09:00:00.000Z";
  const seen: { method: string; params: unknown }[] = [];
  const started = {
    id: "run-new",
    name: "ai-sdlc",
    workflowId: "ai-sdlc",
    workflowVersion: "1",
    status: "running" as const,
    createdAt: asOf,
  };

  const record = <P, R>(method: string, params: z.ZodType<P>, result: R) => ({
    params,
    handle: (p: P): R => {
      seen.push({ method, params: p });
      return result;
    },
  });

  const table: MethodTable = {
    [HELLO_METHOD]: hello,
    [WORKFLOWS_LIST_METHOD]: record(WORKFLOWS_LIST_METHOD, WorkflowsListParamsSchema, {
      workflows: [...WORKFLOWS],
      asOf,
    }),
    [WORKFLOWS_GET_METHOD]: record(WORKFLOWS_GET_METHOD, WorkflowsGetParamsSchema, { workflow: AI_SDLC, asOf }),
    [CONFIG_GET_METHOD]: record(CONFIG_GET_METHOD, ConfigGetParamsSchema, CONFIG_GET),
    [CONFIG_SET_METHOD]: record(CONFIG_SET_METHOD, ConfigSetParamsSchema, {
      document: { ...CONFIG_GET.config, revision: "after-the-write" },
      written: true,
      asOf,
    }),
    [RUNS_START_METHOD]: record(RUNS_START_METHOD, RunsStartParamsSchema, {
      runId: started.id,
      run: started,
      asOf,
    }),
  };

  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({
      orcaVersion: "0.1.0-test",
      capabilities: ["runs.read", "runs.control"],
      auth: { mode: "loopback-unauthenticated" },
      methods: table,
    });
  });
  afterAll(async () => {
    await d.close();
  });

  it("lists the registered workflows and fetches one graph by id", async () => {
    const client = new DaemonClient(d.url);
    expect((await client.workflowsList()).workflows.map((w) => w.id)).toEqual(WORKFLOWS.map((w) => w.id));

    const one = await client.workflowsGet({ id: "ai-sdlc", version: "1" });
    expect(one.workflow.nodes).toHaveLength(AI_SDLC.nodes.length);
    expect(seen.map((c) => c.params)).toEqual([{}, { id: "ai-sdlc", version: "1" }]);
  });

  it("reads both configuration documents in one call, and writes one of them by revision", async () => {
    const client = new DaemonClient(d.url);
    seen.length = 0;

    // Two documents, each with its own revision: the YAML and the ADR 0009 sidecar beside it.
    const config = await client.configGet();
    expect([config.config.document, config.permissions.document]).toEqual(["config", "permissions"]);
    expect(config.schema.length).toBeGreaterThan(0);
    expect(config.effective.agents.claude?.rules.map((r) => r.source)).toContain("permissions");

    // A field edit goes as a `patch`, which is what keeps the file's comments; the revision
    // read a moment ago goes with it, and a daemon whose bytes moved answers CONFIG_STALE.
    const written = await client.configSet({
      document: "config",
      expectedRevision: config.config.revision,
      patch: [{ path: "storeDir", value: ".orca-data" }],
    });
    expect(written.written).toBe(true);
    expect(written.document.revision).toBe("after-the-write");
    expect(seen.map((c) => c.method)).toEqual([CONFIG_GET_METHOD, CONFIG_SET_METHOD]);
    expect(seen[1]!.params).toEqual({
      document: "config",
      expectedRevision: CONFIG_GET.config.revision,
      patch: [{ path: "storeDir", value: ".orca-data" }],
    });
  });

  it("starts a run and answers as soon as it exists, rather than when it finishes", async () => {
    const client = new DaemonClient(d.url);
    seen.length = 0;

    const start = await client.runsStart({ workflowId: "ai-sdlc" });
    expect(start.runId).toBe("run-new");
    expect(start.run.status).toBe("running");
    // `vars` is the schema's default: the palette's picker sends none, so a run started
    // from the app runs on the workflow's own.
    expect(seen[0]).toEqual({ method: RUNS_START_METHOD, params: { workflowId: "ai-sdlc", vars: {} } });
  });
});
