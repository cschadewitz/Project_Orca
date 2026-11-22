import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalHost, SshHost } from "@orca/agents";
import { SshHostSchema, type WorkItem } from "@orca/core";
import { GitWorktreeProvider } from "../src/workspace/git-worktree.js";
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (repo: string) =>
  git(
    repo,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    randomUUID(),
  );
async function rootFixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), "orca-owned-root-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo);
  const options = {
    host: new LocalHost({ id: "local", type: "local" }),
    repo,
    worktreeRoot: join(dir, "trees"),
    isolateRoots: true,
  };
  const provider = new GitWorktreeProvider(options);
  const input = { runId: `run_${randomUUID()}`, workflowId: "test" };
  const receipt = join(repo, ".git", "orca-root-workspaces", `${input.runId}.json`);
  return { dir, repo, options, provider, input, receipt };
}

it("isolates concurrent roots by reserved identity and retains dirty owned work on reuse", async () => {
  const f = await rootFixture();
  const [a, b] = await Promise.all([
    f.provider.provision(f.input),
    f.provider.provision({ ...f.input, runId: `run_${randomUUID()}` }),
  ]);
  expect(a.cwd).not.toBe(b.cwd);
  expect(a.branch).not.toBe(b.branch);
  await fs.writeFile(join(a.cwd, "partial.txt"), "keep me");
  expect(await new GitWorktreeProvider(f.options).provision(f.input)).toEqual(a);
  expect(await fs.readFile(join(a.cwd, "partial.txt"), "utf8")).toBe("keep me");
  await expect(f.provider.release(a)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(git(f.repo, "branch", "--show-current")).toBe("main");
});

it("preserves default roots, child inheritance and WorkItem branches", async () => {
  const f = await rootFixture();
  expect((await new GitWorktreeProvider({ ...f.options, isolateRoots: false }).provision(f.input)).cwd).toBe(f.repo);
  const parent = await f.provider.provision(f.input);
  expect(await f.provider.provision({ ...f.input, parent })).toEqual(parent);
  const workItem = { slug: "existing-item" } as WorkItem;
  const item = await f.provider.provision({ ...f.input, workItem });
  expect(item.branch).toBe("orca/existing-item");
  expect(item.rootProvisioning).toBeUndefined();
});

it("freezes the base in the durable receipt before worktree add", async () => {
  const f = await rootFixture();
  const base = git(f.repo, "rev-parse", "HEAD");
  const mkdir = fs.mkdir;
  vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === f.options.worktreeRoot) {
      expect(JSON.parse(await fs.readFile(f.receipt, "utf8"))).toMatchObject({ baseCommit: base });
      commit(f.repo);
    }
    return mkdir(...args);
  });
  const ws = await f.provider.provision(f.input);
  expect(git(ws.cwd, "rev-parse", "HEAD")).toBe(base);
  expect(git(f.repo, "rev-parse", "HEAD")).not.toBe(base);
});

it.each(["before-add", "after-add"])(
  "retains pending evidence and refuses to repeat Git after %s failure",
  async (boundary) => {
    const f = await rootFixture();
    if (boundary === "before-add") {
      const mkdir = fs.mkdir;
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        if (args[0] === f.options.worktreeRoot) throw new Error("injected before add");
        return mkdir(...args);
      });
    } else {
      const open = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === `${f.receipt}.ready`) throw new Error("injected after add");
        return open(...args);
      });
    }
    await expect(f.provider.provision(f.input)).rejects.toThrow("injected");
    vi.restoreAllMocks();
    const before = git(f.repo, "worktree", "list", "--porcelain");
    const receipt = await fs.readFile(f.receipt, "utf8");
    await expect(new GitWorktreeProvider(f.options).provision(f.input)).rejects.toThrow();
    expect(await fs.readFile(f.receipt, "utf8")).toBe(receipt);
    expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
  },
);

