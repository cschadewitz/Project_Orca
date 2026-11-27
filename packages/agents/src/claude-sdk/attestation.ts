/**
 * Which Claude Code a Claude Agent SDK session runs (#1124), checked from ORCA's own side.
 *
 * On the ACP route ORCA finds Claude Code among the adapter's descendants through a
 * session-start hook that reports a process id. Here ORCA starts `claude` itself, so it attests
 * its own child directly: once the child has answered the SDK's `initialize` (so it has long
 * since exec'd), ORCA hashes `/proc/<pid>/exe` (the file the kernel runs for that process,
 * wherever it is now and whatever is at its old path), checks before and after that the process
 * is still the same one (same start time) and still ORCA's own child, and compares the digest
 * with the one pinned for this SDK version and the Claude Code version ORCA's own preflight
 * read (`claude --version`). Nothing the CLI reports about itself is read or executed.
 *
 * A pair is pinned by a reviewed change with an acceptance run (the
 * `claude-sdk-acceptance.yml` workflow installs exactly the pinned Claude Code and asserts it
 * verifies), as for the ACP route's pairs. Linux x64 only for now; other platforms are not
 * covered and never verify.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { OrcaError } from "@orca/core";

/** The `@anthropic-ai/claude-agent-sdk` version this package pins (checked against the installed one in tests). */
export const CLAUDE_AGENT_SDK_VERSION = "0.3.332";

/** One verified pair: an SDK version, the Claude Code version, and its image per platform. */
export interface ClaudeSdkVerifiedPair {
  sdk: string;
  claudeCode: string;
  /** `${process.platform}-${process.arch}` → sha256 of the `claude` image. */
  images: Readonly<Record<string, string>>;
}

export const CLAUDE_SDK_VERIFIED_PAIRS: readonly ClaudeSdkVerifiedPair[] = [
  {
    sdk: "0.3.332",
    claudeCode: "2.1.332",
    // @anthropic-ai/claude-code-linux-x64@2.1.332, `claude`.
    images: { "linux-x64": "a2df1f41bb00250992926420d0063f89b127cb81abdd284dbefb80c50ff1d026" },
  },
];

export type ClaudeSdkRuntimeAttestation =
  | { verified: true; claudeCode: string; sha256: string }
  | { verified: false; reason: string; sha256?: string | undefined };

export interface AttestClaudeSdkRuntimeOptions {
  /** ORCA's own child, the `claude` it spawned. */
  pid: number | undefined;
  /** The Claude Code version ORCA's preflight read; undefined when unknown. */
  claudeCodeVersion: string | undefined;
  pairs?: readonly ClaudeSdkVerifiedPair[] | undefined;
  sdkVersion?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  /** The daemon's own pid: the child must still be its child. */
  parentPid?: number | undefined;
  /** Ends the image read: the result is then not verified. */
  signal?: AbortSignal | undefined;
}

/** Attest ORCA's own `claude` child. Never throws; says why when it cannot verify. */
export async function attestClaudeSdkRuntime(o: AttestClaudeSdkRuntimeOptions): Promise<ClaudeSdkRuntimeAttestation> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const sdk = o.sdkVersion ?? CLAUDE_AGENT_SDK_VERSION;
  const target = `${platform}-${arch}`;
  if (platform !== "linux") return { verified: false, reason: `ORCA does not attest Claude Code on ${target} yet` };
  const pair = (o.pairs ?? CLAUDE_SDK_VERIFIED_PAIRS).find(
    (p) => p.sdk === sdk && o.claudeCodeVersion !== undefined && p.claudeCode === o.claudeCodeVersion,
  );
  const pinned = pair?.images[target];
  if (o.pid === undefined || !Number.isInteger(o.pid) || o.pid <= 1)
    return { verified: false, reason: "the process ORCA started is not known" };
  const parent = o.parentPid ?? process.pid;
  const before = await procIdentity(o.pid);
  if (!before || before.ppid !== parent)
    return { verified: false, reason: "the process ORCA started is no longer its child" };
  const read = await digestOf(`/proc/${o.pid}/exe`, o.signal);
  if ("error" in read) return { verified: false, reason: `its image cannot be read (${read.error})` };
  const { sha256 } = read;
  const after = await procIdentity(o.pid);
  if (!after || after.start !== before.start || after.ppid !== parent)
    return { verified: false, reason: "the process ORCA started changed while its image was read" };
  if (pinned === undefined)
    return {
      verified: false,
      sha256,
      reason:
        o.claudeCodeVersion === undefined
          ? "its version is unknown"
          : `Claude Code ${o.claudeCodeVersion} with Claude Agent SDK ${sdk} on ${target} is not a pair ORCA verified`,
    };
  if (pinned !== sha256)
    return {
      verified: false,
      sha256,
      reason: `the image it runs is not the one ORCA verified for Claude Code ${o.claudeCodeVersion} on ${target}`,
    };
  return { verified: true, claudeCode: pair!.claudeCode, sha256 };
}

