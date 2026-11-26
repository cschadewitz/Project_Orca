/**
 * The session factory's mapping for an agent with `driver: codex-app-server` (#1154): the
 * options ORCA's runs give every session, as `openCodexAppServerSession` takes them, and a
 * refusal, never a silent drop, for each one the driver does not carry yet.
 *
 * The factory does not call it while it refuses the route (`codexAppServerRefused`,
 * "session-factory"); enabling the route is routing to it.
 */
import { OrcaError } from "@orca/core";
import { ENV_SECRET_DELIVERY, type OpenCodexAppServerSessionOptions, type OpenSessionOptions } from "@orca/agents";

/** The thread policy every factory session runs with: Codex asks before acting outside a workspace-write sandbox. */
export const CODEX_FACTORY_THREAD = { approvalPolicy: "on-request", sandbox: "workspace-write" } as const;

/**
 * `openCodexAppServerSession`'s options for a session the factory opens, with ORCA's own files
 * bound (`permissionFiles`, `protectedPaths`), or a refusal naming the first option the driver
 * cannot carry.
 */
export function codexAppServerSessionOptions(
  options: OpenSessionOptions,
  orcaVersion: string,
): OpenCodexAppServerSessionOptions {
  const agent = options.agent;
  const refuse = (what: string, issue?: string) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agent.id} has driver: codex-app-server, which does not carry ${what} yet${issue ? ` (${issue})` : ""}. ` +
        `ORCA refuses the session rather than run it without; remove driver to run Codex through its ACP adapter.`,
      { agentId: agent.id, option: what },
    );
  // Directories ORCA's checks would treat as the agent's that Codex's sandbox would not.
  if (options.additionalDirectories?.length) throw refuse("additional directories");
  // The agent's own MCP servers are carried (#1163): Codex runs them for the thread, each call
  // asked about through ORCA's policy. ORCA's relay is the ACP route's, and refused below.
  if (options.secretDelivery && options.secretDelivery !== ENV_SECRET_DELIVERY)
    throw refuse("a secret delivery other than environment variables");
  // The ACP and hook routes' own: nothing on this route would honour them.
  if (options.sessionMeta !== undefined) throw refuse("ACP session metadata");
  if (options.admission !== undefined) throw refuse("a runtime admission");
  if (options.relayMcpServers !== undefined && options.relayMcpServers !== false) throw refuse("relayed MCP servers");
  if (options.requireEmbeddedContext !== undefined) throw refuse("embedded context");
  // `recordFsOperation` is the durable record of ORCA's own file executor, which every run
  // supplies. This route has no such executor: Codex reads and writes itself, inside its
  // sandbox, and the driver serves no `fs/*` request. So the callback is not carried, and
  // nothing on this route could invoke it; an executor here needs its own authorization and
  // audit first (#1173).
  if (options.authorizeCapabilityDelivery !== undefined) throw refuse("capability delivery");
  // The driver's judge advises on commands only (#1184-#1188 for the rest).
  if (options.judgeKinds?.edit || options.judgeKinds?.mcp) throw refuse("a judge for edits or MCP calls", "#1187");
  const protectedPaths = options.protectedPaths;
  return {
    host: options.host,
    agent,
    cwd: options.cwd,
    thread: { ...CODEX_FACTORY_THREAD },
    orcaVersion,
    ...(options.env ? { env: options.env } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
    ...(options.authorizeSecretUse ? { authorizeSecretUse: options.authorizeSecretUse } : {}),
    ...(options.askPermission ? { askPermission: options.askPermission } : {}),
    ...(options.permissionFiles ? { permissionFiles: options.permissionFiles } : {}),
    // The asks are checked against all of them; no writable root of the thread may overlap one
    // the agent may not write.
    ...(protectedPaths
      ? {
          policyProtectedPaths: protectedPaths,
          protectedPaths: [...protectedPaths.readOnly, ...protectedPaths.noAccess],
        }
      : {}),
    ...(options.judgePermission ? { judgePermission: options.judgePermission } : {}),
    ...(options.judgeKinds?.command ? { judgeKinds: { command: options.judgeKinds.command } } : {}),
    ...(options.onPermission ? { onPermission: options.onPermission } : {}),
    // Run-level redaction: every secret value the app-server is given, before it says anything.
    ...(options.onSecretValues ? { onSecretValues: options.onSecretValues } : {}),
    ...(options.resumeSessionId ? { resumeThreadId: options.resumeSessionId } : {}),
    ...(options.requireContextRecovery !== undefined ? { requireContextRecovery: options.requireContextRecovery } : {}),
    ...(options.onSessionContinuity ? { onSessionContinuity: options.onSessionContinuity } : {}),
    ...(options.exitGraceMs !== undefined ? { exitGraceMs: options.exitGraceMs } : {}),
    ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
  };
}
