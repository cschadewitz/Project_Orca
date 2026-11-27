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
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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

/** Where ORCA keeps its own copies of verified images: `$XDG_CACHE_HOME/orca/claude-code`, else `~/.cache/…`. */
export function claudeSdkImageDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const cache = env["XDG_CACHE_HOME"];
  return join(cache !== undefined && isAbsolute(cache) ? cache : join(homedir(), ".cache"), "orca", "claude-code");
}

export type ClaudeSdkInstallCheck =
  | {
      verified: true;
      claudeCode: string;
      sha256: string;
      /** ORCA's own copy of the verified bytes: what runs. */ image: string;
    }
  | { verified: false; reason: string; sha256?: string | undefined };

/**
 * Before anything runs (#1318 review): the file ORCA resolved must be an image pinned for this
 * SDK on this platform, and what ORCA then runs (the version probe, the auth probe, the
 * session) is not that path but ORCA's own copy of exactly the bytes it hashed, written once
 * per image into a directory only ORCA's user can use and left read-only, and hashed again
 * before each reuse. An update or
 * replacement of the install between the check and a launch therefore changes nothing that
 * runs. The one thing this cannot stop is a process running as the same user rewriting ORCA's
 * copy; such a process can already read the session's environment, and the runtime
 * attestation after `initialize` measures what actually runs again.
 */
