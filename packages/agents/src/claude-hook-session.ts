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
 *   with that file, plus a session-start hook that records which Claude Code executable ran
 *   it. `cleanup` removes both files when the session ends.
 * - **Before the session is given work** (`verifyRuntime`): ORCA runs that executable's
 *   `--version` and refuses the session unless it and the adapter's version are a verified
 *   pair. The adapter's report alone does not say which Claude Code runs.
 *
 * The hook runs on the agent's machine, so this applies to agents on the daemon's own host.
 * The factory refuses an opted-in agent on an SSH host before anything starts.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
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
 * observes, each one installed and run there: the adapter version `initialize` reports, and the
 * version of the Claude Code executable the session actually runs (`<executable> --version`),
 * which ORCA checks after the session starts and before it is given work. The adapter's own
 * report says nothing about the runtime (an environment variable can point it at another
 * Claude Code), so both must match one pair. Adding a pair is a reviewed change to both.
 */
export const CLAUDE_HOOK_VERIFIED_PAIRS: readonly { adapter: string; runtime: string }[] = [
  { adapter: "0.109.1", runtime: "2.1.330" },
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
  /** The platform the agent runs on; `process.platform` unless a test says otherwise. */
  platform?: NodeJS.Platform | undefined;
  /** How a runtime's version is read; `claudeRuntimeVersion` unless a test says otherwise. */
  runtimeVersion?: ((executable: string) => Promise<{ version: string } | { error: string }>) | undefined;
}

export type ClaudeHookStatus = "pending" | "installed" | "verified";

/** The version a Claude Code executable reports (`2.1.330 (Claude Code)`), or why it has none. */
export function claudeRuntimeVersion(
  executable: string,
  timeoutMs = 15_000,
): Promise<{ version: string } | { error: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--version"],
      { timeout: timeoutMs, env: { ...process.env, CLAUDECODE: "" } },
      (error, stdout) => {
        if (error) return resolve({ error: error.message });
        const m = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(stdout.trim());
        resolve(
          m
            ? { version: m[1]! }
            : { error: `unexpected --version output ${JSON.stringify(stdout.trim().slice(0, 80))}` },
        );
      },
    );
  });
}

export interface ClaudeHookSession {
  /** For `OpenSessionOptions.sessionMeta`. */
  sessionMeta: (
    agentInfo: { name: string; version: string } | undefined,
  ) => Promise<Record<string, unknown> | undefined>;
  /** What happened at `initialize`. */
  status: () => ClaudeHookStatus;
  /**
   * Check, once the session has started and before it is given work, that the Claude Code it
   * runs is the one paired with the adapter's version. Throws (refusing the session) when the
   * runtime did not report itself, or is not a verified pair with the adapter.
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
      let attestation: ClaudeRuntimeAttestation;
      try {
        attestation = JSON.parse(
          await readFile(claudeRuntimeAttestationFile(file), "utf8"),
        ) as ClaudeRuntimeAttestation;
      } catch {
        throw refuse("the Claude Code runtime did not report itself when the session started");
      }
      if (
        attestation.version !== 1 ||
        typeof attestation.executable !== "string" ||
        !isAbsolute(attestation.executable)
      )
        throw refuse("the Claude Code runtime's report is unreadable");
      const runtime = await (opts.runtimeVersion ?? claudeRuntimeVersion)(attestation.executable);
      if ("error" in runtime)
        throw refuse(`ORCA could not read the version of the Claude Code it runs (${runtime.error})`, {
          executable: attestation.executable,
        });
      const version = adapterVersion;
      if (!CLAUDE_HOOK_VERIFIED_PAIRS.some((p) => p.adapter === version && p.runtime === runtime.version))
        throw refuse(
          `it runs Claude Code ${runtime.version} under adapter ${version}, and ORCA has verified the hook only with ${CLAUDE_HOOK_VERIFIED_PAIRS.map((p) => `adapter ${p.adapter} with Claude Code ${p.runtime}`).join(", ")}`,
          { adapter: version, runtime: runtime.version, executable: attestation.executable },
        );
      status = "verified";
    },
    sessionMeta: async (agentInfo) => {
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
