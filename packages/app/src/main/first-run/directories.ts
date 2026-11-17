/** Owned, canonical directory observations. Unknown filesystem/owner identity is a refusal. */
import { constants } from "node:fs";
import { access, lstat, realpath, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { windowsDirectory, windowsFile } from "@orca/protocol/first-run-fence";
import { FirstRunRefusal } from "./refusal.js";
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
/** A refusal of the selection, with the specific reason where the check knows it. */
export const selectionFailure = (
  reason = "Choose owned writable directories with verifiable identity: an existing prepared Git project and a separate empty app workspace. Check access and Git availability, then choose again.",
) => new FirstRunRefusal(reason);

const folder = (project: boolean) => (project ? "The project folder" : "The app workspace folder");
/** The same physical folder must answer both observations; a change between them is a refusal, never adopted. */
const changedWhileChecking = (project: boolean) =>
  selectionFailure(`${folder(project)} changed while it was being checked. Choose the directories again.`);
const runtimeFailure = () =>
  selectionFailure(
    "The app workspace's .orca or auth folder holds a link, a file shared with another location, or files owned by another account or drive. Choose a fresh empty app workspace.",
  );

/** Folders the app never takes as a project or workspace, by the reason a person can act on. */
function reservedFolder(canonical: string, home: string, project: boolean): FirstRunRefusal | undefined {
  if (canonical === dirname(canonical))
    return selectionFailure(`${folder(project)} is a drive or filesystem root. Choose a folder inside it.`);
  if (canonical === home) return selectionFailure(`${folder(project)} is your home folder. Choose a folder inside it.`);
  if (basename(canonical) === ".orca")
    return selectionFailure(
      `${folder(project)} is named .orca, which is reserved for the store. Choose another folder.`,
    );
  return undefined;
}

export async function ownedDirectory(path: string, home: string, project = false): Promise<DirectoryIdentity> {
  if (process.platform === "win32") {
    const identity = windowsDirectory(path, project ? "project" : "directory");
    const reserved = reservedFolder(path, await realpath(home), project);
    if (reserved) throw reserved;
    return identity;
  }
  if (!isAbsolute(path) || typeof process.getuid !== "function") throw selectionFailure();
  // Symlink selections are refused rather than silently adopting their destination.
  const lexical = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  const info = await lstat(canonical, { bigint: true });
  if (lexical.isSymbolicLink())
    throw selectionFailure(`${folder(project)} is a symbolic link. Choose the folder it points to instead.`);
  if (!info.isDirectory()) throw selectionFailure(`${folder(project)} is not a folder. Choose a folder.`);
  if (info.ino <= 0n || info.dev < 0n)
    throw selectionFailure(
      `${folder(project)} has no verifiable file system identity. Choose a folder on a local drive.`,
    );
  if (info.uid !== BigInt(process.getuid()))
    throw selectionFailure(`${folder(project)} is owned by another account. Choose a folder your account owns.`);
  const reserved = reservedFolder(canonical, await realpath(home), project);
  if (reserved) throw reserved;
  try {
    await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw selectionFailure(
      `Your account cannot read and write ${project ? "the project folder" : "the app workspace folder"}. Check its permissions, then choose again.`,
    );
  }
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
  if (contains(project, workspace) || contains(workspace, project))
    throw selectionFailure(
      "The project and the app workspace overlap. Choose an app workspace that is outside the project and does not contain it.",
    );
}
export async function emptyDirectory(path: string): Promise<void> {
  if ((await readdir(path)).length !== 0)
    throw selectionFailure(
      "The app workspace folder is not empty. Choose an empty folder; its existing files were left as they are.",
    );
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
    if (--remaining < 0)
      throw selectionFailure(
        "The app workspace's .orca or auth folder holds more files than setup can check. Choose a fresh empty app workspace.",
      );
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
        throw runtimeFailure();
      const identity = info.isDirectory() ? windowsDirectory(path) : windowsFile(path);
      if (identity.dev !== workspace.dev || identity.uid !== workspace.uid) throw runtimeFailure();
    } else if (
      info.isSymbolicLink() ||
      ((path === join(workspace.path, ".orca") || path === join(workspace.path, "auth")) && !info.isDirectory()) ||
      (!info.isDirectory() && !info.isFile()) ||
      info.ino <= 0n ||
      String(info.dev) !== workspace.dev ||
      String(info.uid) !== workspace.uid ||
      (info.isFile() && info.nlink !== 1n)
    )
      throw runtimeFailure();
    if (info.isDirectory()) {
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
      const entries = await readdir(path);
      if (entries.length > remaining || pending.length + entries.length > remaining)
        throw selectionFailure(
          "The app workspace's .orca or auth folder holds more files than setup can check. Choose a fresh empty app workspace.",
        );
      pending.push(...entries.map((name) => join(path, name)));
    }
  }
}
const notTopLevel = () =>
  selectionFailure(
    "The project folder is not the top level of its Git checkout. Choose the folder that holds the checkout's .git.",
  );
/** Git started and answered with a failure, as against Git missing or timing out (those are `failureReason`'s). */
const gitRan = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "number" &&
  !("killed" in error && error.killed);
function projectGit(path: string) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return async (...args: string[]) =>
    (
      await execute("git", ["-c", "core.fsmonitor=false", "-C", path, ...args], {
        env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
    ).stdout.trim();
}
/** A saved project is the same owned directory, still its repository's top level. HEAD and branch are not part of it:
 * commits, pulls and branch switches are ordinary work in the project, not a different selection. */
export async function projectRepository(path: string, home: string): Promise<DirectoryIdentity> {
  const identity = await ownedDirectory(path, home, true);
  const top = await realpath(await projectGit(identity.path)("rev-parse", "--show-toplevel"));
  if (top !== identity.path) throw notTopLevel();
  const after = await ownedDirectory(identity.path, home, true);
  if (!sameDirectory(identity, after)) throw changedWhileChecking(true);
  return identity;
}
/** Selection also needs an attached branch and a base commit, which the person reviews before Prepare. */
export async function preparedProject(path: string, home: string): Promise<ProjectIdentity> {
  const identity = await ownedDirectory(path, home, true);
  const git = projectGit(identity.path);
  const top = await realpath(await git("rev-parse", "--show-toplevel"));
  if (top !== identity.path) throw notTopLevel();
  const branch = await git("symbolic-ref", "--short", "HEAD").catch((error: unknown) => {
    if (gitRan(error))
      throw selectionFailure(
        "The project has no branch checked out (a detached HEAD). Check out a branch in the project, then choose again.",
      );
    throw error;
  });
  const baseCommit = await git("rev-parse", "--verify", "HEAD").catch((error: unknown) => {
    if (gitRan(error))
      throw selectionFailure("The project's branch has no commits yet. Make a first commit, then choose again.");
    throw error;
  });
  if (!branch || !/^[a-f0-9]{40,64}$/.test(baseCommit))
    throw selectionFailure(
      "Git did not report a branch and commit for the project. Check the checkout, then choose again.",
    );
  const after = await ownedDirectory(identity.path, home, true);
  if (!sameDirectory(identity, after)) throw changedWhileChecking(true);
  return { ...identity, branch, baseCommit };
}