/**
 * Before anything runs (#1318 review): the file ORCA is about to start, at its real path, must
 * be an image pinned for this SDK on this platform, and the version it then reports must be that
 * pair's. This is the check that keeps an unverified program from ever being started with the
 * session's environment, credentials included; the runtime attestation after `initialize`
 * checks again what actually runs, since the file could be replaced in between.
 */
export async function checkClaudeSdkInstall(o: {
  /** The real path of the `claude` ORCA resolved. */
  executable: string;
  pairs?: readonly ClaudeSdkVerifiedPair[] | undefined;
  sdkVersion?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<ClaudeSdkRuntimeAttestation> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const sdk = o.sdkVersion ?? CLAUDE_AGENT_SDK_VERSION;
  const target = `${platform}-${arch}`;
  if (platform !== "linux") return { verified: false, reason: `ORCA does not attest Claude Code on ${target} yet` };
  const read = await digestOf(o.executable, o.signal, true);
  if ("error" in read) return { verified: false, reason: `${o.executable} cannot be read (${read.error})` };
  const pair = (o.pairs ?? CLAUDE_SDK_VERIFIED_PAIRS).find((p) => p.sdk === sdk && p.images[target] === read.sha256);
  if (!pair)
    return {
      verified: false,
      sha256: read.sha256,
      reason: `${o.executable} is not a Claude Code ORCA verified for Claude Agent SDK ${sdk} on ${target}`,
    };
  return { verified: true, claudeCode: pair.claudeCode, sha256: read.sha256 };
}

/**
 * `checkClaudeSdkInstall` as a gate for `claudeSdkPreflight`'s `verifyInstall`: refuses an
 * unverified install before it is run at all, and names the version it must report.
 */
export function requireVerifiedClaudeSdkInstall(
  agentId: string,
  options: { signal?: AbortSignal | undefined; pairs?: readonly ClaudeSdkVerifiedPair[] | undefined } = {},
): (executable: string) => Promise<{ claudeCode: string }> {
  return async (executable) => {
    const result = await checkClaudeSdkInstall({ executable, pairs: options.pairs, signal: options.signal });
    if (!result.verified)
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agentId} has nativeToolHook: experimental, but its Claude Code is not one ORCA verified: ${result.reason}. ` +
          `ORCA refuses to run it at all; use the pinned Claude Code (docs/agents/claude-agent-sdk.md), or remove nativeToolHook.`,
        { agentId, executable, reason: result.reason },
      );
    return { claudeCode: result.claudeCode };
  };
}

/** The sha256 of a file, read until `signal` aborts; `regular` also requires a regular file. */
async function digestOf(
  path: string,
  signal: AbortSignal | undefined,
  regular = false,
): Promise<{ sha256: string } | { error: string }> {
  if (signal?.aborted) return { error: "the check was stopped" };
  let handle;
  try {
    // `/proc/<pid>/exe` is the kernel's link to the running file and has to be followed; an
    // install path is already real, and a link put there since is refused.
    handle = await open(path, constants.O_RDONLY | (regular ? (constants.O_NOFOLLOW ?? 0) : 0));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (regular && !(await handle.stat()).isFile()) return { error: "it is not a regular file" };
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return { sha256: hash.digest("hex") };
  } catch (error) {
    return {
      error: signal?.aborted ? "the check was stopped" : error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A process's parent and start time (`/proc/<pid>/stat`), or undefined once it is gone. */
async function procIdentity(pid: number): Promise<{ ppid: number; start: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After the name: state(0) ppid(1) … starttime(19).
    return { ppid: Number(fields[1]), start: fields[19] ?? "" };
  } catch {
    return undefined;
  }
}
