/**
 * Put a repository on a managed server from the client (#1235), Node-only like `server-courier`:
 * the host needs no git credentials and no access to where the code is hosted.
 *
 * The client writes the refs it was asked for into a git bundle, carries it over the profile's
 * pinned ssh into a scratch directory (`pushCourier`, checked by digest on arrival), and the host
 * fetches from that file into a bare repository under the server root, `repos/<name>.git`. A
 * working checkout beside it, `checkouts/<name>`, has that bare repository as `origin`, so a
 * daemon whose `workspace.repo` is the checkout fetches delegated `gitRef`s from what was pushed
 * (docs/WORKFLOWS.md, "Working from a named git ref"). Every remote command is a list of words
 * that mean themselves (`commandArgs`): nothing is read by a shell.
 *
 * A push only moves a branch forward: a ref the host has at a commit the pushed one does not
 * descend from is refused, never overwritten. Fetching runs no hook on the host.
 *
 * Behind the incubating `tailnet-hosts` flag: nothing calls it while the flag is off.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourierRefused, dropCourier, pushCourier, type CourierTransport } from "./server-courier.js";

/** Where the setup puts the server, relative to the account's home (`orca-server-setup.py`). */
export const SERVER_ROOT_FROM_HOME = ".local/share/orca-server";
/** A repository's name on the host: one path segment, never `.git`-suffixed. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A branch or tag, named in full, in characters that are one remote word. */
const REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]{1,200}$/;
/** An absolute path with nothing a remote word cannot hold. */
const ROOT = /^\/[A-Za-z0-9._/-]{1,400}$/;
const GIT_TIMEOUT_MS = 10 * 60_000;
const BUNDLE_LIMIT = 4 * 1024 ** 3;

/** A git command here, in a directory: exit code and output. A test passes its own. */
export type LocalGit = (
  args: readonly string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `git` on this computer, with no prompts, pager or terminal. */
export const localGit: LocalGit = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 255,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });

/** Thrown when a repository cannot be put on the server; nothing on the host changed unless it says so. */
export class RepositoryRefused extends Error {
  override readonly name = "RepositoryRefused";
}

/** A repository's name on the host, from the local directory's name when none is given. */
export function repositoryName(name: string): string {
  const candidate = name
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  if (!NAME.test(candidate) || candidate.includes(".."))
    throw new RepositoryRefused("Name the repository on the server with --name (letters, digits, . _ -).");
  return candidate;
}

/** The bare repository and the checkout for `name` under the server root. */
export function hostRepositoryPaths(root: string, name: string): { hub: string; checkout: string } {
  if (!ROOT.test(root) || root.split("/").includes("..")) throw new RepositoryRefused("Unusable server root");
  if (!NAME.test(name) || name.includes("..")) throw new RepositoryRefused("Unusable repository name");
  return { hub: `${root}/repos/${name}.git`, checkout: `${root}/checkouts/${name}` };
}

/** The refs to push: the ones asked for, each a full branch or tag, or the current branch. */
export async function refsToPush(git: LocalGit, repo: string, requested: readonly string[]): Promise<string[]> {
  const refs = [...requested];
  if (!refs.length) {
    const head = await git(["symbolic-ref", "-q", "HEAD"], repo);
    if (head.code !== 0) throw new RepositoryRefused("HEAD is not on a branch here: name the refs to push with --ref.");
    refs.push(head.stdout.trim());
  }
  for (const ref of refs) {
    if (!REF.test(ref) || ref.split("/").includes("..") || ref.endsWith(".lock") || ref.endsWith("/"))
      throw new RepositoryRefused(`${ref} is not a full branch or tag name (refs/heads/… or refs/tags/…).`);
    const known = await git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], repo);
    if (known.code !== 0) throw new RepositoryRefused(`${ref} does not name a commit here.`);
  }
  return [...new Set(refs)];
}

