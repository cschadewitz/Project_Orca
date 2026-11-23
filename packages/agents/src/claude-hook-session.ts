/**
 * Installing ORCA's Claude `PreToolUse` hook (`claude-pre-tool-hook.ts`) in a session (#704).
 *
 * The hook goes in through the Claude ACP adapter's programmatic settings tier:
 * `session/new`'s `_meta.claudeCode.options.settings`, as an object. ORCA decides whether to
 * send it once the agent has answered `initialize`, because only then does it know which
 * adapter it is talking to and at what version:
 *
 * - **Not the Claude adapter, or an agent that does not say who it is**: refused. The agent
 *   opted in to the hook, and no other agent here takes it, so the session would run without
 *   the check it asked for.
 * - **The Claude adapter at a version the acceptance test has not covered**: refused. Each
 *   pair in `CLAUDE_HOOK_VERIFIED_PAIRS` is one `claude-hook-acceptance.yml` installs and runs: the hook runs on remembered calls, `ask`
 *   reaches ORCA, and a hook that cannot start, crashes, times out or answers JSON Claude
 *   cannot read blocks the call. Another version may behave differently (an older Claude Code
 *   may ignore `onFailure: "block"`), so a session there would only look guarded.
 * - **A platform the acceptance test does not run on**: refused, for the same reason
 *   (`CLAUDE_HOOK_VERIFIED_PLATFORMS`).
 * - **A covered adapter**: ORCA writes the session's context file (the rules, sidecars,
 *   workspace and protected paths the hook decides with) with owner-only permissions into a
 *   private directory ORCA protects from agents, and sends the settings that run the hook
 *   with that file, plus a session-start hook that records the process id of the Claude Code
 *   that ran it. `cleanup` removes both files when the session ends.
 * - **Before the session is given work** (`verifyRuntime`): the record only points at a
 *   process; ORCA executes nothing it names and takes nothing it says as evidence. From its
 *   own side, ORCA checks that the process is a live descendant of the agent process ORCA
 *   itself started, and hashes the image that process actually runs (`/proc/<pid>/exe`, the
 *   kernel's handle on the running file, not a path) against the digest pinned for the
 *   adapter's verified pair and this platform and architecture. Anything else refuses the
 *   session. The adapter's report alone does not say which Claude Code runs.
 *
 * The hook runs on the agent's machine, so this applies to agents on the daemon's own host.
 * The factory refuses an opted-in agent on an SSH host before anything starts.
 */
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OrcaError, type ConfiguredPermissionPolicy } from "@orca/core";
import {
  claudePreToolHookSettings,
  claudeRuntimeAttestationFile,
  type ClaudeHookContext,
  type ClaudeRuntimeAttestation,
} from "./claude-pre-tool-hook.js";
import type { ProtectedPaths } from "./permissions.js";

/** The names the Claude ACP adapter reports in `initialize`'s `agentInfo`. */
export const CLAUDE_ADAPTER_NAMES: readonly string[] = [
  "@agentclientprotocol/claude-agent-acp",
  "@zed-industries/claude-code-acp",
];

/**
 * The adapter and Claude Code pairs whose installed hook behaviour `claude-hook-acceptance.yml`
 * observes, each one installed and run there: the adapter version `initialize` reports, the
 * Claude Code version it runs, and the SHA-256 of that Claude Code's executable image for each
 * `<platform>-<arch>` the acceptance run covers. ORCA hashes the image the session's runtime
 * process actually runs and accepts only the pinned digest of the adapter's pair; the
 * adapter's own report says nothing about the runtime (an environment variable can point it
 * at another Claude Code). Adding a pair or an image is a reviewed change to both.
 */
export const CLAUDE_HOOK_VERIFIED_PAIRS: readonly {
  adapter: string;
  runtime: string;
  images: Readonly<Record<string, string>>;
}[] = [
  {
    adapter: "0.109.1",
    runtime: "2.1.330",
    // @anthropic-ai/claude-agent-sdk-linux-x64@0.3.330, `claude`.
    images: { "linux-x64": "f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb" },
  },
];

/** The adapter versions in `CLAUDE_HOOK_VERIFIED_PAIRS`. */
export const CLAUDE_HOOK_VERIFIED_ADAPTERS: readonly string[] = CLAUDE_HOOK_VERIFIED_PAIRS.map((p) => p.adapter);

/** The platforms (`process.platform`) that workflow runs the acceptance test on. */
export const CLAUDE_HOOK_VERIFIED_PLATFORMS: readonly NodeJS.Platform[] = ["linux"];

