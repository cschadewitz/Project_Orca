/**
 * A `window.orca` for tests: the handshake, the eleven read methods, the three control
 * methods, the OS-alert channel and daemon notifications, answered from `fixtures.ts`.
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
  HelloResult,
  InputsAnswerParams,
  InputsAnswerResult,
  InputsListParams,
  InputsListResult,
  NotificationMessage,
  ProtocolError,
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
  | "workflows.list"
  | "workflows.get"
  | "agents.list"
  | "inputs.answer"
  | "runs.cancel"
  | "runs.resume"
  | "config.get"
  | "config.set";

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
  "inputs.answer": (
    params: Params<InputsAnswerParams> & { requestId: string; optionId: string },
  ) => Answer<InputsAnswerResult>;
  "runs.cancel": (params: RunsCancelParams) => Answer<RunsCancelResult>;
  "runs.resume": (params: RunsResumeParams) => Answer<RunsResumeResult>;
  "config.get": (params: Params<ConfigGetParams>) => Answer<ConfigGetResult>;
  "config.set": (params: ConfigSetParams) => Answer<ConfigSetResult>;
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

/**
 * A live connection, built out of the same `hello` the fake answers, so the state a screen
 * sees and the handshake it could ask for cannot disagree. `capabilities` is `HELLO`'s,
 * which now includes `runs.control`: the daemon writes as of #160, so a screen test runs
 * against a daemon that takes commands. A test of what a read-only daemon looks like
 * pushes a connection whose capabilities say otherwise (#164).
 */
const LIVE_CONNECTION: ConnectionSnapshot = {
  state: "live",
  since: AS_OF,
  orcaVersion: HELLO.orcaVersion,
  capabilities: HELLO.capabilities,
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
        (!params.roots || r.parentRunId === undefined),
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
    },
    inputs: {
      list: (params = {}) => call("inputs.list", params) as Promise<BridgeResult<InputsListResult>>,
      answer: (params) => call("inputs.answer", params) as Promise<BridgeResult<InputsAnswerResult>>,
    },
    claims: { list: (params = {}) => call("claims.list", params) as Promise<BridgeResult<ClaimsListResult>> },
    artifacts: {
      list: (params = {}) => call("artifacts.list", params) as Promise<BridgeResult<ArtifactsListResult>>,
      get: (params) => call("artifacts.get", params) as Promise<BridgeResult<ArtifactsGetResult>>,
    },
    workflows: {
      list: (params = {}) => call("workflows.list", params) as Promise<BridgeResult<WorkflowsListResult>>,
      get: (params) => call("workflows.get", params) as Promise<BridgeResult<WorkflowsGetResult>>,
    },
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