/** A bundle of `refs` from `repo`, in a temporary directory the caller removes. */
export async function bundleRepository(
  git: LocalGit,
  repo: string,
  refs: readonly string[],
): Promise<{ dir: string; path: string; sha256: string; size: number }> {
  const dir = mkdtempSync(join(tmpdir(), "orca-repository-"));
  const path = join(dir, "repository.bundle");
  try {
    const made = await git(["bundle", "create", "-q", path, ...refs], repo);
    if (made.code !== 0) throw new RepositoryRefused(`git could not bundle ${refs.join(", ")} here.`);
    const size = statSync(path).size;
    if (size > BUNDLE_LIMIT) throw new RepositoryRefused("The repository is larger than 4 GiB as a bundle.");
    return { dir, path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), size };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** What putting a repository on the server came to. */
export interface RepositoryPushed {
  name: string;
  /** The bare repository the refs were fetched into. */
  hub: string;
  /** The working checkout, whose `origin` is `hub`: the value for `workspace.repo`. */
  checkout: string;
  refs: string[];
  /** `created`: cloned now; `updated`: its branch moved forward; `kept`: left as it was, with why. */
  checkoutState: { kind: "created" | "updated" } | { kind: "kept"; reason: string };
}

const run = async (transport: CourierTransport, command: readonly string[], timeoutMs = GIT_TIMEOUT_MS) =>
  transport.exec(command, timeoutMs);

/**
 * Put `refs` (already bundled) into `repos/<name>.git` on the server, then create or move
 * forward `checkouts/<name>`. The server must be one this setup made (its root exists).
 */
export async function pushRepository(
  transport: CourierTransport,
  bundle: { path: string; sha256: string; size: number },
  options: { name: string; refs: readonly string[] },
): Promise<RepositoryPushed> {
  const located = await run(transport, ["realpath", "-e", "--", SERVER_ROOT_FROM_HOME]);
  const root = located.stdout.trim();
  if (located.code !== 0 || !ROOT.test(root))
    throw new RepositoryRefused("This machine is not an ORCA server yet: set it up first.");
  const { hub, checkout } = hostRepositoryPaths(root, options.name);
  if ((await run(transport, ["git", "--version"])).code !== 0)
    throw new RepositoryRefused("git is not installed on the server. Install it there, then push again.");
  if ((await run(transport, ["mkdir", "-p", "--", `${root}/repos`, `${root}/checkouts`])).code !== 0)
    throw new RepositoryRefused("Could not make the repository directories on the server.");
  // Idempotent: an existing bare repository is left as it is.
  if ((await run(transport, ["git", "init", "--bare", "-q", hub])).code !== 0)
    throw new RepositoryRefused(`Could not make ${hub} on the server.`);

  const scratch = await pushCourier(transport, {
    version: "repository",
    files: [{ name: "repository.bundle", path: bundle.path, sha256: bundle.sha256, size: bundle.size }],
  }).catch((error: unknown) => {
    throw error instanceof CourierRefused ? new RepositoryRefused(error.message) : error;
  });
  try {
    const file = `${scratch.path}/repository.bundle`;
    if ((await run(transport, ["git", "-C", hub, "bundle", "verify", "-q", file])).code !== 0)
      throw new RepositoryRefused("The server's repository is missing history the bundle builds on.");
    // No `+`: a ref that would not move forward is refused, never overwritten.
    const fetched = await run(transport, [
      "git",
      "-C",
      hub,
      "fetch",
      "-q",
      "--no-tags",
      "--no-write-fetch-head",
      file,
      ...options.refs.map((ref) => `${ref}:${ref}`),
    ]);
    if (fetched.code !== 0)
      throw new RepositoryRefused(
        `The server has ${options.refs.length === 1 ? options.refs[0] : "one of these refs"} at a commit this push does not build on. Nothing was overwritten.`,
      );
  } finally {
    await dropCourier(transport, scratch);
  }

  const branch = options.refs.find((ref) => ref.startsWith("refs/heads/"));
  if (branch) await run(transport, ["git", "-C", hub, "symbolic-ref", "HEAD", branch]);
  const exists = (await run(transport, ["test", "-d", `${checkout}/.git`])).code === 0;
  let checkoutState: RepositoryPushed["checkoutState"];
  if (!exists) {
    const cloned = await run(transport, ["git", "clone", "-q", "--no-hardlinks", "--", hub, checkout]);
    checkoutState = cloned.code === 0 ? { kind: "created" } : { kind: "kept", reason: "it could not be cloned" };
  } else if (!branch) {
    checkoutState = { kind: "kept", reason: "only tags were pushed" };
  } else {
    const short = branch.slice("refs/heads/".length);
    const current = await run(transport, ["git", "-C", checkout, "symbolic-ref", "-q", "HEAD"]);
    if (current.stdout.trim() !== branch)
      checkoutState = { kind: "kept", reason: `it is on another branch than ${short}` };
    else {
      await run(transport, ["git", "-C", checkout, "fetch", "-q", "--no-tags", "origin"]);
      const moved = await run(transport, ["git", "-C", checkout, "merge", "-q", "--ff-only", `origin/${short}`]);
      checkoutState =
        moved.code === 0
          ? { kind: "updated" }
          : { kind: "kept", reason: "it has changes of its own, so it was not moved forward" };
    }
  }
  return { name: options.name, hub, checkout, refs: [...options.refs], checkoutState };
}

/** The workspace settings that make the daemon work in the pushed checkout (docs/WORKFLOWS.md). */
export function workspaceSnippet(pushed: RepositoryPushed): string {
  const branches = pushed.refs.filter((ref) => ref.startsWith("refs/heads/"));
  return [
    "workspace:",
    "  provider: git-worktree",
    `  repo: ${pushed.checkout}`,
    "  fetchRemote: origin",
    ...(branches.length ? ["  allowedRefs:", ...branches.map((ref) => `    - ${ref}`)] : []),
  ].join("\n");
}
