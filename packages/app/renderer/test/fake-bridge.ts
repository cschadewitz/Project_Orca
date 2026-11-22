/**
 * A `window.orca` for tests: the handshake, the run, workflow, config and plan reads, the
 * writes, the OS-alert channel and daemon notifications, answered from `fixtures.ts`,
 * `fixtures-workflows.ts`, `fixtures-config.ts` and `fixtures-plan.ts`.
 *
 * This is the seam every screen test uses. The renderer can reach exactly one thing outside
 * itself — the preload bridge — so a fake bridge is the whole of "the daemon" as far as a
 * test is concerned: no transport, no store, no timing. What a test gets to control is what
 * matters at that seam:
 *
 * - `script` replaces a method's answer (or its params handling) for one test;
 * - `fail` makes a method answer with a `ProtocolError`, which is how the real bridge reports
 *   every failure — it never rejects (see `packages/app/src/bridge.ts`);
 * - `hold` leaves a call pending so a loading state can be asserted, and hands back the
 *   release;
 * - `notify` pushes a daemon notification to whatever has subscribed;
 * - `connect` pushes a connection snapshot, which is what the main process's state machine
 *   does over the `connection` channel — the renderer no longer decides the five states,
 *   so a test that wants one says so rather than arranging a handshake to imply it;
 * - `calls` records every call in order, so a test can assert a screen asked once and not
 *   four times.
 *
 * The default handlers are not constant-returners: they page, filter and count over the
 * fixture the way the daemon's `ReadModel` does. A list screen wired to a fake that ignored
 * `limit` would pass its test and page wrongly against a real daemon.
 *
 * The bridge this implements is `packages/app/src/bridge.ts`, whole: the handshake, the
 * read methods, the notification stream, the connection, the workspace, the deep-link queue
 * and the preferences. It is typed as `OrcaBridge`
 * rather than as a shape of its own, so the day the real bridge grows a method this file
 * fails to compile instead of quietly holding a second opinion about what the bridge is.
 */
import type {
  SearchParams,
  SearchResult,
  AgentsListParams,
  AgentsListResult,
  ArtifactsGetParams,
  ArtifactsGetResult,
  ArtifactsListParams,
  ArtifactsListResult,
  ClaimsListParams,
  ClaimsListResult,
  ConfigGetParams,
  ConfigGetResult,
  ConfigSetParams,
  ConfigSetResult,
  ClaimsReleaseParams,
  ClaimsReleaseResult,
  DecisionsDecideParams,
  DecisionsDecideResult,
  DecisionsListParams,
  DecisionsListResult,
  DecisionsReopenParams,
  DecisionsReopenResult,
  DependenciesListParams,
  DependenciesListResult,
  DependenciesWaiveParams,
  DependenciesWaiveResult,
  HelloResult,
  InputsAnswerParams,
  InputsAnswerResult,
  InputsListParams,
  InputsListResult,
  ItemsListParams,
  ItemsListResult,
  JournalListParams,
  JournalListResult,
  NotificationMessage,
  PlanGetParams,
  PlanGetResult,
  PlansListParams,
  PlansListResult,
  ProtocolError,
  RisksListParams,
  RisksListResult,
  RisksUpdateParams,
  RisksUpdateResult,
  ScheduleExplainParams,
  ScheduleExplainResult,
  ScheduleGetParams,
  ScheduleGetResult,
  RunsEventsParams,
  RunsEventsResult,
  RunsCancelParams,
  RunsCancelResult,
  RunsGetParams,
  RunsGetResult,
  RunsListParams,
  RunsListResult,
  RunsResumeParams,
  RunsResumeResult,
  RunsStartParams,
  RunsStartResult,
  WorkflowsGetParams,
  WorkflowsGetResult,
  WorkflowsListParams,
  WorkflowsListResult,
} from "@orca/protocol";
import type {
  AlertActivation,
  AlertsUpdate,
  BridgeResult,
  ConnectionSnapshot,
  OrcaBridge,
  WorkspaceSnapshot,
} from "../../src/bridge.js";
import { DEFAULT_PREFERENCES, mergePreferences, type Preferences } from "../../src/preferences/schema.js";
import { AS_OF, CLAIMS, EVENTS, HELLO, INPUTS, RUNS, RUN_DETAILS } from "./fixtures.js";
import { AGENTS_LIST } from "./fixtures-agents.js";
import { WORKFLOWS, WORKFLOW_VIEWS } from "./fixtures-workflows.js";
import { ARTIFACTS, ARTIFACTS_BY_ID } from "./fixtures-artifacts.js";
import { CONFIG_GET } from "./fixtures-config.js";
import {
  DECISIONS,
  DEPENDENCIES,
  EXPLANATIONS,
  JOURNAL,
  PLAN,
  PLANS,
  PLAN_ID,
  PLAN_ITEMS,
  RISKS,
  SCHEDULE,
} from "./fixtures-plan.js";

/** Params as a caller passes them: the schema defaults (`limit`, `offset`) are the daemon's job. */
type Params<T> = Partial<T>;

export type FakeOrcaBridge = OrcaBridge;

