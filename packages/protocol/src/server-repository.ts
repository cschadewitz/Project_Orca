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
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourierRefused, dropCourier, fileSha256, pushCourier, type CourierTransport } from "./server-courier.js";

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
/** Each command of a listing: reading, never fetching. */
const LIST_TIMEOUT_MS = 60_000;

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
    return { dir, path, sha256: await fileSha256(path), size };
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
  /**
   * `created`: cloned now; `updated`: its branch moved to the pushed commit; `kept`: left as it
   * was, with why. `usable`: it is still a checkout of this push's repository, so the workspace
   * settings apply to it.
   */
  checkoutState: { kind: "created" | "updated" } | { kind: "kept"; reason: string; usable: boolean };
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
  // Both parents must be the managed root's own directories, not links elsewhere, before
  // anything is made or changed under them.
  for (const parent of [`${root}/repos`, `${root}/checkouts`])
    if ((await run(transport, ["realpath", "-e", "--", parent])).stdout.trim() !== parent)
      throw new RepositoryRefused(
        `${parent} on the server is not a directory of the ORCA server's own. Nothing was changed.`,
      );
  // An existing hub is used only if it is exactly that bare repository; a new one is made there.
  if ((await run(transport, ["test", "-e", hub])).code === 0) await assertHub(transport, hub);
  else {
    if ((await run(transport, ["git", "init", "--bare", "-q", hub])).code !== 0)
      throw new RepositoryRefused(`Could not make ${hub} on the server.`);
    await assertHub(transport, hub);
  }

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
      // All or nothing: one refused ref leaves every other ref as it was.
      "--atomic",
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
  const checkoutState = await updateCheckout(transport, hub, checkout, branch);
  return { name: options.name, hub, checkout, refs: [...options.refs], checkoutState };
}

/** Whether `hub` is itself a bare repository, where it was made, with nothing redirecting Git. */
async function isHub(transport: CourierTransport, hub: string): Promise<boolean> {
  const resolved = await run(transport, ["realpath", "-e", "--", hub]);
  const gitDir = await run(transport, ["git", "-C", hub, "rev-parse", "--absolute-git-dir"]);
  const bare = await run(transport, ["git", "-C", hub, "rev-parse", "--is-bare-repository"]);
  return (
    resolved.stdout.trim() === hub && gitDir.code === 0 && gitDir.stdout.trim() === hub && bare.stdout.trim() === "true"
  );
}

/** Refuse unless `hub` is itself a bare repository, where it was made, with nothing redirecting Git. */
async function assertHub(transport: CourierTransport, hub: string): Promise<void> {
  if (!(await isHub(transport, hub)))
    throw new RepositoryRefused(
      `${hub} on the server is not the bare repository a push made there. Nothing was changed.`,
    );
}

/**
 * Create the checkout from the hub, or move it forward to exactly the commit the hub's `branch`
 * now names. An existing checkout is touched only when its `origin` is this hub: anything else
 * at that path is someone else's and is left alone, and is not a workspace this push made.
 */
async function updateCheckout(
  transport: CourierTransport,
  hub: string,
  checkout: string,
  branch: string | undefined,
): Promise<RepositoryPushed["checkoutState"]> {
  const kept = (reason: string, usable: boolean) => ({ kind: "kept" as const, reason, usable });
  if ((await run(transport, ["test", "-e", checkout])).code !== 0) {
    const cloned = await run(transport, ["git", "clone", "-q", "--no-hardlinks", "--", hub, checkout]);
    return cloned.code === 0 ? { kind: "created" } : kept("it could not be cloned", false);
  }
  const own = await checkoutOf(transport, checkout, hub);
  if (own === "elsewhere") return kept(`it is not a checkout of its own at ${checkout}, so it was not touched`, false);
  if (own === "other") return kept(`it is not a checkout of ${hub}, so it was not touched`, false);
  if (!branch) return kept("only tags were pushed", true);
  const short = branch.slice("refs/heads/".length);
  const current = await run(transport, ["git", "-C", checkout, "symbolic-ref", "-q", "HEAD"]);
  if (current.code !== 0 || current.stdout.trim() !== branch) return kept(`it is not on ${short}`, true);
  // The exact commit the hub's branch names now, never what some other remote says.
  const tip = await run(transport, ["git", "-C", hub, "rev-parse", "-q", "--verify", branch]);
  const commit = tip.stdout.trim();
  if (tip.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit))
    return kept("the pushed branch could not be read", true);
  const fetched = await run(transport, ["git", "-C", checkout, "fetch", "-q", "--no-tags", "--", hub, branch]);
  if (fetched.code !== 0) return kept("it could not fetch from the server's repository", true);
  const moved = await run(transport, ["git", "-C", checkout, "merge", "-q", "--ff-only", commit]);
  return moved.code === 0 ? { kind: "updated" } : kept("it has changes of its own, so it was not moved forward", true);
}

/**
 * Whether `checkout` is a checkout of `hub`: `elsewhere` when Git is not working on exactly that
 * directory as its worktree root (`git -C` finds a repository above the path it is given, and a
 * link would lead out of the server root), `other` when its `origin` is not the hub.
 */
async function checkoutOf(
  transport: CourierTransport,
  checkout: string,
  hub: string,
): Promise<"yes" | "elsewhere" | "other"> {
  const resolved = await run(transport, ["realpath", "-e", "--", checkout]);
  const top = await run(transport, ["git", "-C", checkout, "rev-parse", "--show-toplevel"]);
  if (resolved.code !== 0 || resolved.stdout.trim() !== checkout || top.code !== 0 || top.stdout.trim() !== checkout)
    return "elsewhere";
  const origin = await run(transport, ["git", "-C", checkout, "remote", "get-url", "origin"]);
  return origin.code === 0 && origin.stdout.trim() === hub ? "yes" : "other";
}

