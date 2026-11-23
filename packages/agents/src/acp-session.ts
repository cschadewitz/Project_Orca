/**
 * ACP client implementation of AgentSession.
 *
 * Lifecycle: spawn process on host -> initialize -> session/new -> N prompt
 * turns -> close. ORCA serves the agent's `fs/*` requests from the host file
 * system (scoped to the session cwd) and answers `session/request_permission`
 * through the agent's PermissionPolicy — configured rules, then whatever the
 * permission sidecars say at that moment, then the defaults (ADR 0009, #271).
 * ORCA's own files are refused to both, ahead of any rule (`protectedPaths`, C4-01).
 */
import { isAbsolute, relative } from "node:path";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import {
  describeError,
  literalEnv,
  newId,
  redactSecretValues,
  OrcaError,
  silentLogger,
  systemClock,
  type AgentSpec,
  type Clock,
  type Logger,
  type PermissionPolicy,
  type SecretsConfig,
  type SessionConfigOption,
} from "@orca/core";
import {
  checkSecretUse,
  ENV_SECRET_DELIVERY,
  fillMcpSecrets,
  planSessionSecrets,
  redactError,
  redactingLogger,
  type AgentSecretDelivery,
  type AuthorizeSecretUse,
} from "./secrets.js";
import {
  explainFsCall,
  fsToolCall,
  resolveOwnedFsTarget,
  stricterExplanation,
  type FsAccess,
} from "./owned-fs-gate.js";
import { judgedLane } from "./judged-lane.js";
import {
  bindOwnedFs,
  newFileMode,
  OwnedFsFailedWithoutEffect,
  OwnedFsNotDispatched,
  stillBound,
  type OwnedFsBinding,
} from "./owned-fs-io.js";
import type { JudgePermission } from "./review-judge/plain-rule.js";
import { processCleanup } from "./process-cleanup.js";
import * as acpUnstable from "@agentclientprotocol/sdk/unstable";
import { createMcpRelay, type McpRelay, type McpRelayCall, type McpRelayDispatch } from "./mcp-relay.js";
import { nativeToolHookUnavailable } from "./native-tool-hook-session.js";
import { normalizeConfigOption, normalizeSessionConfig } from "./config-options.js";
import { isHostFileMissing, type AgentHost, type AgentProcessHandle } from "./host.js";
import {
  decidePermission,
  loadEffectivePermissionPolicy,
  protectedPathFor,
  permissionRuleRecord,
  resolvePermission,
  type PermissionRuleRecord,
  type ProtectedPaths,
} from "./permissions.js";
import {
  summarizeUpdate,
  withStartupTermination,
  type AgentSession,
  type PromptOptions,
  type SessionUpdateEvent,
  type TurnResult,
} from "./session.js";

export interface OpenSessionOptions {
  /**
   * Where each `{ secret: <id> }` in the agent's env, or its MCP servers' env, is read (#336).
   * Every reference is resolved on `host` before the agent is spawned; a missing, unreadable
   * or other-host reference fails the open with nothing started.
   */
  secrets?: SecretsConfig | undefined;
  /**
   * The use check for this session's secret references (#336), asked at every open before
   * anything is read. Without one, a session whose agent uses a reference is refused.
   */
  authorizeSecretUse?: AuthorizeSecretUse | undefined;
  /**
   * How the secrets the agent's own `env` refers to reach it (#704). Default
   * `ENV_SECRET_DELIVERY`: in its process environment. The one place a key store or broker
   * would be put instead.
   */
  secretDelivery?: AgentSecretDelivery | undefined;
  /**
   * The use decision for this session's catalog MCP servers (#337), asked again immediately
   * before `session/new` (or `session/load`) hands the agent its servers, after the process
   * is up and initialized. A denial fails the open, and startup cleanup stops the process.
   */
  authorizeCapabilityDelivery?: (() => Promise<void>) | undefined;
  /**
   * Set when the session will carry skills as embedded `resource` blocks (#337): an agent that
   * does not say at `initialize` that it accepts embedded context is refused right there,
   * with the error this returns, before `session/new` or `session/load` configures anything.
   */
  requireEmbeddedContext?: (() => Error) | undefined;
  /**
   * The `_meta` for `session/new` and `session/load`, decided once the agent has said at
   * `initialize` who it is (#704). The CLI's session factory uses it to install ORCA's
   * pre-tool hook in an agent that takes one (`nativeToolHookSession`), and to check through
   * `ext` (one extension request to the agent, bounded by the handshake timeout) that an agent
   * which took it at spawn has it in force (#705); `agentPid` is the agent process's id, so it
   * can find the runtime the agent actually started. Undefined sends none. A throw fails the
   * open, and startup cleanup stops the process.
   */
  sessionMeta?:
    | ((
        agentInfo: { name: string; version: string } | undefined,
        ext: (method: string, params: Record<string, unknown>) => Promise<unknown>,
        /** The agent process's id, so the hook can tell its runtime's processes from others. */
        agentPid: number | undefined,
      ) => Promise<Record<string, unknown> | undefined>)
    | undefined;
  /**
   * Settles once the session may use ORCA's host services (#704). Until it fulfils, every
   * request the agent makes of ORCA (`fs/read_text_file`, `fs/write_text_file`, a permission
   * ask) waits; if it rejects, each is refused and nothing is read, written or asked. The
   * CLI's session factory sets it for a session with ORCA's pre-tool hook, and fulfils it only
   * once the runtime that session runs has been admitted. Undefined: no wait.
   */
  admission?: Promise<void> | undefined;
  /**
   * ORCA runs the agent's MCP servers itself and serves them over the ACP connection (#704):
   * the agent is told each server's name and nothing else, and a server is started, with its
   * secrets, only for a request made after `admission`. An agent that does not offer MCP over
   * ACP at `initialize` is refused when it has servers to be given. Off: the agent is handed
   * each server's command and environment in `session/new`, as before. A function decides
   * once the agent has said at `initialize` who it is.
   */
  relayMcpServers?: boolean | ((agentInfo: { name: string; version: string } | undefined) => boolean) | undefined;
  /** How long a relayed MCP server has to finish starting (`MCP_RELAY_START_TIMEOUT_MS`). */
  mcpStartTimeoutMs?: number | undefined;
  /** How long one relayed MCP request may take (`MCP_RELAY_REQUEST_TIMEOUT_MS`). */
  mcpRequestTimeoutMs?: number | undefined;
  /** Handed every resolved secret value, before anything else happens, so the caller can redact it. */
  onSecretValues?: (values: readonly string[]) => void;
  host: AgentHost;
  agent: AgentSpec;
  cwd: string;
  additionalDirectories?: string[];
  env?: Record<string, string>;
  logger?: Logger;
  clock?: Clock;
  /** Human/upstream escalation for `ask` permissions. */
  askPermission?: (req: acp.RequestPermissionRequest, invocation?: PermissionInvocation) => Promise<string | undefined>;
  /** Explicit opt-in only. Loading context never restores a pending tool callback. */
  resumeSessionId?: string;
  /**
   * Require an explicit session/load to succeed; never fall back to session/new.
   * This checks protocol load success, not the completeness or identity of native
   * persisted context. It neither restores a permission callback nor authorizes a prompt.
   * A refused, failed or timed-out load has a sanitized details.contextRecoveryReason;
   * startup cleanup closes the connection and attempts bounded owned-process termination.
   */
  requireContextRecovery?: boolean;
  onSessionContinuity?: (state: SessionContinuity) => void;
  /**
   * Permission sidecars to layer under the agent's configured rules (ADR 0009), in
   * precedence order: the workspace `orca.permissions.json` first, a user-scoped one after
   * it. Omitted — an in-memory or test wiring with no config directory — evaluates the
   * configured rules and the defaults alone, which is what this did before #271.
   */
  permissionFiles?: readonly string[];
  /**
   * ORCA's own files — config, sidecar, store, credentials — which this session refuses to
   * the agent whatever its policy says: a permission ask that touches one is denied, and so
   * is an `fs/*` request for one (C4-01). Bound with `permissionFiles` by the CLI's
   * `makeSessionFactory`; omitted, nothing is protected beyond the policy.
   */
  protectedPaths?: ProtectedPaths;
  /**
   * The judge for this agent's plain-language rules (#702, #701). Omitted, judged rules are
   * not consulted and the typed rules decide alone; nothing wires one yet, so the lane is off
   * until a setting turns it on. Only the agent's own permission asks reach it: ORCA's file
   * callbacks are decided by the typed rules.
   */
  judgePermission?: JudgePermission;
  /**
   * Each decision, with what decided it (#702): the basis and, when the rule's origin is
   * known, its layer, index and sidecar revision. `rule` is absent where no policy was read.
   */
  onPermission?: (info: { toolCallId?: string; title: string; decision: string; rule?: PermissionRuleRecord }) => void;
  /**
   * The durable record of ORCA's own file executor (#703): called with each `fs/*`
   * operation's authorization, and awaited before its I/O can start (a rejection refuses the
   * operation). It must resolve only once the record is durable, and refuse where it cannot
   * be. It returns the one function that records that operation's outcome, so the outcome
   * stays bound to the step, turn and operation it was authorized for. Omitted, nothing is
   * recorded.
   */
  recordFsOperation?: (record: FsAuthorizationRecord) => Promise<FsOutcomeRecorder>;
  handshakeTimeoutMs?: number;
  /**
   * How long closing the session waits, after each of SIGTERM and SIGKILL, for the agent
   * process to exit. Defaults to two seconds. A test whose real child ignores SIGTERM
   * shortens it instead of waiting the whole grace out.
   */
  exitGraceMs?: number;
  /**
   * How long a turn may keep running after `session/cancel` before the agent is
   * treated as wedged and its process killed. Overrides `agent.cancelGraceMs`.
   */
  cancelGraceMs?: number;
}

