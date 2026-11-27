/**
 * The Codex builds ORCA has verified, and ORCA's own evidence for the image a process runs
 * (#1162). Both routes read the same pins: the ACP route's verified pairs name an adapter on
 * top of one of these, and the app-server route, which starts Codex itself, attests its own
 * child against them directly.
 *
 * Evidence is read from `/proc` (Linux), so a platform without a digest here is refused rather
 * than trusted: attestation elsewhere is not in scope today.
 */

import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";

/** A file's content digest and the inode it was read from. */
export interface ImageIdentity {
  sha256: string;
  dev: number;
  ino: number;
}

/** The SHA-256 of each verified Codex native binary, by Codex version, then by `<platform>-<arch>`. */
export const CODEX_VERIFIED_IMAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "0.171.0": Object.freeze({
    // @openai/codex-linux-x64@0.171.0, vendor/x86_64-unknown-linux-musl/bin/codex.
    "linux-x64": "b76a027d6b210f9a8da7aaf321dd235c700f0ef7a794d4a5314b9af6c134f0f0",
  }),
});

/**
 * The other files of each verified Codex package that Codex reads or runs, by Codex version,
 * then by `<platform>-<arch>`: path in the package -> SHA-256 (#1286). `bin/codex` is the
 * entrypoint and is pinned in `CODEX_VERIFIED_IMAGES`; the package root is the directory above
 * its `bin`. Codex finds these next to its own executable: the code-mode host, the `rg` it puts
 * on its commands' `PATH`, and its bundled bubblewrap (the sandbox, which Codex also checks
 * itself against a digest built into the pinned binary). The voice host and its libraries are
 * not pinned: the app-server route does not use voice.
 */
export const CODEX_VERIFIED_PACKAGE_FILES: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = Object.freeze({
  "0.171.0": Object.freeze({
    "linux-x64": Object.freeze({
      "codex-package.json": "2e6a51972124359dbff670b008845d778dbf43d3cc9882c220a7e7f09f1a545d",
      "bin/codex-code-mode-host": "f49bd4f0c0cc73cf1ec3a719009e07ce5b6e100520d023c760cc203fb37e5c6f",
      "codex-path/rg": "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
      "codex-resources/bwrap": "91a245ea678a7ae642f383a22576c3c476d0d6d3e2321a553f3ed8d4d487ed74",
    }),
  }),
});

/** This machine's key in `CODEX_VERIFIED_IMAGES`, such as `linux-x64`. */
export const codexImageTarget = (platform: string = process.platform, arch: string = process.arch): string =>
  `${platform}-${arch}`;

/** The verified Codex version whose image on `target` has digest `sha256`, or undefined. */
export function codexVersionForImage(sha256: string, target: string): string | undefined {
  for (const [version, images] of Object.entries(CODEX_VERIFIED_IMAGES)) if (images[target] === sha256) return version;
  return undefined;
}

/** A process's parent and start time, from `/proc/<pid>/stat` (Linux). */
export async function procStat(pid: number): Promise<{ ppid: number; start: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After the name: state, ppid, ...; starttime is field 22 overall, 20 here.
    return { ppid: Number(fields[1]), start: fields[19]! };
  } catch {
    return undefined;
  }
}

/** The SHA-256 of the file the kernel runs for `pid`, read through `/proc/<pid>/exe`. */
export async function procImageSha256(pid: number): Promise<{ sha256: string } | { error: string }> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(`/proc/${pid}/exe`)) hash.update(chunk as Buffer);
    return { sha256: hash.digest("hex") };
  } catch (error) {
    return { error: `its image cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** How long one image check may take before ORCA refuses rather than wait (#1162). */
export const CODEX_IMAGE_CHECK_TIMEOUT_MS = 30_000;

/**
 * The digest and inode of the file at `path`, read through one open descriptor whose file is
 * unchanged (same inode, size, modification and change times) before and after it is hashed:
 * the inode is the descriptor's own, so both describe the same file. For checking an
 * executable before it is started; nothing is executed. Gives up, with an error, once
 * `timeoutMs` passes.
 */
export async function fileImageIdentity(
  path: string,
  timeoutMs: number = CODEX_IMAGE_CHECK_TIMEOUT_MS,
): Promise<ImageIdentity | { error: string }> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let onAbort = () => undefined as void;
  const expired = new Promise<{ error: string }>((resolve) => {
    onAbort = () => resolve({ error: `ORCA's check did not finish within ${timeoutMs} ms` });
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([readIdentity(path, deadline), expired]);
  } finally {
    deadline.removeEventListener("abort", onAbort);
  }
}

