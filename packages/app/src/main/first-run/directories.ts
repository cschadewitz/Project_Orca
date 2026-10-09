/** Owned, canonical directory observations. Unknown filesystem/owner identity is a refusal. */
import { constants } from "node:fs";
import { access, lstat, realpath, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { windowsDirectory, windowsFile } from "@orca/protocol/first-run-fence";
const execute = promisify(execFile);
export interface DirectoryIdentity {
  path: string;
  dev: string;
  ino: string;
  uid: string;
}
export interface ProjectIdentity extends DirectoryIdentity {
  branch: string;
  baseCommit: string;
}
export const selectionFailure = () =>
  new Error(
    "Choose owned writable directories with verifiable identity: an existing prepared Git project and a separate empty app workspace. Check access and Git availability, then choose again.",
  );

export async function ownedDirectory(path: string, home: string, project = false): Promise<DirectoryIdentity> {
  if (process.platform === "win32") {
    const identity = windowsDirectory(path, project ? "project" : "directory");
    if (path === dirname(path) || path === (await realpath(home)) || basename(path) === ".orca")
      throw selectionFailure();
    return identity;
  }
  if (!isAbsolute(path) || typeof process.getuid !== "function") throw selectionFailure();
  // Symlink selections are refused rather than silently adopting their destination.
  const lexical = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  const info = await lstat(canonical, { bigint: true });
  if (
    lexical.isSymbolicLink() ||
    !info.isDirectory() ||
    info.ino <= 0n ||
    info.dev < 0n ||
    info.uid !== BigInt(process.getuid()) ||
    canonical === dirname(canonical) ||
    canonical === (await realpath(home)) ||
    basename(canonical) === ".orca"
  )
    throw selectionFailure();
  await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
  return { path: canonical, dev: String(info.dev), ino: String(info.ino), uid: String(info.uid) };
}
export function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
}
function contains(a: string, b: string): boolean {
  const path = relative(a, b);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
export function separateDirectories(project: string, workspace: string): void {
  if (contains(project, workspace) || contains(workspace, project)) throw selectionFailure();
}
export async function emptyDirectory(path: string): Promise<void> {
  if ((await readdir(path)).length !== 0) throw selectionFailure();
}

/** Reopened daemon-owned trees must not redirect writes outside the selected workspace.
 * This is a bounded observation; concurrent mutation by the same OS principal remains a native gate.
 */
export async function verifyRuntimeDirectories(workspace: DirectoryIdentity): Promise<void> {
  if (process.platform !== "win32" && typeof process.getuid !== "function") throw selectionFailure();
  const pending = [join(workspace.path, ".orca"), join(workspace.path, "auth")];
  let remaining = 8192;
  while (pending.length) {
    const path = pending.pop()!;
    if (--remaining < 0) throw selectionFailure();
    let info;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      if (
        (path === join(workspace.path, ".orca") || path === join(workspace.path, "auth")) &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        continue;
      throw error;
    }
    if (process.platform === "win32") {
      if ((path === join(workspace.path, ".orca") || path === join(workspace.path, "auth")) && !info.isDirectory())
        throw selectionFailure();
      const identity = info.isDirectory() ? windowsDirectory(path) : windowsFile(path);
      if (identity.dev !== workspace.dev || identity.uid !== workspace.uid) throw selectionFailure();
    } else if (
      info.isSymbolicLink() ||
      ((path === join(workspace.path, ".orca") || path === join(workspace.path, "auth")) && !info.isDirectory()) ||
      (!info.isDirectory() && !info.isFile()) ||
      info.ino <= 0n ||
      String(info.dev) !== workspace.dev ||
      String(info.uid) !== workspace.uid ||
      (info.isFile() && info.nlink !== 1n)
    )
      throw selectionFailure();
    if (info.isDirectory()) {
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
      const entries = await readdir(path);
      if (entries.length > remaining || pending.length + entries.length > remaining) throw selectionFailure();
      pending.push(...entries.map((name) => join(path, name)));
    }
  }
}
export async function preparedProject(path: string, home: string): Promise<ProjectIdentity> {
  const identity = await ownedDirectory(path, home, true);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = async (...args: string[]) =>
    (
      await execute("git", ["-c", "core.fsmonitor=false", "-C", identity.path, ...args], {
        env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
    ).stdout.trim();
  const top = await realpath(await git("rev-parse", "--show-toplevel"));
  const branch = await git("symbolic-ref", "--short", "HEAD");
  const baseCommit = await git("rev-parse", "--verify", "HEAD");
  if (top !== identity.path || !branch || !/^[a-f0-9]{40,64}$/.test(baseCommit)) throw selectionFailure();
  const after = await ownedDirectory(identity.path, home, true);
  if (!sameDirectory(identity, after)) throw selectionFailure();
  return { ...identity, branch, baseCommit };
}