/** A repository a push put on the server, with a checkout of it a daemon can work in. */
export interface HostRepository {
  name: string;
  /** The checkout: the value for `workspace.repo`. */
  checkout: string;
  /** The branches the server has, from what was pushed. */
  branches: string[];
  /**
   * The `workspace:` settings that make a daemon work in the checkout, when it is on a branch
   * that exists in it: new work items branch from that branch, the one the checkout has, never
   * a name only the bare repository knows. Absent when the checkout is on no such branch.
   */
  workspace?: HostWorkspace;
  /** Why there are no workspace settings for it. */
  problem?: string;
}

/** The `workspace:` settings for a pushed checkout, as `hostRepositories` builds them. */
export interface HostWorkspace {
  provider: "git-worktree";
  repo: string;
  /** A branch the checkout itself has, so a work item's worktree can start from it. */
  baseBranch: string;
  /** The checkout's `origin`: the bare repository the pushes went to. */
  fetchRemote: "origin";
  /** The branches pushed there, which delegated runs may name. */
  allowedRefs?: string[];
}

/** The most repositories, and branches of one, that are listed. */
const LIST_LIMIT = 50;

/**
 * The repositories pushes put on this server (`repos/<name>.git`) that have a checkout of their
 * own beside them (`checkouts/<name>`), as `pushRepository` leaves them. Anything else under the
 * server root, or a directory that is a link out of it, is not listed. Nothing is changed.
 */
export async function hostRepositories(transport: CourierTransport): Promise<HostRepository[]> {
  const located = await run(transport, ["realpath", "-e", "--", SERVER_ROOT_FROM_HOME], LIST_TIMEOUT_MS);
  const root = located.stdout.trim();
  if (located.code !== 0 || !ROOT.test(root) || root.split("/").includes(".."))
    throw new RepositoryRefused("This machine is not an ORCA server yet: set it up first.");
  for (const parent of [`${root}/repos`, `${root}/checkouts`]) {
    const resolved = await run(transport, ["realpath", "-e", "--", parent], LIST_TIMEOUT_MS);
    if (resolved.code !== 0 || resolved.stdout.trim() !== parent) return [];
  }
  const listed = await run(transport, ["ls", "-1", "-A", "--", `${root}/repos`], LIST_TIMEOUT_MS);
  if (listed.code !== 0) return [];
  const names = listed.stdout
    .split("\n")
    .filter((entry) => entry.endsWith(".git"))
    .map((entry) => entry.slice(0, -".git".length))
    .filter((name) => NAME.test(name) && !name.includes(".."))
    .sort()
    .slice(0, LIST_LIMIT);
  const found: HostRepository[] = [];
  for (const name of names) {
    const { hub, checkout } = hostRepositoryPaths(root, name);
    if (!(await isHub(transport, hub)) || (await checkoutOf(transport, checkout, hub)) !== "yes") continue;
    const refs = await run(
      transport,
      ["git", "-C", hub, "for-each-ref", "--format=%(refname)", "refs/heads/"],
      LIST_TIMEOUT_MS,
    );
    if (refs.code !== 0) continue;
    const branches = refs.stdout
      .split("\n")
      .filter((ref) => REF.test(ref) && ref.startsWith("refs/heads/") && !ref.split("/").includes(".."))
      .slice(0, LIST_LIMIT);
    // The branch the checkout is on, and only if the checkout itself has it: a later push of
    // another branch moves the bare repository's HEAD but leaves the checkout where it was.
    const current = (
      await run(transport, ["git", "-C", checkout, "symbolic-ref", "-q", "HEAD"], LIST_TIMEOUT_MS)
    ).stdout.trim();
    const base =
      REF.test(current) &&
      current.startsWith("refs/heads/") &&
      !current.split("/").includes("..") &&
      (
        await run(
          transport,
          ["git", "-C", checkout, "rev-parse", "-q", "--verify", `${current}^{commit}`],
          LIST_TIMEOUT_MS,
        )
      ).code === 0
        ? current.slice("refs/heads/".length)
        : undefined;
    found.push({
      name,
      checkout,
      branches,
      ...(base
        ? {
            workspace: {
              provider: "git-worktree" as const,
              repo: checkout,
              baseBranch: base,
              fetchRemote: "origin" as const,
              ...(branches.length ? { allowedRefs: [...branches] } : {}),
            },
          }
        : { problem: "Its checkout on the server is not on a branch of its own, so no work can start from it." }),
    });
  }
  return found;
}

/** Whether the checkout is one this push's repository backs, so the daemon can work there. */
export function checkoutUsable(pushed: RepositoryPushed): boolean {
  return pushed.checkoutState.kind !== "kept" || pushed.checkoutState.usable;
}

/**
 * The workspace settings that make the daemon work in the pushed checkout (docs/WORKFLOWS.md).
 * Only for a usable checkout: there is nothing to point a daemon at otherwise.
 */
export function workspaceSnippet(pushed: RepositoryPushed): string | undefined {
  if (!checkoutUsable(pushed)) return undefined;
  const branches = pushed.refs.filter((ref) => ref.startsWith("refs/heads/"));
  return [
    "workspace:",
    "  provider: git-worktree",
    `  repo: ${pushed.checkout}`,
    "  fetchRemote: origin",
    ...(branches.length ? ["  allowedRefs:", ...branches.map((ref) => `    - ${ref}`)] : []),
  ].join("\n");
}
