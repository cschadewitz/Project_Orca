/**
 * Gemini CLI as an ACP agent (`gemini --acp`): what ORCA knows about it, at which version, and
 * which of its own settings let a tool call run without ever reaching ORCA (#705, tiers A and B).
 *
 * ORCA installs no hook in Gemini CLI: `nativeToolHook: on` is refused for it. ORCA decides
 * only the calls Gemini asks about (`session/request_permission`), and answers those with a
 * one-time option (`permissions.ts`, `orchestrator.ts`). Everything here is about the calls
 * Gemini decides alone, observed on the installed CLI by `gemini-acp-acceptance-705.test.ts`
 * (`gemini-acp-acceptance.yml`) or read in its source at the pinned version:
 *
 * - **Read-only tools that never ask**, as observed: `list_directory`, `glob` and `read_file`
 *   ran in Gemini's default mode without a permission request, and the `read_file` the suite
 *   ran made no `fs/*` call either. Gemini's other read-only tools (`grep_search`,
 *   `read_many_files`, web fetch, …) were not run and are unverified.
 * - **Gemini's own grants.** "Allow for this session" (`proceed_always`) covers the whole
 *   command prefix for the rest of the session (`echo a` grants `echo b`), and
 *   `proceed_always_and_save` writes a policy file under Gemini's home that allows the prefix
 *   in every later session, even when the request did not offer it. ORCA never answers with
 *   either; a person answering through ORCA is offered one-time choices only.
 * - **Settings outside ORCA.** The user's `~/.gemini` (saved policies, `tools.allowed`,
 *   `general.defaultApprovalMode`, extensions, trusted folders), a trusted workspace's
 *   `.gemini/settings.json`, and flags such as `--yolo` or `--approval-mode` in a trusted
 *   workspace all let calls run unasked. In a workspace Gemini does not trust it keeps its
 *   default mode, whatever the flags or `session/set_mode` say.
 *
 * `geminiCliFindings` is an advisory, not a guard: it reports the known settings it can see in
 * an agent's command line and environment. It does not read files (a Gemini home's settings
 * and policies, system settings, extensions, trusted folders), so it cannot see what they
 * allow, and an empty list does not mean nothing does. `geminiCliLaunch` gives a profile with
 * none of the settings it knows: its own Gemini home, so what the user saved in `~/.gemini`
 * does not apply. What is in that home is the profile's owner's to keep empty; ORCA does not
 * check it.
 */
import { basename } from "node:path";

/** The name Gemini CLI reports in `initialize`'s `agentInfo`. */
export const GEMINI_CLI_AGENT_NAME = "gemini-cli";

/**
 * Support levels, lowest first, shared with the other agents' modules and the coverage page
 * (`docs/agent-hook-coverage.md`).
 * - `source-reviewed`: read in the agent's source at the version, not run;
 * - `connectivity-tested`: an ORCA session opens, streams, is cancelled and closes on the
 *   installed agent;
 * - `approval-tested`: on the installed agent, an ORCA allow runs once and asks again, a deny
 *   or a cancelled ask does not run, and the calls that never ask are listed;
 * - `execution-guard-certified`: the #706 acceptance suite passes (tier C). Nothing is yet.
 */
export type AgentSupportLevel =
  "source-reviewed" | "connectivity-tested" | "approval-tested" | "execution-guard-certified";

export interface AgentSupportEntry {
  /** The version `initialize` reports. */
  version: string;
  /** `process.platform` values the acceptance run covers. */
  platforms: readonly NodeJS.Platform[];
  level: AgentSupportLevel;
}

/**
 * The Gemini CLI versions ORCA has qualified, each installed and run by
 * `gemini-acp-acceptance.yml` (the suite fails if the workflow's pin is not listed here).
 * Another version may change what asks; it is not refused, since ORCA installs nothing in it,
 * but it is reported as unqualified.
 */
export const GEMINI_CLI_SUPPORT: readonly AgentSupportEntry[] = [
  { version: "0.70.0", platforms: ["linux"], level: "approval-tested" },
];

/** What a level says for a version Gemini reports, or undefined when it is not qualified. */
export function geminiCliSupport(
  agentInfo: { name: string; version: string } | undefined,
  platform: NodeJS.Platform = process.platform,
): AgentSupportEntry | undefined {
  if (agentInfo?.name !== GEMINI_CLI_AGENT_NAME) return undefined;
  return GEMINI_CLI_SUPPORT.find((e) => e.version === agentInfo.version && e.platforms.includes(platform));
}

/**
 * What answering a Gemini permission request with an option does, by its id at 0.70.0
 * (`ToolConfirmationOutcome`, `toPermissionOptions` in `packages/cli/src/acp/acpUtils.ts`).
 * - `once`: this call only; the next one asks again.
 * - `session`: Gemini stops asking for the rest of the session, for the whole command prefix
 *   (shell), file (edit), tool or MCP server.
 * - `saved`: also written to a policy file in Gemini's home, so it holds in later sessions.
 * - `reject`: the call does not run.
 * - `unknown`: not an id Gemini 0.70.0 defines.
 */
export type GeminiOptionEffect = "once" | "session" | "saved" | "reject" | "unknown";

const OPTION_EFFECTS: Readonly<Record<string, GeminiOptionEffect>> = {
  proceed_once: "once",
  proceed_always: "session",
  proceed_always_server: "session",
  proceed_always_tool: "session",
  proceed_always_and_save: "saved",
  cancel: "reject",
};

export function geminiOptionEffect(optionId: string): GeminiOptionEffect {
  return Object.hasOwn(OPTION_EFFECTS, optionId) ? OPTION_EFFECTS[optionId]! : "unknown";
}