export interface PermissionInvocation {
  sessionId: string;
  turnId: string;
  invocationId: string;
  signal: AbortSignal;
}

export interface SessionContinuity {
  mode: "fresh" | "loaded";
  reason: "new" | "load-supported" | "load-unsupported" | "load-failed";
}

/** The outer `mcp/message` params, checked as far as dispatching to a server needs. */
function mcpMessageParams(params: unknown): acpUnstable.McpMessageParams {
  const p = params as Partial<acpUnstable.McpMessageParams> | null;
  if (
    p === null ||
    typeof p !== "object" ||
    typeof p.serverId !== "string" ||
    typeof p.requestId !== "string" ||
    typeof p.method !== "string"
  )
    throw acp.RequestError.invalidParams({ reason: "not an MCP message" });
  return p as acpUnstable.McpMessageParams;
}

export const ORCA_CLIENT_INFO = { name: "orca", version: "0.1.0" } as const;

/** Provider errors can contain private context; report only the failed recovery boundary. */
function contextRecoveryFailure(reason: "missing-session-id" | "load-unsupported" | "load-failed" | "load-timeout") {
  const failures = {
    "missing-session-id": ["CONFIG_INVALID", "Required agent context recovery needs a nonempty resumeSessionId."],
    "load-unsupported": [
      "NOT_SUPPORTED",
      "The agent does not advertise session loading required for context recovery.",
    ],
    "load-failed": ["AGENT_PROTOCOL", "Required agent context could not be loaded; no fresh session was opened."],
    "load-timeout": ["AGENT_TRANSPORT", "Required agent context loading timed out; no fresh session was opened."],
  } as const;
  const [code, message] = failures[reason];
  return new OrcaError(code, message, { contextRecoveryReason: reason });
}

/**
 * One authorization of ORCA's own file executor (#703). It names the file only by a bounded,
 * root-relative display reference: the path the agent asked for and the physical file it
 * resolved to stay in this process.
 */
export interface FsAuthorizationRecord {
  operationId: string;
  /** The live turn the operation belongs to. */
  turnId: string;
  access: FsAccess;
  /** The path as asked for, relative to the session root it is in, and bounded. */
  display: string;
  /** Whether it reached a different file once links were followed (local hosts). */
  linked?: true;
  /** How the I/O is carried out: bound to the checked file or directory, compatibility, or unbound (remote). */
  io: FsIoMode;
  /** `allow` by the policy, or `ask:allow_once` by a person's one-time answer. */
  decision: string;
  rule?: PermissionRuleRecord;
}

/**
 * How ORCA carries out an `fs/*` operation (#703): `bound` to the checked file or directory
 * (local), `compatibility` for a new file the strict path cannot bind (best effort, outside the
 * identity-bound guarantee, #1034), `unbound` on a remote host, whose paths are compared as
 * written (#1032).
 */
export type FsIoMode = "bound" | "compatibility" | "unbound";

/**
 * What happened to an authorized operation. `effect-unknown` is a write that failed once it
 * may have changed something: not `failed`, and not safe to retry as if it had not run.
 */
export type FsOperationOutcome = "completed" | "failed" | "not-dispatched" | "effect-unknown";

/** Records the outcome of the one operation it was returned for. */
export type FsOutcomeRecorder = (outcome: FsOperationOutcome) => Promise<void>;

/** Longest display reference recorded for a file operation; longer ones keep their end. */
const FS_DISPLAY_MAX = 200;

