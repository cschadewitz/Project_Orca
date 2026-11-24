/** Authenticated HTTP and WebSocket daemon composition. */
import { createHmac, randomBytes } from "node:crypto";
import {
  PROTOCOL_VERSION,
  OperatorBoundaryProjectionSchema,
  RevisionBoundaryViewSchema,
  type OperatorPageParams,
  type OperatorRow,
  type OperatorBoundaryRow,
  AdmissionExecutionViewSchema,
  type AdmissionExecutionView,
  INPUTS_REVISION_ITEM_LIMIT,
  PendingRevisionTargetSchema,
  PendingRevisionSummarySchema,
  PendingRevisionsDiscoverySchema,
  RuntimeMaintenanceTargetSchema,
  type PendingRevisionSummary,
  type PendingRevisionTarget,
} from "@orca/protocol";
import {
  OperatorReadModel,
  operatorEventCollections,
  operatorGenerationCollections,
  operatorLinkedDocumentCollections,
  operatorPinnedGraph,
  eventSnapshot,
  type OperatorReadOptions,
} from "./operator-read-model.js";
import type { EventStore, LeaseStore } from "@orca/store";
/**
 * The daemon's HTTP surface: `POST /rpc` takes one request envelope and answers with one
 * response envelope; `GET /health` is for process supervisors.
 *
 * Notifications need a connection the daemon can push on, which HTTP has not got, so a
 * `MethodContext.source` also brings up a WebSocket endpoint on `/socket` (socket.ts). That
 * is strictly additive: without a `source` this is exactly the server it always was, and
 * even with one, `hello` and every read method still work over `/rpc` with no socket in
 * sight. A client subscribes by opening a socket, not by changing how it reads.
 *
 * Both endpoints authenticate before anything else happens (#328, `auth/`): `startDaemon`
 * refuses to start without an explicit `auth` policy, a request is admitted on its headers
 * before its body is read, and every method runs behind the guard. `GET /health` is the one
 * unauthenticated answer, and all it ever says is `{ "ok": true }`.
 */
import { isOrcaError, OrcaError, type OrcaConfig } from "@orca/core";
import type { createRevisionInputServices, createRevisionRuntime } from "@orca/engine";
import { createDaemonIdentity } from "./daemon-identity.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describeError } from "@orca/core";
import {
  isProtocolFault,
  parseMessage,
  protocolError,
  socketUrlFor,
  type ProtocolError,
  type ResponseMessage,
} from "@orca/protocol";
import { methodsFor, type MethodContext, type MethodTable } from "./methods.js";
import type { daemonExecutionRuntime } from "./execution-runtime.js";
import { Maintenance } from "./maintenance.js";
import { attachSocket } from "./socket.js";
import { Authorizer, bindPrincipal, principalOf } from "./auth/guard.js";
import { SecretsReadModel, type SecretsSource } from "./secrets-model.js";
import { directAdmissionAuthority } from "./admission-retry.js";
import { holds, type Principal } from "./auth/principal.js";
import type { JudgeBudgetInspection } from "./judge-budget.js";
import { judgeKeyStatus, judgeStatus } from "./judge-status.js";
import {
  HostResourceReadModel,
  resourceResponseForPublication,
  type HostResourceReadSource,
} from "./operator-host-resources.js";
import { authForbidden } from "./auth/errors.js";
import { submissionAuthority } from "./request-submission.js";
import { revisionAccess } from "./revision-input.js";
import { authInvalid, authRequired } from "./auth/errors.js";
import { OwnershipStore } from "./auth/ownership.js";
import type { ResourceResolver } from "./auth/resources.js";
import { TransportGate, validateDeployment, type Admission, type DaemonAuthOptions } from "./auth/transport.js";

export interface DaemonOptions extends MethodContext {
  runtimeIdle?: ReturnType<typeof daemonExecutionRuntime> | undefined;
  /** Opt-in contract seam only. Normal CLI composition does not install a resource collector. */
  hostResourceSource?: HostResourceReadSource;
  /** The live secret reference catalog and its hosts, for `secrets.list` and `secrets.check` (#336). */
  secretsSource?: () => SecretsSource;
  /**
   * `judge.status` (#701): the active generation's configuration and a read-only inspection of
   * the judge's budget. The caller's grants are read from its own current credentials.
   */
  judgeStatusSource?: {
    config: () => Pick<OrcaConfig, "review" | "secrets" | "hosts"> | undefined;
    budget: () => Promise<JudgeBudgetInspection>;
  };
  /** Installed protected evidence reader; never a callback that attaches execution. */
  admissionExecutionSource?: ((runId: string) => Promise<AdmissionExecutionView | undefined>) | undefined;
  /** Actual protected runtime and registered retry services; never a placeholder capability. */
  revisionSources?: {
    services: ReturnType<typeof createRevisionInputServices>;
    readBoundaries: ReturnType<typeof createRevisionRuntime>["readBoundaries"];
  };
  /** Explicit read projection sources, independent of the legacy unbounded read model. */
  operatorSources?: Pick<OperatorReadOptions, "generations" | "configStatus" | "artifact" | "artifactRun"> & {
    events: EventStore;
    leases?: LeaseStore;
    liveState?: Parameters<typeof operatorEventCollections>[0]["liveState"];
    liveRevision?: Parameters<typeof operatorEventCollections>[0]["liveRevision"];
    documents?: Parameters<typeof operatorLinkedDocumentCollections>[0];
    definitionFor?: Parameters<typeof operatorPinnedGraph>[0]["definitionFor"];
  };

