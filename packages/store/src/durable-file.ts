/**
 * Durable file steps for store format carryover (#897): a crash may stop the sequence at any
 * point, but never leave a later step on disk without the earlier ones it depends on.
 *
 * POSIX: file data is fsynced before close, and a directory is fsynced after an entry in it is
 * created or renamed. Windows cannot open a directory for flushing from Node; there a file's
 * data and metadata are flushed (FlushFileBuffers) before and after a rename, and NTFS journals
 * the directory entries themselves.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush an existing file's data and metadata. */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Copy `source` into a NEW file at `target`, created exclusively by this process and flushed.
 * No copy-file primitive: the new file's security comes only from its creation in `target`'s
 * private parent (an owner-only mode here; on Windows, the parent's protected owner-only DACL,
 * inherited by the kernel when the file is created), never from anything copied from the source.
 */
export async function createCopy(source: string, target: string): Promise<void> {
  const input = await open(source, "r");
  try {
    const output = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1 << 16);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** A new file holding `text`, created exclusively, flushed before it is closed. */
export async function createDurable(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
