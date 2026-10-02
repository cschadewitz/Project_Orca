/** Authenticated HTTP and WebSocket daemon composition. */
import { randomBytes } from "node:crypto";
import {
  PROTOCOL_VERSION,
  AdmissionExecutionViewSchema,
  type AdmissionExecutionView,
  INPUTS_REVISION_ITEM_LIMIT,
  PendingRevisionTargetSchema,
  PendingRevisionSummarySchema,
  PendingRevisionsDiscoverySchema,
  type PendingRevisionSummary,
  type PendingRevisionTarget,
} from "@orca/protocol";
import {
  OperatorReadModel,
  operatorEventCollections,
  operatorGenerationCollections,
  operatorLinkedDocumentCollections,
  operatorPinnedGraph,
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
import { isOrcaError, OrcaError } from "@orca/core";
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
import { Maintenance } from "./maintenance.js";
import { attachSocket } from "./socket.js";
import { Authorizer, bindPrincipal, principalOf } from "./auth/guard.js";
import { directAdmissionAuthority } from "./admission-retry.js";
import { holds } from "./auth/principal.js";
import { authForbidden } from "./auth/errors.js";
import { submissionAuthority } from "./request-submission.js";
import { revisionAccess } from "./revision-input.js";
import { authInvalid, authRequired } from "./auth/errors.js";
import { OwnershipStore } from "./auth/ownership.js";
import type { ResourceResolver } from "./auth/resources.js";
import { TransportGate, validateDeployment, type Admission, type DaemonAuthOptions } from "./auth/transport.js";

export interface DaemonOptions extends MethodContext {
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
  res.end(JSON.stringify(body));
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
  const ctx: MethodContext = {
    ...(identity ? { identity } : {}),
    processId: process.pid,
    maintenance: new Maintenance(opts.maintenanceToken, opts.admissionFile),
    orcaVersion: opts.orcaVersion,
    storeDir: opts.storeDir,
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
  // A daemon without a store serves `hello` alone, and says so in `hello.methods`: a read
  // method it cannot answer is an unknown method, not a method that fails.
  const authorizer = new Authorizer(
    auth.mode === "token"
      ? {
          currentPrincipal: (principal) => {
            if (!principal.credentialId) throw authRequired();
            const current = auth.credentials.current(principal.credentialId);
            if (!current.ok) throw authRequired();
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
        return new OperatorReadModel({
          ...sources,
          cursorKey,
          target: identity,
          protocol: PROTOCOL_VERSION,
          orcaVersion: opts.orcaVersion,
          current,
          allowsRun: (principal, runId) => authorizer.runs.allows(principal, runId),
          collections: {
            ...operatorEventCollections({
              events: sources.events,
              ...(sources.leases ? { leases: sources.leases } : {}),
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
  const methods = authorizer.guard(opts.methods ? ctx.maintenance!.wrap(opts.methods) : methodsFor(ctx));
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
    close: async () => {
      // Sockets first: an open upgraded connection is not an HTTP connection, so
      // `closeAllConnections` does not reach it and `server.close` would wait on it forever.
      await detachSocket?.();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
