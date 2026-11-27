/**
 * Secret references for a Claude Agent SDK session (#1126), read and delivered the way the ACP
 * route does it (#336, #704): the same plan (`planSessionSecrets`), the same use check
 * (`checkSecretUse`), and the session's `AgentSecretDelivery` deciding what reaches Claude.
 *
 * The SDK route spawns `claude` itself rather than through `AgentHost.spawnAgent`, so the
 * reading the host would do at spawn happens here, immediately before ORCA starts the person's
 * `claude` for this session, and only on ORCA's own machine. The agent's MCP servers are
 * planned with it: ORCA runs them itself (#1125), and a value reaches a server only in the
 * variable its own `env` names. A value reaches Claude only in a
 * variable the agent's own `env` names, every variable a secret on this host is read from is
 * withheld from what Claude inherits, and the values are returned so the caller redacts them
 * from logs, errors and the run's events.
 */
import { OrcaError, literalEnv, type AgentSpec, type SecretsConfig } from "@orca/core";
import type { RelayedMcpServer } from "../mcp-relay.js";
import type { AgentHost } from "../host.js";
import { readLocalSecret } from "../hosts/local-host.js";
import {
  ENV_SECRET_DELIVERY,
  checkSecretUse,
  fillMcpSecrets,
  planSessionSecrets,
  type AgentSecretDelivery,
  type AuthorizeSecretUse,
} from "../secrets.js";

/** What a session's `claude` is given from secret references. */
export interface ClaudeSdkSecrets {
  /** The agent variables filled from a secret, by name. */
  env: Record<string, string>;
  /** Variables Claude must not inherit from the daemon. */
  withheld: readonly string[];
  /** Every value read, for redaction. Never logged or shown. */
  values: readonly string[];
  /** The agent's MCP servers with their secret-backed variables filled, for ORCA to run. */
  mcpServers: RelayedMcpServer[];
}

export interface ClaudeSdkSecretOptions {
  host: AgentHost;
  agent: AgentSpec;
  secrets: SecretsConfig | undefined;
  authorizeSecretUse: AuthorizeSecretUse | undefined;
  delivery?: AgentSecretDelivery | undefined;
}

/** Plan, check and read the secrets the agent's `env` refers to. Reads nothing it may not use. */
export async function claudeSdkSecrets(options: ClaudeSdkSecretOptions): Promise<ClaudeSdkSecrets> {
  const { host, agent } = options;
  // The agent's env and its MCP servers' env: ORCA runs the servers itself (#1125), so each
  // reference there has a consumer and is checked and read like the agent's own.
  const plan = planSessionSecrets(host, agent, options.secrets);
  await checkSecretUse(plan, host, agent.id, options.authorizeSecretUse);
  const delivery = options.delivery ?? ENV_SECRET_DELIVERY;
  const { secrets = [], withheldEnv = [] } = delivery.spawnOptions(plan);
  if (secrets.length > 0 && delivery.kind !== ENV_SECRET_DELIVERY.kind)
    throw new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id} has driver: claude-agent-sdk, which delivers secrets only as environment variables; ` +
        `this session's secret delivery is '${delivery.kind}'.`,
      { agentId: agent.id, delivery: delivery.kind },
    );
  // The factory runs this route on ORCA's own machine only; checked again here, before any read.
  if (secrets.length > 0 && host.spec?.type !== "local")
    throw new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id} has driver: claude-agent-sdk, whose secrets are read only on ORCA's own machine.`,
      { agentId: agent.id, host: host.id },
    );
  const env: Record<string, string> = {};
  const values: string[] = [];
  const byId = new Map<string, string>();
  for (const d of secrets) {
    const value = await readLocalSecret(d.id, d.source, host.id);
    values.push(value);
    byId.set(d.id, value);
    for (const name of d.env) env[name] = value;
  }
  const mcpServers = fillMcpSecrets(plan, byId).map((m) => ({
    name: m.name,
    command: m.command,
    args: [...m.args],
    env: literalEnv(m.env),
  }));
  return { env, withheld: withheldEnv, values, mcpServers };
}
