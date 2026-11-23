/**
 * GitHub Copilot CLI over its own ACP server (`copilot --acp`, #709).
 *
 * ORCA talks to Copilot through the generic ACP session like any other agent. This module holds
 * only what is specific to Copilot, and every part of it closes a route by which Copilot would
 * otherwise run tools without ORCA's policy seeing them. Each was observed on the real Copilot
 * CLI (`copilot-cli-acceptance.yml`, docs/agent-support.md):
 *
 * - **Launch profile.** Flags and variables that grant approval up front (`--allow-all`,
 *   `--yolo`, `COPILOT_ALLOW_ALL`, autopilot, …) are refused, as is a GitHub token written into
 *   ORCA's config or inherited from the daemon's environment (it silently replaces the login
 *   the person chose). Copilot's own state directory must be named (`COPILOT_HOME`), so saved
 *   approvals from somebody's everyday `~/.copilot` are not inherited, and auto-update must be
 *   off so the version ORCA checked is the version that runs.
 * - **Version.** The executable is asked its version before every session and only the
 *   versions in `COPILOT_CLI_VERIFIED_VERSIONS` open.
 * - **Slash commands.** Copilot runs a prompt that starts with `/` as one of its own commands,
 *   over ACP too, and `/allow-all on`, `/yolo`, `/permissions allow-all` and `/autopilot on`
 *   turn its permission asks off for the rest of the session without any notice to the client.
 *   A prompt that starts with a slash command is refused before it is sent.
 * - **Session options.** Copilot advertises an `allow_all` option and an autopilot mode. ORCA
 *   refuses to set either, refuses a session that opens with either on, and ends a session that
 *   reports either turned on.
 * - **"Always" answers.** Copilot's "Always allow" approves the whole command name (`touch`,
 *   whatever its arguments) for the rest of the session, without asking again. ORCA answers an
 *   ask with "Allow once" instead, whatever was chosen, so every later call is asked about
 *   again and decided by ORCA's own policy, which keeps its own "always" rules.
 *
 * What stays outside, because Copilot never asks: commands Copilot classifies as read-only, file
 * reads inside the workspace, and text typed into a shell it already started. See the matrix.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { OrcaError, isSecretRef, literalEnv, type AgentSpec, type SessionConfigOption } from "@orca/core";
import type { OpenSessionOptions } from "../acp-session.js";
import type { AgentSession } from "../session.js";
import type { ProviderGuard } from "./guard.js";

/**
 * The Copilot CLI versions ORCA has run its acceptance suite against. Another version is
 * refused: the routes above are behaviour of one version, and a later one can add another.
 * Moving the pin is a reviewed change here and in `copilot-cli-acceptance.yml` together.
 */
export const COPILOT_CLI_VERIFIED_VERSIONS: readonly string[] = ["1.0.114"];

/** Launch options that grant, widen or bypass Copilot's own permission asks. */
const GRANTING_FLAGS = [
  "--allow-all",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-all-urls",
  "--yolo",
  "--allow-tool",
  "--allow-url",
  "--autopilot",
  "--assisted-approval",
  "--no-sandbox",
  "--trust-folder",
  "--add-dir",
] as const;
/** Options that change what ORCA is talking to, or resume somebody else's session. */
const TRANSPORT_FLAGS = ["--port", "--resume", "--continue", "--prompt", "-p"] as const;
/** Variables that carry a credential. A literal in ORCA's config is refused; a secret reference is fine. */
export const COPILOT_TOKEN_VARIABLES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_PROVIDER_API_KEY",
] as const;
/** Variables that would turn permission asks off, by their documented truthy spellings. */
const GRANTING_VARIABLES = ["COPILOT_ALLOW_ALL", "COPILOT_PLAN_THEN_AUTOPILOT", "COPILOT_ASSISTED_APPROVAL"] as const;
/** The documented false spellings of a boolean variable; absence counts as false too. */
const FALSEY = new Set(["false", "0", "no", "off", "n", ""]);

