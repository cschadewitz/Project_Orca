/**
 * Putting a repository on a managed server from the client (#1235). The "server" is a temporary
 * home on this machine: every remote command runs here, in that home, exactly as ssh would run
 * its words, so real git does the bundling, fetching and cloning on both sides.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CourierTransport } from "../src/server-courier.js";
import {
  bundleRepository,
  hostRepositoryPaths,
  localGit,
  pushRepository,
  refsToPush,
  repositoryName,
  RepositoryRefused,
  workspaceSnippet,
} from "../src/server-repository.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-repository-test-"));
  dirs.push(dir);
  return dir;
};
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function repo(first = "one\n"): string {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), first);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}
function commit(dir: string, text: string) {
  writeFileSync(join(dir, "README.md"), text);
  git(dir, "commit", "-q", "-am", text.trim());
}

/** A server whose home is a temporary directory, with ORCA set up there (its root exists). */
function server(options: { setUp?: boolean; fail?: (command: readonly string[]) => boolean } = {}) {
  const home = tmp();
  if (options.setUp !== false) mkdirSync(join(home, ".local/share/orca-server"), { recursive: true });
  const commands: string[][] = [];
  const transport: CourierTransport = {
    exec: (command) => {
      commands.push([...command]);
      if (options.fail?.(command)) return Promise.resolve({ code: 1, stdout: "" });
      const result = spawnSync(command[0]!, command.slice(1), { cwd: home, env, encoding: "utf8" });
      return Promise.resolve({ code: result.status ?? 255, stdout: result.stdout ?? "" });
    },
    upload: (path, remotePath) => {
      copyFileSync(path, remotePath.startsWith("/") ? remotePath : join(home, remotePath));
      return Promise.resolve();
    },
  };
  return { home, transport, commands, root: join(home, ".local/share/orca-server") };
}