/** `path` relative to the session root it is in, bounded: what a run's record shows of it. */
function fsDisplay(path: string, roots: readonly string[]): string {
  let shown = path;
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      shown = rel === "" ? "." : rel;
      break;
    }
  }
  return shown.length <= FS_DISPLAY_MAX ? shown : `…${shown.slice(shown.length - (FS_DISPLAY_MAX - 1))}`;
}

/** What `authorizeFs` hands the executor: the dispatch check, and what allowed it. */
interface FsAuthorization {
  dispatch: () => void;
  /** The live turn it was authorized in. */
  turnId: string;
  decision: string;
  rule: PermissionRuleRecord;
  /** Whether `policy`, read again just before the I/O, still lets this operation through. */
  stillAllowed: (policy: PermissionPolicy) => boolean;
}

function withinRoots(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false;
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export async function openAcpSession(opts: OpenSessionOptions): Promise<AgentSession> {
  // An agent that asked for ORCA's tool hook is opened only by the session factory that
  // installs it (`sessionMeta`); any other caller (a probe, a tool) would run it unguarded.
  if (opts.sessionMeta === undefined) {
    const refused = nativeToolHookUnavailable(opts.agent);
    if (refused) throw refused;
  }
  if (opts.requireContextRecovery && !opts.resumeSessionId?.trim()) throw contextRecoveryFailure("missing-session-id");
  // Secret references (#336) are checked before anything starts; the host reads them as part
  // of starting the agent. From then on every error this session throws, the handshake's
  // and each later call's, has the values redacted, stderr tails included, so a caller can
  // return or write it as it is.
  const secretPlan = planSessionSecrets(opts.host, opts.agent, opts.secrets);
  await checkSecretUse(secretPlan, opts.host, opts.agent.id, opts.authorizeSecretUse);
  const values: string[] = [];
  const redacted = <T>(work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      throw redactError(error, values);
    });
  const session = await redacted(() => openPlanned(opts, secretPlan, values));
  for (const method of ["prompt", "setConfigOption", "cancel", "close"] as const) {
    const original = session[method].bind(session) as (...args: unknown[]) => Promise<unknown>;
    (session as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => redacted(() => original(...args));
  }
  return session;
}

async function openPlanned(
  opts: OpenSessionOptions,
  secretPlan: ReturnType<typeof planSessionSecrets>,
  values: string[],
): Promise<AgentSession> {
  const logger = redactingLogger(
    (opts.logger ?? silentLogger).child({ agent: opts.agent.id, host: opts.host.id }),
    () => values,
  );
  const clock = opts.clock ?? systemClock;
  const roots = [opts.cwd, ...(opts.additionalDirectories ?? [])];
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  let acpSessionId = "";
  let configOptions: SessionConfigOption[] = [];
  let embeddedContext: boolean;
  const id = newId("sess", clock.now());
  let activeTurn: ActiveTurn | undefined;
  /** Sidecar problems already reported — a file unreadable, a rule ignored — so each warns once per session, not per ask. */
  const warnedSidecars = new Set<string>();

  /**
   * The *evaluated* policy, not `opts.agent.permissions`, which is only what the config says:
   * configured rules, then each sidecar, then `DEFAULT_PERMISSION_POLICY`'s rules when they
   * apply (#140). Read fresh on every ask rather than once per session (#271), because
   * "allow always" is answered *while a session is open*: the daemon appends the rule to the
   * sidecar and the next tool call is the one that has to stop asking. A policy captured at
   * `session/new` would go on asking until the run ended, which is the bug #271 names.
   *
   * A sidecar that is missing contributes nothing. A sidecar that is there and corrupt is
   * logged once and skipped, not thrown: failing the ask would fail the tool call and take
   * the turn with it, and an agent blocked by a file it cannot see or fix is a worse answer
   * than one that falls back to its configured rules. Skipping alone would not be
   * conservative, though — the sidecar can hold `deny` and `ask` rules, and dropping them
   * would let a default `allow` through — so the loader turns every `allow` decided after
   * the unreadable file into `ask` (ADR 0009). A wildcard `allow` in a readable sidecar is
   * ignored and logged the same way, once.
   */
  const policyForAsk = () =>
    loadEffectivePermissionPolicy(
      opts.agent,
      opts.permissionFiles ?? [],
      (file, e) => {
        if (warnedSidecars.has(file)) return;
        warnedSidecars.add(file);
        logger.warn("permission sidecar unreadable; asking instead of allowing anything it could have refused", {
          file,
          error: e instanceof Error ? e.message : String(e),
        });
      },
      (file, rule) => {
        const key = `${file}\0${JSON.stringify(rule)}`;
        if (warnedSidecars.has(key)) return;
        warnedSidecars.add(key);
        logger.warn("permission sidecar rule ignored: a wildcard allow belongs in the config, not the sidecar", {
          file,
          rule,
        });
      },
    );
  /** The judged lane, when this session has a judge (#702): re-reads the policy after a verdict. */
  const judged = opts.judgePermission
    ? judgedLane({
        judge: opts.judgePermission,
        reload: policyForAsk,
        // Targets are checked on this machine's file system: only a local session's are its own.
        localHost: opts.host.spec.type === "local",
      })
    : undefined;

  /** Rules ORCA writes are workspace-relative; ORCA's own files go ahead of every rule (C4-01). */
  const evalScope = {
    workspaceCwd: opts.cwd,
    ...(opts.protectedPaths ? { protectedPaths: opts.protectedPaths } : {}),
  };

  /**
   * The `ask` a permission decision puts to a person through the host, bound to one live
   * turn. A host-side persistence or parking error fails the prompt unchanged; sending only
   * a JSON-RPC error would let the agent continue or retry it.
   */
  const askThrough = (turn: ActiveTurn, invocation: PermissionInvocation) =>
    opts.askPermission
      ? {
          ask: async (request: acp.RequestPermissionRequest) => {
            try {
              return await opts.askPermission!(request, invocation);
            } catch (error) {
              // An ask that was retired (its turn ended, or the request it was for) has nothing
              // left to fail: a callback that rejects late must not take the live turn with it.
              if (activeTurn !== turn || turn.abort.signal.aborted || invocation.signal.aborted) return undefined;
              const failure =
                error instanceof Error
                  ? error
                  : new OrcaError("INTERNAL", "permission callback failed", {}, { cause: error });
              turn.failure = failure;
              turn.fail(failure);
              requestCancel("permission callback failed");
              throw error;
            }
          },
        }
      : {};

  /**
   * Decide one `fs/*` request by the policy, immediately before its I/O (#703). It proceeds on
   * a rule's allow, or on a person's one-time allow for this exact operation that ORCA asks
   * for on the agent's behalf; anything else throws before the I/O. An answer from the
   * agent's own earlier ask is not reused: one answer covers one operation (#703 review).
   *
   * Every await is followed by a recheck: the turn must be the same live one, and after a
   * person answers, the policy is read again and a deny that appeared meanwhile wins. It
   * returns the dispatch check, which the handler runs in the same step that starts the I/O.
   * `resolved` is the file the path reaches on a local host, named under its session root
   * (`resolveOwnedFsTarget`): when it differs from the path as written, both are decided and
   * the stricter answer stands, so a link cannot carry a write past a rule on the file it
   * leads to. Each decision is logged like an ask's, prefixed `fs:`; that log is not a
   * durable authorization or execution record.
   */
  const authorizeFs = async (path: string, access: FsAccess, resolved?: string): Promise<FsAuthorization> => {
    const explain = (policy: PermissionPolicy) => {
      const written = explainFsCall(policy, path, access, evalScope);
      return resolved === undefined || resolved === path
        ? written
        : stricterExplanation(written, explainFsCall(policy, resolved, access, evalScope));
    };
    const turn = activeTurn;
    const record = (decision: string, rule?: PermissionRuleRecord) => {
      opts.onPermission?.({
        title: fsToolCall(path, access).title ?? path,
        decision: `fs:${decision}`,
        ...(rule ? { rule } : {}),
      });
      logger.debug("fs permission", { path, access, decision });
    };
    const refuse = (decision: string, reason: string, rule?: PermissionRuleRecord): never => {
      record(decision, rule);
      throw acp.RequestError.invalidParams({ path, reason });
    };
    // Outside a live prompt there is nobody to answer and no turn the operation belongs to.
    if (!turn || turn.abort.signal.aborted)
      return refuse("no-turn", "no live turn: ORCA answers file requests only in one");
    const live = () => activeTurn === turn && !turn.abort.signal.aborted;
    /**
     * Returned to the handler, which calls it in the same synchronous step that starts the
     * host I/O: returning from here is not the dispatch boundary (#703 review).
     */
    const dispatch = () => {
      if (live()) return;
      record("dispatch:turn-ended");
      throw acp.RequestError.invalidParams({ path, reason: "the turn ended before the file I/O started" });
    };
    const policy = await policyForAsk();
    if (!live()) return refuse("turn-ended", "the turn ended before the file request was decided");
    const explained = explain(policy);
    const decision = explained.decision;
    const rule = permissionRuleRecord(explained);
    if (decision === "allow") {
      record("allow", rule);
      // A rule's allow holds only while the policy still allows it.
      return {
        dispatch,
        turnId: turn.id,
        decision: "allow",
        rule,
        stillAllowed: (now) => explain(now).decision === "allow",
      };
    }
    if (decision !== "ask") return refuse(decision, `not allowed: ${decision}`, rule);
    const invocation: PermissionInvocation = {
      sessionId: id,
      turnId: turn.id,
      invocationId: randomUUID(),
      signal: turn.abort.signal,
    };
    const asked = await resolvePermission(policy, {
      request: {
        sessionId: acpSessionId,
        toolCall: fsToolCall(resolved ?? path, access, `orca-fs-${randomUUID()}`),
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
      signal: invocation.signal,
      ...askThrough(turn, invocation),
      scope: evalScope,
    });
    // Only a person's one-time allow for this very operation.
    if (asked.decision !== "ask:allow_once") return refuse(asked.decision, `not allowed: ${asked.decision}`, rule);
    // The wait may have been long: read the policy again, and the turn must still be live.
    const after = explain(await policyForAsk());
    if (after.decision === "deny")
      return refuse(
        "ask:allow_once:denied-since",
        "not allowed: the policy denies it now",
        permissionRuleRecord(after),
      );
    if (!live()) return refuse("ask:allow_once:turn-ended", "the turn ended while the file request was asked", rule);
    record("ask:allow_once", rule);
    // A person's one-time answer holds unless the policy now denies it.
    return {
      dispatch,
      turnId: turn.id,
      decision: "ask:allow_once",
      rule,
      stillAllowed: (now) => explain(now).decision !== "deny",
    };
  };

  /**
   * Run one authorized `fs/*` operation (#703). When the session is given
   * `recordFsOperation`, the authorization is recorded and that record awaited before the
   * I/O can start, and a record that cannot be written refuses the operation: nothing is done
   * that was not first recorded. The dispatch checks (the turn is the same live one, the path
   * still resolves to the same file) then run in the step that starts the I/O, and the
   * outcome is recorded after it: `completed`, `failed`, or `not-dispatched` when a dispatch
   * check refused. A crash between the two records leaves an authorization with no outcome,
   * which reads as execution-unknown (`ownedFsExecutions` in `@orca/core`): ORCA never
   * repeats the operation itself, and the agent decides what to do next.
   */
  const executeOwnedFs = async <T>(
    path: string,
    access: FsAccess,
    target: { io: string; mode: FsIoMode; unchanged: () => void },
    authorized: FsAuthorization,
    io: (file: string) => Promise<T>,
  ): Promise<T> => {
    let recordOutcome: FsOutcomeRecorder | undefined;
    if (opts.recordFsOperation) {
      try {
        recordOutcome = await opts.recordFsOperation({
          operationId: randomUUID(),
          turnId: authorized.turnId,
          access,
          display: fsDisplay(path, roots),
          ...(target.io !== path ? { linked: true as const } : {}),
          io: target.mode,
          decision: authorized.decision,
          ...(authorized.rule ? { rule: authorized.rule } : {}),
        });
      } catch (error) {
        logger.warn("fs authorization could not be recorded; refusing the operation", {
          path,
          access,
          error: describeError(error),
        });
        throw acp.RequestError.invalidParams({
          path,
          reason: "the authorization could not be recorded, so the file I/O did not start",
        });
      }
    }
    const outcome = async (result: FsOperationOutcome) => {
      if (!recordOutcome) return;
      await recordOutcome(result).catch((error: unknown) =>
        logger.warn("fs outcome could not be recorded", { path, access, error: describeError(error) }),
      );
    };
    // Recording took time: authority is checked again, from the policy as it is now, and the
    // target must still be the very file authorized. Both in the step that starts the I/O.
    const refusedNow = async (reason: string): Promise<never> => {
      await outcome("not-dispatched");
      throw acp.RequestError.invalidParams({ path, reason });
    };
    let current: PermissionPolicy;
    try {
      current = await policyForAsk();
    } catch {
      return refusedNow("the policy could not be read again before the file I/O");
    }
    try {
      authorized.dispatch();
    } catch (error) {
      await outcome("not-dispatched");
      throw error;
    }
    if (!authorized.stillAllowed(current)) return refusedNow("not allowed now: the policy changed before the file I/O");
    try {
      target.unchanged();
    } catch (error) {
      await outcome("not-dispatched");
      throw error;
    }
    let result: T;
    try {
      result = await io(target.io);
    } catch (error) {
      if (error instanceof OwnedFsNotDispatched) return refusedNow(error.message);
      // A read changes nothing, and a write that failed before changing anything says so.
      // Any other write failure may have changed the file: its effect is unknown, and the
      // agent is told not to take it as a write that never happened (#703 review).
      if (access === "read" || error instanceof OwnedFsFailedWithoutEffect) {
        await outcome("failed");
        throw error instanceof OwnedFsFailedWithoutEffect ? error.original : error;
      }
      await outcome("effect-unknown");
      logger.warn("fs write failed after it may have started", { path, error: describeError(error) });
      throw acp.RequestError.internalError({
        path,
        reason:
          "the write failed after it may have started: whether the file changed is unknown, so it is not safe to retry as if it had not run",
      });
    }
    await outcome("completed");
    return result;
  };

  /** Aborted when the session ends, however it ends: what a relayed listing request lives by. */
  const sessionLive = new AbortController();

  /**
   * Decide one request to a relayed MCP server at dispatch time (#704 review). Admission is
   * only the first gate: it says the runtime was checked, not that a later request is wanted.
   *
   * - A listing (`server/discover`, `tools/list`, `ping`) acts on nothing and goes ahead in a
   *   live session, turn or not: an agent lists its tools when the session starts.
   * - `tools/call` must belong to the session's live prompt turn, and is decided by ORCA's
   *   policy, read fresh, as `<server>: <tool>` of kind `other`, the same call the pre-tool
   *   hook decides. An allow proceeds; an ask is put to a person through the host as a
   *   one-time allow for this exact call, and the policy is read again after the answer;
   *   anything else refuses. An answer the agent got for its own earlier ask is not reused.
   *
   * The returned check runs in the same step that writes the request to the server, and its
   * signal ends the request with the turn (or, for a listing, the session).
   */
  const authorizeMcp = async (call: McpRelayCall, request: AbortSignal): Promise<McpRelayDispatch> => {
    const record = (title: string, decision: string) => {
      opts.onPermission?.({ title, decision: `mcp:${decision}` });
      logger.debug("mcp permission", { server: call.server, method: call.method, decision });
    };
    if (sessionLive.signal.aborted) throw new Error("the session has ended");
    if (call.method !== "tools/call") {
      const check = () => {
        if (sessionLive.signal.aborted) throw new Error("the session ended before the request was sent");
      };
      return { signal: sessionLive.signal, dispatch: check, recheck: async () => check() };
    }
    const title = `${call.server}: ${call.tool}`;
    const refuse = (decision: string, reason: string): never => {
      record(title, decision);
      throw new Error(reason);
    };
    const turn = activeTurn;
    if (!turn || turn.abort.signal.aborted)
      return refuse("no-turn", "no live turn: ORCA relays tool calls only in one");
    const live = () =>
      activeTurn === turn && !turn.abort.signal.aborted && !sessionLive.signal.aborted && !request.aborted;
    /** How the call was allowed: a person's one-time allow stands until a deny appears. */
    let grantedBy: "allow" | "ask:allow_once" = "allow";
    const gate: McpRelayDispatch = {
      signal: turn.abort.signal,
      dispatch: () => {
        if (live()) return;
        record(title, "dispatch:turn-ended");
        throw new Error("the turn ended before the tool call was sent");
      },
      // At the handoff to the server: the policy as it is now, the same turn.
      recheck: async () => {
        const now = decide(await policyForAsk());
        if (now === "deny") return refuse("recheck:denied-since", "ORCA's policy denies it now");
        if (now === "ask" && grantedBy === "allow")
          return refuse("recheck:asks-since", "ORCA's policy asks for it now, and nobody was asked");
        if (!live()) return refuse("recheck:turn-ended", "the turn ended while the server started");
      },
    };
    const toolCall = (toolCallId: string): acp.RequestPermissionRequest["toolCall"] => ({
      toolCallId,
      title,
      kind: "other",
      locations: [],
      rawInput: call.arguments,
    });
    const decide = (policy: Awaited<ReturnType<typeof policyForAsk>>) =>
      decidePermission(policy, { sessionId: acpSessionId, toolCall: toolCall(""), options: [] }, evalScope);
    const policy = await policyForAsk();
    if (!live()) return refuse("turn-ended", "the turn ended before the tool call was decided");
    const decision = decide(policy);
    if (decision === "allow") {
      record(title, "allow");
      return gate;
    }
    if (decision !== "ask") return refuse(decision, `ORCA's policy says ${decision}`);
    // The ask lives only as long as the request: its deadline or cancellation retires it.
    const invocation: PermissionInvocation = {
      sessionId: id,
      turnId: turn.id,
      invocationId: randomUUID(),
      signal: AbortSignal.any([turn.abort.signal, request]),
    };
    const asked = await resolvePermission(policy, {
      request: {
        sessionId: acpSessionId,
        toolCall: toolCall(`orca-mcp-${randomUUID()}`),
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
      signal: invocation.signal,
      ...askThrough(turn, invocation),
      scope: evalScope,
    });
    if (asked.decision !== "ask:allow_once") return refuse(asked.decision, `not allowed: ${asked.decision}`);
    if (decide(await policyForAsk()) === "deny")
      return refuse("ask:allow_once:denied-since", "ORCA's policy denies it now");
    if (!live()) return refuse("ask:allow_once:turn-ended", "the turn ended while the tool call was asked");
    record(title, "ask:allow_once");
    grantedBy = "ask:allow_once";
    return gate;
  };

  /**
   * Refuse an `fs/*` request for one of ORCA's own files. These handlers read and write with
   * no permission ask at all, so this is the only check ORCA makes on them.
   */
  // Settled once, observed by every request: a rejection is an answer here, never unhandled.
  const admitted: Promise<boolean> = opts.admission
    ? opts.admission.then(
        () => true,
        () => false,
      )
    : Promise.resolve(true);
  const refuseUnadmitted = async (path: string): Promise<void> => {
    if (await admitted) return;
    logger.warn("agent file request refused: the session was not admitted", { path });
    throw acp.RequestError.invalidParams({ path, reason: "the session was not admitted" });
  };

  /**
   * Where a local `fs/*` request really lands (#703): links followed, and inside a session
   * root once they are. A remote host's paths are compared as written. The returned check
   * runs in the dispatch step and refuses when the path no longer resolves to the same file.
   */
  const localHost = opts.host.spec.type === "local";
  const ownedTarget = (
    path: string,
    access: FsAccess,
  ): {
    io: string;
    resolved?: string;
    binding?: OwnedFsBinding;
    /** How the I/O is carried out, decided before it is authorized and recorded with it. */
    mode: FsIoMode;
    unchanged: () => void;
  } => {
    if (!localHost) return { io: path, mode: "unbound", unchanged: () => undefined };
    const target = resolveOwnedFsTarget(path, roots);
    if (!target.ok)
      throw acp.RequestError.invalidParams({
        path,
        reason:
          target.reason === "outside" ? "outside session roots once links are followed" : "the path cannot be resolved",
      });
    // The file it reaches, or the directory it would be created under, by identity: a path
    // string alone does not show the object behind it stayed the same (#703 review).
    if (!opts.host.fs.bound)
      throw acp.RequestError.invalidParams({ path, reason: "the file's identity cannot be established" });
    // Only an ordinary file is read or written; a directory, FIFO or device is refused here.
    const binding = bindOwnedFs(target.io);
    if (!binding)
      throw acp.RequestError.invalidParams({
        path,
        reason: "not an ordinary file, or the file's identity cannot be established",
      });
    // A new file the strict path cannot bind goes the compatibility way, as its own dispatch,
    // recorded as such; one neither can carry out is refused before anything (#1034).
    const mode = access === "read" ? "bound" : newFileMode(binding);
    if (mode === "refused")
      throw acp.RequestError.invalidParams({
        path,
        reason: "this new file cannot be created bound to the checked directory on this host",
      });
    return {
      io: target.io,
      resolved: target.asWritten,
      binding,
      mode,
      unchanged: () => {
        if (!stillBound(path, binding))
          throw acp.RequestError.invalidParams({ path, reason: "the path changed before the file I/O started" });
      },
    };
  };

  // Present whenever a binding was made: `ownedTarget` binds only on a host that has it.
  const bound = () => opts.host.fs.bound!;

  const refuseProtected = (path: string, access: "read" | "write"): void => {
    if (protectedPathFor(path, access, opts.protectedPaths) === undefined) return;
    logger.warn("agent file request refused: the path is ORCA's own", { path, access });
    throw acp.RequestError.invalidParams({ path, reason: "protected: ORCA's own files are not open to agents" });
  };

  const proc: AgentProcessHandle = await opts.host.spawnAgent(secretPlan.agent, {
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.secretDelivery ?? ENV_SECRET_DELIVERY).spawnOptions(secretPlan),
  });
  const secretValues = proc.secretValues ?? new Map<string, string>();
  values.push(...secretValues.values());
  if (values.length) opts.onSecretValues?.([...values]);
  const mcpServers = fillMcpSecrets(secretPlan, secretValues);
  const relay: McpRelay | undefined =
    opts.relayMcpServers && mcpServers.length
      ? createMcpRelay({
          host: opts.host,
          cwd: opts.cwd,
          env: opts.env,
          servers: mcpServers.map((m) => ({ name: m.name, command: m.command, args: m.args, env: literalEnv(m.env) })),
          withheldEnv: secretPlan.withheldEnv,
          redact: (text) => redactSecretValues(text, values),
          admitted,
          authorize: authorizeMcp,
          logger,
          clientInfo: { ...ORCA_CLIENT_INFO },
          ...(opts.mcpStartTimeoutMs !== undefined ? { startTimeoutMs: opts.mcpStartTimeoutMs } : {}),
          ...(opts.mcpRequestTimeoutMs !== undefined ? { requestTimeoutMs: opts.mcpRequestTimeoutMs } : {}),
          exitGraceMs: opts.exitGraceMs,
        })
      : undefined;

  const app = acp
    .client({ name: ORCA_CLIENT_INFO.name })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const p = ctx.params;
      if (p.sessionId !== acpSessionId && acpSessionId !== "") return;
      if (p.update.sessionUpdate === "config_option_update") {
        configOptions = p.update.configOptions.map(normalizeConfigOption);
      }
      const e: SessionUpdateEvent = {
        sessionId: p.sessionId,
        raw: p.update,
        summary: summarizeUpdate(p.update),
        at: clock.now(),
      };
      for (const l of listeners) l(e);
    })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      // Nothing is asked of anybody for a session that has not been admitted.
      if (!(await admitted)) return { outcome: { outcome: "cancelled" } };
      const turn = activeTurn;
      // A session id alone is insufficient: asks outside this exact live prompt are stale.
      if (!turn || turn.abort.signal.aborted || ctx.params.sessionId !== acpSessionId)
        return { outcome: { outcome: "cancelled" } };
      const invocation: PermissionInvocation = {
        sessionId: id,
        turnId: turn.id,
        invocationId: randomUUID(),
        signal: turn.abort.signal,
      };
      const { response, decision, rule } = await resolvePermission(await policyForAsk(), {
        request: ctx.params,
        signal: invocation.signal,
        ...askThrough(turn, invocation),
        // Rules ORCA writes are workspace-relative, so that a grant made in one git worktree
        // still fires in the next one; without the workspace to resolve them against, none
        // of them could ever match the absolute paths an agent reports (ADR 0009).
        // ORCA's own files go ahead of every rule, so no policy can open them (C4-01).
        scope: evalScope,
        ...(judged ? { judged } : {}),
      });
      opts.onPermission?.({
        ...(ctx.params.toolCall.toolCallId ? { toolCallId: ctx.params.toolCall.toolCallId } : {}),
        title: ctx.params.toolCall.title ?? "",
        decision,
        ...(rule ? { rule } : {}),
      });
      logger.debug("permission", { title: ctx.params.toolCall.title, decision });
      return response;
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      const { path, line, limit } = ctx.params;
      await refuseUnadmitted(path);
      // Only this session's own agent session may ask ORCA for file I/O (#703 review).
      if (ctx.params.sessionId !== acpSessionId)
        throw acp.RequestError.invalidParams({ path, reason: "not this session" });
      if (!withinRoots(path, roots)) throw acp.RequestError.invalidParams({ path, reason: "outside session roots" });
      refuseProtected(path, "read");
      const target = ownedTarget(path, "read");
      const authorized = await authorizeFs(path, "read", target.resolved);
      let content: string;
      try {
        content = await executeOwnedFs(path, "read", target, authorized, (file) =>
          target.binding ? bound().read(target.binding) : opts.host.fs.readFile(file),
        );
      } catch (e) {
        // A missing file is an answer, not a failure: agents (Gemini CLI among them) find out
        // whether a file exists by reading it, and only "Resource not found" reads as missing.
        // This is past the policy gate, so a path the policy refuses never learns either way.
        if (isHostFileMissing(e)) throw acp.RequestError.resourceNotFound(path);
        throw e;
      }
      if (line !== undefined && line !== null) {
        const lines = content
          .split("\n")
          .slice(
            Math.max(0, line - 1),
            limit !== undefined && limit !== null ? Math.max(0, line - 1) + limit : undefined,
          );
        content = lines.join("\n");
      }
      return { content };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      const { path, content } = ctx.params;
      await refuseUnadmitted(path);
      if (ctx.params.sessionId !== acpSessionId)
        throw acp.RequestError.invalidParams({ path, reason: "not this session" });
      if (!withinRoots(path, roots)) throw acp.RequestError.invalidParams({ path, reason: "outside session roots" });
      refuseProtected(path, "write");
      const target = ownedTarget(path, "write");
      const authorized = await authorizeFs(path, "write", target.resolved);
      await executeOwnedFs(path, "write", target, authorized, (file) =>
        !target.binding
          ? opts.host.fs.writeFile(file, content)
          : target.mode === "compatibility"
            ? bound().writeCompatibility(target.binding, content)
            : bound().write(target.binding, content),
      );
      return {};
    });

  // The stable builder has no MCP-over-ACP method of its own, so it takes the request as a
  // custom method with its own params check; the relay validates the rest.
  if (relay) app.onRequest(acpUnstable.methods.client.mcp.message, mcpMessageParams, relay.handleRequest);
  const conn = app.connect(proc.stream);
  const closed = conn.closed.then(() => undefined);
  // Losing the agent's transport ends everything the relay runs for it, not only the turn.
  void closed.then(() => {
    activeTurn?.abort.abort("agent connection closed");
    sessionLive.abort("agent connection closed");
    void relay?.close();
  });
  // A handle whose exit cannot be observed rejects; that ends no turn, and must not surface as
  // an unhandled rejection either.
  void proc.exited.then(
    () => {
      activeTurn?.abort.abort("agent process exited");
      sessionLive.abort("agent process exited");
      void relay?.close();
    },
    () => undefined,
  );
  const cleanupProcess = processCleanup(proc, opts.exitGraceMs);
  // Settles when the owned process's exit is observed. A rejection means the exit cannot be
  // observed at all, which is not evidence it is gone, so it stays a rejection for callers.
  const terminated: Promise<void> = proc.exited.then(() => undefined);
  void terminated.catch(() => undefined);
  /** Startup failure, close and cancellation all share one bounded cleanup. */
  let terminating: Promise<void> | undefined;
  const terminate = (reason?: unknown): Promise<void> => {
    if (terminating) return terminating;
    terminating = (async () => {
      activeTurn?.abort.abort("session closed");
      sessionLive.abort("session closed");
      if (activeTurn?.grace) clearTimeout(activeTurn.grace);
      listeners.clear();
      try {
        conn.close(reason);
      } catch {
        /* Still retain responsibility for the child if transport close fails. */
      }
      await Promise.all([cleanupProcess(), relay?.close()]);
    })();
    // Cancellation can initiate shutdown without an awaiting caller.
    void terminating.catch((error: unknown) =>
      logger.warn("agent session cleanup failed", { sessionId: id, error: describeError(error) }),
    );
    return terminating;
  };
  const handshakeTimeout = opts.handshakeTimeoutMs ?? 30_000;

  const withTimeout = <T>(p: Promise<T>, ms: number, what: string, timeoutFailure?: Error): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            timeoutFailure ??
              new OrcaError("AGENT_TRANSPORT", `${what} timed out after ${ms}ms`, { stderr: proc.stderrTail() }),
          ),
        ms,
      );
      // Forward settlement without adopting the still-pending request: adoption would
      // make the timeout's reject a no-op.
      void p.then(
        (value) => {
          clearTimeout(t);
          resolve(value);
        },
        (error: Error) => {
          clearTimeout(t);
          reject(error);
        },
      );
    });

  try {
    const init = await withTimeout(
      conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
          // ORCA can set boolean config options as well as selects.
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { ...ORCA_CLIENT_INFO },
      }),
      handshakeTimeout,
      "initialize",
    );
    logger.debug("initialized", { protocolVersion: init.protocolVersion, agentInfo: init.agentInfo });
    embeddedContext = init.agentCapabilities?.promptCapabilities?.embeddedContext === true;
    if (opts.requireEmbeddedContext && !embeddedContext) throw opts.requireEmbeddedContext();
    const agentInfo = init.agentInfo ? { name: init.agentInfo.name, version: init.agentInfo.version } : undefined;
    const relayed =
      relay !== undefined && (typeof opts.relayMcpServers === "function" ? opts.relayMcpServers(agentInfo) : true);
    if (relayed && (init.agentCapabilities?.mcpCapabilities as { acp?: unknown } | undefined)?.acp !== true)
      throw new OrcaError(
        "AGENT_PROTOCOL",
        "the agent cannot be given its MCP servers through ORCA: it does not offer MCP over ACP",
        { agent: opts.agent.id },
      );
    const newSession: acp.NewSessionRequest = {
      cwd: opts.cwd,
      mcpServers: relayed
        ? relay.declare(conn.agent)
        : mcpServers.map((m) => ({
            name: m.name,
            command: m.command,
            args: m.args,
            // Every reference was resolved above, so only literal values remain.
            env: Object.entries(literalEnv(m.env)).map(([name, value]) => ({ name, value })),
          })),
    };
    if (opts.additionalDirectories) newSession.additionalDirectories = opts.additionalDirectories;
    const meta = await opts.sessionMeta?.(
      init.agentInfo ? { name: init.agentInfo.name, version: init.agentInfo.version } : undefined,
      (method, params) => withTimeout(conn.agent.request<unknown>(method, params), handshakeTimeout, method),
      proc.pid,
    );
    if (meta) newSession._meta = meta;
    let loaded = false;
    let continuity: SessionContinuity = { mode: "fresh", reason: "new" };
    if (opts.resumeSessionId) {
      continuity = { mode: "fresh", reason: "load-unsupported" };
      if (init.agentCapabilities?.loadSession) {
        const timeoutFailure = opts.requireContextRecovery ? contextRecoveryFailure("load-timeout") : undefined;
        // Outside the `try`: a denial is the open's failure, never a failed load to fall back from.
        // Nothing waits between this and the request that delivers the servers.
        await opts.authorizeCapabilityDelivery?.();
        try {
          const restored = await withTimeout(
            conn.agent.request(acp.methods.agent.session.load, { ...newSession, sessionId: opts.resumeSessionId }),
            handshakeTimeout,
            "session/load",
            timeoutFailure,
          );
          acpSessionId = opts.resumeSessionId;
          configOptions = normalizeSessionConfig(restored);
          loaded = true;
          continuity = { mode: "loaded", reason: "load-supported" };
        } catch (error) {
          if (opts.requireContextRecovery) {
            if (timeoutFailure && error === timeoutFailure) throw timeoutFailure;
            throw contextRecoveryFailure("load-failed");
          }
          continuity = { mode: "fresh", reason: "load-failed" };
        }
      } else if (opts.requireContextRecovery) throw contextRecoveryFailure("load-unsupported");
    }
    if (!loaded) {
      // Asked again here: a `session/load` that failed or timed out may have taken a while.
      await opts.authorizeCapabilityDelivery?.();
      const created = await withTimeout(
        conn.agent.request(acp.methods.agent.session.new, newSession),
        handshakeTimeout,
        "session/new",
      );
      acpSessionId = created.sessionId;
      configOptions = normalizeSessionConfig(created);
    }
    opts.onSessionContinuity?.(continuity);
  } catch (e) {
    const failure =
      e instanceof OrcaError
        ? e
        : new OrcaError(
            "AGENT_PROTOCOL",
            `ACP handshake with '${opts.agent.id}' failed: ${(e as Error).message}`,
            { stderr: proc.stderrTail() },
            { cause: e },
          );
    try {
      await terminate(e);
    } catch (cleanupError) {
      // Keep the handshake as the primary failure and retain it as the cause. The process may
      // still be alive: carry its exit so a caller counting live processes can wait for it.
      throw withStartupTermination(
        new OrcaError(
          failure.code,
          failure.message,
          {
            ...failure.details,
            cleanup: describeError(cleanupError),
          },
          { cause: failure },
        ),
        proc.exited,
      );
    }
    throw withStartupTermination(failure, proc.exited);
  }

  const cancelGraceMs = opts.cancelGraceMs ?? opts.agent.cancelGraceMs;

  /** The in-flight prompt turn, if any. */
  interface ActiveTurn {
    id: string;
    abort: AbortController;
    failure?: Error;
    /** Why cancellation was requested; set once, by the first requester. */
    cancelReason?: string;
    /** Armed when `session/cancel` is sent; fires if the agent never ends the turn. */
    grace?: ReturnType<typeof setTimeout>;
    /** Rejects the turn from outside the ACP request (the agent is wedged). */
    fail: (e: Error) => void;
  }

  /**
   * Ask the agent to end the current turn, and stop waiting for it if it does not.
   * `session/cancel` is only a notification: a deadlocked agent (or a stalled
   * transport) never answers it, and the prompt request would otherwise hang
   * forever, taking the step, the run and `orchestrator.cancel()` with it.
   */
  const requestCancel = (reason: string): void => {
    const turn = activeTurn;
    if (!turn || turn.cancelReason) return;
    turn.cancelReason = reason;
    turn.abort.abort(reason);
    logger.debug("cancelling turn", { reason, graceMs: cancelGraceMs });
    void conn.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: acpSessionId })
      .catch(() => undefined /* connection may already be gone */);
    turn.grace = setTimeout(() => {
      const err = new OrcaError(
        "AGENT_TRANSPORT",
        `agent '${opts.agent.id}' did not end its turn within ${cancelGraceMs}ms of session/cancel (${reason}); killing it`,
        { reason, stderr: proc.stderrTail() },
      );
      logger.warn("agent wedged after cancel; terminating", { reason });
      turn.fail(err);
      void terminate(err);
    }, cancelGraceMs);
  };

  const session: AgentSession = {
    id,
    agentId: opts.agent.id,
    hostId: opts.host.id,
    cwd: opts.cwd,
    acpSessionId,
    closed,
    terminated,
    promptCapabilities: { embeddedContext },

    async prompt(input, options: PromptOptions = {}): Promise<TurnResult> {
      if (activeTurn) throw new OrcaError("RUN_STATE", "a prompt turn is already active on this session");
      if (options.signal?.aborted) throw new OrcaError("CANCELLED", String(options.signal.reason ?? "cancelled"));
      const blocks: acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
      const started = clock.now();
      // Settles the turn when the agent is wedged and the ACP request itself will never answer.
      let wedged: Error | undefined;
      const turn: ActiveTurn = { id: randomUUID(), abort: new AbortController(), fail: () => undefined };
      const failed = new Promise<never>((_, reject) => {
        turn.fail = (e) => {
          wedged = e;
          reject(e);
        };
      });
      failed.catch(() => undefined); // observed through the race below
      activeTurn = turn;
      const onAbort = () => requestCancel(`aborted: ${String(options.signal?.reason ?? "cancelled")}`);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = options.timeoutMs
        ? setTimeout(() => requestCancel(`turn timed out after ${options.timeoutMs}ms`), options.timeoutMs)
        : undefined;
      try {
        const res = await Promise.race([
          conn.agent.request(acp.methods.agent.session.prompt, { sessionId: acpSessionId, prompt: blocks }),
          failed,
        ]);
        return { stopReason: res.stopReason, durationMs: clock.now() - started };
      } catch (e) {
        if (turn.failure) throw turn.failure;
        if (wedged) throw wedged;
        throw new OrcaError(
          "AGENT_PROTOCOL",
          `prompt failed: ${(e as Error).message}`,
          { stderr: proc.stderrTail() },
          { cause: e },
        );
      } finally {
        turn.abort.abort("turn ended");
        if (timer) clearTimeout(timer);
        if (turn.grace) clearTimeout(turn.grace);
        options.signal?.removeEventListener("abort", onAbort);
        activeTurn = undefined;
      }
    },

    onUpdate(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    get configOptions() {
      return configOptions;
    },

    async setConfigOption(configId, value) {
      const params: acp.SetSessionConfigOptionRequest =
        typeof value === "boolean"
          ? { sessionId: acpSessionId, configId, type: "boolean", value }
          : { sessionId: acpSessionId, configId, value };
      let res: acp.SetSessionConfigOptionResponse;
      try {
        res = await conn.agent.request(acp.methods.agent.session.setConfigOption, params);
      } catch (e) {
        throw new OrcaError(
          "AGENT_PROTOCOL",
          `agent '${opts.agent.id}' rejected session/set_config_option ${configId}=${String(value)}: ${(e as Error).message}`,
          { configId, value },
          { cause: e },
        );
      }
      configOptions = res.configOptions.map(normalizeConfigOption);
      return configOptions;
    },

    async cancel() {
      requestCancel("cancel requested");
    },

    close() {
      return terminate();
    },
  };
  return session;
}
