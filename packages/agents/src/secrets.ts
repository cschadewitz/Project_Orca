/**
 * Secret references at the execution boundary (#336). A session's references are checked here
 * and then read by the host *as part of starting the agent*, so the read and the delivery are
 * one act on one connection:
 *
 * - A reference bound to another host is refused. There is no fallback to a value found on
 *   this host, in the daemon's environment, or anywhere else.
 * - The host reads each value immediately before the process starts: a local host in the
 *   daemon, an SSH host in the same remote shell that then execs the agent. A missing or
 *   unreadable value refuses the spawn, so the process never starts with a hole where its
 *   credential should be.
 * - Every environment variable a secret on this host is read *from* is removed from what the
 *   agent inherits, so a credential reaches an agent only through a reference to it.
 * - Nothing is cached: every session open reads again, which is how a rotated value is picked
 *   up and a revoked one stops working. The values come back to the session, which redacts
 *   them from its logs and errors and hands them to its caller to redact.
 */
import {
  isSecretRef,
  literalEnv,
  OrcaError,
  redactSecretValues,
  secretSource,
  type AgentSpec,
  type Logger,
  type SecretSource,
  type SecretsConfig,
} from "@orca/core";
import type { AgentHost, SecretDelivery } from "./host.js";

/** Why a secret could not be read. Never the value, never the provider's own error text. */
export type SecretFailure = "undefined" | "wrong-host" | "missing" | "unsupported";

export function secretUnavailable(secret: string, reason: SecretFailure, detail: string, hostId: string): OrcaError {
  return new OrcaError("CONFIG_INVALID", `secret '${secret}' is unavailable: ${detail}`, {
    secret,
    reason,
    hostId,
  });
}

/** For hosts: the error for a source that is not there, in words that never include a value. */
export function sourceMissing(id: string, source: SecretSource, hostId: string): OrcaError {
  return secretUnavailable(
    id,
    "missing",
    source.provider === "env"
      ? `environment variable ${source.name} is not set on host '${hostId}'`
      : `file ${source.path} does not exist or cannot be read on host '${hostId}'`,
    hostId,
  );
}

/** What a session asks its host to read and deliver when it starts the agent. */
export interface SessionSecretPlan {
  /** The agent with literal env only, its MCP servers' references removed (`mcpSecrets` has them). */
  agent: AgentSpec;
  /** One entry per secret: where it is read, and the agent variables it fills. */
  deliveries: SecretDelivery[];
  /** MCP server env variables filled from a secret, by server index. */
  mcpSecrets: { server: number; name: string; secret: string }[];
  /**
   * Variables the agent must not inherit: every `provider: env` source of a secret bound to
   * this host, referenced by this agent or not.
   */
  withheldEnv: string[];
}

/**
 * Check every reference in the agent's own env and its inline MCP servers' env against the
 * catalog and `host`, and say what the host has to read. Reads nothing.
 */
export function planSessionSecrets(
  host: AgentHost,
  agent: AgentSpec,
  secrets: SecretsConfig | undefined,
): SessionSecretPlan {
  const deliveries = new Map<string, SecretDelivery>();
  const use = (id: string): SecretDelivery => {
    const known = deliveries.get(id);
    if (known) return known;
    const def = secrets?.[id];
    if (!def) throw secretUnavailable(id, "undefined", "no such secret is configured", host.id);
    if (def.host !== host.id)
      throw secretUnavailable(
        id,
        "wrong-host",
        `it is bound to host '${def.host}', and this session runs on '${host.id}'`,
        host.id,
      );
    if (!host.deliversSecrets)
      throw secretUnavailable(id, "unsupported", `host '${host.id}' cannot read secrets`, host.id);
    const delivery: SecretDelivery = { id, source: secretSource(def), env: [] };
    deliveries.set(id, delivery);
    return delivery;
  };
  for (const [name, value] of Object.entries(agent.env)) if (isSecretRef(value)) use(value.secret).env.push(name);
  const mcpSecrets: SessionSecretPlan["mcpSecrets"] = [];
  agent.mcpServers.forEach((server, index) => {
    for (const [name, value] of Object.entries(server.env))
      if (isSecretRef(value)) {
        use(value.secret);
        mcpSecrets.push({ server: index, name, secret: value.secret });
      }
  });
  const withheldEnv = [
    ...new Set(
      Object.values(secrets ?? {})
        .filter((d) => d.host === host.id && d.provider === "env")
        .map((d) => (d.provider === "env" ? d.name : "")),
    ),
  ];
  return {
    agent: {
      ...agent,
      env: literalEnv(agent.env),
      mcpServers: agent.mcpServers.map((s) => ({ ...s, env: literalEnv(s.env) })),
    },
    deliveries: [...deliveries.values()],
    mcpSecrets,
    withheldEnv,
  };
}

/** The MCP servers with their secret-backed variables filled from what the host read. */
export function fillMcpSecrets(plan: SessionSecretPlan, values: ReadonlyMap<string, string>): AgentSpec["mcpServers"] {
  return plan.agent.mcpServers.map((server, index) => {
    const env = { ...literalEnv(server.env) };
    for (const m of plan.mcpSecrets) if (m.server === index) env[m.name] = values.get(m.secret)!;
    return { ...server, env };
  });
}

/** Drop one trailing newline, which an editor or `echo` leaves at the end of a secret file. */
export function trimSecret(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

/** `env` without the withheld names: what an agent process inherits. */
export function withoutWithheld(
  env: NodeJS.ProcessEnv,
  withheld: readonly string[] | undefined,
): Record<string, string | undefined> {
  if (!withheld?.length) return { ...env };
  const drop = new Set(withheld);
  // Windows environment names are case-insensitive.
  const key = process.platform === "win32" ? (k: string) => k.toUpperCase() : (k: string) => k;
  const dropKeys = new Set([...drop].map(key));
  return Object.fromEntries(Object.entries(env).filter(([k]) => !dropKeys.has(key(k))));
}

/** A logger that redacts the values `values()` returns from every message and field. */
export function redactingLogger(logger: Logger, values: () => readonly string[]): Logger {
  const r = <T>(v: T) => redactSecretValues(v, values());
  return {
    log: (level, msg, fields) => logger.log(level, r(msg), fields && r(fields)),
    debug: (msg, fields) => logger.debug(r(msg), fields && r(fields)),
    info: (msg, fields) => logger.info(r(msg), fields && r(fields)),
    warn: (msg, fields) => logger.warn(r(msg), fields && r(fields)),
    error: (msg, fields) => logger.error(r(msg), fields && r(fields)),
    child: (fields) => redactingLogger(logger.child(r(fields)), values),
  };
}

/**
 * Redact secret values from a thrown error in place - message, stack, an `OrcaError`'s details
 * (stderr tails among them) and its cause chain - so it can be returned or written as it is.
 */
export function redactError<E>(error: E, values: readonly string[], seen = new Set<unknown>()): E {
  if (!values.length || !(error instanceof Error) || seen.has(error)) return error;
  seen.add(error);
  const r = <T>(v: T) => redactSecretValues(v, values);
  error.message = r(error.message);
  if (error.stack) error.stack = r(error.stack);
  if (error instanceof OrcaError && error.details)
    Object.defineProperty(error, "details", { value: r(error.details), writable: true, configurable: true });
  if (error.cause !== undefined)
    error.cause = error.cause instanceof Error ? redactError(error.cause, values, seen) : r(error.cause);
  return error;
}