/** Something in an agent's configuration that lets calls run without reaching ORCA. */
export interface AgentProfileFinding {
  /** Stable id, for tests and for a UI to key on. */
  id: string;
  /**
   * `bypass`: tool calls run that would otherwise have asked ORCA. `outside`: settings ORCA
   * does not control apply, and may allow calls ORCA never sees.
   */
  effect: "bypass" | "outside";
  message: string;
}

/**
 * Whether an agent is configured to run Gemini CLI in ACP mode. A routing hint from the
 * command line only (the executable is `gemini`, or Node runs a `gemini` script or the
 * `@google/gemini-cli` package), never proof of what runs; `geminiCliSupport` on the
 * `initialize` answer is the check.
 */
export function isGeminiCliAgent(agent: { command: string; args: readonly string[] }): boolean {
  const named = (p: string) => {
    const b = basename(p.replaceAll("\\", "/")).replace(/\.(exe|cmd|js|mjs)$/i, "");
    return b === "gemini" || p.replaceAll("\\", "/").includes("/@google/gemini-cli/");
  };
  const acp = agent.args.includes("--acp") || agent.args.includes("--experimental-acp");
  return acp && (named(agent.command) || agent.args.some((a) => !a.startsWith("-") && named(a)));
}

/** A flag's values, whether written `--flag value` or `--flag=value`. */
function flagValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag && i + 1 < args.length) out.push(args[i + 1]!);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  });
  return out;
}

const hasFlag = (args: readonly string[], ...flags: string[]) =>
  args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));

/**
 * An advisory: the known settings, among those it can inspect in an agent's command line and
 * environment, under which Gemini CLI 0.70.0 runs tool calls without asking ORCA or reads
 * settings ORCA does not control. It reads no file and runs nothing, so a setting inside a
 * settings or policy file, an extension or a trusted-folders list is not seen; an empty list
 * is not a finding that nothing bypasses ORCA. Empty for an agent that is not Gemini CLI.
 * Nothing is refused on these: they are the user's to choose, and `orca agents` shows them
 * so the choice is visible.
 */
export function geminiCliFindings(agent: {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, unknown>>;
}): AgentProfileFinding[] {
  if (!isGeminiCliAgent(agent)) return [];
  const { args, env } = agent;
  const findings: AgentProfileFinding[] = [];
  const set = (name: string) => env[name] !== undefined && env[name] !== "";
  // Gemini forces its default mode in a workspace it does not trust (`config.ts`, observed),
  // so these bypass only where the workspace can be trusted: a trust flag, or a Gemini home
  // or trust file ORCA does not control.
  const trustable =
    hasFlag(args, "--skip-trust") ||
    env["GEMINI_CLI_TRUST_WORKSPACE"] === "true" ||
    !set("GEMINI_CLI_HOME") ||
    set("GEMINI_CLI_TRUSTED_FOLDERS_PATH") ||
    set("GEMINI_CLI_SYSTEM_SETTINGS_PATH") ||
    set("GEMINI_CLI_SYSTEM_DEFAULTS_PATH");
  const inert = trustable ? "" : " (inert while the workspace is untrusted: Gemini then keeps its default mode)";
  const modes = flagValues(args, "--approval-mode");
  if (hasFlag(args, "--yolo", "-y") || modes.includes("yolo"))
    findings.push({
      id: "yolo",
      effect: trustable ? "bypass" : "outside",
      message: `YOLO mode: Gemini runs every tool call without asking${inert}`,
    });
  if (modes.includes("auto_edit"))
    findings.push({
      id: "auto-edit",
      effect: trustable ? "bypass" : "outside",
      message: `--approval-mode auto_edit: Gemini makes file edits without asking${inert}`,
    });
  if (hasFlag(args, "--allowed-tools"))
    findings.push({
      id: "allowed-tools",
      effect: "bypass",
      message: "--allowed-tools: the tools listed run without asking",
    });
  if (hasFlag(args, "--policy", "--admin-policy"))
    findings.push({
      id: "policy-files",
      effect: "bypass",
      message: "--policy/--admin-policy: Gemini's policy files can allow calls without asking",
    });
  if (hasFlag(args, "--skip-trust") || env["GEMINI_CLI_TRUST_WORKSPACE"] === "true")
    findings.push({
      id: "trusted-workspace",
      effect: "outside",
      message:
        "the workspace is trusted: its .gemini settings, policies and hooks apply, and a repository can carry them",
    });
  if (!set("GEMINI_CLI_HOME"))
    findings.push({
      id: "user-home",
      effect: "outside",
      message:
        'no GEMINI_CLI_HOME: the user\'s ~/.gemini applies (saved "always allow" policies, tools.allowed, default approval mode, extensions, trusted folders)',
    });
  for (const name of [
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
  ])
    if (set(name))
      findings.push({
        id: name.toLowerCase().replaceAll("_", "-"),
        effect: "outside",
        message: `${name}: Gemini reads settings from a file ORCA does not control`,
      });
  return findings;
}

/**
 * A launch profile for Gemini CLI with none of `geminiCliFindings`: ACP mode, default approval
 * mode, and a Gemini home of its own (`home`, a directory ORCA or the user creates for this
 * agent), so the user's saved grants, extensions and trusted folders do not apply. Credentials
 * are the caller's: `GEMINI_API_KEY` as a secret reference (#336), or a sign-in made with that
 * same home.
 */
export function geminiCliLaunch(opts: { home: string; command?: string }): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { command: opts.command ?? "gemini", args: ["--acp"], env: { GEMINI_CLI_HOME: opts.home } };
}