it.each(["parent-sync", "receipt-sync"])("retains evidence before Git on %s failure", async (boundary) => {
  const f = await rootFixture();
  const before = git(f.repo, "worktree", "list", "--porcelain");
  const open = fs.open;
  const synced: string[] = [];
  const target = boundary === "parent-sync" ? join(f.repo, ".git") : f.receipt;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    const sync = file.sync.bind(file);
    vi.spyOn(file, "sync").mockImplementation(async () => {
      synced.push(String(args[0]));
      if (args[0] === target) throw new Error("injected sync failure");
      await sync();
    });
    return file;
  });
  await expect(f.provider.provision(f.input)).rejects.toThrow("injected sync failure");
  expect(synced).toContain(target);
  expect(await fs.readFile(f.receipt, "utf8")).toContain(f.input.runId);
  expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
  expect(git(f.repo, "for-each-ref", "--format=%(refname)", `refs/heads/orca/roots/${f.input.runId}`)).toBe("");
  await expect(fs.stat(join(f.options.worktreeRoot, f.input.runId))).rejects.toMatchObject({ code: "ENOENT" });
  vi.restoreAllMocks();
  await expect(f.provider.provision(f.input)).rejects.toThrow();
  expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
});

it("syncs the receipt and its directory and parent before the first Git mutation", async () => {
  const f = await rootFixture();
  const open = fs.open;
  const synced: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    const sync = file.sync.bind(file);
    vi.spyOn(file, "sync").mockImplementation(async () => {
      await sync();
      synced.push(String(args[0]));
    });
    return file;
  });
  const mkdir = fs.mkdir;
  vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === f.options.worktreeRoot) {
      expect(synced).toEqual([f.receipt, join(f.repo, ".git", "orca-root-workspaces"), join(f.repo, ".git")]);
      expect(git(f.repo, "worktree", "list", "--porcelain")).not.toContain(f.input.runId);
    }
    return mkdir(...args);
  });
  await f.provider.provision(f.input);
});

