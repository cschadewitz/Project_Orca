// @vitest-environment happy-dom
/**
 * Repositories pushed to a managed server, on its Config surface (#1235): with no workspace the
 * pushed checkout becomes one; a workspace already on it only gains the pushed branches it does
 * not allow; any other workspace is left alone with the reason; and a report is staged only on
 * the connection it was read on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DaemonTargetSnapshot, HostRepositoryView } from "../../src/daemon-connection.js";

const studio = {
  value: {} as unknown,
  target: { epoch: 1 },
  edits: [] as unknown[],
  subscribe: () => () => {},
  editAccess: () => ({ allowed: true as const }),
  edit(edits: unknown[]) {
    this.edits.push(...edits);
  },
};
vi.mock("../src/config/configuration-studio-context.js", () => ({ useConfigurationStudio: () => studio }));

const { HostRepositoriesSection, workspacePlan } = await import("../src/config/host-repositories-section.js");

const checkout = "/home/a/.local/share/orca-server/checkouts/app";
const app: HostRepositoryView = {
  name: "app",
  checkout,
  branches: ["refs/heads/main", "refs/heads/release/1.2"],
  head: "refs/heads/release/1.2",
};
const lab = { id: "lab", name: "Lab", destination: "casey@lab" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  studio.edits = [];
  studio.value = {};
  studio.target = { epoch: 1 };
});

function connect(repositories: HostRepositoryView[], profile?: typeof lab) {
  let snapshot = { epoch: 1, ...(profile ? { profile } : {}) } as DaemonTargetSnapshot;
  const listeners = new Set<(target: DaemonTargetSnapshot) => void>();
  const replies: ((value: HostRepositoryView[]) => void)[] = [];
  const hostRepositories = vi.fn(
    () =>
      new Promise<{ ok: true; value: HostRepositoryView[] }>((resolve) =>
        replies.push((value) => resolve({ ok: true, value })),
      ),
  );
  vi.stubGlobal("orca", {
    daemonConnection: {
      read: () => snapshot,
      subscribe: (listener: (target: DaemonTargetSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      profiles: { hostRepositories },
    },
  });
  return {
    hostRepositories,
    reply: async (value: HostRepositoryView[] = repositories) => {
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
      await act(async () => replies.shift()!(value));
    },
    move: (next: Partial<DaemonTargetSnapshot>) =>
      act(() => {
        snapshot = { ...snapshot, ...next };
        for (const listener of listeners) listener(snapshot);
      }),
  };
}

describe("the workspace for a pushed repository", () => {
  it("is the whole workspace when there is none", () => {
    expect(workspacePlan({}, app)).toEqual({
      kind: "use",
      edits: [
        {
          kind: "set",
          path: ["workspace"],
          value: {
            provider: "git-worktree",
            repo: checkout,
            baseBranch: "release/1.2",
            fetchRemote: "origin",
            allowedRefs: ["refs/heads/main", "refs/heads/release/1.2"],
          },
        },
      ],
    });
  });

  it("only adds the pushed branches a workspace on that checkout does not allow, keeping the rest", () => {
    const workspace = {
      provider: "git-worktree",
      repo: checkout,
      baseBranch: "main",
      branchPrefix: "team/",
      isolateRoots: true,
      allowedRefs: ["refs/tags/v1"],
    };
    expect(workspacePlan({ workspace }, app)).toEqual({
      kind: "allow",
      edits: [
        { kind: "insert", path: ["workspace", "allowedRefs"], index: 1, value: "refs/heads/main" },
        { kind: "insert", path: ["workspace", "allowedRefs"], index: 2, value: "refs/heads/release/1.2" },
      ],
    });
    expect(workspacePlan({ workspace: { ...workspace, allowedRefs: undefined } }, app)).toEqual({
      kind: "allow",
      edits: [{ kind: "set", path: ["workspace", "allowedRefs"], value: app.branches }],
    });
    // A prefix already covers a branch.
    expect(
      workspacePlan({ workspace: { ...workspace, allowedRefs: ["refs/heads/main", "refs/heads/release/*"] } }, app),
    ).toEqual({ kind: "current" });
  });

  it("leaves any other workspace alone, with the reason", () => {
    for (const workspace of [
      { provider: "local", root: "/srv/app" },
      { provider: "git-worktree", repo: "/srv/app" },
      { provider: "git-worktree", repo: checkout, hostId: "builder" },
      { provider: "git-worktree", repo: checkout, allowedRefs: "refs/heads/main" },
      "somewhere",
    ])
      expect(workspacePlan({ workspace }, app)).toMatchObject({
        kind: "conflict",
        reason: expect.stringMatching(/already has a workspace/),
      });
    expect(workspacePlan({ workspace: { provider: "git-worktree", repo: "/srv/app" } }, app)).toMatchObject({
      reason: expect.stringContaining("in /srv/app"),
    });
  });
});

describe("the section", () => {
  it("puts the workspace into the draft while connected to the profile", async () => {
    const server = connect([app], lab);
    render(<HostRepositoriesSection />);
    await server.reply();
    fireEvent.click(await screen.findByRole("button", { name: "Use as workspace" }));
    expect(studio.edits).toMatchObject([{ kind: "set", path: ["workspace"], value: { repo: checkout } }]);
  });

  it("shows another workspace's reason and stages nothing", async () => {
    studio.value = { workspace: { provider: "local", root: "/srv/app" } };
    const server = connect([app], lab);
    render(<HostRepositoriesSection />);
    await server.reply();
    const button = await screen.findByRole("button", { name: "Use as workspace" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/not a git worktree workspace/)).toBeTruthy();
    fireEvent.click(button);
    expect(studio.edits).toEqual([]);
  });

  it("is not shown on a connection that is not a profile, or with nothing pushed", async () => {
    const none = connect([app]);
    const { container } = render(<HostRepositoriesSection />);
    expect(container.textContent).toBe("");
    expect(none.hostRepositories).not.toHaveBeenCalled();
    cleanup();
    const empty = connect([], lab);
    const second = render(<HostRepositoriesSection />);
    await empty.reply();
    expect(second.container.textContent).toBe("");
  });

  it("stages nothing from a report for an earlier connection, even to the same profile", async () => {
    const server = connect([app], lab);
    const { container } = render(<HostRepositoriesSection />);
    await vi.waitFor(() => expect(server.hostRepositories).toHaveBeenCalledTimes(1));
    server.move({ epoch: 2 });
    studio.target = { epoch: 2 };
    await server.reply([{ ...app, checkout: "/stale/checkouts/app" }]);
    expect(container.textContent).toBe("");
    await server.reply();
    const button = await screen.findByRole("button", { name: "Use as workspace" });
    // The draft moves to another target before the click: nothing is staged.
    studio.target = { epoch: 3 };
    fireEvent.click(button);
    expect(studio.edits).toEqual([]);
  });
});
