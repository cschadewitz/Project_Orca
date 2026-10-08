/** Synthetic byte probes. They make no assumption about the pending checkpoint format. */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export function truncatedCopies(validRecord: Uint8Array): Uint8Array[] {
  if (validRecord.length < 3) throw new Error("A record must have at least three bytes");
  const offsets = new Set([0, 1, Math.floor(validRecord.length / 2), validRecord.length - 1]);
  return [...offsets].map((offset) => validRecord.slice(0, offset));
}

export function flippedCopy(validRecord: Uint8Array, offset: number): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= validRecord.length) {
    throw new Error("Invalid byte offset");
  }
  const damaged = validRecord.slice();
  damaged[offset] = damaged[offset]! ^ 0x01;
  return damaged;
}

/**
 * Scan only a disposable profile. Reject links and oversized trees rather than
 * following them or silently skipping bytes. Return file names, never contents.
 */
export async function filesContainingSyntheticBytes(
  profile: string,
  sentinels: readonly Uint8Array[],
  maxTotalBytes: number,
): Promise<string[]> {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) throw new Error("Invalid scan limit");
  if (sentinels.length === 0 || sentinels.some((bytes) => bytes.length === 0)) {
    throw new Error("Synthetic sentinels must be nonempty");
  }
  let scanned = 0;
  const matches: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("Synthetic profile contains a symbolic link");
      if (item.isDirectory()) {
        await walk(path);
      } else if (item.isFile()) {
        const size = (await stat(path)).size;
        scanned += size;
        if (scanned > maxTotalBytes) throw new Error("Synthetic profile exceeds scan limit");
        const bytes = await readFile(path);
        if (sentinels.some((sentinel) => bytes.includes(sentinel))) matches.push(relative(profile, path));
      } else {
        throw new Error("Synthetic profile contains an unsupported file type");
      }
    }
  }
  await walk(profile);
  return matches;
}