export type MethodName =
  | "hello"
  | "runs.list"
  | "runs.get"
  | "runs.events"
  | "inputs.list"
  | "claims.list"
  | "artifacts.list"
  | "artifacts.get"
  | "search"
  | "workflows.list"
  | "workflows.get"
  | "agents.list"
  | "inputs.answer"
  | "runs.cancel"
  | "runs.resume"
  | "runs.start"
  | "runs.recovery"
  | "runs.reviewEffect"
  | "runs.recover"
  | "runs.reconcileRecover"
  | "config.get"
  | "config.set"
  | "plans.list"
  | "plan.get"
  | "items.list"
  | "schedule.get"
  | "schedule.explain"
  | "dependencies.list"
  | "risks.list"
  | "decisions.list"
  | "journal.list"
  | "dependencies.waive"
  | "decisions.decide"
  | "decisions.reopen"
  | "risks.update"
  | "claims.release";

type Answer<T> = BridgeResult<T> | Promise<BridgeResult<T>>;

/** One handler per method; `script` takes any subset of these. */
export interface Handlers {
  hello: () => Answer<HelloResult>;
  "runs.list": (params: Params<RunsListParams>) => Answer<RunsListResult>;
  "runs.get": (params: RunsGetParams) => Answer<RunsGetResult>;
  "runs.events": (params: Params<RunsEventsParams> & { runId: string }) => Answer<RunsEventsResult>;
  "inputs.list": (params: Params<InputsListParams>) => Answer<InputsListResult>;
  "claims.list": (params: Params<ClaimsListParams>) => Answer<ClaimsListResult>;
  "artifacts.list": (params: Params<ArtifactsListParams>) => Answer<ArtifactsListResult>;
  "artifacts.get": (params: Params<ArtifactsGetParams>) => Answer<ArtifactsGetResult>;
  "workflows.list": (params: Params<WorkflowsListParams>) => Answer<WorkflowsListResult>;
  "workflows.get": (params: WorkflowsGetParams) => Answer<WorkflowsGetResult>;
  "agents.list": (params: Params<AgentsListParams>) => Answer<AgentsListResult>;
  search: (params: Params<SearchParams> & { query: string }) => Answer<SearchResult>;
  "inputs.answer": (
    params: Params<InputsAnswerParams> & { requestId: string; optionId: string },
  ) => Answer<InputsAnswerResult>;
  "runs.cancel": (params: RunsCancelParams) => Answer<RunsCancelResult>;
  "runs.resume": (params: RunsResumeParams) => Answer<RunsResumeResult>;
  "runs.start": (params: Params<RunsStartParams> & { workflowId: string }) => Answer<RunsStartResult>;
  "runs.recovery": (
    params: import("@orca/protocol").RunsRecoveryParams,
  ) => Answer<import("@orca/protocol").RunsRecoveryResult>;
  "runs.reviewEffect": (
    params: import("@orca/protocol").RunsReviewEffectParams,
  ) => Answer<import("@orca/protocol").RunsReviewEffectResult>;
  "runs.recover": (
    params: import("@orca/protocol").RunsRecoverParams,
  ) => Answer<import("@orca/protocol").RunsRecoverResult>;
  "runs.reconcileRecover": (params: { operationId: string }) => Answer<import("@orca/protocol").RunsRecoverResult>;
  "config.get": (params: Params<ConfigGetParams>) => Answer<ConfigGetResult>;
  "config.set": (params: ConfigSetParams) => Answer<ConfigSetResult>;
  "plans.list": (params: Params<PlansListParams>) => Answer<PlansListResult>;
  "plan.get": (params: PlanGetParams) => Answer<PlanGetResult>;
  "items.list": (params: Params<ItemsListParams> & { planId: string }) => Answer<ItemsListResult>;
  "schedule.get": (params: ScheduleGetParams) => Answer<ScheduleGetResult>;
  "schedule.explain": (params: ScheduleExplainParams) => Answer<ScheduleExplainResult>;
  "dependencies.list": (params: Params<DependenciesListParams> & { planId: string }) => Answer<DependenciesListResult>;
  "risks.list": (params: Params<RisksListParams> & { planId: string }) => Answer<RisksListResult>;
  "decisions.list": (params: Params<DecisionsListParams> & { planId: string }) => Answer<DecisionsListResult>;
  "journal.list": (params: Params<JournalListParams> & { planId: string }) => Answer<JournalListResult>;
  "dependencies.waive": (params: DependenciesWaiveParams) => Answer<DependenciesWaiveResult>;
  "decisions.decide": (params: DecisionsDecideParams) => Answer<DecisionsDecideResult>;
  "decisions.reopen": (params: DecisionsReopenParams) => Answer<DecisionsReopenResult>;
  "risks.update": (params: RisksUpdateParams) => Answer<RisksUpdateResult>;
  "claims.release": (params: Params<ClaimsReleaseParams> & { workItemId: string }) => Answer<ClaimsReleaseResult>;
}

export interface BridgeCall {
  method: MethodName;
  params: unknown;
}

export interface FakeBridgeOptions {
  /** `process.platform` of the main process; `darwin` puts shortcuts on ⌘. */
  platform?: string;
  preferences?: Preferences;
  /** What `connection.read()` answers before anything has been pushed. Defaults to live. */
  connection?: ConnectionSnapshot;
  /** The store on screen. Defaults to a writable workspace, which is the ordinary case. */
  workspace?: WorkspaceSnapshot;
  /** The `orca://` URL this window was opened for, the way a cold start delivers one (#165). */
  deepLink?: string;
}