const flagName = (arg: string) => arg.split("=", 1)[0]!;

/** Copilot's executable name: `copilot` (Linux, macOS) or `copilot.exe` (Windows). */
export function isCopilotCliAgent(agent: Pick<AgentSpec, "command" | "args" | "type">): boolean {
  if (agent.type === "orca-daemon") return false;
  const name = win32
    .basename(agent.command)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (name === "copilot") return true;
  // A package runner that would fetch Copilot at launch is Copilot too, and is refused below.
  return /^(npx|pnpx|bunx|npm|pnpm)$/i.test(name) && agent.args.some((a) => a.startsWith("@github/copilot"));
}

/**
 * What is wrong with this launch profile, as the host would start it: the agent's `env` over
 * `ambient`, the daemon's own environment, less what ORCA withholds for secrets. Empty when
 * none of the known hazards is present; it says nothing about the version, which is checked
 * against the executable itself.
 */
export function copilotCliProfileProblems(
  agent: AgentSpec,
  ambient: Readonly<Record<string, string | undefined>>,
  hostType: "local" | "ssh" | undefined,
): string[] {
  const problems: string[] = [];
  const name = win32
    .basename(agent.command)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (name !== "copilot")
    problems.push(
      "command: start the copilot executable itself (an absolute path), not a package runner that fetches a version at launch",
    );
  else if (!isAbsolute(agent.command) && !win32.isAbsolute(agent.command))
    problems.push("command: give the copilot executable as an absolute path, so PATH order cannot swap it");
  if (hostType !== "local")
    problems.push(
      "host: Copilot is supported on this computer only; its environment on another host cannot be checked",
    );

  const flags = agent.args.map(flagName);
  if (!flags.includes("--acp")) problems.push("args: --acp is missing");
  if (!flags.includes("--no-auto-update")) problems.push("args: --no-auto-update is missing");
  for (const flag of GRANTING_FLAGS)
    if (flags.includes(flag)) problems.push(`args: ${flag} approves tools without asking ORCA`);
  for (const flag of TRANSPORT_FLAGS) if (flags.includes(flag)) problems.push(`args: ${flag} is not supported`);
  const mode = agent.args.findIndex((a) => flagName(a) === "--mode");
  if (mode >= 0) {
    const arg = agent.args[mode]!;
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : agent.args[mode + 1];
    if (value !== "interactive") problems.push(`args: --mode ${value ?? ""} is not supported`.trim());
  }

  const literal = literalEnv(agent.env);
  const effective: Record<string, string | undefined> = { ...ambient, ...literal };
  for (const variable of GRANTING_VARIABLES) {
    const value = effective[variable];
    if (value !== undefined && !FALSEY.has(value.trim().toLowerCase()))
      problems.push(
        `env: ${variable} approves tools without asking ORCA${literal[variable] === undefined ? " (inherited from the daemon's environment)" : ""}`,
      );
  }
  if (!FALSEY.has((effective.COPILOT_AUTO_UPDATE ?? "unset").trim().toLowerCase()))
    problems.push('env: set COPILOT_AUTO_UPDATE to "false"');
  const home = literal.COPILOT_HOME;
  if (!home || !(isAbsolute(home) || win32.isAbsolute(home)))
    problems.push(
      "env: set COPILOT_HOME to an absolute directory of its own, so approvals saved in another Copilot profile do not apply",
    );
  for (const variable of [...COPILOT_TOKEN_VARIABLES, "COPILOT_PROVIDER_API_KEY_COMMAND"]) {
    const configured = agent.env[variable];
    if (configured !== undefined && !isSecretRef(configured))
      problems.push(`env: ${variable} is written into ORCA's config; refer to it as a secret instead`);
    else if (configured === undefined && (ambient[variable] ?? "") !== "")
      problems.push(
        `env: ${variable} is inherited from the daemon's environment and would replace the Copilot sign-in; define it as a secret (which withholds it) or start ORCA without it`,
      );
  }
  return problems;
}

