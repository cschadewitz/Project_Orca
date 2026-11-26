/**
 * Local executable availability only: no shell, agent handshake, sign-in, version probe or
 * provider operation. For `driver: codex-app-server` (#1167) the executable's bytes are also
 * compared by digest with the Codex builds ORCA pinned; it is still never executed.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import type { FirstRunAgentCheck } from "../../first-run-contract.js";
import { CODEX_PINNED_IMAGES, pinnedCodexVersion } from "./codex-pins.js";
/** Configured basename is a routing hint, never executable/artifact/source correspondence. */
function configuredRoute(
  command: string,
  args: readonly string[] = [],
  driver?: string,
): FirstRunAgentCheck["evidence"]["configuredRoute"] {
  // The driver the config names decides the route, whatever the command is called.
  if (driver === "codex-app-server") return "codex-app-server-candidate";
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
/** The most bytes the pin check reads: well above any pinned build, so it never reads without bound. */
export const CODEX_PIN_MAX_BYTES = 512 * 1024 * 1024;
/** How long the pin check may take before it gives up: it is advisory and must not hold the review. */
export const CODEX_PIN_TIMEOUT_MS = 15_000;

/**
 * Compares the open file's bytes, read through `file`, with the pins. Only on a platform that
 * has a pin; never past `maxBytes` or `timeoutMs`; and `unreadable` unless the file is the same
 * (inode, size, modification and change times) before and after, and was read to its end.
 */
async function codexPin(
  file: import("node:fs/promises").FileHandle,
  target: string,
  limits: {
    pins?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<NonNullable<FirstRunAgentCheck["evidence"]["codexPin"]>> {
  const pins = limits.pins ?? CODEX_PINNED_IMAGES;
  if (!Object.values(pins).some((images) => images[target] !== undefined)) return { state: "no-platform-pin" };
  const maxBytes = limits.maxBytes ?? CODEX_PIN_MAX_BYTES;
  const deadline = Date.now() + (limits.timeoutMs ?? CODEX_PIN_TIMEOUT_MS);
  try {
    const before = await file.stat();
    if (before.size > maxBytes) return { state: "unreadable" };
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1 << 20);
    let position = 0;
    for (;;) {
      if (Date.now() > deadline) return { state: "unreadable" };
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > maxBytes) return { state: "unreadable" };
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    const same =
      position === before.size &&
      after.size === before.size &&
      after.ino === before.ino &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs;
    if (!same) return { state: "unreadable" };
    const version = pinnedCodexVersion(hash.digest("hex"), target, pins);
    return version ? { state: "pinned", version } : { state: "unpinned" };
  } catch {
    return { state: "unreadable" };
  }
}
export async function inspectLocalTool(
  agent: {
    id: string;
    command: string;
    args?: readonly string[];
    driver?: string | undefined;
    env: Record<string, string>;
  },
  /** This machine's pin key, the pins and the pin check's bounds: for tests only. */
  codex: {
    target?: string;
    pins?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<FirstRunAgentCheck> {
  const target = codex.target ?? `${process.platform}-${process.arch}`;
  const result = (
    state: FirstRunAgentCheck["state"],
    pin?: FirstRunAgentCheck["evidence"]["codexPin"],
  ): FirstRunAgentCheck => ({
    agentId: agent.id,
    state,
    evidence: {
      configuredRoute: configuredRoute(agent.command, agent.args, agent.driver),
      support: "unknown",
      version: "unknown",
      architecture: state === "architecture" ? "mismatch" : "unknown",
      acp: "not-checked",
      signIn: "unknown",
      exactCommand: "unsupported",
      ...(pin ? { codexPin: pin } : {}),
    },
  });
  const candidates = isAbsolute(agent.command)
    ? [agent.command]
    : agent.command.includes("/") || agent.command.includes("\\")
      ? []
      : (agent.env.PATH ?? process.env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .slice(0, 64)
          .map((path) => join(path, agent.command));
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
        return result(
          "handshake-required",
          agent.driver === "codex-app-server" ? await codexPin(file, target, codex) : undefined,
        );
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