export interface FakeBridge {
  readonly bridge: FakeOrcaBridge;
  /** Every call made through the bridge, oldest first. */
  readonly calls: readonly BridgeCall[];
  /** Put this on `window.orca`. Returns the restore, which belongs in `afterEach`. */
  install: () => () => void;
  /** Replace what one or more methods answer, for the rest of the test. */
  script: (handlers: Partial<Handlers>) => void;
  /** Answer this method with a protocol error, the way the bridge reports a dead daemon. */
  fail: (method: MethodName, error: ProtocolError) => void;
  /** Leave every further call to this method pending; the returned function lets them finish. */
  hold: (method: MethodName) => () => void;
  /** Deliver a daemon notification to every subscriber. */
  notify: (notification: NotificationMessage) => void;
  /** Push a connection snapshot, the way the main process's state machine does. */
  connect: (snapshot: ConnectionSnapshot) => void;
  /**
   * Every `alerts.update` the renderer has sent, oldest first: what the main process would
   * have posted notifications and set the badge from (#162).
   */
  readonly alerts: readonly AlertsUpdate[];
  /** Deliver a notification click, the way the main process does when a person answers one. */
  activate: (activation: AlertActivation) => void;
  /** What `connection.read()` would answer right now. */
  readonly connection: ConnectionSnapshot;
  /** How many subscribers are listening — a screen that leaks one is a screen that leaks. */
  readonly subscribers: number;
  /** The preferences the fake is holding, after any writes a test has made. */
  readonly preferences: Preferences;
  /** Deliver an `orca://` URL to every subscriber, the way `open-url` reaches a window. */
  link: (url: string) => void;
  /** What `workspace.read()` would answer right now. */
  readonly workspace: WorkspaceSnapshot;
}

const ok = <T>(result: T): BridgeResult<T> => ({ ok: true, result });
const err = (code: string, message: string): BridgeResult<never> => ({ ok: false, error: { code, message } });

/**
 * The daemon's own defaults for the two paging methods. Written out rather than taken from
 * the Zod schemas so that a fake that drifts from the protocol fails the schema test in
 * `fake-bridge.test.ts` instead of quietly agreeing with itself.
 */
const RUNS_LIST_LIMIT = 100;
const RUNS_EVENTS_LIMIT = 200;
const ARTIFACTS_LIST_LIMIT = 200;
const ITEMS_LIST_LIMIT = 200;
const JOURNAL_LIST_LIMIT = 200;

/**
 * A live connection, built out of the same `hello` the fake answers, so the state a screen
 * sees and the handshake it could ask for cannot disagree. `capabilities` is `HELLO`'s,
 * which now includes `runs.control`: the daemon writes as of #160, so a screen test runs
 * against a daemon that takes commands. A test of what a read-only daemon looks like
 * pushes a connection whose capabilities say otherwise (#164).
 *
 * `methods` comes from the same fixture for the same reason: the main process folds
 * `hello.methods` onto the snapshot, and a control that asks "is `config.set` served"
 * (`useMethodPresent`) must be asking about the daemon this fake is.
 */
const LIVE_CONNECTION: ConnectionSnapshot = {
  state: "live",
  since: AS_OF,
  orcaVersion: HELLO.orcaVersion,
  capabilities: HELLO.capabilities,
  ...(HELLO.methods === undefined ? {} : { methods: HELLO.methods }),
};

/**
 * The workspace a test gets unless it says otherwise: a writable store the app found for
 * itself, which is what every screen but the file-mode banner is written against.
 */
const DEFAULT_WORKSPACE: WorkspaceSnapshot = { path: "/work/orca", readOnly: false, source: "default" };