/**
 * Where the hook program is, as built: `bin/claude-pre-tool-hook.js` beside this module in
 * the package's `dist`, or `claude-pre-tool-hook.mjs` beside the bundled daemon
 * (`packages/app/scripts/build-daemon.js`). Undefined when neither exists, which is the case
 * when this runs from source.
 */
export function claudePreToolHookScript(): string | undefined {
  for (const rel of ["./bin/claude-pre-tool-hook.js", "./claude-pre-tool-hook.mjs"]) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(file)) return file;
  }
  return undefined;
}

export interface ClaudeHookSessionOptions {
  agentId: string;
  permissions: ConfiguredPermissionPolicy;
  permissionFiles: readonly string[];
  workspaceCwd: string;
  additionalDirectories?: readonly string[] | undefined;
  protectedPaths?: ProtectedPaths | undefined;
  /** A directory only ORCA uses, protected from agents; the context file is written here. */
  contextDir: string;
  /** The runtime and the hook program, both absolute. No program: a Claude session is refused. */
  runtime: string;
  script: string | undefined;
  /** The platform and architecture the agent runs on; `process`'s unless a test says otherwise. */
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  /** How a process's image is attested; `processImageDigest` unless a test says otherwise. */
  imageDigest?:
    ((pid: number, agentPid: number | undefined) => Promise<{ sha256: string } | { error: string }>) | undefined;
}

export type ClaudeHookStatus = "pending" | "installed" | "verified";

/** A process's parent and start time, from `/proc/<pid>/stat` (Linux). */
async function procStat(pid: number): Promise<{ ppid: number; start: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After the name: state, ppid, ...; starttime is field 22 overall, 20 here.
    return { ppid: Number(fields[1]), start: fields[19]! };
  } catch {
    return undefined;
  }
}

/**
 * ORCA's own evidence for the image a process runs (Linux): the process must be a live
 * descendant of `agentPid`, the agent process ORCA started, and the same process (same start
 * time) before and after its image is read; the digest is of `/proc/<pid>/exe`, which opens
 * the file the kernel is running for it, wherever that is now and whatever is at its old
 * path. Nothing is executed.
 */
