/**
 * Where store carryover may write its private copies on this platform (#897).
 *
 * Windows: the store's private records (the execution key among them) are copied only into
 * directories the packaged first-run boundary creates with an owner-only protected DACL, and
 * every copied directory and file is then verified owner-only and owned by this user. Windows
 * lets anyone with "bypass traverse checking" reach a child by path, so a private parent alone
 * is not enough. Without the native boundary the copy is refused, never made unverified.
 *
 * POSIX: `undefined`, meaning the store package's owner-only backups directory.
 */
import { windowsDirectory, windowsFile, windowsPrivateChild } from "@orca/protocol/first-run-fence";
import type { PrivateCopyBackend } from "@orca/store";

const verified = (check: () => unknown): Promise<boolean> => {
  try {
    check();
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
};

export const windowsPrivateCopy: PrivateCopyBackend = {
  mkdir(path) {
    windowsPrivateChild(path);
    return Promise.resolve();
  },
  privateRoot: (path) => verified(() => windowsDirectory(path)),
  privateEntry: (path, kind) => verified(() => (kind === "dir" ? windowsDirectory(path) : windowsFile(path))),
};

export function storePrivacy(platform: NodeJS.Platform = process.platform): PrivateCopyBackend | undefined {
  return platform === "win32" ? windowsPrivateCopy : undefined;
}