/** `copilot --version` prints "GitHub Copilot CLI 1.0.114." */
export function parseCopilotCliVersion(output: string): string | undefined {
  return /GitHub Copilot CLI (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

export type VersionProbe = (command: string, env: Record<string, string | undefined>) => Promise<string>;

/** Runs the executable with `--version` only: no session, no network, no sign-in. */
export const probeCopilotCliVersion: VersionProbe = (command, env) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      ["--no-auto-update", "--version"],
      { env: { ...env, COPILOT_AUTO_UPDATE: "false" }, timeout: 15_000, windowsHide: true },
      (error, stdout) => (error ? reject(new Error(error.message, { cause: error })) : resolve(String(stdout))),
    );
  });

/** Versions already read, by executable path and its size and modification time. */
const versionCache = new Map<string, string>();

async function checkVersion(
  agent: AgentSpec,
  env: Record<string, string | undefined>,
  probe: VersionProbe,
): Promise<void> {
  let key: string | undefined;
  try {
    const info = await stat(agent.command);
    key = `${agent.command}\0${info.size}\0${info.mtimeMs}`;
  } catch {
    /* Not readable here: probe anyway, which reports the real failure. */
  }
  let version = key ? versionCache.get(key) : undefined;
  if (!version) {
    let output: string;
    try {
      output = await probe(agent.command, env);
    } catch (error) {
      throw new OrcaError(
        "AGENT_TRANSPORT",
        `Copilot CLI for agent '${agent.id}' could not report its version: ${error instanceof Error ? error.message : String(error)}`,
        { agentId: agent.id },
      );
    }
    version = parseCopilotCliVersion(output);
    if (!version)
      throw new OrcaError(
        "NOT_SUPPORTED",
        `Agent '${agent.id}' did not report a Copilot CLI version; ORCA opens only Copilot CLI ${COPILOT_CLI_VERIFIED_VERSIONS.join(", ")}.`,
        { agentId: agent.id },
      );
    if (key) versionCache.set(key, version);
  }
  if (!COPILOT_CLI_VERIFIED_VERSIONS.includes(version))
    throw new OrcaError(
      "NOT_SUPPORTED",
      `Agent '${agent.id}' runs Copilot CLI ${version}; ORCA has verified only ${COPILOT_CLI_VERIFIED_VERSIONS.join(", ")}. Install that version and keep auto-update off.`,
      { agentId: agent.id, version, verified: [...COPILOT_CLI_VERIFIED_VERSIONS] },
    );
}

