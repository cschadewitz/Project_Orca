/**
 * Durable file steps for store format carryover (#897): a crash may stop the sequence at any
 * point, but never leave a later step on disk without the earlier ones it depends on.
 *
 * POSIX: file data is fsynced before close, and a directory is fsynced after an entry in it is
 * created or renamed. Windows cannot open a directory for flushing from Node: `syncDirectory` is
 * a no-op there and orders nothing, so format carryover, whose marker must not outlive its
 * backup, writes the Windows backup in place into a slot file that survived a Windows restart
 * and flushes that file instead; the archive then records the conversion across a lost marker
 * (backup-archive.ts, store-format-carryover.ts, #910).
 */
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";

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

/** Errors Windows gives a rename while another handle has the source or the target open. */
const SHARING_VIOLATIONS = new Set(["EPERM", "EACCES", "EBUSY"]);
/** The waits between attempts, about 1.3 seconds in all: an antivirus scan or a reader's open handle. */
export const REPLACE_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640];

/**
 * Rename `from` over `to`, the last step of every write-then-rename publication. On Windows a
 * rename fails with EPERM, EACCES or EBUSY while any other handle has either file open: a
 * reader of the target in another request, or an antivirus scanner looking at the file just
 * closed. That is a moment, not a refusal, so the rename is tried again for a bounded time, as
 * graceful-fs does (#1284). Elsewhere, and for any other error, it fails at once.
 */
export async function replaceFile(
  from: string,
  to: string,
  options: {
    platform?: NodeJS.Platform;
    rename?: (from: string, to: string) => Promise<void>;
    delaysMs?: readonly number[];
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const move = options.rename ?? rename;
  const delays = options.delaysMs ?? REPLACE_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const delay = delays[attempt];
      if (platform !== "win32" || !SHARING_VIOLATIONS.has(code) || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
