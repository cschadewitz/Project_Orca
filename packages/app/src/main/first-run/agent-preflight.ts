/** Local executable availability only: no shell, agent handshake, sign-in, version probe or provider operation. */
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import type { FirstRunAgentCheck } from "../../first-run-contract.js";
/** Configured basename is a routing hint, never executable/artifact/source correspondence. */
function configuredRoute(
  command: string,
  args: readonly string[] = [],
  driver?: string,
): FirstRunAgentCheck["evidence"]["configuredRoute"] {
  // The configured driver, not a command name: the person's own `claude`, run through the
  // Claude Agent SDK (#1131, experimental, held on its feature branch).
  if (driver === "claude-agent-sdk") return "claude-agent-sdk-candidate";
  const name = win32.basename(command).replace(/\.exe$/i, "");
  if (name === "claude-code-acp") return "claude-code-acp-candidate";
  if (name === "codex-acp") return "codex-acp-candidate";
  if (name.toLowerCase() === "copilot") return "copilot-cli-acp-candidate";
  if (name.toLowerCase() === "cline") return "cline-acp-candidate";
  // OpenCode is one executable; only its `acp` subcommand speaks ACP (#710).
  if (name === "opencode" && args[0] === "acp") return "opencode-acp-candidate";
  return "unverified";
}
/** Only a complete known thin Mach-O header can establish this narrow negative observation. */
export function machOArchitectureMismatch(header: Buffer, platform: string, arch: string): boolean {
  if (platform !== "darwin" || header.length < 8 || (arch !== "arm64" && arch !== "x64")) return false;
  const magic = header.readUInt32LE(0);
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) return false;
  const cpu = header.readUInt32LE(4);
  return cpu !== (arch === "arm64" ? 0x100000c : 0x1000007);
}
export async function inspectLocalTool(agent: {
  id: string;
  command: string;
  args?: readonly string[];
  env: Record<string, string>;
  driver?: string | undefined;
  /** The computer the agent would run on (this one): `process.platform` unless given. */
  platform?: NodeJS.Platform | undefined;
}): Promise<FirstRunAgentCheck> {
  // A `driver: claude-agent-sdk` agent with no command runs `claude` from PATH, as the daemon does.
  const command = agent.command.length === 0 && agent.driver === "claude-agent-sdk" ? "claude" : agent.command;
  const result = (state: FirstRunAgentCheck["state"]): FirstRunAgentCheck => ({
    agentId: agent.id,
    state,
    evidence: {
      configuredRoute: configuredRoute(command, agent.args, agent.driver),
      support: "unknown",
      version: "unknown",
      architecture: state === "architecture" ? "mismatch" : "unknown",
      acp: "not-checked",
      signIn: "unknown",
      exactCommand: "unsupported",
    },
  });
  // The SDK driver does not run on Windows at all (the daemon refuses it before any session),
  // so nothing is looked for: finding `claude` there would suggest a route that cannot work.
  if (agent.driver === "claude-agent-sdk" && (agent.platform ?? process.platform) === "win32")
    return result("unsupported");
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes("/") || command.includes("\\")
      ? []
      : (agent.env.PATH ?? process.env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .slice(0, 64)
          .map((path) => join(path, command));
  let state: FirstRunAgentCheck["state"] = "missing";
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      if (!(await lstat(path)).isFile()) {
        state = "unavailable";
        continue;
      }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile()) {
          state = "unavailable";
          continue;
        }
        const header = Buffer.alloc(8);
        const { bytesRead } = await file.read(header, 0, 8, 0);
        if (bytesRead < 4) {
          state = "unavailable";
          continue;
        }
        if (machOArchitectureMismatch(header.subarray(0, bytesRead), process.platform, process.arch))
          return result("architecture");
        return result("handshake-required");
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
        state = "unavailable";
    }
  }
  return result(state);
}