  /** Persistent store identity initialized by the owner at bootstrap. */
  workspaceId?: string;
  /**
   * How callers are authenticated. Required at runtime: `startDaemon` refuses to start
   * without it, and there is no default - `{ mode: "loopback-unauthenticated" }` has to be
   * asked for, and is refused off loopback. `docs/daemon-security.md` has both modes.
   *
   * Optional in the type only so the callers that integration wires (`orca serve`) still
   * compile while they are wired; a call that omits it fails closed, not open.
   */
  auth?: DaemonAuthOptions | undefined;
  maintenanceToken?: string | undefined;
  admissionFile?: string | undefined;
  /** Durable managed-root admission, independent of runtime drain. Existing completion remains available. */
  newAdmissionOpen?: (() => boolean) | undefined;
  /** Held completion/observation permission; final durable stop or lost root identity closes it. */
  existingWorkOpen?: (() => boolean) | undefined;
  host?: string | undefined;
  /** `0` (the default) picks a free port; read the real one from `DaemonHandle.port`. */
  port?: number | undefined;
  methods?: MethodTable | undefined;
  /** Overridable so a test can close the agent-output batch window by hand. */
  batchMs?: number | undefined;
}

export interface DaemonHandle {
  host: string;
  port: number;
  url: string;
  /** The WebSocket URL, when this daemon was given an engine feed to subscribe to. */
  socketUrl?: string | undefined;
  /** Stop transports and await dispatched method handlers, including disconnected callers. */
  close: () => Promise<void>;
  /** Bounded startup sweep; resolves only the original sealed credential, never a process owner. */
  recoverContinuations?: (() => Promise<void>) | undefined;
}

const MAX_BODY_BYTES = 1_000_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(resourceResponseForPublication(body)));
}

/** The response to a refused admission: the same envelope a method failure has, with a status. */
export function refusalOf(admission: Extract<Admission, { ok: false }>): {
  status: number;
  headers: Record<string, string>;
  body: ResponseMessage;
} {
  return {
    status: admission.status,
    headers: admission.status === 401 ? { "www-authenticate": 'Bearer realm="orca"' } : {},
    body: { kind: "response", id: 0, ok: false, error: admission.error },
  };
}

/**
 * The operation check `dispatch` runs once the envelope parses and before the params do.
 * `exists` is whether the method table answers the method. It throws the refusal.
 */
export type AuthorizeOperation = (method: string, exists: boolean) => void;

/**
 * Run one request envelope through the method table; every failure becomes a response envelope.
 * With `authorize`, the caller's operation grant is checked before its params are validated.
 */
export async function dispatch(
  text: string,
  methods: MethodTable,
  ctx: MethodContext,
  authorize?: AuthorizeOperation,
): Promise<ResponseMessage> {
  const fail = (id: string | number, error: ProtocolError): ResponseMessage => ({
    kind: "response",
    id,
    ok: false,
    error,
  });
  const msg = parseMessage(text);
  if (!msg) return fail(0, protocolError("PROTOCOL_MESSAGE", "not a protocol message"));
  if (msg.kind !== "request")
    return fail(0, protocolError("PROTOCOL_MESSAGE", `expected a request, got a ${msg.kind}`));
  if (authorize) {
    try {
      authorize(msg.method, Object.hasOwn(methods, msg.method));
    } catch (e) {
      return fail(msg.id, isProtocolFault(e) ? e.toJSON() : describeError(e));
    }
  }
  const method = Object.hasOwn(methods, msg.method) ? methods[msg.method] : undefined;
  if (!method) return fail(msg.id, protocolError("PROTOCOL_METHOD", `unknown method '${msg.method}'`));
  const params = method.params.safeParse(msg.params ?? {});
  if (!params.success) {
    return fail(
      msg.id,
      protocolError("PROTOCOL_MESSAGE", `invalid params for '${msg.method}'`, { issues: params.error.issues }),
    );
  }
  try {
    return { kind: "response", id: msg.id, ok: true, result: await method.handle(params.data, ctx) };
  } catch (e) {
    // A `ProtocolFault` already *is* the error half of a response - it carries one of the
    // protocol-only codes, which `describeError` (whose vocabulary is `OrcaErrorCode`) would
    // flatten to `INTERNAL`. Everything else goes the way it always did.
    return fail(msg.id, isProtocolFault(e) ? e.toJSON() : describeError(e));
  }
}

