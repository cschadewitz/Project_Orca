/** Local Linux root isolation. A pending receipt is evidence, never permission to retry Git. */
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { LocalHost } from "@orca/agents";
import { OrcaError, type Workspace } from "@orca/core";
import { z } from "zod";
import type { GitWorktreeProviderOptions } from "./git-worktree.js";
import { GIT_REF, gitRefMoved, gitRefRefusal, type ProvisionInput, refAllowed } from "./provider.js";

const exec = promisify(execFile);
const Receipt = z.strictObject({
  version: z.literal(1),
  runId: z.string(),
  repo: z.string(),
  commonDir: z.string(),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string(),
  path: z.string(),
  /** The named ref the run was given (#883), fetched once; `baseCommit` is what it named then. */
  ref: z.string().optional(),
  /** The object the ref named when checked and fetched (an annotated tag's tag object, else `baseCommit`). */
  refObject: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
});
type Receipt = z.infer<typeof Receipt>;
const refuse = () =>
  new OrcaError("RUN_STATE", "Owned root workspace is unavailable; inspect its original provisioning receipt");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd });
  return result.stdout.trim();
}

async function succeeds(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await exec("git", args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Preparing a caller-selected ref (#883) happens outside any agent sandbox, so no repository
 * hook (checkout, reference-transaction), fsmonitor command or submodule recursion may run.
 * Filter drivers are switched off separately, by name (`noFilters`).
 */
const CONTAINED = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
];
/** Default deadlines for the remote operations a ref needs; past them the ref is refused. */
const LS_REMOTE_MS = 30_000;
const FETCH_MS = 120_000;

/**
 * `-c` options that switch off every filter driver (clean, smudge, process) the configuration
 * at `cwd` names, so content a caller selected is written as stored, with no driver command
 * run outside the agent sandbox. A driver name `-c` cannot carry refuses provisioning.
 */
async function noFilters(cwd: string): Promise<string[]> {
  let keys: string;
  try {
    keys = (await exec("git", ["config", "--name-only", "--get-regexp", "^filter\\."], { cwd })).stdout;
  } catch (error) {
    // `git config --get-regexp` exits 1 when nothing matches; anything else is not a clean answer.
    if ((error as { code?: unknown }).code === 1) return [];
    throw refuse();
  }
  const drivers = new Set<string>();
  for (const key of keys.split("\n").filter(Boolean)) {
    const dot = key.lastIndexOf(".");
    if (dot <= "filter".length) continue; // `filter.<variable>` names no driver
    const name = key.slice("filter.".length, dot);
    if (!name || /[=\r\n]/.test(name)) throw refuse();
    drivers.add(name);
  }
  return [...drivers].flatMap((d) => [
    ...["clean", "smudge", "process"].flatMap((v) => ["-c", `filter.${d}.${v}=`]),
    ...["-c", `filter.${d}.required=false`],
  ]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Check each existing component, including dangling symlinks, before mkdir or Git. */
async function noSymlinks(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await noSymlinks(parent);
  if (await exists(path)) {
    if ((await lstat(path)).isSymbolicLink()) throw refuse();
    if ((await realpath(path)) !== path) throw refuse();
  }
}

/** Exclusive, durable reservation. A torn write also blocks reuse, retaining evidence. */
async function publish(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class OwnedRootWorktree {
  constructor(private readonly o: GitWorktreeProviderOptions) {}

  private async identity(runId: string) {
    if (
      !this.o.isolateRoots ||
      !(this.o.host instanceof LocalHost) ||
      process.platform !== "linux" ||
      !/^run_(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[0-9A-HJKMNP-TV-Z]{26})$/.test(runId)
    )
      throw refuse();
    const repo = resolve(this.o.repo);
    const root = resolve(this.o.worktreeRoot ?? join(dirname(repo), `${basename(repo)}-worktrees`));
    const path = join(root, runId);
    const branch = `${this.o.branchPrefix ?? "orca/"}roots/${runId}`;
    await noSymlinks(repo);
    await noSymlinks(root);
    if ((await git(repo, "rev-parse", "--show-toplevel")) !== repo) throw refuse();
    await git(repo, "check-ref-format", `refs/heads/${branch}`);
    const commonDir = await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    await noSymlinks(commonDir);
    const receipts = join(commonDir, "orca-root-workspaces");
    await noSymlinks(receipts);
    return { repo, root, path, branch, commonDir, receipts, receiptPath: join(receipts, `${runId}.json`) };
  }

  private get remote(): string {
    return this.o.fetchRemote ?? "origin";
  }

  /**
   * A remote Git operation: noninteractive (no terminal, askpass or credential-manager
   * prompt, batch-mode SSH unless the administrator configured `core.sshCommand`), with no
   * stdin, and killed at its deadline. Every failure, a timeout included, refuses the ref.
   */
  private async remoteGit(repo: string, ref: string, deadline: number, what: string, args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GCM_INTERACTIVE: "never",
    };
    if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !(await succeeds(repo, "config", "--get", "core.sshCommand")))
      env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    const timeout = this.o.remoteTimeoutMs ?? deadline;
    try {
      const pending = exec("git", [...CONTAINED, ...args], { cwd: repo, env, timeout, killSignal: "SIGKILL" });
      pending.child.stdin?.end();
      return (await pending).stdout;
    } catch (error) {
      const timedOut = (error as { killed?: boolean }).killed === true;
      throw gitRefRefusal(
        ref,
        timedOut
          ? `${what} '${this.remote}' did not finish within ${Math.round(timeout / 1000)}s`
          : `${what} '${this.remote}' failed`,
      );
    }
  }

  /**
   * Whether `ref` can give a run its own checkout (#883), without changing the repository:
   * fully qualified, allowed by the workspace's `allowedRefs`, and advertised by the fetch
   * remote under exactly that name. Run before admission; it fails closed when the remote
   * cannot be checked.
   */
  async checkRef(ref: string): Promise<string> {
    await this.admissible(ref);
    return this.advertised(resolve(this.o.repo), ref);
  }

  private async admissible(ref: string): Promise<void> {
    if (!GIT_REF.test(ref))
      throw gitRefRefusal(ref, "it is not a fully qualified branch or tag (refs/heads/… or refs/tags/…)");
    if (!this.o.isolateRoots || !(this.o.host instanceof LocalHost) || process.platform !== "linux")
      throw gitRefRefusal(ref, "owned root worktrees are not available on this daemon");
    if (!refAllowed(ref, this.o.allowedRefs))
      throw gitRefRefusal(ref, "the remote's workspace does not allow it (workspace.allowedRefs)");
    const repo = resolve(this.o.repo);
    if (!(await succeeds(repo, "check-ref-format", ref))) throw gitRefRefusal(ref, "it is not a valid ref name");
  }

  /** The commit the remote advertises under exactly `ref`; never a suffix match. */
  private async advertised(repo: string, ref: string): Promise<string> {
    const out = await this.remoteGit(repo, ref, LS_REMOTE_MS, "listing refs of", [
      "ls-remote",
      "--refs",
      "--",
      this.remote,
      ref,
    ]);
    const exact = out
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => cols[1] === ref);
    if (exact.length !== 1 || !/^[a-f0-9]{40,64}$/.test(exact[0]![0]!))
      throw gitRefRefusal(ref, `the '${this.remote}' remote does not have it`);
    return exact[0]![0]!;
  }

  /**
   * Fetch `ref` under a run-private ref and return the commit it names, refusing unless the
   * fetched object is exactly `expected`, the object `checkRef` saw (#883). The fetch writes
   * nothing else: no configured refspec mapping (remote-tracking refs), no pruning, no
   * FETCH_HEAD, no tags, submodules, commit-graph or automatic maintenance.
   */
  private async fetchRef(
    repo: string,
    runId: string,
    ref: string,
    expected: string | undefined,
  ): Promise<{
    object: string;
    commit: string;
  }> {
    // Rechecked at provision: the allowlist may have changed since admission.
    await this.admissible(ref);
    if (expected === undefined || !/^[a-f0-9]{40,64}$/.test(expected))
      throw gitRefRefusal(ref, "it was not checked before provisioning");
    const local = `refs/orca/fetched/${runId}`;
    try {
      await this.remoteGit(repo, ref, FETCH_MS, "fetching it from", [
        "-c",
        "fetch.writeCommitGraph=false",
        "-c",
        `remote.${this.remote}.followRemoteHEAD=never`,
        "fetch",
        "--refmap=",
        "--no-prune",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        "--",
        this.remote,
        `+${ref}:${local}`,
      ]);
      const object = await git(repo, "rev-parse", "--verify", "--end-of-options", local);
      if (object !== expected)
        throw gitRefMoved(ref, `it moved on '${this.remote}' after it was checked; admit the run again`);
      // A branch names a commit; an annotated tag names a tag object, peeled here explicitly.
      const commit = await git(repo, "rev-parse", "--verify", "--end-of-options", `${object}^{commit}`).catch(() => {
        throw gitRefRefusal(ref, "it does not name a commit");
      });
      return { object, commit };
    } catch (error) {
      if (error instanceof OrcaError) throw error;
      throw gitRefRefusal(ref, `fetching it from '${this.remote}' failed`);
    } finally {
      await git(repo, ...CONTAINED, "update-ref", "-d", local).catch(() => undefined);
    }
  }

  async provision(input: ProvisionInput): Promise<Workspace> {
    const identity = await this.identity(input.runId);
    const { repo, root, path, branch, commonDir, receipts, receiptPath } = identity;
    // Freeze before any external Git mutation; the receipt is the only source on retry.
    if (await exists(receiptPath)) {
      const receipt = await this.readReceipt(input.runId);
      // The receipt freezes what was provisioned; a retry must name the same ref and pin.
      if (receipt.ref !== input.gitRef || (input.gitRef && receipt.refObject !== input.gitRefObject)) throw refuse();
      const workspace = this.workspace(receipt);
      await this.validate(workspace);
      return workspace;
    }
    // A named ref is fetched before the reservation: a fetch changes no worktree, and the
    // commit it named is frozen in the receipt, so a retry never fetches again.
    const fetched = input.gitRef ? await this.fetchRef(repo, input.runId, input.gitRef, input.gitRefObject) : undefined;
    const baseCommit =
      fetched?.commit ??
      (await git(repo, "rev-parse", "--verify", "--end-of-options", `${this.o.baseBranch ?? "main"}^{commit}`));
    const receipt = Receipt.parse({
      version: 1,
      runId: input.runId,
      repo,
      commonDir,
      baseCommit,
      branch,
      path,
      ...(input.gitRef && fetched ? { ref: input.gitRef, refObject: fetched.object } : {}),
    });
    if (await exists(path)) throw refuse();
    if ((await git(repo, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`)).length) throw refuse();
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await publish(receiptPath, receipt);
    // The reservation is not durable until its directory entry in the Git common
    // directory is durable too. Failure retains evidence and must precede Git effects.
    const parent = await open(commonDir, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    // From here every failure retains the reservation. Never add again without a ready marker.
    await mkdir(root, { recursive: true });
    await noSymlinks(path);
    if (await exists(path)) throw refuse();
    if (input.gitRef) {
      // Caller-selected content: register the worktree without writing files, then write them
      // with no hook, fsmonitor command or filter driver, as configured for that worktree
      // (conditional includes there may name drivers the main checkout does not).
      await git(repo, ...CONTAINED, "worktree", "add", "--no-checkout", "-b", branch, "--", path, baseCommit);
      await git(path, ...CONTAINED, ...(await noFilters(path)), "reset", "-q", "--hard", baseCommit);
    } else await git(repo, "worktree", "add", "-b", branch, "--", path, baseCommit);
    const gitDir = await this.registration(receipt, true);
    await publish(`${receiptPath}.ready`, { gitDir });
    return this.workspace(receipt);
  }

  private workspace(receipt: Receipt): Workspace {
    return {
      hostId: this.o.host.id,
      cwd: receipt.path,
      repo: receipt.repo,
      branch: receipt.branch,
      provider: "git-worktree",
      rootProvisioning: {
        runId: receipt.runId,
        baseCommit: receipt.baseCommit,
        ...(receipt.ref ? { ref: receipt.ref } : {}),
        ...(receipt.refObject ? { refObject: receipt.refObject } : {}),
      },
    };
  }

  private async readReceipt(runId: string): Promise<Receipt> {
    const identity = await this.identity(runId);
    await noSymlinks(identity.receiptPath);
    const receipt = Receipt.parse(JSON.parse(await readFile(identity.receiptPath, "utf8")));
    if (
      receipt.runId !== runId ||
      receipt.repo !== identity.repo ||
      receipt.commonDir !== identity.commonDir ||
      receipt.branch !== identity.branch ||
      receipt.path !== identity.path
    )
      throw refuse();
    return receipt;
  }

  async validate(workspace: Workspace): Promise<void> {
    if (!workspace.rootProvisioning) throw refuse();
    const receipt = await this.readReceipt(workspace.rootProvisioning.runId);
    if (
      workspace.cwd !== receipt.path ||
      workspace.repo !== receipt.repo ||
      workspace.branch !== receipt.branch ||
      workspace.hostId !== this.o.host.id ||
      workspace.provider !== "git-worktree" ||
      workspace.rootProvisioning.baseCommit !== receipt.baseCommit ||
      workspace.rootProvisioning.ref !== receipt.ref ||
      workspace.rootProvisioning.refObject !== receipt.refObject
    )
      throw refuse();
    const { receiptPath } = await this.identity(receipt.runId);
    await noSymlinks(`${receiptPath}.ready`);
    const ready = z
      .strictObject({ gitDir: z.string() })
      .parse(JSON.parse(await readFile(`${receiptPath}.ready`, "utf8")));
    if ((await this.registration(receipt, false)) !== ready.gitDir) throw refuse();
  }

  private async registration(receipt: Receipt, pristine: boolean): Promise<string> {
    await noSymlinks(receipt.path);
    const dotGit = join(receipt.path, ".git");
    await noSymlinks(dotGit);
    if (!(await lstat(dotGit)).isFile()) throw refuse();
    if (
      (await git(receipt.path, "rev-parse", "--show-toplevel")) !== receipt.path ||
      (await git(receipt.path, "rev-parse", "--path-format=absolute", "--git-common-dir")) !== receipt.commonDir ||
      (await git(receipt.path, "symbolic-ref", "HEAD")) !== `refs/heads/${receipt.branch}`
    )
      throw refuse();
    const head = await git(receipt.path, "rev-parse", "HEAD");
    const entries = (await git(receipt.repo, "worktree", "list", "--porcelain", "-z")).split("\0\0");
    const registered = entries.filter((entry) => entry.split("\0").includes(`worktree ${receipt.path}`));
    if (
      registered.length !== 1 ||
      !registered[0]!.split("\0").includes(`branch refs/heads/${receipt.branch}`) ||
      !registered[0]!.split("\0").includes(`HEAD ${head}`)
    )
      throw refuse();
    if (pristine && head !== receipt.baseCommit) throw refuse();
    // Owned edits and descendant commits survive cancellation/resume. Rewritten ancestry does not.
    await git(receipt.path, "merge-base", "--is-ancestor", receipt.baseCommit, head);
    const gitDir = await git(receipt.path, "rev-parse", "--absolute-git-dir");
    await noSymlinks(gitDir);
    return gitDir;
  }
}
