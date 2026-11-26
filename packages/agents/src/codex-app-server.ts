/**
 * The Codex app-server driver (#1154): `driver: codex-app-server` on an agent. On this route
 * ORCA is to start the user's installed Codex CLI as `codex app-server` and speak its JSON-RPC
 * protocol itself, rather than through the `codex-acp` adapter, on the user's own `codex login`.
 *
 * **This step starts no app-server, and refuses every session that asks for the driver.** It
 * holds the parts that need no client yet:
 *
 * - **The refusal** at every boundary that could otherwise start the agent: the session
 *   factory, ORCA's ACP launch (which would start `command` as an ACP agent, whatever session
 *   metadata it is given) and delegation to a remote daemon.
 * - **The launch** (`codexAppServerLaunch`): `command` names the Codex CLI, `codex` on the
 *   host's `PATH` or a path to it; ORCA finds the executable and appends the `app-server`
 *   subcommand. The agent's environment is passed through as configured: ORCA sets no Codex
 *   variable of its own, so Codex reads the user's own `CODEX_HOME` and the login in it.
 *   ORCA bundles no Codex.
 * - **The login check** (`codexLoginRefused`) over Codex's `account/read` answer. ORCA offers
 *   no sign-in of its own: it never calls `account/login/*`, never asks Codex to refresh a
 *   token, and never reads Codex's credential files. A Codex that reports no account where it
 *   needs one is refused with the command that fixes it, `codex login`.
 *
 * Shapes are those Codex 0.171.0 generates (`codex app-server generate-ts`).
 */
import type { AgentSpec, Env } from "@orca/core";
import { OrcaError } from "@orca/core";
import { findLocalExecutable } from "./capability-use.js";

type DriverSetting = "acp" | "codex-app-server" | undefined;

/** The subcommand of the Codex CLI that serves the protocol over stdio. */
export const CODEX_APP_SERVER_SUBCOMMAND = "app-server";

/** Whether the agent asks for the Codex app-server driver. */
export function codexAppServerRequested(agent: { driver?: DriverSetting }): boolean {
  return agent.driver === "codex-app-server";
}

/** Where a session for the driver is refused. */
export type CodexAppServerBoundary =
  /** The session factory, on ORCA's own host. */
  | "session-factory"
  /** The session factory, for an agent on another host. */
  | "non-local-host"
  /** ORCA's ACP launch (`openAcpSession`), under the session factory. */
  | "launch"
  /** A remote daemon (delegation). */
  | "remote-delegation";

/**
 * The refusal for `driver: codex-app-server` at `where`, or `undefined` for an agent that does
 * not ask for the driver. Every boundary refuses for now; the reason names the issue that lifts
 * it, and the fix that runs the agent today.
 */