it.each(["directory", "dirty-worktree", "symlink", "branch"])("refuses unowned %s without cleanup", async (kind) => {
  const f = await rootFixture();
  const path = join(f.options.worktreeRoot, f.input.runId);
  const branch = `orca/roots/${f.input.runId}`;
  await fs.mkdir(f.options.worktreeRoot);
  if (kind === "directory") await fs.mkdir(path);
  if (kind === "symlink") await fs.symlink(f.repo, path);
  if (kind === "branch") git(f.repo, "branch", branch);
  if (kind === "dirty-worktree") {
    git(f.repo, "worktree", "add", "-qb", branch, path);
    await fs.writeFile(join(path, "partial"), "unowned");
  }
  const before = git(f.repo, "worktree", "list", "--porcelain");
  await expect(f.provider.provision(f.input)).rejects.toThrow();
  expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
  await expect(fs.stat(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
  if (kind === "dirty-worktree") expect(await fs.readFile(join(path, "partial"), "utf8")).toBe("unowned");
});

it.each(["branch", "base", "registration", "repository", "symlink", "receipt"])(
  "refuses changed %s on reuse",
  async (kind) => {
    const f = await rootFixture();
    const ws = await f.provider.provision(f.input);
    if (kind === "branch") git(ws.cwd, "checkout", "-qb", "wrong");
    if (kind === "base") {
      git(ws.cwd, "checkout", "--orphan", "unrelated");
      commit(ws.cwd);
      git(ws.cwd, "branch", "-f", ws.branch!, "HEAD");
      git(ws.cwd, "checkout", ws.branch!);
    }
    if (kind === "registration") {
      const gitDir = git(ws.cwd, "rev-parse", "--absolute-git-dir");
      await fs.writeFile(join(gitDir, "gitdir"), join(f.dir, "wrong", ".git"));
    }
    if (kind === "repository") {
      await fs.rename(join(ws.cwd, ".git"), join(ws.cwd, ".git.saved"));
      git(ws.cwd, "init", "-q", "-b", ws.branch!);
      commit(ws.cwd);
    }
    if (kind === "symlink") {
      await fs.rename(ws.cwd, `${ws.cwd}-saved`);
      await fs.symlink(`${ws.cwd}-saved`, ws.cwd);
    }
    if (kind === "receipt") {
      const receipt = JSON.parse(await fs.readFile(f.receipt, "utf8")) as Record<string, unknown>;
      receipt.runId = `run_${randomUUID()}`;
      await fs.writeFile(f.receipt, JSON.stringify(receipt));
    }
    await expect(f.provider.validate(ws)).rejects.toThrow();
  },
);

it("refuses traversal identities and symlinked configured parents before effects", async () => {
  const f = await rootFixture();
  await expect(f.provider.provision({ ...f.input, runId: "../../outside" })).rejects.toThrow();
  await fs.symlink(f.repo, f.options.worktreeRoot);
  await expect(f.provider.provision(f.input)).rejects.toThrow();
  await expect(fs.stat(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses remote opt-in roots rather than falling back to the shared checkout", async () => {
  const f = await rootFixture();
  const provider = new GitWorktreeProvider({
    ...f.options,
    host: new SshHost(SshHostSchema.parse({ id: "remote", type: "ssh", host: "unused.invalid" })),
  });
  await expect(provider.provision(f.input)).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(fs.stat(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
});

/** A repository whose `origin` is a bare repository with a `feature` branch ahead of `main`. */
async function refFixture() {
  const f = await rootFixture();
  const upstream = join(f.dir, "upstream.git");
  git(f.dir, "clone", "-q", "--bare", f.repo, upstream);
  const work = join(f.dir, "upstream-work");
  git(f.dir, "clone", "-q", upstream, work);
  git(work, "checkout", "-q", "-b", "feature");
  commit(work);
  git(work, "push", "-q", "origin", "feature");
  git(f.repo, "remote", "add", "origin", upstream);
  return { ...f, feature: git(work, "rev-parse", "HEAD") };
}

it("checks out a named ref fetched from the remote into a run's own root (#883)", async () => {
  const f = await refFixture();
  // The local repository has never seen the branch: checking and provisioning fetch it.
  await expect(f.provider.checkRef("feature")).resolves.toBeUndefined();
  const workspace = await f.provider.provision({ ...f.input, gitRef: "feature" });
  expect(workspace.rootProvisioning).toEqual({ runId: f.input.runId, baseCommit: f.feature, ref: "feature" });
  expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(f.feature);
  // The run-private fetch ref is gone; the run's own branch holds the commit.
  expect(git(f.repo, "for-each-ref", "refs/orca")).toBe("");
  // Reuse is from the receipt, never a second fetch, and only for the same ref.
  expect(await new GitWorktreeProvider(f.options).provision({ ...f.input, gitRef: "feature" })).toEqual(workspace);
  await expect(new GitWorktreeProvider(f.options).provision(f.input)).rejects.toThrow("unavailable");
  // A commit the repository now has is taken as is.
  await expect(f.provider.checkRef(f.feature)).resolves.toBeUndefined();
});

it("refuses a ref it cannot check out, before anything is fetched or reserved (#883)", async () => {
  const f = await refFixture();
  for (const ref of ["-u", "a..b", "main@{1}", "x:y", "nope"])
    await expect(f.provider.checkRef(ref)).rejects.toMatchObject({ code: "NOT_SUPPORTED", details: { gitRef: ref } });
  await expect(f.provider.checkRef("0".repeat(40))).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  const shared = new GitWorktreeProvider({ ...f.options, isolateRoots: false });
  await expect(shared.checkRef("feature")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  await expect(shared.provision({ ...f.input, gitRef: "feature" })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  await expect(fs.readdir(join(f.repo, ".git", "orca-root-workspaces"))).rejects.toThrow();
});