/** The loopback mode's principal sees everything, so it never resolves a resource. */
const NO_RESOURCES: ResourceResolver = {
  run: async () => undefined,
  inputRun: async () => undefined,
  artifactRun: async () => undefined,
  claimRun: async () => undefined,
  workflowExists: () => false,
};

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const host = opts.host ?? "127.0.0.1";
  // Before anything is built: an unsafe or absent policy is a refusal to start, not a warning.
  validateDeployment(opts.auth, host);
  const auth = opts.auth;
  const identity = opts.identity ?? (opts.workspaceId ? createDaemonIdentity(opts.workspaceId) : undefined);
  if (identity && opts.workspaceId && identity.workspaceId !== opts.workspaceId)
    throw new OrcaError("CONFIG_INVALID", "daemon identity does not match its workspace");
  const runtimeTarget = RuntimeMaintenanceTargetSchema.safeParse({ ...identity, processId: process.pid });
  const runtime = auth.mode === "token" && runtimeTarget.success ? opts.runtimeIdle : undefined;
  const maintenance = new Maintenance(
    opts.maintenanceToken,
    opts.admissionFile,
    runtime && identity
      ? {
          activity: runtime.activity,
          target: { ...identity, processId: process.pid },
          unfinished: async () => {
            const ids = await runtime.orchestrator.listRuns();
            // An oversized or failed inventory cannot establish quiescence.
            if (ids.length > 4096) return { unfinished: [], truncated: true };
            const unfinished: import("@orca/protocol").RuntimeDrainResult["unfinished"] = [];
            for (const runId of ids) {
              const { status } = await runtime.orchestrator.getSummary(runId);
              if (status === "completed" || status === "failed" || status === "cancelled") continue;
              const group = unfinished.find((entry) => entry.status === status);
              if (group) group.count++;
              else unfinished.push({ status, count: 1 });
            }
            return { unfinished, truncated: false };
          },
        }
      : undefined,
    opts.newAdmissionOpen,
    opts.existingWorkOpen,
  );
  const ctx: MethodContext = {
    ...(identity ? { identity } : {}),
    processId: process.pid,
    maintenance,
    orcaVersion: opts.orcaVersion,
    storeDir: opts.storeDir,
    deployment: opts.deployment,
    store: opts.store,
    capabilities: opts.capabilities,
    reads: opts.reads,
    workflowInputs: opts.workflowInputs,
    requestSubmissions: auth.mode === "token" ? opts.requestSubmissions : undefined,
    admissionRetries: auth.mode === "token" ? opts.admissionRetries : undefined,
    continuationAdmissions: auth.mode === "token" ? opts.continuationAdmissions : undefined,
    submissionWorkspaceId: opts.submissionWorkspaceId,
    source: opts.source,
    liveInputs: opts.liveInputs,
    planSource: opts.planSource,
    control: opts.control,
    planControl: opts.planControl,
    agents: opts.agents,
    config: opts.config,
  };
  const boundOrchestrator = runtime?.orchestrator;
  const boundModels = {
    requests: ctx.requestSubmissions,
    admissions: ctx.admissionRetries,
    continuations: ctx.continuationAdmissions,
    control: ctx.control,
  };
  if (runtime)
    runtime.activity.bind(
      () => {
        const orchestrator = runtime.orchestrator;
        const requests = ctx.requestSubmissions;
        const admissions = ctx.admissionRetries;
        const continuations = ctx.continuationAdmissions;
        const available =
          runtime.available &&
          runtime.orchestrator === boundOrchestrator &&
          runtime.workspaceId === identity?.workspaceId &&
          runtime.port.instanceId === identity?.instanceId &&
          auth.mode === "token" &&
          runtime.matchesAuthentication(auth.credentials, auth.ownership) &&
          ctx.source === orchestrator &&
          ctx.requestSubmissions === boundModels.requests &&
          ctx.admissionRetries === boundModels.admissions &&
          ctx.continuationAdmissions === boundModels.continuations &&
          ctx.control === boundModels.control &&
          orchestrator.runtimeActivity === runtime.activity &&
          orchestrator.liveInput === runtime &&
          ctx.liveInputs === runtime.port &&
          runtime.port.runtimeActivity === runtime.activity &&
          !!requests &&
          requests.runtimeActivity === runtime.activity &&
          requests.executionOrchestrator === orchestrator &&
          !!admissions &&
          admissions.runtimeActivity === runtime.activity &&
          admissions.executionOrchestrator === orchestrator &&
          !!continuations &&
          continuations.runtimeActivity === runtime.activity &&
          continuations.executionOrchestrator === orchestrator &&
          continuations.executionRuntime === runtime &&
          ctx.control?.executionOrchestrator === orchestrator;
        return {
          available,
          active: [
            ...(orchestrator.attachedExecutionCount ? ["execution" as const] : []),
            ...(runtime.port.pendingCount ? ["callback" as const] : []),
            ...(runtime.originCount || orchestrator.leaseActivityCount ? ["renewal" as const] : []),
            ...(continuations?.taskCount ? ["continuation" as const] : []),
          ],
        };
      },
      () => maintenance.existingWorkClosed(),
    );
  // A daemon without a store serves `hello` alone, and says so in `hello.methods`: a read
  // method it cannot answer is an unknown method, not a method that fails.
  const authorizer = new Authorizer(
    auth.mode === "token"
      ? {
          currentPrincipal: (principal) => {
            if (!principal.credentialId) throw authRequired();
            const current = auth.credentials.current(principal.credentialId);
            if (!current.ok) throw authInvalid();
            return current.principal;
          },
          resolver: auth.resolver,
          ownership: auth.ownership,
          audit: auth.audit,
          admissions: auth.admissions ?? ctx.source,
        }
      : {
          currentPrincipal: (principal) => principal,
          resolver: NO_RESOURCES,
          ownership: new OwnershipStore(),
          audit: auth.audit,
          admissions: ctx.source,
        },
  );
  if (opts.reads && typeof opts.reads.inputRevisionActionId === "function" && auth.mode === "token") {
    const reads = opts.reads;
    ctx.inputRevisionRestrictions = async (invocation, inputs, revisionRunIds) => {
      const bound = principalOf(invocation);
      const credentialId = bound?.principal.credentialId;
      if (!credentialId) throw authRequired();
      const principal = () => {
        const current = auth.credentials.current(credentialId);
        if (!current.ok) throw authInvalid();
        if (
          current.principal.id !== bound.principal.id ||
          current.principal.credentialId !== credentialId ||
          !holds(current.principal, "runs.read")
        )
          throw authForbidden();
        return current.principal;
      };
      const authority = () => {
        const current = principal();
        return JSON.stringify({ permissions: [...current.permissions].sort(), scope: current.scope });
      };
      const original = authority();
      const visibility = new Map<string, boolean>();
      for (const runId of new Set([...inputs.map((input) => input.runId), ...revisionRunIds]))
        visibility.set(runId, await authorizer.runs.allows(principal(), runId));
      const recheck = async () => {
        if (authority() !== original) throw authForbidden();
        for (const [runId, allowed] of visibility)
          if ((await authorizer.runs.allows(principal(), runId)) !== allowed) throw authForbidden();
        if (authority() !== original) throw authForbidden();
      };
      const projected = [];
      for (const input of inputs) {
        // Filter before any private pin lookup. An authorization change during this or a
        // later boundary/discovery read refuses the complete result, including metadata.
        if (!visibility.get(input.runId)) continue;
        if (authority() !== original || !(await authorizer.runs.allows(principal(), input.runId)))
          throw authForbidden();
        const actionId = await reads.inputRevisionActionId(input);
        projected.push({ ...input, ...(actionId === undefined ? {} : { revisionActionId: actionId }) });
      }
      await recheck();
      return { inputs: projected, recheck };
    };
  }

  if (opts.admissionExecutionSource && auth.mode === "token") {
    const source = opts.admissionExecutionSource;
    ctx.admissionExecution = async (invocation, runId) => {
      const bound = principalOf(invocation);
      const credentialId = bound?.principal.credentialId;
      if (!credentialId) throw authRequired();
      const check = async () => {
        const current = auth.credentials.current(credentialId);
        if (!current.ok) throw authInvalid();
        if (current.principal.id !== bound.principal.id || !holds(current.principal, "runs.read"))
          throw authForbidden();
        if (!(await authorizer.runs.allows(current.principal, runId))) throw authForbidden();
      };
      await check();
      const projection = await source(runId);
      await check();
      return projection === undefined ? undefined : AdmissionExecutionViewSchema.parse(projection);
    };
  }
  if (opts.revisionSources && identity && ctx.control && auth.mode === "token") {
    const sources = opts.revisionSources;
    const accessFor = (invocation: MethodContext) => {
      const bound = principalOf(invocation);
      const credentialId = bound?.principal.credentialId;
      if (!credentialId) throw authRequired();
      const principalId = bound.principal.id;
      const currentPrincipal = async () => {
        const current = auth.credentials.current(credentialId);
        if (!current.ok) throw authInvalid();
        if (current.principal.id !== principalId || current.principal.credentialId !== credentialId)
          throw authForbidden();
        return current.principal;
      };
      return {
        currentPrincipal,
        access: revisionAccess({ workspaceId: identity.workspaceId, principalId, currentPrincipal, authorizer }),
      };
    };
    ctx.revisionInputs = async (invocation) => {
      const { access } = accessFor(invocation);
      return { service: sources.services.forAccess(access), access };
    };
    ctx.revisionBoundaries = async (invocation, runId) => {
      const { currentPrincipal } = accessFor(invocation);
      const visible = async () => {
        const current = await currentPrincipal();
        return (
          holds(current, "runs.read") &&
          holds(current, "inputs.answer") &&
          holds(current, "runs.control") &&
          (await authorizer.runs.allows(current, runId))
        );
      };
      // inputs.list still filters inaccessible rows normally. Optional enrichment must not
      // turn an unowned row into an exception (or read its protected boundary first).
      if (!(await visible())) return [];
      let boundaries;
      try {
        boundaries = await sources.readBoundaries(runId);
      } catch (error) {
        // An active interpreter can own the fence. Absence of this optional projection
        // makes no claim about revision acceptance; unexpected store/auth failures surface.
        if (isOrcaError(error) && error.code === "RUN_LEASED") return [];
        throw error;
      }
      return (await visible()) ? boundaries : [];
    };
    ctx.pendingRevisionDiscovery = async (invocation, runIds) => {
      const { currentPrincipal, access } = accessFor(invocation);
      const visible = async (runId?: string) => {
        const current = await currentPrincipal();
        if (!holds(current, "runs.read")) throw authForbidden();
        return runId === undefined || (await authorizer.runs.allows(current, runId));
      };
      await visible();
      if (!runIds.length) return { items: [], incomplete: true, reason: "run-scope-required" };
      // Reading summaries cannot materialize text, even for a caller that may separately
      // fetch it. Retry/service authority remains pinned to the original invocation.
      const service = sources.services.forAccess({
        ...access,
        read: async (runId) => {
          await access.read(runId);
          return { content: false, mutate: false };
        },
      });
      const items: PendingRevisionSummary[] = [];
      const omissions = new Map<string, "limit" | "boundary-unavailable">();
      const omitted = (runId: string, reason: "limit" | "boundary-unavailable") => {
        if (reason === "limit" || !omissions.has(runId)) omissions.set(runId, reason);
      };
      let inspected = 0;
      for (const runId of runIds) {
        // An inaccessible run contributes neither candidates, counts nor omission reasons.
        if (!(await visible(runId))) continue;
        let boundaries;
        try {
          boundaries = await sources.readBoundaries(runId);
        } catch (error) {
          if (isOrcaError(error) && error.code === "RUN_LEASED") {
            if (await visible(runId)) omitted(runId, "boundary-unavailable");
            continue;
          }
          throw error;
        }
        if (!(await visible(runId))) continue;
        const candidates = new Map<string, PendingRevisionTarget[]>();
        for (const boundary of boundaries) {
          if (boundary?.currentRevisionId === undefined) continue;
          const target = PendingRevisionTargetSchema.safeParse({
            runId: boundary.target?.runId,
            revisionId: boundary.currentRevisionId,
            destinationId: boundary.target?.destinationId,
            attemptId: boundary.attemptId,
          });
          if (!target.success || target.data.runId !== runId) {
            omitted(runId, "boundary-unavailable");
            continue;
          }
          const matching = candidates.get(target.data.destinationId) ?? [];
          if (!matching.length && candidates.size >= INPUTS_REVISION_ITEM_LIMIT + 1) {
            omitted(runId, "limit");
            continue;
          }
          if (matching.length < 2) matching.push(target.data);
          candidates.set(target.data.destinationId, matching);
        }
        for (const matching of candidates.values()) {
          if (matching.length !== 1) {
            omitted(runId, "boundary-unavailable");
            continue;
          }
          if (inspected >= INPUTS_REVISION_ITEM_LIMIT) {
            omitted(runId, "limit");
            break;
          }
          const target = matching[0]!;
          if (!(await visible(runId))) break;
          inspected++;
          let pending;
          try {
            pending = await service.readPending(target);
          } catch (error) {
            // Losing the fence or a concurrently superseded destination is incomplete
            // discovery, never an invented empty/accepted history. Journal/auth faults
            // are deliberately not folded into successful omission.
            if (isOrcaError(error) && ["RUN_LEASED", "REVISION_STALE"].includes(error.code)) {
              if (await visible(runId)) omitted(runId, "boundary-unavailable");
              continue;
            }
            if (isOrcaError(error) && error.code === "RUN_NOT_FOUND" && !(await visible(runId))) break;
            throw error;
          }
          if (!(await visible(runId))) break;
          if (pending.state === "superseded") {
            omitted(runId, "boundary-unavailable");
            continue;
          }
          const summary = PendingRevisionSummarySchema.safeParse({
            target: pending.target,
            expectedRevision: pending.expectedRevision,
            state: pending.state,
            ...(pending.unavailableReason ? { unavailableReason: pending.unavailableReason } : {}),
          });
          if (summary.success) items.push(summary.data);
          else omitted(runId, "boundary-unavailable");
        }
      }
      const authorized: PendingRevisionSummary[] = [];
      for (const item of items) if (await visible(item.target.runId)) authorized.push(item);
      let reason: "limit" | "boundary-unavailable" | undefined;
      for (const [runId, omission] of omissions)
        if ((await visible(runId)) && (reason === undefined || omission === "limit")) reason = omission;
      await visible();
      return PendingRevisionsDiscoverySchema.parse(
        reason ? { items: authorized, incomplete: true, reason } : { items: authorized, incomplete: false },
      );
    };
  }
  if (ctx.requestSubmissions && ctx.submissionWorkspaceId && auth.mode === "token") {
    const workspaceId = ctx.submissionWorkspaceId;
    ctx.requestSubmissionAuthority = async (invocation) => {
      const bound = principalOf(invocation);
      const actor = invocation.mutationActor;
      if (!bound || !actor || !bound.principal.credentialId) throw authRequired();
      const credentialId = bound.principal.credentialId;
      return submissionAuthority({
        workspaceId,
        actor,
        authorizer,
        principal: async () => {
          const current = auth.credentials.current(credentialId);
          if (!current.ok) throw authInvalid();
          return current.principal;
        },
      });
    };
  }
  if (ctx.admissionRetries && ctx.submissionWorkspaceId && auth.mode === "token") {
    const workspaceId = ctx.submissionWorkspaceId;
    ctx.admissionAuthorities = async (invocation) => {
      const bound = principalOf(invocation);
      // Read calls have no mutationActor, so bind a verified actor from the authenticated context.
      if (!bound?.principal.credentialId) throw authRequired();
      const credentialId = bound.principal.credentialId;
      const actor = { principalId: bound.principal.id, credentialId };
      const principal = async () => {
        const current = auth.credentials.current(credentialId);
        if (!current.ok) throw authInvalid();
        return current.principal;
      };
      return {
        principalId: actor.principalId,
        workspaceId,
        executionAuthority: invocation.executionResumeAuthority,
        check: async () => {
          if (!holds(await principal(), "runs.start")) throw authForbidden();
        },
        request: async () => submissionAuthority({ workspaceId, actor, authorizer, principal }),
        direct: async () => directAdmissionAuthority({ workspaceId, actor, authorizer, principal }),
      };
    };
  }
  if (ctx.continuationAdmissions && ctx.submissionWorkspaceId && auth.mode === "token") {
    const workspaceId = ctx.submissionWorkspaceId;
    ctx.continuationAccess = async (invocation) => {
      const bound = principalOf(invocation);
      const credentialId = bound?.principal.credentialId;
      if (!credentialId) throw authRequired();
      return {
        workspaceId,
        authorizer,
        executionAuthority: invocation.executionResumeAuthority,
        current: async () => {
          const current = auth.credentials.current(credentialId);
          if (!current.ok) throw authInvalid();
          return current.principal;
        },
      };
    };
  }
  if (opts.secretsSource) {
    const model = new SecretsReadModel(opts.secretsSource);
    // The principal as it is now: a credential is re-read at each call, so a revoked or
    // narrowed grant stops showing what it no longer covers.
    const current = (invocation: MethodContext): Principal => {
      const bound = principalOf(invocation);
      if (!bound) throw authRequired();
      if (auth.mode !== "token") return bound.principal;
      const credentialId = bound.principal.credentialId;
      if (!credentialId) throw authRequired();
      const latest = auth.credentials.current(credentialId);
      if (!latest.ok) throw authInvalid();
      if (latest.principal.id !== bound.principal.id || !holds(latest.principal, "secrets.read")) throw authForbidden();
      return latest.principal;
    };
    ctx.secretsRead = {
      list: async (invocation) => model.list(current(invocation)),
      check: (params, invocation) => model.check(current(invocation), params.id),
    };
  }
  if (opts.judgeStatusSource) {
    const source = opts.judgeStatusSource;
    ctx.judgeStatus = async (invocation) => {
      const bound = principalOf(invocation);
      if (!bound) throw authRequired();
      let principals: readonly Principal[] | undefined;
      let principal: string | undefined;
      if (auth.mode === "token") {
        // The caller as it is now: a revoked or narrowed credential stops answering.
        const credentialId = bound.principal.credentialId;
        if (!credentialId) throw authRequired();
        const latest = auth.credentials.current(credentialId);
        if (!latest.ok) throw authInvalid();
        if (latest.principal.id !== bound.principal.id || !holds(latest.principal, "config.read"))
          throw authForbidden();
        principal = latest.principal.id;
        principals = auth.credentials.currentForPrincipal(principal);
      }
      const config = source.config();
      return judgeStatus({
        config,
        key: await judgeKeyStatus(config),
        auth: principal && principals ? { mode: "token", principal, principals } : { mode: "loopback" },
        budget: await source.budget(),
      });
    };
  }
  if (opts.hostResourceSource && identity && auth.mode === "token") {
    const resources = new HostResourceReadModel(identity, opts.hostResourceSource);
    ctx.hostResourceRead = (params, invocation) => {
      const binding = principalOf(invocation);
      const credentialId = binding?.principal.credentialId;
      if (!credentialId) throw authRequired();
      return resources.read(params, {
        current: () => {
          const latest = auth.credentials.current(credentialId);
          if (!latest.ok) throw authInvalid();
          if (latest.principal.id !== binding.principal.id || latest.principal.credentialId !== credentialId)
            throw authForbidden();
          return latest.principal;
        },
        allowsRun: (principal, runId) => authorizer.runs.allows(principal, runId),
      });
    };
    // A host-only mount still needs authenticated discovery; no unrelated run sources are implied.
    if (!opts.operatorSources)
      ctx.operatorReads = {
        methods: ["operator.discover"],
        model: async (invocation) =>
          new OperatorReadModel({
            target: identity,
            protocol: PROTOCOL_VERSION,
            orcaVersion: ctx.orcaVersion,
            current: async () => {
              const binding = principalOf(invocation);
              if (!binding?.principal.credentialId) throw authRequired();
              const latest = auth.credentials.current(binding.principal.credentialId);
              if (!latest.ok) throw authInvalid();
              if (latest.principal.id !== binding.principal.id) throw authForbidden();
              return latest.principal;
            },
            allowsRun: (principal, runId) => authorizer.runs.allows(principal, runId),
            collections: {},
            operations: (principal) => authorizer.permittedMethods(principal, Object.keys(methods)),
          }),
      };
  }
  if (opts.operatorSources && identity && auth.mode === "token") {
    const sources = opts.operatorSources;
    const cursorKey = randomBytes(32);
    const names = [
      "operator.discover",
      "operator.page",
      ...(sources.generations ? ["operator.preflight"] : []),
      ...(sources.configStatus ? ["operator.config"] : []),
      ...(sources.artifact && sources.artifactRun ? ["operator.artifact"] : []),
    ];
    ctx.operatorMutations = {
      async current(invocation, method) {
        const binding = principalOf(invocation);
        const credentialId = binding?.principal.credentialId;
        if (!credentialId) throw authRequired();
        const latest = auth.credentials.current(credentialId);
        if (!latest.ok) throw authInvalid();
        if (
          latest.principal.id !== binding.principal.id ||
          latest.principal.credentialId !== credentialId ||
          JSON.stringify(latest.principal.scope) !== JSON.stringify(binding.principal.scope) ||
          JSON.stringify([...latest.principal.permissions].sort()) !==
            JSON.stringify([...binding.principal.permissions].sort())
        )
          throw authForbidden();
        authorizer.checkOperation(latest.principal, method, true, binding.meta);
        return bindPrincipal({ ...invocation }, latest.principal, binding.meta);
      },
      async invokeLegacy(name, params, invocation, expected) {
        const binding = principalOf(invocation);
        const credentialId = binding?.principal.credentialId;
        if (!credentialId) throw authRequired();
        const latest = auth.credentials.current(credentialId);
        if (!latest.ok) throw authInvalid();
        if (latest.principal.id !== binding.principal.id) throw authForbidden();
        authorizer.checkOperation(latest.principal, name, Boolean(methods[name]), binding.meta);
        const method = methods[name];
        if (!method) throw new OrcaError("NOT_SUPPORTED", "Operator action is unavailable");
        return method.handle(
          method.params.parse(params),
          bindPrincipal(
            { ...invocation, ...(expected ? { operatorDecisionTarget: expected } : {}) },
            latest.principal,
            binding.meta,
          ),
        );
      },
    };
    ctx.operatorReads = {
      methods: names,
      async model(invocation) {
        const binding = principalOf(invocation);
        const credentialId = binding?.principal.credentialId;
        if (!credentialId) throw authRequired();
        const current = async () => {
          const check = auth.credentials.current(credentialId);
          if (!check.ok) throw authInvalid();
          return check.principal;
        };
        const checkBoundaryRun = async (params: OperatorPageParams, row?: OperatorRow) => {
          const principal = await current();
          if (
            principal.id !== binding.principal.id ||
            principal.credentialId !== credentialId ||
            !holds(principal, "runs.read") ||
            !params.runId ||
            (row && row.runId !== params.runId) ||
            !(await authorizer.runs.allows(principal, params.runId))
          )
            throw authForbidden();
          return principal;
        };
        const sameBoundaryAuthority = async (
          params: OperatorPageParams,
          before: Awaited<ReturnType<typeof current>>,
        ) => {
          const latest = await checkBoundaryRun(params);
          if (
            JSON.stringify([...latest.permissions].sort()) !== JSON.stringify([...before.permissions].sort()) ||
            JSON.stringify(latest.scope) !== JSON.stringify(before.scope)
          )
            throw authForbidden();
        };
        const declaration = async (params: OperatorPageParams, row: OperatorRow) => {
          const principal = await checkBoundaryRun(params, row);
          if (params.collection !== "inputs" || row.kind !== "decision" || row.live) return undefined;
          if (!row.nodeId || !row.stepRunId || !row.requestId || row.requestId !== row.id || !row.options || !ctx.reads)
            throw new OrcaError("RUN_STATE", "The pinned input declaration is unavailable");
          const action = await ctx.reads.inputRevisionActionId({
            id: row.id,
            kind: "decision",
            runId: params.runId!,
            stepRunId: row.stepRunId,
            nodeId: row.nodeId,
            options: row.options,
          });
          await sameBoundaryAuthority(params, principal);
          return action;
        };
        type Boundaries = Awaited<ReturnType<NonNullable<DaemonOptions["revisionSources"]>["readBoundaries"]>>;
        let captured: { runId: string; collection: string; boundaries: Boundaries; continuation?: string } | undefined;
        const boundaryRevision = async (params: OperatorPageParams) => {
          const principal = await checkBoundaryRun(params);
          const snapshot = await eventSnapshot(sources.events, params);
          const boundaries =
            params.collection === "inputs" &&
            holds(principal, "inputs.answer") &&
            holds(principal, "runs.control") &&
            opts.revisionSources
              ? await opts.revisionSources.readBoundaries(params.runId!)
              : [];
          const continuation =
            params.collection === "runs" && ctx.continuationAdmissions && ctx.continuationAccess
              ? await ctx.continuationAdmissions.expectedBoundary(
                  params.runId!,
                  await ctx.continuationAccess(invocation),
                )
              : undefined;
          await sameBoundaryAuthority(params, principal);
          if ((await snapshot.currentRevision()) !== snapshot.revision)
            throw new OrcaError("RUN_STATE", "Operator boundary changed during observation");
          captured = {
            runId: params.runId!,
            collection: params.collection,
            boundaries,
            ...(continuation ? { continuation } : {}),
          };
          return createHmac("sha256", cursorKey)
            .update(
              JSON.stringify([
                identity,
                params.runId,
                params.collection,
                snapshot.revision,
                boundaries,
                continuation ?? null,
              ]),
            )
            .digest("base64url");
        };
        return new OperatorReadModel({
          ...sources,
          cursorKey,
          target: identity,
          protocol: PROTOCOL_VERSION,
          orcaVersion: opts.orcaVersion,
          current,
          allowsRun: (principal, runId) => authorizer.runs.allows(principal, runId),
          declaredRevisionActionId: declaration,
          boundaryRevision,
          boundaryRow: async (params: OperatorPageParams, row: OperatorRow): Promise<OperatorBoundaryRow> => {
            const principal = await checkBoundaryRun(params, row);
            if (!captured || captured.runId !== params.runId || captured.collection !== params.collection)
              throw new OrcaError("RUN_STATE", "Operator boundary observation is unavailable");
            const after: OperatorBoundaryRow = { ...row };
            const declaredRevisionActionId = await declaration(params, row);
            if (params.collection === "runs" && row.kind === "run") {
              if (!ctx.continuationAdmissions || !ctx.continuationAccess) after.continuationState = "unsupported";
              else if (captured.continuation) {
                after.continuationState = "available";
                after.expectedBoundary = captured.continuation;
              } else after.continuationState = "unavailable";
            } else if (params.collection === "inputs" && row.kind === "decision" && !row.live) {
              if (declaredRevisionActionId !== undefined) after.revisionActionId = declaredRevisionActionId;
              if (holds(principal, "inputs.answer") && holds(principal, "runs.control")) {
                if (!declaredRevisionActionId || !opts.revisionSources) after.revisionState = "unsupported";
                else {
                  const matching = captured.boundaries.filter(
                    (b) =>
                      b.target.runId === row.runId &&
                      b.target.stepRunId === row.stepRunId &&
                      b.target.requestId === row.id &&
                      b.status === "waiting",
                  );
                  const boundary = matching.length === 1 ? matching[0] : undefined;
                  if (boundary) {
                    after.revision = RevisionBoundaryViewSchema.parse({
                      target: boundary.target,
                      capability: boundary.capability,
                      destinationDescription: boundary.destinationDescription,
                    });
                    after.revisionState = "available";
                  } else after.revisionState = "unavailable";
                }
              }
            }
            await sameBoundaryAuthority(params, principal);
            return OperatorBoundaryProjectionSchema.parse({
              params,
              before: row,
              after,
              ...(declaredRevisionActionId !== undefined ? { declaredRevisionActionId } : {}),
            }).after;
          },
          collections: {
            ...operatorEventCollections({
              events: sources.events,
              ...(sources.leases ? { leases: sources.leases } : {}),
              ...(sources.liveState && sources.liveRevision
                ? {
                    liveState: sources.liveState,
                    liveRevision: () =>
                      createHmac("sha256", cursorKey).update(sources.liveRevision!()).digest("base64url"),
                  }
                : {}),
              allowsRun: (principal, runId) => authorizer.runs.allows(principal, runId),
            }),
            ...(sources.generations ? operatorGenerationCollections(sources.generations) : {}),
            ...(sources.documents ? operatorLinkedDocumentCollections(sources.documents) : {}),
            ...(sources.definitionFor
              ? {
                  graph: operatorPinnedGraph({
                    events: sources.events,
                    definitionFor: sources.definitionFor,
                    ...(sources.generations
                      ? { active: operatorGenerationCollections(sources.generations).graph! }
                      : {}),
                  }),
                }
              : {}),
          },
          // Discover actual installed RPCs, not only this bounded read projection.
          // MCP mutation aliases remain absent until their real adapters are installed.
          operations: (principal) => authorizer.permittedMethods(principal, Object.keys(methods)),
        });
      },
    };
  }
  const gate = new TransportGate(auth, host, authorizer);
  // The guard is outermost: a caller is authorized before maintenance admission is consulted,
  // so an unauthorized caller cannot even learn that an update is in progress.
  const guarded = authorizer.guard(opts.methods ? ctx.maintenance!.wrap(opts.methods) : methodsFor(ctx));
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const methods: MethodTable = Object.fromEntries(
    Object.entries(guarded).map(([name, method]) => [
      name,
      {
        params: method.params,
        handle: (params: unknown, invocation: MethodContext) => {
          if (closing) throw new OrcaError("RUN_STATE", "The daemon is closing");
          // Register before entering any asynchronous authority or application work.
          // A caller disconnect does not cancel an admitted durable operation.
          const operation = Promise.resolve().then(() => method.handle(params, invocation));
          pending.add(operation);
          void operation.then(
            () => pending.delete(operation),
            () => pending.delete(operation),
          );
          return operation;
        },
      },
    ]),
  );
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });
      if (req.method === "POST" && path === "/rpc") {
        const admission = gate.admit(req, "http");
        if (!admission.ok) {
          // Refused on its headers: the body is never read, so it is never parsed or buffered.
          const refusal = refusalOf(admission);
          req.resume();
          return sendJson(res, refusal.status, refusal.body, { ...refusal.headers, connection: "close" });
        }
        let body: string;
        try {
          body = await readBody(req);
        } catch (e) {
          return sendJson(res, 413, { kind: "response", id: 0, ok: false, error: describeError(e) });
        }
        // Body receipt can outlive a credential or its grants. Keep the early rejection,
        // then authenticate again at dispatch and bind only the current authority.
        const current = gate.admit(req, "http");
        if (!current.ok) {
          const refusal = refusalOf(current);
          return sendJson(res, refusal.status, refusal.body, refusal.headers);
        }
        const { principal, meta } = current;
        return sendJson(
          res,
          200,
          await dispatch(body, methods, bindPrincipal(ctx, principal, meta), (method, exists) =>
            authorizer.checkOperation(principal, method, exists, meta),
          ),
        );
      }
      sendJson(res, 404, { kind: "response", id: 0, ok: false, error: protocolError("PROTOCOL_METHOD", "not found") });
    })();
  });
  const detachSocket = ctx.source
    ? attachSocket(server, {
        methods,
        ctx,
        source: ctx.source,
        gate,
        authorizer,
        ...(opts.batchMs === undefined ? {} : { batchMs: opts.batchMs }),
      })
    : undefined;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host}:${port}`;
  const continuationModel = ctx.continuationAdmissions;
  const recoverContinuations =
    continuationModel && ctx.submissionWorkspaceId && auth.mode === "token"
      ? async () => {
          // Existing continuations may drain; the full idle fence still refuses timer entry.
          if (maintenance.existingWorkClosed()) return;
          await continuationModel.recoverBatch(async (entry) => {
            const credentialId = entry.actor?.credentialId;
            if (!credentialId || entry.workspaceId !== ctx.submissionWorkspaceId) return undefined;
            const checked = auth.credentials.current(credentialId);
            if (!checked.ok || checked.principal.id !== entry.principalId) return undefined;
            const principal = checked.principal;
            if (!holds(principal, "runs.control") || (entry.command.decision && !holds(principal, "inputs.answer")))
              return undefined;
            if (!(await authorizer.runs.allows(principal, entry.receipt.runId))) return undefined;
            return {
              workspaceId: entry.workspaceId,
              authorizer,
              executionAuthority: authorizer.executionResumeAuthority(principal),
              current: async () => {
                const current = auth.credentials.current(credentialId);
                if (!current.ok || current.principal.id !== entry.principalId) throw authInvalid();
                return current.principal;
              },
            };
          });
        }
      : undefined;
  return {
    host,
    port,
    url,
    ...(recoverContinuations ? { recoverContinuations } : {}),
    ...(detachSocket ? { socketUrl: socketUrlFor(url) } : {}),
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        // Automatic admission attachment verifies durable receipts outside the
        // RPC handler. Fence it now and retain its reads through settlement.
        const admissionsStopped = opts.admissionRetries?.close();
        // Stop accepting HTTP immediately; upgraded connections need separate closure.
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((e) => (e ? reject(e) : resolve()));
          server.closeAllConnections();
        });
        await Promise.all([stopped, detachSocket?.()]);
        // Handler rejection still settles its work. Dispatch retains the original error.
        await Promise.allSettled(pending);
        await admissionsStopped;
      });
      return closing;
    },
  };
}