/** A prompt Copilot would run as one of its own commands: text whose first character is `/`. */
export function startsWithSlashCommand(input: string | readonly acp.ContentBlock[]): boolean {
  const blocks: readonly acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
  return blocks.some((b) => b.type === "text" && /^\s*\//.test(b.text));
}

/** Copilot's session options that turn its permission asks off. */
export function grantingOption(configId: string, value: unknown): boolean {
  if (configId === "allow_all") return value === true || value === "on";
  if (configId === "mode") return typeof value === "string" && /autopilot/i.test(value);
  return false;
}

function grantingOptionsIn(options: readonly SessionConfigOption[]): string[] {
  return options.filter((o) => grantingOption(o.id, (o as { currentValue?: unknown }).currentValue)).map((o) => o.id);
}

/** "Always allow" becomes "Allow once"; with no once option offered, nothing is chosen. */
export function boundedOptionId(request: acp.RequestPermissionRequest, chosen: string | undefined): string | undefined {
  if (chosen === undefined) return undefined;
  const option = request.options.find((o) => o.optionId === chosen);
  if (!option) return chosen;
  if (option.kind === "allow_always") return request.options.find((o) => o.kind === "allow_once")?.optionId;
  if (option.kind === "reject_always") return request.options.find((o) => o.kind === "reject_once")?.optionId ?? chosen;
  return chosen;
}

/** Enforce the session half: slash prompts, allow-all and autopilot. */
export function guardCopilotSession(session: AgentSession): AgentSession {
  let tripped: string[] = grantingOptionsIn(session.configOptions);
  const refuseOpen = tripped.length > 0;
  const fail = (what: string) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `Copilot session ${what}: ${tripped.join(", ")} approves tools without asking ORCA, so the session was ended.`,
      { agentId: session.agentId, options: [...tripped] },
    );
  const stop = session.onUpdate((e) => {
    if (e.raw.sessionUpdate !== "config_option_update") return;
    const on = grantingOptionsIn(session.configOptions);
    if (!on.length) return;
    tripped = on;
    void session.cancel().finally(() => session.close());
  });
  const guarded: AgentSession = Object.create(session) as AgentSession;
  Object.defineProperties(guarded, {
    prompt: {
      value: async (input: Parameters<AgentSession["prompt"]>[0], options?: Parameters<AgentSession["prompt"]>[1]) => {
        if (tripped.length) throw fail("turned on");
        if (startsWithSlashCommand(input))
          throw new OrcaError(
            "NOT_SUPPORTED",
            "Copilot runs a prompt that starts with '/' as one of its own commands, some of which turn its permission asks off; ORCA does not send one. Reword the prompt so it does not start with '/'.",
            { agentId: session.agentId },
          );
        const result = await session.prompt(input, options);
        if (tripped.length) throw fail("turned on");
        return result;
      },
    },
    setConfigOption: {
      value: async (configId: string, value: string | boolean) => {
        if (grantingOption(configId, value))
          throw new OrcaError(
            "NOT_SUPPORTED",
            `ORCA does not set Copilot's '${configId}' to '${String(value)}': it approves tools without asking ORCA.`,
            { agentId: session.agentId, configId },
          );
        return session.setConfigOption(configId, value);
      },
    },
    close: {
      value: async () => {
        stop();
        return session.close();
      },
    },
  });
  if (refuseOpen) {
    void session.close();
    throw fail("opened with");
  }
  return guarded;
}

export interface CopilotCliGuardOptions {
  /** Reads the executable's version; `probeCopilotCliVersion` by default. */
  probe?: VersionProbe;
  /** The daemon's environment, which a local agent inherits; `process.env` by default. */
  environment?: () => Readonly<Record<string, string | undefined>>;
}

export function copilotCliGuard(guardOptions: CopilotCliGuardOptions = {}): ProviderGuard {
  const probe = guardOptions.probe ?? probeCopilotCliVersion;
  const environment = guardOptions.environment ?? (() => process.env);
  return {
    id: "copilot-cli",
    matches: (agent) => isCopilotCliAgent(agent),
    async prepare(options: OpenSessionOptions): Promise<OpenSessionOptions> {
      const { agent, host } = options;
      const withheld = new Set(
        Object.values(options.secrets ?? {})
          .filter((d) => d.host === host.id && d.provider === "env")
          .map((d) => (d.provider === "env" ? d.name : "")),
      );
      const ambient = Object.fromEntries(Object.entries(environment()).filter(([k]) => !withheld.has(k)));
      const problems = copilotCliProfileProblems(agent, ambient, host.spec?.type);
      if (problems.length)
        throw new OrcaError("CONFIG_INVALID", `Copilot agent '${agent.id}' cannot start: ${problems.join("; ")}.`, {
          agentId: agent.id,
          problems,
        });
      await checkVersion(agent, { ...ambient, ...literalEnv(agent.env) }, probe);
      const ask = options.askPermission;
      return ask
        ? {
            ...options,
            askPermission: async (request, invocation) => boundedOptionId(request, await ask(request, invocation)),
          }
        : options;
    },
    guard: guardCopilotSession,
  };
}
