/**
 * A `window.orca` for tests: the handshake, the five read methods and daemon notifications,
 * answered from `fixtures.ts`.
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
 * - `calls` records every call in order, so a test can assert a screen asked once and not
 *   four times.
 *
 * The default handlers are not constant-returners: they page, filter and count over the
 * fixture the way the daemon's `ReadModel` does. A list screen wired to a fake that ignored
 * `limit` would pass its test and page wrongly against a real daemon.
 *
 * ## The read methods are not on `OrcaBridge` yet
 *
 * `packages/app/src/bridge.ts` declares `platform`, `hello` and `preferences` — the preload
 * does not forward the read methods yet (#150 landed them on the daemon side). `FakeOrcaBridge`
 * below is `OrcaBridge` plus the shape they will take, so the tests that need them can be
 * written now; when the preload grows them, this file should import the real types and delete
 * the local declaration rather than keep a second opinion about it.
 */
import type {
  ClaimsListParams,
  ClaimsListResult,
  HelloResult,
  InputsListParams,
  InputsListResult,
  NotificationMessage,
  ProtocolError,
  RunsEventsParams,
  RunsEventsResult,
  RunsGetParams,
  RunsGetResult,
  RunsListParams,
  RunsListResult,
} from "@orca/protocol";
import type { BridgeResult, OrcaBridge } from "../../src/bridge.js";
import { DEFAULT_PREFERENCES, mergePreferences, type Preferences } from "../../src/preferences/schema.js";
import { AS_OF, CLAIMS, EVENTS, HELLO, INPUTS, RUNS, RUN_DETAILS } from "./fixtures.js";

/** Params as a caller passes them: the schema defaults (`limit`, `offset`) are the daemon's job. */
type Params<T> = Partial<T>;

/** The read half of the bridge, as the preload will expose it. */
export interface ReadBridge {
  runs: {
    list: (params?: Params<RunsListParams>) => Promise<BridgeResult<RunsListResult>>;
    get: (params: RunsGetParams) => Promise<BridgeResult<RunsGetResult>>;
    events: (params: Params<RunsEventsParams> & { runId: string }) => Promise<BridgeResult<RunsEventsResult>>;
  };
  inputs: { list: (params?: Params<InputsListParams>) => Promise<BridgeResult<InputsListResult>> };
  claims: { list: (params?: Params<ClaimsListParams>) => Promise<BridgeResult<ClaimsListResult>> };
  /** Daemon-initiated messages. Returns the unsubscribe, the way the real one will. */
  notifications: { subscribe: (listener: (notification: NotificationMessage) => void) => () => void };
}

export type FakeOrcaBridge = OrcaBridge & ReadBridge;

export type MethodName = "hello" | "runs.list" | "runs.get" | "runs.events" | "inputs.list" | "claims.list";

type Answer<T> = BridgeResult<T> | Promise<BridgeResult<T>>;

/** One handler per method; `script` takes any subset of these. */
export interface Handlers {
  hello: () => Answer<HelloResult>;
  "runs.list": (params: Params<RunsListParams>) => Answer<RunsListResult>;
  "runs.get": (params: RunsGetParams) => Answer<RunsGetResult>;
  "runs.events": (params: Params<RunsEventsParams> & { runId: string }) => Answer<RunsEventsResult>;
  "inputs.list": (params: Params<InputsListParams>) => Answer<InputsListResult>;
  "claims.list": (params: Params<ClaimsListParams>) => Answer<ClaimsListResult>;
}

export interface BridgeCall {
  method: MethodName;
  params: unknown;
}

export interface FakeBridgeOptions {
  /** `process.platform` of the main process; `darwin` puts shortcuts on ⌘. */
  platform?: string;
  preferences?: Preferences;
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
  /** How many subscribers are listening — a screen that leaks one is a screen that leaks. */
  readonly subscribers: number;
  /** The preferences the fake is holding, after any writes a test has made. */
  readonly preferences: Preferences;
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
};

/** A fake `window.orca`. Nothing is installed until `install()` is called. */
export function fakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const handlers: Handlers = { ...defaults };
  const calls: BridgeCall[] = [];
  const listeners = new Set<(notification: NotificationMessage) => void>();
  const held = new Map<MethodName, Promise<void>>();
  let preferences = options.preferences ?? DEFAULT_PREFERENCES;

  /** Record the call, wait out any hold, then answer. One place, so `calls` can never miss one. */
  async function call<K extends MethodName>(method: K, params: Parameters<Handlers[K]>[0]): Promise<unknown> {
    calls.push({ method, params });
    await held.get(method);
    return (handlers[method] as (p: unknown) => Answer<unknown>)(params);
  }

  const bridge: FakeOrcaBridge = {
    platform: options.platform ?? "darwin",
    hello: () => call("hello", undefined) as Promise<BridgeResult<HelloResult>>,
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
    },
    inputs: { list: (params = {}) => call("inputs.list", params) as Promise<BridgeResult<InputsListResult>> },
    claims: { list: (params = {}) => call("claims.list", params) as Promise<BridgeResult<ClaimsListResult>> },
    notifications: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
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
    get subscribers() {
      return listeners.size;
    },
    get preferences() {
      return preferences;
    },
  };
}
