/**
 * pi as an ACP agent, through the `pi-acp` adapter (#705, tier A: connectivity tested): what ORCA knows
 * about it, at which versions, and what that means for ORCA's permission rules.
 *
 * **pi never asks before a tool call.** Its built-in tools (`bash`, `read`, `edit`, `write`,
 * …) run on their own, and `pi-acp` serves no file operation through ORCA, so ORCA's rules,
 * its protected files and its `fs/*` boundary do not apply to a pi agent. Observed on the
 * installed agent by `pi-acp-acceptance-705.test.ts` (`pi-acp-acceptance.yml`). Casey chose
 * (2026-11-23) to run pi and say so plainly rather than refuse it: `piFindings` reports it for
 * every pi agent, and `orca agents` shows it. **Running pi requires an operating-system sandbox**
 * (a container or VM holding only what pi may touch): that sandbox is the only boundary, and
 * ORCA does not provide or check it. pi is connectivity tested, not approval tested: no tool
 * call of pi's is ever an ORCA approval.
 *
 * The one thing that reaches ORCA as a permission request is a pi extension's own dialog
 * (`ctx.ui.confirm`/`select`): `pi-acp` turns it into a request on a synthetic `pi-ui-*` call
 * of kind `other`, with options `yes`/`no` (or `choice-<n>`), and answers the extension with
 * the label. That is the extension's question, not an ORCA tool approval: the call it may be
 * about stays outside ORCA's policy enforcement (#747), and an ORCA rule that allows kind
 * `other` answers it "yes" unattended.
 */
import { basename } from "node:path";
import type { AgentProfileFinding, AgentSupportEntry } from "./gemini-cli.js";

/** The name `pi-acp` reports in `initialize`'s `agentInfo`. */
export const PI_ACP_AGENT_NAME = "pi-acp";

/**
 * The `pi-acp` versions ORCA has qualified, each installed with the pi it is paired with
 * (`pi` below) and run by `pi-acp-acceptance.yml` (the suite fails if the workflow's pins are
 * not listed here). `pi-acp` reports only its own version; the pi it starts is whichever `pi`
 * it finds (`PI_ACP_PI_COMMAND`, else `PATH`). The level is connectivity: pi's tool calls never
 * ask ORCA, so there is no approval to test, and the suite records only that they run unasked.
 */
export const PI_ACP_SUPPORT: readonly (AgentSupportEntry & { pi: string })[] = [
  { version: "0.0.35", pi: "1.6.0", platforms: ["linux"], level: "connectivity-tested" },
];

/** What a level says for the adapter version `pi-acp` reports, or undefined when unqualified. */
export function piAcpSupport(
  agentInfo: { name: string; version: string } | undefined,
  platform: NodeJS.Platform = process.platform,
): (AgentSupportEntry & { pi: string }) | undefined {
  if (agentInfo?.name !== PI_ACP_AGENT_NAME) return undefined;
  return PI_ACP_SUPPORT.find((e) => e.version === agentInfo.version && e.platforms.includes(platform));
}

/**
 * Whether an agent is configured to run `pi-acp`: the executable is `pi-acp`, or Node runs a
 * `pi-acp` script or the `pi-acp` package. A routing hint only; `piAcpSupport` on the
 * `initialize` answer is the check.
 */
export function isPiAcpAgent(agent: { command: string; args: readonly string[] }): boolean {
  const named = (p: string) => {
    const path = p.replaceAll("\\", "/");
    return basename(path).replace(/\.(exe|cmd|js|mjs)$/i, "") === "pi-acp" || path.includes("/pi-acp/dist/");
  };
  return named(agent.command) || agent.args.some((a) => !a.startsWith("-") && named(a));
}

/**
 * An advisory for a pi agent: always that pi runs every tool call without asking ORCA, and,
 * from the environment it can inspect, whether pi reads the user's own agent directory. It
 * reads no file, so what an agent directory, extension or package holds is not seen.
 */
export function piFindings(agent: {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, unknown>>;
}): AgentProfileFinding[] {
  if (!isPiAcpAgent(agent)) return [];
  const set = (name: string) => agent.env[name] !== undefined && agent.env[name] !== "";
  const findings: AgentProfileFinding[] = [
    {
      id: "pi-never-asks",
      effect: "bypass",
      message:
        "pi runs every tool call without asking: ORCA's permission rules and protected files do not apply to it; run it in a sandbox",
    },
  ];
  if (!set("PI_CODING_AGENT_DIR"))
    findings.push({
      id: "pi-user-agent-dir",
      effect: "outside",
      message:
        "no PI_CODING_AGENT_DIR: the user's ~/.pi/agent applies (settings, extensions, saved project trust, credentials)",
    });
  return findings;
}

/**
 * A launch profile for pi through `pi-acp` with an agent directory of its own (`agentDir`, for
 * settings, models, credentials and extensions), so nothing the user installed in `~/.pi`
 * runs in it. `pi` is the pi executable `pi-acp` starts; give it to pin which pi runs.
 */
export function piAcpLaunch(opts: { agentDir: string; pi?: string; command?: string }): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: opts.command ?? "pi-acp",
    args: [],
    env: { PI_CODING_AGENT_DIR: opts.agentDir, ...(opts.pi ? { PI_ACP_PI_COMMAND: opts.pi } : {}) },
  };
}
