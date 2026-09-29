/**
 * LocalWorkspaceProvider in a git checkout (#139): a work item's run gets `orca/<slug>`
 * checked out and records the branch it replaced; outside git, or without a work item,
 * nothing changes.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkItem } from "@orca/core";
import { LocalWorkspaceProvider } from "@orca/engine";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-local-ws-"));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function repo(): Promise<string> {
  const dir = await tempDir();
  git(dir, "init", "-q", "-b", "trunk");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

const workItem = (slug: string) => ({ slug }) as WorkItem;

describe("LocalWorkspaceProvider in a git checkout", () => {
  it("checks out orca/<slug> for a work item and records the branch it replaced", async () => {
    const dir = await repo();
    const ws = await new LocalWorkspaceProvider(dir).provision({
      runId: "run_1",
      workflowId: "w",
      workItem: workItem("add-login"),
    });
    expect(ws).toMatchObject({ cwd: dir, provider: "local", branch: "orca/add-login", previousBranch: "trunk" });
    expect(git(dir, "branch", "--show-current")).toBe("orca/add-login");
  });

  it("reuses an existing orca/<slug> branch, and leaves an already-checked-out one alone", async () => {
    const dir = await repo();
    git(dir, "branch", "orca/add-login");
    const provider = new LocalWorkspaceProvider(dir);
    const first = await provider.provision({ runId: "run_1", workflowId: "w", workItem: workItem("add-login") });
    expect(first).toMatchObject({ branch: "orca/add-login", previousBranch: "trunk" });
    const again = await provider.provision({ runId: "run_2", workflowId: "w", workItem: workItem("add-login") });
    expect(again.branch).toBe("orca/add-login");
    expect(again).not.toHaveProperty("previousBranch");
    expect(git(dir, "branch", "--show-current")).toBe("orca/add-login");
  });

  it("switches the parent's checkout when a child run is for a work item", async () => {
    const dir = await repo();
    const provider = new LocalWorkspaceProvider(dir);
    const parent = await provider.provision({ runId: "run_p", workflowId: "program" });
    expect(parent).toEqual({ hostId: "local", cwd: dir, provider: "local" });
    const child = await provider.provision({ runId: "run_c", workflowId: "w", workItem: workItem("fix"), parent });
    expect(child).toMatchObject({ cwd: dir, branch: "orca/fix", previousBranch: "trunk" });
  });

  it("changes nothing without a work item, or outside a git repository", async () => {
    const dir = await repo();
    expect(await new LocalWorkspaceProvider(dir).provision({ runId: "run_1", workflowId: "w" })).toEqual({
      hostId: "local",
      cwd: dir,
      provider: "local",
    });
    expect(git(dir, "branch", "--show-current")).toBe("trunk");

    const plain = await tempDir();
    expect(
      await new LocalWorkspaceProvider(plain).provision({ runId: "run_1", workflowId: "w", workItem: workItem("x") }),
    ).toEqual({ hostId: "local", cwd: plain, provider: "local" });
  });
});
