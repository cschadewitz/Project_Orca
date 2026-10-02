/**
 * The guard: a wrapper over an existing method table that authorizes every call against the
 * principal the transport bound to its context.
 *
 * It is a wrapper rather than a change to the methods because the methods are shared and
 * this is not their business: `guard(table)` returns a table with the same names and param
 * schemas whose handlers check, filter and audit around the originals. It works on any table
 * - `methodsFor(ctx)`, a test's injected table, or one carrying a method no daemon registers
 * yet - so the contract can be exercised without the daemon.
 *
 * Order, per call:
 *
 * 1. `checkOperation` - the transport calls it after the envelope parses and *before* the
 *    params do, so a caller learns nothing about a method's params it may not call. An
 *    operation missing from the inventory is refused even if the table answers it.
 * 2. Params validation - `dispatch`, unchanged.
 * 3. The handler below: the operation check again (a table used without the transport is
 *    not a bypass), then the resource check, then the original handler, then filtering of
 *    what it returned, then the audit record.
 *
 * A principal with an unrestricted scope skips step 3's resource work entirely, so the
 * owner sees exactly the daemon it always saw.
 */
import { OrcaError, isOrcaError } from "@orca/core";
import {
  AGENT_CHANGED,
  AGENT_UPDATE,
  CONFIG_CHANGED,
  EVENT_APPENDED,
  INPUT_ANSWERED,
  INPUT_INVALIDATED,
  INPUT_OPENED,
  PLAN_CHANGED,
  RUN_CHANGED,
  STEP_CHANGED,
  WORKFLOWS_CHANGED,
  type ArtifactView,
  type ClaimView,
  type HelloResult,
  type JournalListResult,
  type OpenInputView,
  type NotificationMessage,
  type RunsGetResult,
  type RunsEventsResult,
  type RunSummaryView,
  type WorkflowSummaryView,
} from "@orca/protocol";
import type { OrcaEvent } from "@orca/core";
import type { MethodContext, MethodTable } from "../methods.js";
import {
  artifactEvent,
  eventWithoutArtifacts,
  journalWithoutArtifacts,
  runWithoutArtifacts,
} from "./artifact-projection.js";
import { actorOf, targetOf, type AuditRecord, type AuditSink } from "./audit.js";
import {
  artifactNotFound,
  authForbidden,
  authRequired,
  claimNotFound,
  inputNotFound,
  runNotFound,
  workflowNotFound,
} from "./errors.js";
import { CAPABILITY_PERMISSIONS, OPERATIONS, type OperationSpec } from "./operations.js";
import type { OwnershipStore } from "./ownership.js";
import { PERMISSIONS, holds, isUnrestricted, workflowAllowed, type Principal } from "./principal.js";
import { RunAccess, type ResourceResolver } from "./resources.js";

export interface RequestMeta {
  transport: "http" | "socket";
  /** The peer address, or the client address a trusted proxy forwarded. */
  remote?: string | undefined;
}

interface Binding {
  principal: Principal;
  meta: RequestMeta;
}

const bindings = new WeakMap<object, Binding>();

/**
 * A copy of `ctx` that carries `principal`. The binding lives in a WeakMap keyed by the copy,
 * so it cannot be forged by a field a caller controls and it does not change `MethodContext`.
 */
export function bindPrincipal(ctx: MethodContext, principal: Principal, meta: RequestMeta): MethodContext {
  const bound = { ...ctx };
  bindings.set(bound, { principal, meta });
  return bound;
}

export function principalOf(ctx: MethodContext): Binding | undefined {
  return bindings.get(ctx);
}