async function readIdentity(path: string, deadline: AbortSignal): Promise<ImageIdentity | { error: string }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return { error: `it cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { error: "it is not a regular file" };
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      if (deadline.aborted) return { error: "ORCA's check did not finish in time" };
      hash.update(chunk as Buffer);
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      return { error: "it changed while ORCA read it" };
    return { sha256: hash.digest("hex"), dev: before.dev, ino: before.ino };
  } catch (error) {
    return { error: `it cannot be read (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * ORCA's own evidence for the image of a process ORCA itself started (Linux): `pid` must be a
 * live child of this process, and the same process (same parent and start time) before and
 * after its image is read. The image is opened once through `/proc/<pid>/exe`, the file the
 * kernel is running for it, wherever that is now and whatever is at its old path, and its
 * digest and inode both come from that one descriptor. Nothing is executed, and no path the
 * process reports is read. Bounded as `fileImageIdentity` is.
 */
export async function ownChildImageDigest(
  pid: number | undefined,
  timeoutMs: number = CODEX_IMAGE_CHECK_TIMEOUT_MS,
): Promise<ImageIdentity | { error: string }> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return { error: "its process id is unknown" };
  const before = await procStat(pid);
  if (before === undefined || before.ppid !== process.pid)
    return { error: `process ${pid} is not running as a child ORCA started` };
  const image = await fileImageIdentity(`/proc/${pid}/exe`, timeoutMs);
  if ("error" in image) return { error: image.error.replace(/^it /, "its image ") };
  const after = await procStat(pid);
  if (after === undefined || after.ppid !== before.ppid || after.start !== before.start)
    return { error: `process ${pid} changed while its image was read` };
  return image;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Checks the package around a verified Codex entrypoint before it is started (#1286): every
 * file `CODEX_VERIFIED_PACKAGE_FILES` pins for `version` on `target` is a regular file in the
 * package, reached through no link, with its pinned digest. Returns why not, or undefined.
 * Like the entrypoint's own check, this is by pathname before the start: it catches a package
 * that drifted or had a file swapped, not a same-user process racing the start. Gives up once
 * `timeoutMs` passes for the whole package.
 */
export async function checkCodexPackage(
  entrypoint: string,
  version: string,
  target: string,
  {
    timeoutMs = CODEX_IMAGE_CHECK_TIMEOUT_MS,
    pins = CODEX_VERIFIED_PACKAGE_FILES,
  }: { timeoutMs?: number; pins?: typeof CODEX_VERIFIED_PACKAGE_FILES } = {},
): Promise<string | undefined> {
  const files = pins[version]?.[target];
  if (!files) return `ORCA has no pinned package files for Codex ${version} on ${target}`;
  if (basename(dirname(entrypoint)) !== "bin") return "its command is not the bin/codex of a Codex package";
  const root = dirname(dirname(entrypoint));
  const deadline = Date.now() + timeoutMs;
  for (const [file, sha256] of Object.entries(files)) {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const at = join(root, ...parts.slice(0, i));
      let entry;
      try {
        entry = await lstat(at);
      } catch (error) {
        return `the package's ${file} cannot be read (${reason(error)})`;
      }
      const last = i === parts.length;
      if (entry.isSymbolicLink() || (last ? !entry.isFile() : !entry.isDirectory()))
        return `the package's ${parts.slice(0, i).join("/")} is not a plain ${last ? "file" : "directory"}`;
    }
    const left = deadline - Date.now();
    if (left <= 0) return `ORCA's check of the package did not finish within ${timeoutMs} ms`;
    const identity = await fileImageIdentity(join(root, file), left);
    if ("error" in identity) return `the package's ${file}: ${identity.error.replace(/^it /, "")}`;
    if (identity.sha256 !== sha256) return `the package's ${file} is not the file ORCA verified for Codex ${version}`;
  }
  return undefined;
}

/**
 * Checks each `bwrap` on the `PATH` Codex is started with (#1286). Codex runs a bubblewrap
 * found on its `PATH` in preference to its bundled one, and checks only the bundled one, so a
 * `bwrap` there is accepted only when it, and every directory above it, is owned by root and
 * writable by no one else (an installed system package): one the user's own processes could
 * replace is refused. Empty entries are the working directory, as for a shell. Returns why
 * not, or undefined.
 */
export async function checkSystemBwrap(path: string | undefined, cwd: string): Promise<string | undefined> {
  for (const entry of new Set((path ?? "").split(delimiter))) {
    const candidate = resolvePath(cwd, entry, "bwrap");
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
        continue;
      return `ORCA could not check the bubblewrap at ${candidate} on Codex's PATH (${reason(error)})`;
    }
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (error) {
      return `ORCA could not resolve the bubblewrap at ${candidate} on Codex's PATH (${reason(error)})`;
    }
    // Both the path Codex looks up and the file it reaches: a link on the way is as
    // replaceable as its owner allows.
    for (const start of new Set([candidate, real]))
      for (let at = start; ; at = dirname(at)) {
        let owner;
        try {
          owner = await lstat(at);
        } catch (error) {
          return `ORCA could not check ${at}, on the way to the bubblewrap on Codex's PATH (${reason(error)})`;
        }
        if (owner.uid !== 0 || (!owner.isSymbolicLink() && (owner.mode & 0o022) !== 0))
          return `Codex would run the bubblewrap at ${candidate} on its PATH instead of its own, and ${at} is not root's alone (owned by root and writable by no one else)`;
        if (dirname(at) === at) break;
      }
  }
  return undefined;
}
