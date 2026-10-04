/** Independent bounded filesystem accounting for disposable implementation fixtures. */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface FilesystemEvidence {
  entries: number;
  retainedBytes: number;
  stagingBytes: number;
  controlBytes: number;
  exportMetadataBytes: number;
  files: ReadonlyMap<string, Buffer>;
}

export async function inspectPrivateRoot(root: string): Promise<FilesystemEvidence> {
  const names = await readdir(root);
  // Fail explicitly, never make the scan silently incomplete under pressure.
  if (names.length > 16) throw new Error("Fixture root entry ceiling exceeded");
  let retainedBytes = 0;
  let stagingBytes = 0;
  let controlBytes = 0;
  let exportMetadataBytes = 0;
  const files = new Map<string, Buffer>();
  for (const name of names) {
    const path = join(root, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe fixture root entry");
    if (info.size > 1_048_576 + 16_384) throw new Error("Fixture file exceeds slot ceiling");
    const bytes = await readFile(path);
    files.set(name, bytes);
    if (name === "export-stage.tmp") stagingBytes += bytes.length;
    else retainedBytes += bytes.length;
    if (!/^slot-[012]\.bin$/.test(name) && name !== "export-stage.tmp") controlBytes += bytes.length;
    if (name.startsWith("export.json")) exportMetadataBytes += bytes.length;
  }
  return { entries: names.length, retainedBytes, stagingBytes, controlBytes, exportMetadataBytes, files };
}

export function barrier(): { entered: Promise<void>; release(): void; wait(): Promise<void> } {
  let announce = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: () => {
      announce();
      return pending;
    },
  };
}
