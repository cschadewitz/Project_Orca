/**
 * Secret references at the execution boundary (#336): read each `{ secret: <id> }` an agent
 * session needs on the session's own host, immediately before the agent process starts.
 *
 * - A reference bound to another host is refused. There is no fallback to a value found on
 *   this host, in the daemon's environment, or anywhere else.
 * - A missing or unreadable value is refused before anything is spawned, so the dependent
 *   process never starts with a hole where its credential should be.
 * - Nothing is cached: every session open reads again, which is how a rotated value is picked
 *   up and a revoked one stops working. Values live only in this process's memory for as long
 *   as the session needs them, and the caller is handed them to redact.
 */
import {
  isSecretRef,
  literalEnv,
  OrcaError,
  redactSecretValues,
  secretSource,
  type AgentSpec,
  type Logger,
  type Env,
  type McpServerConfig,
  type SecretSource,
  type SecretsConfig,
} from "@orca/core";
import type { AgentHost } from "./host.js";

/** Why a secret could not be read. Never the value, never the provider's own error text. */
export type SecretFailure = "undefined" | "wrong-host" | "missing" | "unreadable" | "unsupported";

export function secretUnavailable(secret: string, reason: SecretFailure, detail: string, hostId: string): OrcaError {
  return new OrcaError("CONFIG_INVALID", `secret '${secret}' is unavailable: ${detail}`, {
    secret,
    reason,
    hostId,
  });
}

export interface SessionSecrets {
  /** The agent with literal env only; references are resolved into `secretEnv`. */
  agent: AgentSpec;
  /** Agent environment variables whose values came from references. */
  secretEnv: Record<string, string>;
  /** Every resolved value, for the caller to redact. */
  values: string[];
}

/**
 * Resolve every reference in the agent's own env and its inline MCP servers' env, on `host`.
 * Throws on the first one that cannot be read; reads nothing at all when there are none.
 */
export async function resolveSessionSecrets(
  host: AgentHost,
  agent: AgentSpec,
  secrets: SecretsConfig | undefined,
): Promise<SessionSecrets> {
  const cache = new Map<string, string>();
  const values: string[] = [];
  const read = async (id: string): Promise<string> => {
    const known = cache.get(id);
    if (known !== undefined) return known;
    const def = secrets?.[id];
    if (!def) throw secretUnavailable(id, "undefined", "no such secret is configured", host.id);
    if (def.host !== host.id)
      throw secretUnavailable(
        id,
        "wrong-host",
        `it is bound to host '${def.host}', and this session runs on '${host.id}'`,
        host.id,
      );
    if (!host.readSecret) throw secretUnavailable(id, "unsupported", `host '${host.id}' cannot read secrets`, host.id);
    const value = await host.readSecret(id, secretSource(def));
    cache.set(id, value);
    values.push(value);
    return value;
  };
  const resolveEnv = async (env: Env): Promise<{ literal: Record<string, string>; secret: Record<string, string> }> => {
    const secret: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (isSecretRef(value)) secret[name] = await read(value.secret);
    return { literal: literalEnv(env), secret };
  };
  const own = await resolveEnv(agent.env);
  const mcpServers: McpServerConfig[] = [];
  for (const server of agent.mcpServers) {
    const env = await resolveEnv(server.env);
    mcpServers.push({ ...server, env: { ...env.literal, ...env.secret } });
  }
  return { agent: { ...agent, env: own.literal, mcpServers }, secretEnv: own.secret, values };
}

/** Drop one trailing newline, which an editor or `echo` leaves at the end of a secret file. */
export function trimSecret(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
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

/** A logger that redacts resolved secret values from every message and field it is given. */
export function redactingLogger(logger: Logger, values: readonly string[]): Logger {
  if (!values.length) return logger;
  const r = <T>(v: T) => redactSecretValues(v, values);
  return {
    log: (level, msg, fields) => logger.log(level, r(msg), fields && r(fields)),
    debug: (msg, fields) => logger.debug(r(msg), fields && r(fields)),
    info: (msg, fields) => logger.info(r(msg), fields && r(fields)),
    warn: (msg, fields) => logger.warn(r(msg), fields && r(fields)),
    error: (msg, fields) => logger.error(r(msg), fields && r(fields)),
    child: (fields) => redactingLogger(logger.child(r(fields)), values),
  };
}