export async function checkClaudeSdkInstall(o: {
  /** The real path of the `claude` ORCA resolved. */
  executable: string;
  /** Where ORCA keeps its copies (`claudeSdkImageDir()` unless given). */
  imageDir?: string | undefined;
  pairs?: readonly ClaudeSdkVerifiedPair[] | undefined;
  sdkVersion?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<ClaudeSdkInstallCheck> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const sdk = o.sdkVersion ?? CLAUDE_AGENT_SDK_VERSION;
  const target = `${platform}-${arch}`;
  if (platform !== "linux") return { verified: false, reason: `ORCA does not attest Claude Code on ${target} yet` };
  const read = await digestOf(o.executable, o.signal, { regular: true });
  if ("error" in read) return { verified: false, reason: `${o.executable} cannot be read (${read.error})` };
  const pair = (o.pairs ?? CLAUDE_SDK_VERIFIED_PAIRS).find((p) => p.sdk === sdk && p.images[target] === read.sha256);
  if (!pair)
    return {
      verified: false,
      sha256: read.sha256,
      reason: `${o.executable} is not a Claude Code ORCA verified for Claude Agent SDK ${sdk} on ${target}`,
    };
  const staged = await stageImage(o.executable, read, o.imageDir ?? claudeSdkImageDir(), o.signal);
  if ("error" in staged)
    return { verified: false, sha256: read.sha256, reason: `ORCA could not keep its own copy of it (${staged.error})` };
  return { verified: true, claudeCode: pair.claudeCode, sha256: read.sha256, image: staged.image };
}

/**
 * `checkClaudeSdkInstall` as a gate for `claudeSdkPreflight`'s `verifyInstall`: refuses an
 * unverified install before it is run at all, names the version it must report, and hands back
 * ORCA's own copy as the file to run.
 */
export function requireVerifiedClaudeSdkInstall(
  agentId: string,
  options: { pairs?: readonly ClaudeSdkVerifiedPair[] | undefined; imageDir?: string | undefined } = {},
): (executable: string, signal: AbortSignal) => Promise<{ claudeCode: string; executable: string }> {
  return async (executable, signal) => {
    const result = await checkClaudeSdkInstall({
      executable,
      pairs: options.pairs,
      imageDir: options.imageDir,
      signal,
    });
    if (!result.verified)
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agentId} has nativeToolHook: experimental, but its Claude Code is not one ORCA verified: ${result.reason}. ` +
          `ORCA refuses to run it at all; use the pinned Claude Code (docs/agents/claude-agent-sdk.md), or remove nativeToolHook.`,
        { agentId, executable, reason: result.reason },
      );
    return { claudeCode: result.claudeCode, executable: result.image };
  };
}

/**
 * ORCA's copy of the image `read` measured, at `<dir>/<sha256>/claude`: reused when it is there
 * as ORCA left it and its bytes hash to the pin again, otherwise written from `source` again, the bytes hashed as they are written
 * and required to be the ones measured, then made read-only and moved into place in one rename.
 */
async function stageImage(
  source: string,
  read: { sha256: string; size: number },
  dir: string,
  signal: AbortSignal | undefined,
): Promise<{ image: string } | { error: string }> {
  try {
    await privateDir(dir);
    const final = join(dir, read.sha256);
    const image = join(final, "claude");
    const existing = await keptCopy(final, read.size);
    // A kept copy is used only once its bytes hash to the pin again; one that does not (or is
    // not as ORCA left it) is replaced by a fresh copy.
    if (existing === "kept") {
      const again = await digestOf(image, signal, { regular: true });
      if (!("error" in again) && again.sha256 === read.sha256) return { image };
      if (signal?.aborted) return { error: "the check was stopped" };
    }
    if (existing !== "missing") await removeTree(final);
    const stage = await mkdtemp(join(dir, ".stage-"));
    try {
      const out = await open(join(stage, "claude"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700);
      let copied;
      try {
        copied = await digestOf(source, signal, { regular: true, copyTo: out });
        if (!("error" in copied)) await out.sync();
      } finally {
        await out.close().catch(() => undefined);
      }
      if ("error" in copied) return { error: copied.error };
      if (copied.sha256 !== read.sha256) return { error: "the file changed while ORCA read it" };
      await chmod(join(stage, "claude"), 0o500);
      await chmod(stage, 0o500);
      try {
        await rename(stage, final);
      } catch (error) {
        // Another session put the same image in place first: used only once it hashes to the pin.
        if ((await keptCopy(final, read.size)) === "kept") {
          const theirs = await digestOf(image, signal, { regular: true });
          if (!("error" in theirs) && theirs.sha256 === read.sha256) return { image };
        }
        throw error;
      }
      return { image };
    } finally {
      await removeTree(stage);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** `dir`, created if missing, as a directory owned by ORCA's user that no one else can use. */
async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error(`${dir} is not a directory owned by ORCA's user`);
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/** Whether `<final>/claude` is a copy as ORCA leaves one: read-only, its own, the right size. */
async function keptCopy(final: string, size: number): Promise<"kept" | "missing" | "other"> {
  const uid = process.getuid?.();
  try {
    const d = await lstat(final);
    const f = await lstat(join(final, "claude"));
    const own = (s: { uid: number; mode: number }) => s.uid === uid && (s.mode & 0o222) === 0 && (s.mode & 0o077) === 0;
    return d.isDirectory() && own(d) && f.isFile() && own(f) && f.size === size ? "kept" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other";
  }
}

/** Remove a tree ORCA wrote, read-only directories included. */
async function removeTree(path: string): Promise<void> {
  await chmod(path, 0o700).catch(() => undefined);
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * The sha256 and size of a file, read until `signal` aborts. With `regular`, the path must
 * already be a regular file before it is opened (so a FIFO or device never blocks the open),
 * it is opened without following a link or blocking, and it must be the same file once open.
 * `copyTo` also receives every byte that is hashed.
 */
async function digestOf(
  path: string,
  signal: AbortSignal | undefined,
  o: { regular?: boolean; copyTo?: FileHandle } = {},
): Promise<{ sha256: string; size: number } | { error: string }> {
  if (signal?.aborted) return { error: "the check was stopped" };
  let handle: FileHandle;
  try {
    let before: { dev: number; ino: number } | undefined;
    if (o.regular) {
      const info = await lstat(path);
      if (!info.isFile()) return { error: "it is not a regular file" };
      before = info;
    }
    if (signal?.aborted) return { error: "the check was stopped" };
    // `/proc/<pid>/exe` is the kernel's link to the running file and has to be followed; an
    // install path is already real, and a link put there since is refused.
    handle = await open(
      path,
      constants.O_RDONLY | (o.regular ? (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) : 0),
    );
    if (before) {
      const now = await handle.stat();
      if (!now.isFile() || now.dev !== before.dev || now.ino !== before.ino) {
        await handle.close().catch(() => undefined);
        return { error: "it changed while ORCA opened it" };
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const hash = createHash("sha256");
    let size = 0;
    const stream = handle.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.length;
      if (o.copyTo) await o.copyTo.write(bytes);
    }
    if (signal?.aborted) return { error: "the check was stopped" };
    return { sha256: hash.digest("hex"), size };
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