export async function processImageDigest(
  pid: number,
  agentPid: number | undefined,
): Promise<{ sha256: string } | { error: string }> {
  if (agentPid === undefined) return { error: "the agent's process id is unknown" };
  if (!Number.isInteger(pid) || pid <= 1 || pid === agentPid) return { error: `process ${pid} is not the runtime` };
  const lineage = async (): Promise<string | undefined> => {
    const self = await procStat(pid);
    if (!self) return undefined;
    for (let p = self.ppid, hops = 0; p > 1 && hops < 64; hops++) {
      if (p === agentPid) return self.start;
      const up = await procStat(p);
      if (!up) return undefined;
      p = up.ppid;
    }
    return undefined;
  };
  const before = await lineage();
  if (before === undefined) return { error: `process ${pid} is not running under the agent ORCA started` };
  let sha256: string;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(`/proc/${pid}/exe`)) hash.update(chunk as Buffer);
    sha256 = hash.digest("hex");
  } catch (error) {
    return { error: `its image cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if ((await lineage()) !== before) return { error: `process ${pid} changed while its image was read` };
  return { sha256 };
}

export interface ClaudeHookSession {
  /** For `OpenSessionOptions.sessionMeta`. */
  sessionMeta: (
    agentInfo: { name: string; version: string } | undefined,
    agentPid: number | undefined,
  ) => Promise<Record<string, unknown> | undefined>;
  /** What happened at `initialize`. */
  status: () => ClaudeHookStatus;
  /**
   * Check, once the session has started and before it is given work, that the Claude Code it
   * runs is the image pinned for the adapter's version. Throws (refusing the session) when the
   * runtime did not report itself, is not under the agent ORCA started, or runs another image.
   */
  verifyRuntime: () => Promise<void>;
  /** Remove the context file, if one was written. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/** The hook, ready to be installed in one session if the agent turns out to be Claude. */
export function claudeHookSession(opts: ClaudeHookSessionOptions): ClaudeHookSession {
  let status: ClaudeHookStatus = "pending";
  let file: string | undefined;
  let adapterVersion: string | undefined;
  let agentProcess: number | undefined;
  const target = () => `${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`;
  const refuse = (why: string, details: Record<string, unknown> = {}) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `agent ${opts.agentId} has nativeToolHook: on, but ${why}, so ORCA cannot check its tool calls. ` +
        `ORCA refuses the session rather than run it unguarded; remove nativeToolHook: on to run it without the hook.`,
      { agentId: opts.agentId, ...details },
    );
  return {
    status: () => status,
    cleanup: async () => {
      if (file === undefined) return;
      const f = file;
      file = undefined;
      await rm(f, { force: true });
      await rm(claudeRuntimeAttestationFile(f), { force: true });
    },
    verifyRuntime: async () => {
      if (status !== "installed" || file === undefined || adapterVersion === undefined)
        throw refuse("the hook was not installed in the session");
      let attestation: Partial<ClaudeRuntimeAttestation>;
      try {
        attestation = JSON.parse(
          await readFile(claudeRuntimeAttestationFile(file), "utf8"),
        ) as Partial<ClaudeRuntimeAttestation>;
      } catch {
        throw refuse("the Claude Code runtime did not report itself when the session started");
      }
      if (attestation.version !== 1 || typeof attestation.pid !== "number")
        throw refuse("the Claude Code runtime's report is unreadable");
      const version = adapterVersion;
      const pair = CLAUDE_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === version);
      const pinned = pair?.images[target()];
      if (!pair || pinned === undefined)
        throw refuse(`ORCA has no verified Claude Code image for adapter ${version} on ${target()}`);
      const image = await (opts.imageDigest ?? processImageDigest)(attestation.pid, agentProcess);
      if ("error" in image)
        throw refuse(`ORCA could not attest the Claude Code the session runs (${image.error})`, {
          pid: attestation.pid,
        });
      if (image.sha256 !== pinned)
        throw refuse(
          `the Claude Code the session runs is not the one ORCA verified with adapter ${version} (Claude Code ${pair.runtime}, image ${pinned.slice(0, 12)}…, not ${image.sha256.slice(0, 12)}…)`,
          { adapter: version, image: image.sha256, pinned },
        );
      status = "verified";
    },
    sessionMeta: async (agentInfo, agentPid) => {
      if (!agentInfo) throw refuse("the agent did not say at initialize which adapter it is");
      if (!CLAUDE_ADAPTER_NAMES.includes(agentInfo.name))
        throw refuse(`it runs ${agentInfo.name}, which does not take ORCA's hook`, { adapter: agentInfo.name });
      if (!CLAUDE_HOOK_VERIFIED_ADAPTERS.includes(agentInfo.version))
        throw refuse(
          `it runs ${agentInfo.name} ${agentInfo.version}, and ORCA has verified the hook only with ${CLAUDE_HOOK_VERIFIED_ADAPTERS.join(", ")}`,
          { adapter: agentInfo.name, version: agentInfo.version, verified: [...CLAUDE_HOOK_VERIFIED_ADAPTERS] },
        );
      const platform = opts.platform ?? process.platform;
      if (!CLAUDE_HOOK_VERIFIED_PLATFORMS.includes(platform))
        throw refuse(
          `ORCA has verified the hook only on ${CLAUDE_HOOK_VERIFIED_PLATFORMS.join(", ")}, not ${platform}`,
          {
            platform,
          },
        );
      // The image is pinned per architecture; one the acceptance run does not cover is refused.
      if (CLAUDE_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === agentInfo.version)?.images[target()] === undefined)
        throw refuse(`ORCA has no verified Claude Code image for ${target()}`, { platform: target() });
      if (opts.script === undefined) throw refuse("ORCA's hook program is missing from this build");
      const context: ClaudeHookContext = {
        version: 1,
        agentId: opts.agentId,
        permissions: opts.permissions,
        permissionFiles: [...opts.permissionFiles],
        workspaceCwd: opts.workspaceCwd,
        ...(opts.additionalDirectories?.length ? { additionalDirectories: [...opts.additionalDirectories] } : {}),
        // The hook program is read-only to the agent's native tools too, beside ORCA's own files.
        protectedPaths: {
          readOnly: [...(opts.protectedPaths?.readOnly ?? []), opts.script],
          noAccess: [...(opts.protectedPaths?.noAccess ?? [])],
          ...(opts.protectedPaths?.agentAreas ? { agentAreas: [...opts.protectedPaths.agentAreas] } : {}),
        },
      };
      await mkdir(opts.contextDir, { recursive: true, mode: 0o700 });
      file = join(opts.contextDir, `${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(context), { encoding: "utf8", mode: 0o600, flag: "wx" });
      status = "installed";
      adapterVersion = agentInfo.version;
      agentProcess = agentPid;
      return {
        claudeCode: {
          options: {
            settings: claudePreToolHookSettings({
              command: opts.runtime,
              args: [opts.script, file],
              attestArgs: [opts.script, "--attest", file],
            }),
          },
        },
      };
    },
  };
}