const defaults: Handlers = {
  hello: () => ok(HELLO),

  "runs.list": (params) => {
    const wanted = params.status;
    const matches = RUNS.filter(
      (r) =>
        (!wanted?.length || wanted.includes(r.status)) &&
        (params.requestId === undefined || r.requestId === params.requestId) &&
        (params.workItemId === undefined || r.workItem?.id === params.workItemId) &&
        (params.parentRunId === undefined || r.parentRunId === params.parentRunId) &&
        (!params.roots || r.parentRunId === undefined) &&
        (params.workflowId === undefined || r.workflowId === params.workflowId) &&
        (params.createdFrom === undefined || Date.parse(r.createdAt) >= Date.parse(params.createdFrom)) &&
        (params.runIds === undefined || params.runIds.includes(r.id)),
    );
    const offset = params.offset ?? 0;
    const limit = params.limit ?? RUNS_LIST_LIMIT;
    // `total` counts the filter, not the page: that is what lets a client page without asking again.
    return ok({ runs: matches.slice(offset, offset + limit), total: matches.length, asOf: AS_OF });
  },

  "runs.get": ({ runId }) => {
    const detail = RUN_DETAILS[runId];
    return detail ? ok(detail) : err("RUN_NOT_FOUND", `no run ${runId}`);
  },

  "runs.events": (params) => {
    if (params.after !== undefined && params.before !== undefined) {
      return err("PROTOCOL_MESSAGE", "give either 'after' or 'before', not both");
    }
    const all = EVENTS[params.runId] ?? [];
    const lastSeq = all.length ? all[all.length - 1]!.seq : 0;
    const typed = params.types?.length ? all.filter((e) => params.types!.includes(e.type)) : all;
    const limit = params.limit ?? RUNS_EVENTS_LIMIT;

    // `before` takes the events *immediately* before the cursor, so it slices from the end.
    const window =
      params.before !== undefined
        ? typed.filter((e) => e.seq < params.before!).slice(-limit)
        : typed.filter((e) => params.after === undefined || e.seq > params.after).slice(0, limit);

    const first = window[0];
    const last = window[window.length - 1];
    const hasMore =
      params.before !== undefined
        ? first !== undefined && typed.some((e) => e.seq < first.seq)
        : last !== undefined && typed.some((e) => e.seq > last.seq);

    return ok({
      events: window,
      ...(last ? { nextCursor: last.seq } : {}),
      ...(first ? { prevCursor: first.seq } : {}),
      hasMore,
      lastSeq,
      asOf: AS_OF,
    });
  },

  "inputs.list": (params) => {
    const inputs = INPUTS.filter(
      (i) =>
        (params.runId === undefined || i.runId === params.runId) &&
        (!params.kind?.length || params.kind.includes(i.kind)),
    );
    // `waiting` is the title bar's one number, and the daemon sends it so nobody recounts.
    return ok({ inputs: [...inputs], waiting: inputs.length, asOf: AS_OF });
  },

  "claims.list": (params) =>
    ok({
      claims: CLAIMS.filter(
        (c) =>
          (params.runId === undefined || c.owner.runId === params.runId) &&
          (params.workItemId === undefined || c.workItemId === params.workItemId),
      ),
      asOf: AS_OF,
    }),

  // No fixture corpus: a test that wants hits scripts them (`search` in `script`).
  search: () => ok({ hits: [], scannedRuns: 0, asOf: AS_OF }),

  "artifacts.list": (params) => {
    const matches = ARTIFACTS.filter(
      (a) =>
        (params.runId === undefined || a.runId === params.runId) &&
        (params.name === undefined || a.view.name === params.name) &&
        (params.kind === undefined || a.view.kind === params.kind) &&
        (params.producedByStepRunId === undefined || a.view.producedByStepRunId === params.producedByStepRunId),
    );
    const offset = params.offset ?? 0;
    const limit = params.limit ?? ARTIFACTS_LIST_LIMIT;
    // Metadata only, never a body, and `total` counts the filter rather than the page —
    // both of which are the daemon's contract (#159) and not conveniences of this fake.
    return ok({
      artifacts: matches.slice(offset, offset + limit).map((a) => a.view),
      total: matches.length,
      asOf: AS_OF,
    });
  },

  "artifacts.get": (params) => {
    // The protocol refines this: an id, or a run and a name — one or the other.
    if ((params.artifactId !== undefined) === (params.runId !== undefined && params.name !== undefined)) {
      return err("PROTOCOL_MESSAGE", "address an artifact by 'artifactId', or by 'runId' and 'name'");
    }
    let found: (typeof ARTIFACTS)[number] | undefined;
    if (params.artifactId !== undefined) {
      found = ARTIFACTS_BY_ID.get(params.artifactId);
    } else {
      const named = ARTIFACTS.filter((a) => a.runId === params.runId && a.view.name === params.name);
      // Absent `version` means the latest of that name in that run — the list is oldest
      // version first, so that is the last of them.
      found =
        params.version === undefined ? named[named.length - 1] : named.find((a) => a.view.version === params.version);
    }
    if (!found) return err("ARTIFACT_NOT_FOUND", "no such artifact");
    return ok({
      artifact: found.view,
      ...(found.text !== undefined ? { text: found.text } : {}),
      ...(found.omitted !== undefined ? { omitted: found.omitted } : {}),
      asOf: AS_OF,
    });
  },

  // The registered workflows only. The two graphs written inline inside `sdlc`'s `parallel`
  // are fetchable by their `parent::node::branch` ids but are not rows: a nested graph is
  // part of its parent's file and has no life of its own in a picker.
  "workflows.list": () => ok({ workflows: [...WORKFLOWS], asOf: AS_OF }),

  "workflows.get": ({ id, version }) => {
    const workflow = WORKFLOW_VIEWS[id];
    if (!workflow) return err("WORKFLOW_NOT_FOUND", `workflow '${id}' not registered`);
    // The daemon's rule, not a convenience of this fake: ORCA keeps one definition per
    // workflow, so a version other than the one on disk is not a graph it can produce.
    if (version !== undefined && version !== workflow.version)
      return err("WORKFLOW_NOT_FOUND", `workflow '${id}' is at version ${workflow.version}`);
    return ok({ workflow, asOf: AS_OF });
  },

  // `agents.list` takes no parameters: every configured agent comes back, contacted or not,
  // and the daemon does no filtering for the surface to mirror here.
  "agents.list": () => ok(AGENTS_LIST),

  /* The three that write. They answer and change nothing: the fixture store is a constant,
     and a fake that quietly removed an answered input would hide the thing a screen test
     is actually about — whether the screen moved on without being told to. A test that
     wants the input gone scripts `inputs.list` to say so, or pushes `input.answered`.

     `permission` is absent unless a test asks for it, exactly as the daemon leaves it
     absent unless `always` was sent, so nothing promises "ORCA will not ask again" by
     default. */
  "inputs.answer": (params) => {
    const input = INPUTS.find((i) => i.id === params.requestId);
    if (!input) return err("INPUT_NOT_FOUND", `no open input ${params.requestId}`);
    return ok({ requestId: params.requestId, runId: input.runId, answer: params.optionId, asOf: AS_OF });
  },

  "runs.cancel": ({ runId }) => {
    const run = RUNS.find((r) => r.id === runId);
    return run ? ok({ run: { ...run, status: "cancelled" }, asOf: AS_OF }) : err("RUN_NOT_FOUND", `no run ${runId}`);
  },

  // Answered once the run has parked again, so the status is a settled one and never
  // `running` — which is what the protocol says and what a screen is written against.
  "runs.resume": ({ runId }) => {
    const run = RUNS.find((r) => r.id === runId);
    return run ? ok({ run: { ...run, status: "succeeded" }, asOf: AS_OF }) : err("RUN_NOT_FOUND", `no run ${runId}`);
  },

  /* Answers as the daemon does: the moment the run exists, with its id and a summary that
     is `running` and has no outcome yet. The id is derived from the workflow so a test can
     assert where the palette navigated without scripting a handler. */
  /* Recovery (#357) is not in the fixture daemon's `hello.methods`, so nothing calls these
     unless a test lists the methods and scripts the answers. */
  "runs.recovery": () => err("NOT_SUPPORTED", "no recovery in the fixture daemon"),
  "runs.reviewEffect": () => err("NOT_SUPPORTED", "no recovery in the fixture daemon"),
  "runs.recover": () => err("NOT_SUPPORTED", "no recovery in the fixture daemon"),
  "runs.reconcileRecover": () => err("NOT_SUPPORTED", "no recovery in the fixture daemon"),

  "runs.start": ({ workflowId }) => {
    const workflow = WORKFLOWS.find((w) => w.id === workflowId);
    if (!workflow) return err("WORKFLOW_NOT_FOUND", `no workflow ${workflowId}`);
    return ok({
      runId: `run-started-${workflow.id}`,
      run: {
        id: `run-started-${workflow.id}`,
        name: workflow.name,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        status: "running",
        createdAt: AS_OF,
        startedAt: AS_OF,
      },
      asOf: AS_OF,
    });
  },

  "config.get": () => ok(CONFIG_GET),

  /* `config.set` answers and changes nothing, for the same reason the three above do. What
     it does model is the one refusal a form has to handle: a revision that is not the one
     on the fixture is `CONFIG_STALE`, so a screen test can drive "somebody edited this
     underneath you" without scripting anything. A test that wants the write to land sends
     the fixture's revision; a test that wants it refused sends anything else. */
  "config.set": (params) => {
    const current = params.document === "config" ? CONFIG_GET.config : CONFIG_GET.permissions;
    if (params.expectedRevision !== current.revision)
      return err("CONFIG_STALE", `${current.path} has changed since you read it`);
    const document = params.text === undefined ? current : { ...current, text: params.text };
    return ok({
      document,
      written: params.validateOnly !== true,
      ...(params.validateOnly ? { validation: { errors: [] } } : {}),
      asOf: AS_OF,
    });
  },

  /* The plan reads (#169). Every one names a `planId`, because the daemon has no default
     plan — `plans.list` is how a surface finds one — and every one of these refuses an
     unknown id rather than answering about the only plan there happens to be. */

  "plans.list": () => ok({ plans: [...PLANS], asOf: AS_OF }),

  "plan.get": ({ planId }) =>
    planId === PLAN_ID ? ok({ plan: PLAN, asOf: AS_OF }) : err("PLAN_NOT_FOUND", `no plan ${planId}`),

  "items.list": (params) => {
    if (params.planId !== PLAN_ID) return err("PLAN_NOT_FOUND", `no plan ${params.planId}`);
    const text = params.text?.trim().toLowerCase();
    const matches = PLAN_ITEMS.filter(
      (i) =>
        (!params.status?.length || params.status.includes(i.status as never)) &&
        (!params.classification?.length || params.classification.includes(i.classification)) &&
        (params.requestId === undefined || i.requestId === params.requestId) &&
        (!text || i.slug.toLowerCase().includes(text) || i.title.toLowerCase().includes(text)),
    );
    const offset = params.offset ?? 0;
    const limit = params.limit ?? ITEMS_LIST_LIMIT;
    // In schedule order, and `total` counts the filter rather than the page — both of which
    // are the daemon's contract and not conveniences of this fake.
    return ok({ items: matches.slice(offset, offset + limit), total: matches.length, asOf: AS_OF });
  },

  "schedule.get": ({ planId }) =>
    planId === PLAN_ID ? ok({ schedule: SCHEDULE, asOf: AS_OF }) : err("PLAN_NOT_FOUND", `no plan ${planId}`),

  "schedule.explain": ({ planId, workItemId }) => {
    if (planId !== PLAN_ID) return err("PLAN_NOT_FOUND", `no plan ${planId}`);
    // The daemon takes an id or a slug, so the fake does too.
    const slug = PLAN_ITEMS.find((i) => i.id === workItemId || i.slug === workItemId)?.slug;
    const lines = slug === undefined ? undefined : EXPLANATIONS[slug];
    return lines ? ok({ lines: [...lines], asOf: AS_OF }) : err("PLAN_INVALID", `no work item ${workItemId}`);
  },

  "dependencies.list": (params) => {
    if (params.planId !== PLAN_ID) return err("PLAN_NOT_FOUND", `no plan ${params.planId}`);
    const from = PLAN_ITEMS.find((i) => i.id === params.workItemId || i.slug === params.workItemId)?.id;
    return ok({
      dependencies: DEPENDENCIES.filter(
        (d) =>
          (params.workItemId === undefined || d.from === from) &&
          (!params.status?.length || params.status.includes(d.status)),
      ),
      asOf: AS_OF,
    });
  },

  "risks.list": (params) => {
    if (params.planId !== PLAN_ID) return err("PLAN_NOT_FOUND", `no plan ${params.planId}`);
    const affecting = PLAN_ITEMS.find((i) => i.id === params.workItemId || i.slug === params.workItemId)?.id;
    return ok({
      risks: RISKS.filter(
        (r) =>
          (!params.status?.length || params.status.includes(r.status)) &&
          (params.workItemId === undefined || r.affects.some((a) => a.id === affecting)),
      ),
      matrix: PLAN.riskMatrix,
      appetite: PLAN.policy.riskAppetite,
      asOf: AS_OF,
    });
  },

  "decisions.list": (params) =>
    params.planId === PLAN_ID
      ? ok({
          decisions: DECISIONS.filter((d) => !params.status?.length || params.status.includes(d.status)),
          asOf: AS_OF,
        })
      : err("PLAN_NOT_FOUND", `no plan ${params.planId}`),

  "journal.list": (params) => {
    if (params.planId !== PLAN_ID) return err("PLAN_NOT_FOUND", `no plan ${params.planId}`);
    if (params.after !== undefined && params.before !== undefined)
      return err("PROTOCOL_MESSAGE", "give either 'after' or 'before', not both");
    const typed = params.types?.length ? JOURNAL.filter((e) => params.types!.includes(e.type)) : JOURNAL;
    const limit = params.limit ?? JOURNAL_LIST_LIMIT;
    // `before` takes the entries *immediately* before the cursor, so it slices from the end.
    const window =
      params.before !== undefined
        ? typed.filter((e) => e.seq < params.before!).slice(-limit)
        : typed.filter((e) => params.after === undefined || e.seq > params.after).slice(0, limit);
    const first = window[0];
    const last = window[window.length - 1];
    return ok({
      entries: window,
      ...(last ? { nextCursor: last.seq } : {}),
      ...(first ? { prevCursor: first.seq } : {}),
      hasMore:
        params.before !== undefined
          ? first !== undefined && typed.some((e) => e.seq < first.seq)
          : last !== undefined && typed.some((e) => e.seq > last.seq),
      lastSeq: JOURNAL[JOURNAL.length - 1]!.seq,
      asOf: AS_OF,
    });
  },

  /* The plan writes. Like the run controls above, they answer and change nothing: the
     fixture is a constant, and a fake that quietly re-bucketed an item would hide the thing
     a screen test is actually about — whether the screen repainted because it was told to. */

  "dependencies.waive": ({ dependencyId, rationale }) => {
    const dependency = DEPENDENCIES.find((d) => d.id === dependencyId);
    if (!dependency) return err("PLAN_INVALID", `no dependency ${dependencyId}`);
    return ok({
      dependency: {
        ...dependency,
        status: "waived",
        evaluation: { state: "waived", detail: rationale ? `waived: ${rationale}` : "waived" },
        ...(rationale ? { resolution: rationale } : {}),
        resolvedAt: AS_OF,
      },
      asOf: AS_OF,
    });
  },

  "decisions.decide": ({ key, option, rationale }) => {
    const decision = DECISIONS.find((d) => d.key === key || d.id === key);
    if (!decision) return err("PLAN_INVALID", `no decision ${key}`);
    const options = decision.options.map((o) => o.key);
    if (!options.includes(option))
      return err("PLAN_INVALID", `'${option}' is not an option of decision '${decision.key}': ${options.join(", ")}`);
    // Deciding stores the matrix's result, so it is no longer a preview (#173).
    const { resultIsPreview: _preview, ...stored } = decision;
    return ok({
      decision: {
        ...stored,
        status: "decided",
        chosen: option,
        decidedBy: "human",
        decidedAt: AS_OF,
        ...(rationale ? { rationale } : {}),
      },
      choice: option,
      asOf: AS_OF,
    });
  },

  "decisions.reopen": ({ key }) => {
    const decision = DECISIONS.find((d) => d.key === key || d.id === key);
    if (!decision) return err("PLAN_INVALID", `no decision ${key}`);
    return ok({
      decision: { ...decision, status: "open" },
      // What reopening costs: the dependencies it had satisfied are open again, so the items
      // they gate stop being dispatchable.
      reopenedDependencyIds: DEPENDENCIES.filter(
        (d) => d.target.kind === "decision" && d.target.decisionId === decision.id,
      ).map((d) => d.id),
      asOf: AS_OF,
    });
  },

  "risks.update": ({ key, status }) => {
    const risk = RISKS.find((r) => r.key === key || r.id === key);
    if (!risk) return err("PLAN_INVALID", `no risk ${key}`);
    const open = ["open", "mitigating", "realized"].includes(status);
    return ok({
      risk: { ...risk, status, open, ...(open ? {} : { closedAt: AS_OF }) },
      asOf: AS_OF,
    });
  },

  // Refused while the owner could still resume unless `force`, exactly as the daemon does —
  // so a confirmation that trusted `owner.releasable` and a call that did not would disagree
  // here rather than in front of a person.
  "claims.release": ({ workItemId, force }) => {
    const claim = CLAIMS.find((c) => c.workItemId === workItemId);
    if (!claim) return err("CLAIM_NOT_FOUND", `work item ${workItemId} is not claimed`);
    if (!claim.owner.releasable && !force)
      return err(
        "RUN_STATE",
        `work item ${workItemId} is claimed by run ${claim.owner.runId}, which is ${claim.owner.status}, not finished: resume or cancel that run, or release with force`,
      );
    const item = PLAN_ITEMS.find((i) => i.id === workItemId || i.slug === claim.workItem?.slug);
    return ok({
      claim,
      ...(item?.status === "in-progress"
        ? {
            note: `${workItemId} is still in-progress${item.runId ? ` (run ${item.runId})` : ""}; the plan scheduler treats it as running until that status changes`,
          }
        : {}),
      asOf: AS_OF,
    });
  },
};