/** A refusal the guard decided on: the error the caller sees, and the reason only the audit log sees. */
class Denied extends Error {
  constructor(
    readonly error: Error,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** The engine feed, for attributing a started run at `run.created` (see `startOwned`). */
export interface AdmissionSource {
  subscribe(listener: (event: OrcaEvent) => void, filter?: { runId?: string | undefined }): () => void;
}

export interface AuthorizerOptions {
  resolver: ResourceResolver;
  /** Live-answer acceptance rechecks credentials under the owner lease. */
  currentPrincipal?: (principal: Principal) => Principal;
  ownership: OwnershipStore;
  audit?: AuditSink | undefined;
  admissions?: AdmissionSource | undefined;
  now?: (() => Date) | undefined;
}

const RUN_NOTIFICATIONS = new Set<string>([
  RUN_CHANGED,
  STEP_CHANGED,
  AGENT_UPDATE,
  INPUT_OPENED,
  INPUT_ANSWERED,
  INPUT_INVALIDATED,
  EVENT_APPENDED,
]);

/** Pages are read this long when a restricted list has to see everything to filter it. */
const PAGE = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- params are whatever the method's schema produced.
type Params = any;

export class Authorizer {
  readonly runs: RunAccess;
  private readonly audit: AuditSink | undefined;
  private readonly now: () => Date;
  private readonly currentPrincipal: AuthorizerOptions["currentPrincipal"];

  constructor(opts: AuthorizerOptions) {
    this.runs = new RunAccess(opts.resolver, opts.ownership);
    this.audit = opts.audit;
    this.now = opts.now ?? (() => new Date());
    this.currentPrincipal = opts.currentPrincipal;
  }

  get resolver(): ResourceResolver {
    return this.runs.resolver;
  }

  // ------------------------------------------------------------------ operations

  /**
   * The operation check, before params are parsed. `exists` is whether the table answers the
   * method: an un-inventoried method nobody answers falls through to `PROTOCOL_METHOD`, which
   * discloses nothing `hello` does not; an un-inventoried method somebody *does* answer is
   * refused, because that is the bypass deny-by-default exists to stop.
   */
  checkOperation(principal: Principal, method: string, exists: boolean, meta: RequestMeta): void {
    if (method.startsWith("requests.") && (!holds(principal, "runs.start") || !holds(principal, "plan.write"))) {
      this.deny(principal, meta, method, undefined, "AUTH_FORBIDDEN", "request-submission-not-permitted");
      throw authForbidden();
    }
    if (
      (method === "inputs.revise" || method === "inputs.replaceRevision") &&
      (!holds(principal, "inputs.answer") || !holds(principal, "runs.control"))
    ) {
      this.deny(principal, meta, method, undefined, "AUTH_FORBIDDEN", "revision-not-permitted");
      throw authForbidden();
    }
    const spec = OPERATIONS[method];
    if (!spec) {
      if (!exists) return;
      this.deny(principal, meta, method, undefined, "AUTH_FORBIDDEN", "operation-not-inventoried");
      throw authForbidden();
    }
    if (spec.permission && !holds(principal, spec.permission)) {
      this.deny(principal, meta, method, undefined, "AUTH_FORBIDDEN", `missing-permission:${spec.permission}`);
      throw authForbidden();
    }
  }

  /** The methods of `names` this principal may call - what `hello.methods` tells it. */
  permittedMethods(principal: Principal, names: readonly string[]): string[] {
    return names.filter((name) => {
      const spec = OPERATIONS[name];
      return (
        spec !== undefined &&
        (!spec.permission || holds(principal, spec.permission)) &&
        (name !== "operator.artifact" || holds(principal, "runs.read")) &&
        (!name.startsWith("requests.") || holds(principal, "runs.start")) &&
        (!(name === "inputs.revise" || name === "inputs.replaceRevision") || holds(principal, "runs.control"))
      );
    });
  }

  /** Same credential-pinned authority for transport calls and trusted durable recovery. */
  executionResumeAuthority(principal: Principal): NonNullable<MethodContext["executionResumeAuthority"]> {
    return {
      actor: {
        principalId: principal.id,
        ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
      },
      authorize: async (origin) => {
        if (!this.currentPrincipal) throw authRequired();
        const current = this.currentPrincipal(principal);
        if (
          current.id !== principal.id ||
          current.credentialId !== principal.credentialId ||
          current.id !== origin.actor.principalId ||
          !holds(current, "runs.control") ||
          !holds(current, "runs.start") ||
          (origin.request && !holds(current, "plan.write")) ||
          !workflowAllowed(current.scope, origin.workflowId)
        )
          throw authForbidden();
        if (!(await this.runs.allows(current, origin.rootId))) throw runNotFound(origin.rootId);
      },
    };
  }

  /** Attribute a root run to a principal. The integration seam for `ControlModel.startRun`. */
  attributeRun(runId: string, principal: Principal): void {
    this.runs.ownership.record(runId, principal.id);
  }

  // ----------------------------------------------------------------- the table

  guard(table: MethodTable): MethodTable {
    const guarded: MethodTable = {};
    for (const [name, method] of Object.entries(table)) {
      const spec = OPERATIONS[name];
      guarded[name] = {
        params: method.params,
        handle: async (params: Params, ctx: MethodContext) => {
          const bound = principalOf(ctx);
          // No principal is no call: a context that did not come through an authenticating
          // transport is refused, never treated as local.
          if (!bound) throw authRequired();
          const { principal, meta } = bound;
          this.checkOperation(principal, name, true, meta);
          if (!spec) {
            this.deny(principal, meta, name, params, "AUTH_FORBIDDEN", "operation-not-inventoried");
            throw authForbidden();
          }
          if (spec.permission && !holds(principal, spec.permission)) {
            this.deny(principal, meta, name, params, "AUTH_FORBIDDEN", `missing-permission:${spec.permission}`);
            throw authForbidden();
          }
          const invocation = bindPrincipal(
            {
              ...ctx,
              mutationActor: {
                principalId: principal.id,
                ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
              },
              liveAnswerAuthority: {
                actor: {
                  principalId: principal.id,
                  ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
                },
                authorize: async (target, standing) => {
                  if (!this.currentPrincipal) throw authRequired();
                  const current = this.currentPrincipal(principal);
                  if (
                    current.id !== principal.id ||
                    current.credentialId !== principal.credentialId ||
                    !holds(current, "inputs.answer") ||
                    (standing && !holds(current, "permissions.grant"))
                  )
                    throw authForbidden();
                  if (!(await this.runs.allows(current, target.runId)))
                    throw inputNotFound(target.requestId, target.runId);
                },
              },
              executionResumeAuthority: this.executionResumeAuthority(principal),
              attributeStartedRun: async (runId) => {
                this.attributeRun(runId, principal);
                await this.runs.ownership.flush(runId);
                if (this.runs.ownership.owner(runId) !== principal.id)
                  throw new OrcaError("INTERNAL", "run ownership could not be persisted; execution was not started");
              },
            },
            principal,
            meta,
          );
          const original = (p: Params) => method.handle(p, invocation);
          try {
            const result = await this.authorized(name, spec, principal, params, original, table, ctx);
            if (spec.audit) this.operation(principal, meta, name, params, "succeeded", undefined, result);
            return result;
          } catch (e) {
            if (e instanceof Denied) {
              const code = isOrcaError(e.error) ? e.error.code : (e.error as { code?: string }).code;
              this.deny(principal, meta, name, params, code ?? "AUTH_FORBIDDEN", e.reason);
              throw e.error;
            }
            if (name.startsWith("operator.") && ["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN"].includes(codeOf(e)))
              this.deny(principal, meta, name, params, codeOf(e), "operator-authority-refused");
            if (spec.audit) this.operation(principal, meta, name, params, "failed", codeOf(e));
            throw e;
          }
        },
      };
    }
    return guarded;
  }

  private async authorized(
    name: string,
    spec: OperationSpec,
    principal: Principal,
    params: Params,
    original: (p: Params) => unknown,
    table: MethodTable,
    ctx: MethodContext,
  ): Promise<unknown> {
    const restricted = !isUnrestricted(principal.scope);
    if (name === "hello") return this.hello(principal, (await original(params)) as HelloResult);

    switch (spec.resource) {
      case "none":
        if (name === "journal.list" && !holds(principal, "artifacts.read"))
          return journalWithoutArtifacts((await original(params)) as JournalListResult);
        return original(params);
      case "subscription":
        return original(params);

      case "run": {
        const runId = params.runId as string;
        if (restricted && !(await this.runs.allows(principal, runId)))
          throw new Denied(runNotFound(runId), "run-not-visible");
        const result = await (restricted
          ? rethrowAs(original(params), "RUN_NOT_FOUND", () => runNotFound(runId))
          : original(params));
        if (!holds(principal, "artifacts.read")) {
          if (name === "runs.get") return runWithoutArtifacts(result as RunsGetResult);
          if (name === "runs.events") {
            const page = result as RunsEventsResult;
            // Retain scan cursors: even an entirely hidden page must allow forward/backward progress.
            return {
              ...page,
              events: page.events.filter((event) => !artifactEvent(event.type)).map(eventWithoutArtifacts),
            };
          }
        }
        return result;
      }

      case "run-list":
        return restricted ? this.runsList(principal, params, original) : original(params);

      case "input-list": {
        const result = (await original(params)) as { inputs: OpenInputView[]; waiting: number };
        let inputs = restricted ? await this.visible(principal, result.inputs, (i) => i.runId) : result.inputs;
        if (!holds(principal, "artifacts.read")) inputs = inputs.map((input) => ({ ...input, artifacts: [] }));
        return { ...result, inputs, waiting: inputs.length };
      }

      case "claim-list": {
        const result = (await original(params)) as { claims: ClaimView[] };
        if (!restricted) return result;
        return { ...result, claims: await this.visible(principal, result.claims, (c) => c.owner.runId) };
      }

      case "artifact-list":
        return restricted ? this.artifactsList(principal, params, original, table, ctx) : original(params);

      case "artifact": {
        if (!restricted) return original(params);
        const runId =
          params.artifactId !== undefined
            ? await this.resolver.artifactRun(params.artifactId as string)
            : (params.runId as string);
        if (!runId || !(await this.runs.allows(principal, runId)))
          throw new Denied(artifactNotFound(params), "artifact-not-visible");
        return rethrowAs(original(params), "ARTIFACT_MISSING", () => artifactNotFound(params));
      }

      case "workflow": {
        // Linked documents are workspace resources, not made visible by owning a new run.
        // Work-item execution may settle the plan, so reading it alone is insufficient.
        if (name === "runs.start" || name === "runs.admit") {
          if (params.requestId !== undefined && !holds(principal, "plan.read"))
            throw new Denied(authForbidden(), "linked-request-not-permitted");
          if (params.workItemId !== undefined && (!holds(principal, "plan.read") || !holds(principal, "plan.write")))
            throw new Denied(authForbidden(), "linked-work-item-not-permitted");
        }
        const workflowId = params[spec.param ?? "workflowId"] as string;
        if (!workflowAllowed(principal.scope, workflowId))
          throw new Denied(workflowNotFound(workflowId), "workflow-not-in-scope");
        const call = () => original(params);
        // A restricted principal never sees `known`: the not-found is rebuilt without it.
        return principal.scope.workflows === "*"
          ? call()
          : rethrowAs(call(), "WORKFLOW_NOT_FOUND", () => workflowNotFound(workflowId));
      }

      case "workflow-list": {
        const result = (await original(params)) as { workflows: WorkflowSummaryView[] };
        if (principal.scope.workflows === "*") return result;
        return { ...result, workflows: result.workflows.filter((w) => workflowAllowed(principal.scope, w.id)) };
      }

      case "input":
        return this.answer(principal, params, original, restricted);

      case "claim": {
        if (!restricted) return original(params);
        const workItemId = params.workItemId as string;
        const runId = await this.resolver.claimRun(workItemId);
        if (!runId || !(await this.runs.allows(principal, runId)))
          throw new Denied(claimNotFound(workItemId), "claim-not-visible");
        return original(params);
      }
    }
  }

  /** `hello` tells a principal about the methods and capabilities it may actually use. */
  private hello(principal: Principal, result: HelloResult): HelloResult {
    const everything = PERMISSIONS.every((p) => holds(principal, p));
    const { storeDir, ...rest } = result;
    return {
      ...rest,
      // The store's path on disk is the configuration's business.
      ...(storeDir !== undefined && holds(principal, "config.read") ? { storeDir } : {}),
      capabilities: result.capabilities.filter((c) => {
        if (c === "inputs.revise" || c === "inputs.replaceRevision")
          return holds(principal, "inputs.answer") && holds(principal, "runs.control");
        if (c === "operator.artifact") return holds(principal, "artifacts.read") && holds(principal, "runs.read");
        if (c === "inputs.revisionPending") return holds(principal, "runs.read");
        const needs = CAPABILITY_PERMISSIONS[c];
        return needs ? needs.some((p) => holds(principal, p)) : everything;
      }),
      ...(result.methods ? { methods: this.permittedMethods(principal, result.methods) } : {}),
    };
  }

  /**
   * `inputs.answer` - a decision, which is the thing this story most has to get right.
   *
   * A standing rule (`always`) is its own grant, checked first. Then the gate itself: the
   * exact pending request, in a run the caller can see, inside the run the caller named if it
   * named one. A request this check cannot place is the same not-found `control.ts` gives for
   * an id that names nothing. Stale state - already answered, run no longer waiting, an option
   * that does not exist - is still the control model's to refuse, and it does, under the lease.
   */
  private async answer(
    principal: Principal,
    params: Params,
    original: (p: Params) => unknown,
    restricted: boolean,
  ): Promise<unknown> {
    if (params.always && !holds(principal, "permissions.grant"))
      throw new Denied(authForbidden(), "missing-permission:permissions.grant");
    if (!restricted) return original(params);
    const requestId = params.requestId as string;
    const named = params.runId as string | undefined;
    const notFound = () => inputNotFound(requestId, named);
    if (named !== undefined && !(await this.runs.allows(principal, named)))
      throw new Denied(notFound(), "input-run-not-visible");
    const open = await this.resolver.inputRun(requestId);
    if (open !== undefined) {
      if (!(await this.runs.allows(principal, open))) throw new Denied(notFound(), "input-not-visible");
      if (named !== undefined && !(await this.runs.within(open, named)))
        throw new Denied(notFound(), "input-run-mismatch");
    } else if (named === undefined) {
      // Not open, and no run to scope the search to: the control model would search the whole
      // store and might name a run this caller cannot see. Answered gates in a visible run are
      // still reported precisely when the caller passes that run's id.
      throw new Denied(notFound(), "input-not-open");
    }
    return original(params);
  }

  private async runsList(principal: Principal, params: Params, original: (p: Params) => unknown): Promise<unknown> {
    type Page = { runs: RunSummaryView[]; total: number; asOf: string };
    const rows: RunSummaryView[] = [];
    const seen = new Set<string>();
    let last: Page;
    for (let offset = 0; ;) {
      last = (await original({ ...params, limit: PAGE, offset })) as Page;
      for (const row of last.runs) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        this.runs.learn(row.id, { workflowId: row.workflowId, parentRunId: row.parentRunId });
        rows.push(row);
      }
      offset += last.runs.length;
      if (last.runs.length === 0 || offset >= last.total) break;
    }
    const visible = await this.visible(principal, rows, (r) => r.id);
    return {
      ...last,
      runs: visible.slice(params.offset as number, (params.offset as number) + (params.limit as number)),
      total: visible.length,
    };
  }

  /**
   * `artifacts.list` for a restricted principal. `ArtifactView` does not carry its run, so a
   * store-wide listing is rebuilt from the runs the principal can see, one run at a time, in
   * the read model's own order (name, version, id).
   */
  private async artifactsList(
    principal: Principal,
    params: Params,
    original: (p: Params) => unknown,
    table: MethodTable,
    ctx: MethodContext,
  ): Promise<unknown> {
    type Page = { artifacts: ArtifactView[]; total: number; asOf: string };
    const all = async (runId: string): Promise<Page & { rows: ArtifactView[] }> => {
      const rows: ArtifactView[] = [];
      let page: Page;
      for (let offset = 0; ;) {
        page = (await original({ ...params, runId, limit: PAGE, offset })) as Page;
        rows.push(...page.artifacts);
        offset += page.artifacts.length;
        if (page.artifacts.length === 0 || offset >= page.total) break;
      }
      return { ...page!, rows };
    };
    if (params.runId !== undefined) {
      const runId = params.runId as string;
      if (!(await this.runs.allows(principal, runId))) {
        // The same answer a run with no artifacts - or no existence - gets.
        const page = (await original(params)) as Page;
        return { ...page, artifacts: [], total: 0 };
      }
      return original(params);
    }
    const runsList = table["runs.list"];
    const asOf = this.now().toISOString();
    if (!runsList) return { artifacts: [], total: 0, asOf };
    const listed = (await this.runsList(principal, { offset: 0, limit: Number.MAX_SAFE_INTEGER }, (p) =>
      runsList.handle(p, ctx),
    )) as { runs: RunSummaryView[] };
    const rows: ArtifactView[] = [];
    let stamp = asOf;
    for (const run of listed.runs) {
      const page = await all(run.id);
      rows.push(...page.rows);
      stamp = page.asOf;
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.id.localeCompare(b.id));
    return {
      artifacts: rows.slice(params.offset as number, (params.offset as number) + (params.limit as number)),
      total: rows.length,
      asOf: stamp,
    };
  }

  private async visible<T>(principal: Principal, rows: readonly T[], runOf: (row: T) => string): Promise<T[]> {
    const out: T[] = [];
    for (const row of rows) if (await this.runs.allows(principal, runOf(row))) out.push(row);
    return out;
  }

  // ------------------------------------------------------------- notifications

  /**
   * Whether one pushed notification may reach this principal. Run notifications need
   * `runs.read` and the run; the store-wide ones each need their own read grant. A method
   * this gate does not know is withheld - a newer push is not a bypass either.
   */
  async allowsNotification(principal: Principal, method: string, params: Record<string, unknown>): Promise<boolean> {
    if (method === EVENT_APPENDED && !holds(principal, "artifacts.read")) {
      const event = params.event as { type?: string } | undefined;
      if (!event?.type || artifactEvent(event.type)) return false;
    }
    if (RUN_NOTIFICATIONS.has(method))
      return holds(principal, "runs.read") && (await this.runs.allows(principal, String(params.runId)));
    switch (method) {
      case AGENT_CHANGED:
        return holds(principal, "agents.read");
      case CONFIG_CHANGED:
        return holds(principal, "config.read");
      case PLAN_CHANGED:
        return holds(principal, "plan.read");
      case WORKFLOWS_CHANGED:
        return holds(principal, "workflows.read") && workflowAllowed(principal.scope, String(params.id));
      default:
        return false;
    }
  }

  /** Authorize and project for this recipient, without changing a shared frame or stored event. */
  async projectNotification(
    principal: Principal,
    message: NotificationMessage,
  ): Promise<NotificationMessage | undefined> {
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (!(await this.allowsNotification(principal, message.method, params))) return undefined;
    if (message.method !== EVENT_APPENDED || holds(principal, "artifacts.read")) return message;
    return { ...message, params: { ...params, event: eventWithoutArtifacts(params.event as OrcaEvent) } };
  }

  /**
   * `subscribe` over the socket. A run-scoped stream needs `runs.read`; for a run the caller
   * cannot see it is answered exactly as one for a run that does not exist - a subscription
   * that replays nothing and delivers nothing - so `replayed` is never a count of hidden events.
   */
  async subscribeScope(
    principal: Principal,
    runId: string | undefined,
    meta: RequestMeta,
  ): Promise<"replay" | "silent"> {
    if (runId === undefined) return "replay";
    if (!holds(principal, "runs.read")) {
      this.deny(principal, meta, "subscribe", { runId }, "AUTH_FORBIDDEN", "missing-permission:runs.read");
      throw authForbidden();
    }
    if (await this.runs.allows(principal, runId)) return "replay";
    this.deny(principal, meta, "subscribe", { runId }, "SUBSCRIPTION_SILENCED", "run-not-visible");
    return "silent";
  }

  // --------------------------------------------------------------------- audit

  private record(entry: Omit<AuditRecord, "at">): void {
    this.audit?.record({ at: this.now().toISOString(), ...entry });
  }

  deny(
    principal: Principal | undefined,
    meta: RequestMeta,
    operation: string | undefined,
    params: unknown,
    code: string,
    reason: string,
  ): void {
    this.record({
      event: principal ? "authz.denied" : "authn.denied",
      transport: meta.transport,
      ...(principal ? { actor: actorOf(principal) } : {}),
      ...(operation ? { operation } : {}),
      target: targetOf(params),
      outcome: "denied",
      code,
      reason,
      remote: meta.remote,
    });
  }

  /** An authentication refusal at the transport: no principal, and the reason is internal. */
  denyAuthentication(meta: RequestMeta, code: string, reason: string, credentialId?: string): void {
    this.record({
      event: "authn.denied",
      transport: meta.transport,
      outcome: "denied",
      code,
      reason,
      ...(credentialId ? { target: { credentialId } } : {}),
      remote: meta.remote,
    });
  }

  /** A socket the daemon closed because its credential stopped being valid. */
  connectionClosed(principal: Principal, meta: RequestMeta, reason: string): void {
    this.record({
      event: "connection.closed",
      transport: meta.transport,
      actor: actorOf(principal),
      outcome: "denied",
      code: "AUTH_INVALID",
      reason,
      remote: meta.remote,
    });
  }

  private operation(
    principal: Principal,
    meta: RequestMeta,
    name: string,
    params: unknown,
    outcome: "succeeded" | "failed",
    code?: string,
    result?: unknown,
  ): void {
    const resultRun =
      result && typeof result === "object" && typeof (result as { runId?: unknown }).runId === "string"
        ? (result as { runId: string }).runId
        : undefined;
    this.record({
      event: "operation",
      transport: meta.transport,
      actor: actorOf(principal),
      operation: name,
      target: targetOf(
        params,
        resultRun && resultRun !== (params as { runId?: string })?.runId ? { resultRunId: resultRun } : undefined,
      ),
      outcome,
      ...(code ? { code } : {}),
      remote: meta.remote,
    });
  }
}

function codeOf(e: unknown): string {
  if (isOrcaError(e)) return e.code;
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : "INTERNAL";
}

/** Await `value`, replacing a thrown error with `code` by the canonical one. */
async function rethrowAs(value: unknown, code: string, canonical: () => OrcaError): Promise<unknown> {
  try {
    return await value;
  } catch (e) {
    if (isOrcaError(e) && e.code === code) throw canonical();
    throw e;
  }
}