export function codexAppServerRefused(
  agent: { id: string; driver?: DriverSetting },
  where: CodexAppServerBoundary,
  host?: { type: string; id: string },
): OrcaError | undefined {
  if (!codexAppServerRequested(agent)) return undefined;
  const why = {
    "session-factory": "ORCA does not run Codex on this driver yet (#1157)",
    "non-local-host": `it runs on ${host?.type ?? "another"} host ${host?.id ?? "(unknown)"}, and the driver runs only on ORCA's own machine for now (#1166)`,
    launch: "ORCA's ACP launch would start the Codex CLI as an ACP agent, and this driver is not ACP",
    "remote-delegation": "it is an orca-daemon agent, and the driver applies to agents ORCA starts itself",
  }[where];
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agent.id} has driver: codex-app-server, but ${why}. ORCA refuses the session; ` +
      `remove driver to run Codex through its ACP adapter.`,
    { agentId: agent.id, ...(host ? { host: host.id } : {}) },
  );
}

/** What ORCA starts for the driver: the Codex CLI's executable and its arguments. */
export interface CodexAppServerLaunch {
  /** The executable found for the agent's `command`. */
  command: string;
  /** The agent's own `args` (Codex's global options), then `app-server`. */
  args: string[];
  /** The agent's environment, exactly as configured: ORCA adds nothing to it. */
  env: Env;
}

/**
 * The launch for an agent on ORCA's own host: its `command` found as an executable (an
 * absolute path as it is, a relative one from `cwd`, a bare name on the `PATH` the agent will
 * see), then `app-server` after the agent's own arguments. Refused, naming what to install or
 * set, when no executable is found. Reads nothing but the directories it searches.
 */
export async function codexAppServerLaunch(
  agent: Pick<AgentSpec, "id" | "command" | "args" | "env">,
  options: { cwd: string; env?: Readonly<Record<string, string | undefined>> },
): Promise<CodexAppServerLaunch> {
  const fromAgent = agent.env.PATH;
  const path = typeof fromAgent === "string" ? fromAgent : (options.env ?? process.env).PATH;
  const found = await findLocalExecutable(agent.command, options.cwd, path);
  if (found === undefined)
    throw new OrcaError(
      "AGENT_NOT_FOUND",
      `agent ${agent.id} has driver: codex-app-server, but ORCA found no Codex CLI at ${JSON.stringify(agent.command)}` +
        (agent.command.includes("/") || agent.command.includes("\\") ? "" : " on the agent's PATH") +
        `. Install Codex (npm install -g @openai/codex) or set command to the path of its codex executable.`,
      { agentId: agent.id, command: agent.command },
    );
  return { command: found, args: [...agent.args, CODEX_APP_SERVER_SUBCOMMAND], env: agent.env };
}

/**
 * The parameters ORCA sends with `account/read`: none. In particular no `refreshToken`, which
 * would have Codex refresh, and write, the user's credentials on ORCA's request.
 */
export const CODEX_ACCOUNT_READ_PARAMS: Readonly<Record<string, never>> = Object.freeze({});

const ACCOUNT_KINDS = ["apiKey", "chatgpt", "amazonBedrock", "gcp"] as const;

/**
 * `account/read`'s answer as Codex 0.171.0 generates it (`GetAccountResponse`): `account` is
 * `null` or an object whose `type` is one of `ACCOUNT_KINDS`, and `requiresOpenaiAuth` a
 * boolean. Only those two fields are read. `undefined` for any other shape.
 */
function readAccount(answer: unknown): { kind: CodexAccountKind; requiresOpenaiAuth: boolean } | undefined {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined;
  const { account, requiresOpenaiAuth } = answer as { account?: unknown; requiresOpenaiAuth?: unknown };
  if (typeof requiresOpenaiAuth !== "boolean") return undefined;
  if (account === null) return { kind: "none", requiresOpenaiAuth };
  if (typeof account !== "object" || account === undefined || Array.isArray(account)) return undefined;
  const type = (account as { type?: unknown }).type;
  const kind = ACCOUNT_KINDS.find((k) => k === type);
  return kind === undefined ? undefined : { kind, requiresOpenaiAuth };
}

/** The kinds of account Codex reports, or `none`. */
export type CodexAccountKind = "apiKey" | "chatgpt" | "amazonBedrock" | "gcp" | "none";

/**
 * Whether the Codex behind a session may run, from its `account/read` answer: `undefined` when
 * it reports an account, of any kind the user set up, or needs none (a provider without OpenAI
 * sign-in); the refusal, naming `codex login`, when it needs one and has none. An answer that
 * is not one of those shapes is refused too, since ORCA cannot tell what Codex would run as.
 * Only the account's kind is read; its email, plan and workspace are left alone.
 */
export function codexLoginRefused(agentId: string, answer: unknown): OrcaError | undefined {
  const read = readAccount(answer);
  if (read === undefined)
    return new OrcaError(
      "AGENT_PROTOCOL",
      `agent ${agentId}: Codex answered account/read with a shape ORCA does not know, so ORCA cannot tell ` +
        `whether it is signed in. ORCA refuses the session; check that the Codex CLI is a version ORCA supports.`,
      { agentId },
    );
  if (read.kind === "none" && read.requiresOpenaiAuth)
    return new OrcaError(
      "NOT_SUPPORTED",
      `agent ${agentId}: Codex is not signed in. Run \`codex login\` as the account ORCA runs Codex as ` +
        `(with the same CODEX_HOME), then start the run again. ORCA does not sign in to Codex itself.`,
      { agentId, reason: "codex-login-required" },
    );
  return undefined;
}

/** The kind of account an `account/read` answer reports, for diagnostics; `undefined` when unknown. */
export function codexAccountKind(answer: unknown): CodexAccountKind | undefined {
  return readAccount(answer)?.kind;
}
