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
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/** The SHA-256 of each verified Codex native binary, by Codex version, then by `<platform>-<arch>`. */
export const CODEX_VERIFIED_IMAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "0.171.0": Object.freeze({
    // @openai/codex-linux-x64@0.171.0, vendor/x86_64-unknown-linux-musl/bin/codex.
    "linux-x64": "b76a027d6b210f9a8da7aaf321dd235c700f0ef7a794d4a5314b9af6c134f0f0",
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

/**
 * ORCA's own evidence for the image of a process ORCA itself started (Linux): `pid` must be a
 * live child of this process, and the same process (same parent and start time) before and
 * after its image is read. The digest is of `/proc/<pid>/exe`, the file the kernel is running
 * for it, wherever that is now and whatever is at its old path. Nothing is executed, and no
 * path the process reports is read.
 */
export async function ownChildImageDigest(pid: number | undefined): Promise<{ sha256: string } | { error: string }> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return { error: "its process id is unknown" };
  const before = await procStat(pid);
  if (before === undefined || before.ppid !== process.pid)
    return { error: `process ${pid} is not running as a child ORCA started` };
  const image = await procImageSha256(pid);
  if ("error" in image) return image;
  const after = await procStat(pid);
  if (after === undefined || after.ppid !== before.ppid || after.start !== before.start)
    return { error: `process ${pid} changed while its image was read` };
  return image;
}
