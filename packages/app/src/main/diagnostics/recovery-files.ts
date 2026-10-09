/** Injectable filesystem boundary; shipping native I/O must be handle-relative. */
import { lstat, open, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";

export type RecoveryStat = Pick<
  Stats,
  "uid" | "mode" | "nlink" | "size" | "isFile" | "isDirectory" | "isSymbolicLink"
> & {
  dev: number | bigint;
  ino: number | bigint;
};
export interface RecoveryFileHandle {
  stat(): Promise<RecoveryStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  writeFile(bytes: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface RecoveryFileSystem {
  lstat(path: string): Promise<RecoveryStat>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: number, mode?: number): Promise<RecoveryFileHandle>;
}

/** Existing path-based fixture behavior; this is not native ancestry/ACL proof. */
export const nodeRecoveryFiles: RecoveryFileSystem = { lstat, readdir, open };