/** A fake `window.orca`. Nothing is installed until `install()` is called. */
export function fakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const handlers: Handlers = { ...defaults };
  const calls: BridgeCall[] = [];
  const listeners = new Set<(notification: NotificationMessage) => void>();
  const held = new Map<MethodName, Promise<void>>();
  const connections = new Set<(snapshot: ConnectionSnapshot) => void>();
  const links = new Set<(url: string) => void>();
  const workspaces = new Set<(snapshot: WorkspaceSnapshot) => void>();
  const activations = new Set<(activation: AlertActivation) => void>();
  const alerts: AlertsUpdate[] = [];
  let preferences = options.preferences ?? DEFAULT_PREFERENCES;
  let connection = options.connection ?? LIVE_CONNECTION;
  let workspace = options.workspace ?? DEFAULT_WORKSPACE;
  /* Taken once, like the real bridge: a deep link is delivered to one reader, so a window
     that reads it and then reloads must not find it waiting a second time. */
  let pendingLink = options.deepLink;

  /** The main process's half of a workspace switch: set it, then push it. */
  const setWorkspace = (next: WorkspaceSnapshot): BridgeResult<WorkspaceSnapshot> => {
    workspace = next;
    for (const listener of [...workspaces]) listener(next);
    return ok(next);
  };

  /** Record the call, wait out any hold, then answer. One place, so `calls` can never miss one. */
  async function call<K extends MethodName>(method: K, params: Parameters<Handlers[K]>[0]): Promise<unknown> {
    calls.push({ method, params });
    await held.get(method);
    return (handlers[method] as (p: unknown) => Answer<unknown>)(params);
  }

  const bridge: FakeOrcaBridge = {
    platform: options.platform ?? "darwin",
    updates: {
      read: () => ({ phase: "unavailable", current: "0.0.0" }),
      act: () => Promise.resolve({ ok: true, result: { phase: "unavailable", current: "0.0.0" } }),
      subscribe: () => () => undefined,
      prepare: () => () => undefined,
    },
    hello: () => call("hello", undefined) as Promise<BridgeResult<HelloResult>>,
    workspace: {
      read: () => workspace,
      subscribe: (listener) => {
        workspaces.add(listener);
        return () => workspaces.delete(listener);
      },
      // The real thing starts a read-only daemon over the chosen store; here it is the
      // observable half of that — the snapshot the banner and the status bar read.
      open: (params = {}) =>
        Promise.resolve(setWorkspace({ path: params.path ?? workspace.path, readOnly: true, source: "chosen" })),
      connectLive: () => Promise.resolve(setWorkspace(DEFAULT_WORKSPACE)),
    },
    deepLink: {
      take: () => {
        const url = pendingLink;
        pendingLink = undefined;
        return url;
      },
      subscribe: (listener) => {
        links.add(listener);
        return () => links.delete(listener);
      },
    },
    preferences: {
      read: () => preferences,
      write: (patch) => {
        preferences = mergePreferences(preferences, patch);
        return Promise.resolve(ok(preferences));
      },
    },
    runs: {
      list: (params = {}) => call("runs.list", params) as Promise<BridgeResult<RunsListResult>>,
      get: (params) => call("runs.get", params) as Promise<BridgeResult<RunsGetResult>>,
      events: (params) => call("runs.events", params) as Promise<BridgeResult<RunsEventsResult>>,
      cancel: (params) => call("runs.cancel", params) as Promise<BridgeResult<RunsCancelResult>>,
      resume: (params) => call("runs.resume", params) as Promise<BridgeResult<RunsResumeResult>>,
      start: (params) => call("runs.start", params) as Promise<BridgeResult<RunsStartResult>>,
      recovery: (params) =>
        call("runs.recovery", params) as Promise<BridgeResult<import("@orca/protocol").RunsRecoveryResult>>,
      reviewEffect: (params) =>
        call("runs.reviewEffect", params) as Promise<BridgeResult<import("@orca/protocol").RunsReviewEffectResult>>,
      recover: (params) =>
        call("runs.recover", params) as Promise<BridgeResult<import("@orca/protocol").RunsRecoverResult>>,
      reconcileRecover: (params) =>
        call("runs.reconcileRecover", params) as Promise<BridgeResult<import("@orca/protocol").RunsRecoverResult>>,
    },
    inputs: {
      list: (params = {}) => call("inputs.list", params) as Promise<BridgeResult<InputsListResult>>,
      answer: (params) => call("inputs.answer", params) as Promise<BridgeResult<InputsAnswerResult>>,
    },
    claims: {
      list: (params = {}) => call("claims.list", params) as Promise<BridgeResult<ClaimsListResult>>,
      release: (params) => call("claims.release", params) as Promise<BridgeResult<ClaimsReleaseResult>>,
    },
    plan: {
      list: (params = {}) => call("plans.list", params) as Promise<BridgeResult<PlansListResult>>,
      get: (params) => call("plan.get", params) as Promise<BridgeResult<PlanGetResult>>,
      items: (params) => call("items.list", params) as Promise<BridgeResult<ItemsListResult>>,
      schedule: (params) => call("schedule.get", params) as Promise<BridgeResult<ScheduleGetResult>>,
      explain: (params) => call("schedule.explain", params) as Promise<BridgeResult<ScheduleExplainResult>>,
      dependencies: (params) => call("dependencies.list", params) as Promise<BridgeResult<DependenciesListResult>>,
      risks: (params) => call("risks.list", params) as Promise<BridgeResult<RisksListResult>>,
      decisions: (params) => call("decisions.list", params) as Promise<BridgeResult<DecisionsListResult>>,
      journal: (params) => call("journal.list", params) as Promise<BridgeResult<JournalListResult>>,
      waive: (params) => call("dependencies.waive", params) as Promise<BridgeResult<DependenciesWaiveResult>>,
      decide: (params) => call("decisions.decide", params) as Promise<BridgeResult<DecisionsDecideResult>>,
      reopen: (params) => call("decisions.reopen", params) as Promise<BridgeResult<DecisionsReopenResult>>,
      updateRisk: (params) => call("risks.update", params) as Promise<BridgeResult<RisksUpdateResult>>,
    },
    artifacts: {
      list: (params = {}) => call("artifacts.list", params) as Promise<BridgeResult<ArtifactsListResult>>,
      get: (params) => call("artifacts.get", params) as Promise<BridgeResult<ArtifactsGetResult>>,
    },
    workflows: {
      list: (params = {}) => call("workflows.list", params) as Promise<BridgeResult<WorkflowsListResult>>,
      get: (params) => call("workflows.get", params) as Promise<BridgeResult<WorkflowsGetResult>>,
    },
    search: { query: (params) => call("search", params) as Promise<BridgeResult<SearchResult>> },
    agents: { list: (params = {}) => call("agents.list", params) as Promise<BridgeResult<AgentsListResult>> },
    config: {
      get: (params = {}) => call("config.get", params) as Promise<BridgeResult<ConfigGetResult>>,
      set: (params) => call("config.set", params) as Promise<BridgeResult<ConfigSetResult>>,
    },
    notifications: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    alerts: {
      update: (update) => {
        alerts.push(update);
      },
      subscribe: (listener) => {
        activations.add(listener);
        return () => activations.delete(listener);
      },
    },
    connection: {
      read: () => connection,
      subscribe: (listener) => {
        connections.add(listener);
        return () => connections.delete(listener);
      },
    },
  };

  return {
    bridge,
    calls,
    install() {
      const had = Object.getOwnPropertyDescriptor(window, "orca");
      Object.defineProperty(window, "orca", { configurable: true, writable: true, value: bridge });
      return () => {
        if (had) Object.defineProperty(window, "orca", had);
        else delete (window as { orca?: unknown }).orca;
      };
    },
    script(overrides) {
      Object.assign(handlers, overrides);
    },
    fail(method, error) {
      // An error answer satisfies every method's return type, but TypeScript cannot see that
      // through an indexed write keyed by a union, so the table is widened for this one line.
      (handlers as unknown as Record<MethodName, () => BridgeResult<never>>)[method] = () => ({ ok: false, error });
    },
    hold(method) {
      let release = (): void => {};
      held.set(
        method,
        new Promise<void>((resolve) => {
          release = () => {
            held.delete(method);
            resolve();
          };
        }),
      );
      return () => release();
    },
    notify(notification) {
      for (const listener of [...listeners]) listener(notification);
    },
    connect(snapshot) {
      connection = snapshot;
      for (const listener of [...connections]) listener(snapshot);
    },
    get alerts() {
      return alerts;
    },
    activate(activation) {
      for (const listener of [...activations]) listener(activation);
    },
    get connection() {
      return connection;
    },
    link(url) {
      for (const listener of [...links]) listener(url);
    },
    get workspace() {
      return workspace;
    },
    get subscribers() {
      return listeners.size;
    },
    get preferences() {
      return preferences;
    },
  };
}