async function push(local: string, transport: CourierTransport, name = "app", requested: string[] = []) {
  const refs = await refsToPush(localGit, local, requested);
  const bundle = await bundleRepository(localGit, local, refs);
  try {
    return await pushRepository(transport, bundle, { name, refs });
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
}

describe("pushRepository", () => {
  it("creates the bare repository and a checkout, then moves both forward on the next push", async () => {
    const local = repo();
    const host = server();
    const first = await push(local, host.transport);
    expect(first).toMatchObject({
      hub: `${host.root}/repos/app.git`,
      checkout: `${host.root}/checkouts/app`,
      refs: ["refs/heads/main"],
      checkoutState: { kind: "created" },
    });
    expect(git(first.checkout, "rev-parse", "HEAD")).toBe(git(local, "rev-parse", "HEAD"));
    expect(git(first.checkout, "remote", "get-url", "origin")).toBe(first.hub);

    commit(local, "two\n");
    const second = await push(local, host.transport);
    expect(second.checkoutState).toEqual({ kind: "updated" });
    expect(git(second.checkout, "rev-parse", "HEAD")).toBe(git(local, "rev-parse", "HEAD"));
    // Nothing is read by a shell: every command is words, and no command word is a shell.
    expect(host.commands.some((command) => ["sh", "bash", "-c"].includes(command[0]!))).toBe(false);
    expect(workspaceSnippet(second)).toContain(`repo: ${host.root}/checkouts/app`);
  });

  it("never overwrites a branch the server has that this push does not build on", async () => {
    const local = repo();
    const host = server();
    await push(local, host.transport);
    // Unrelated history: its main does not build on the server's.
    const other = repo("another project\n");
    await expect(push(other, host.transport)).rejects.toThrow(/Nothing was overwritten|missing history/);
    expect(git(`${host.root}/repos/app.git`, "rev-parse", "refs/heads/main")).toBe(git(local, "rev-parse", "HEAD"));
  });

  it("keeps a checkout with changes of its own, and still updates the bare repository", async () => {
    const local = repo();
    const host = server();
    const first = await push(local, host.transport);
    writeFileSync(join(first.checkout, "README.md"), "edited on the server\n");
    git(first.checkout, "commit", "-q", "-am", "server edit");
    commit(local, "two\n");
    const second = await push(local, host.transport);
    expect(second.checkoutState).toMatchObject({ kind: "kept", usable: true });
    expect(git(second.hub, "rev-parse", "refs/heads/main")).toBe(git(local, "rev-parse", "HEAD"));
  });

  it("never touches a checkout whose origin is another repository, and offers no settings for it", async () => {
    const local = repo();
    const host = server();
    const elsewhere = repo("someone else's\n");
    mkdirSync(join(host.root, "checkouts"), { recursive: true });
    git(host.root, "clone", "-q", elsewhere, join(host.root, "checkouts/app"));
    const before = git(join(host.root, "checkouts/app"), "rev-parse", "HEAD");
    const pushed = await push(local, host.transport);
    expect(pushed.checkoutState).toMatchObject({ kind: "kept", usable: false });
    expect(workspaceSnippet(pushed)).toBeUndefined();
    expect(git(pushed.checkout, "rev-parse", "HEAD")).toBe(before);
    expect(host.commands.some((c) => c.includes(pushed.checkout) && (c.includes("fetch") || c.includes("merge")))).toBe(
      false,
    );
  });

  it("does not merge when the checkout's fetch fails, and offers no settings when the first clone fails", async () => {
    const local = repo();
    const failing = { fetch: false, clone: false };
    const host = server({
      fail: (command) =>
        (failing.fetch && command[3] === "fetch" && command[2]!.endsWith("/checkouts/app")) ||
        (failing.clone && command[1] === "clone"),
    });
    failing.clone = true;
    const refused = await push(local, host.transport);
    expect(refused.checkoutState).toMatchObject({ kind: "kept", usable: false });
    expect(workspaceSnippet(refused)).toBeUndefined();
    failing.clone = false;
    await push(local, host.transport);
    failing.fetch = true;
    commit(local, "two\n");
    host.commands.length = 0;
    const kept = await push(local, host.transport);
    expect(kept.checkoutState).toMatchObject({ kind: "kept", reason: expect.stringMatching(/could not fetch/) });
    expect(host.commands.some((c) => c.includes("merge"))).toBe(false);
  });

  it("updates no ref when any one of them is refused", async () => {
    const local = repo();
    const host = server();
    await push(local, host.transport);
    const other = repo("another project\n");
    git(other, "branch", "feature");
    await expect(push(other, host.transport, "app", ["refs/heads/main", "refs/heads/feature"])).rejects.toThrow(
      /Nothing was overwritten/,
    );
    const hub = `${host.root}/repos/app.git`;
    expect(git(hub, "rev-parse", "refs/heads/main")).toBe(git(local, "rev-parse", "HEAD"));
    expect(() => git(hub, "rev-parse", "--verify", "-q", "refs/heads/feature")).toThrow();
  });

  it("refuses a machine that is not set up yet, before anything is made", async () => {
    const host = server({ setUp: false });
    await expect(push(repo(), host.transport)).rejects.toThrow(/not an ORCA server yet/);
    expect(host.commands).toHaveLength(1);
  });
});

describe("what is pushed", () => {
  it("is the current branch by default, or full branch and tag names that exist here", async () => {
    const local = repo();
    git(local, "tag", "v1");
    await expect(refsToPush(localGit, local, [])).resolves.toEqual(["refs/heads/main"]);
    await expect(refsToPush(localGit, local, ["refs/tags/v1", "refs/heads/main"])).resolves.toEqual([
      "refs/tags/v1",
      "refs/heads/main",
    ]);
    for (const ref of ["main", "refs/heads/nope", "refs/remotes/origin/main", "refs/heads/a..b", "refs/heads/$(x)"])
      await expect(refsToPush(localGit, local, [ref])).rejects.toBeInstanceOf(RepositoryRefused);
  });

  it("goes under the server root by a name that is one path segment", () => {
    expect(repositoryName("My App.git")).toBe("my-app");
    expect(() => repositoryName("..")).toThrow(/--name/);
    expect(() => hostRepositoryPaths("/home/a b", "app")).toThrow(/server root/);
    expect(() => hostRepositoryPaths("/srv/orca", "../x")).toThrow(/repository name/);
  });
});
