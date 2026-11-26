// @vitest-environment happy-dom
/**
 * Agents installed on a managed server, on its Config surface (#1235): the entry goes into the
 * draft, an existing one with its id has only what runs the agent updated (its policy and other
 * fields stay), a same-id entry that is not a local ACP agent is refused, and a report is shown
 * and staged only on the connection (epoch and profile) it was read on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DaemonTargetSnapshot, HostAgentView } from "../../src/daemon-connection.js";

const studio = {
  value: { agents: [{ id: "local", command: "x" }] } as unknown,
  target: { epoch: 1 },
  edits: [] as unknown[],
  subscribe: () => () => {},
  editAccess: () => ({ allowed: true as const }),
  edit(edits: unknown[]) {
    this.edits.push(...edits);
  },
};
vi.mock("../src/config/configuration-studio-context.js", () => ({ useConfigurationStudio: () => studio }));

const { HostAgentsSection, agentEntryPlan } = await import("../src/config/host-agents-section.js");

const entry = {
  id: "codex",
  name: "Codex",
  command: "/home/a/.local/share/orca-server/current/runtime/bin/node",
  args: [
    "/home/a/.local/share/orca-server/agents/codex/0.171.0/files/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
  ],
  env: { CODEX_HOME: "/home/a/.local/share/orca-server/agents/codex/home" },
};
const codex: HostAgentView = {
  agent: "codex",
  name: "Codex",
  version: "0.171.0",
  installed: true,
  signedIn: "yes",
  signIn: "device-code",
  entry,
};
const lab = { id: "lab", name: "Lab", destination: "casey@lab" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  studio.edits = [];
  studio.value = { agents: [{ id: "local", command: "x" }] };
  studio.target = { epoch: 1 };
});

/** A connection whose snapshot and replies the test drives. */
function connect(agents: HostAgentView[], profile?: typeof lab) {
  let snapshot = { epoch: 1, ...(profile ? { profile } : {}) } as DaemonTargetSnapshot;
  const listeners = new Set<(target: DaemonTargetSnapshot) => void>();
  const replies: ((agents: HostAgentView[]) => void)[] = [];
  const hostAgents = vi.fn(
    () =>
      new Promise<{ ok: true; value: HostAgentView[] }>((resolve) =>
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
      profiles: { hostAgents },
    },
  });
  return {
    hostAgents,
    /** Answer the oldest request, once it has been made. */
    reply: async (value: HostAgentView[] = agents) => {
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

describe("the agents: entry for an installed agent", () => {
  it("is appended, or starts the list", () => {
    expect(agentEntryPlan({ agents: [{ id: "local" }] }, entry)).toEqual({
      kind: "add",
      edits: [{ kind: "insert", path: ["agents"], index: 1, value: entry }],
    });
    expect(agentEntryPlan({}, entry)).toEqual({
      kind: "add",
      edits: [{ kind: "set", path: ["agents"], value: [entry] }],
    });
    expect(agentEntryPlan(undefined, entry)).toEqual({
      kind: "add",
      edits: [{ kind: "set", path: ["agents"], value: [entry] }],
    });
  });

  it("updates only what runs one an earlier install added, keeping its policy and other settings", () => {
    const permissions = { default: "deny", rules: [{ tool: "shell", decision: "deny" }] };
    const existing = {
      id: "codex",
      name: "My Codex",
      command: entry.command,
      // The entry an install of 0.170.0 here added.
      args: [entry.args[0]!.replace("/codex/0.171.0/", "/codex/0.170.0/")],
      env: { CODEX_HOME: entry.env.CODEX_HOME, HTTPS_PROXY: "http://proxy:3128", TOKEN: { secret: "t" } },
      permissions,
      roles: ["reviewer"],
    };
    const plan = agentEntryPlan({ agents: [{ id: "local" }, existing] }, entry);
    expect(plan).toEqual({
      kind: "update",
      edits: [{ kind: "set", path: ["agents", 1, "args"], value: entry.args }],
    });
    // Nothing the edits touch is the policy, the name, the roles or the other env.
    const touched = plan.kind === "update" ? plan.edits.map((edit) => edit.path.slice(2).join(".")) : [];
    expect(touched).toEqual(["args"]);
    expect(
      agentEntryPlan({ agents: [{ ...existing, ...entry, env: { ...existing.env, ...entry.env } }] }, entry),
    ).toEqual({
      kind: "current",
    });
  });

  it("refuses an entry with its id that no install here added, local ACP ones included", () => {
    const home = entry.env.CODEX_HOME;
    for (const other of [
      // Configured by the person: their own codex-acp, their own node and adapter, or another profile.
      { id: "codex", command: "codex-acp", env: { CODEX_HOME: home } },
      { id: "codex", command: "/usr/bin/node", args: entry.args, env: { CODEX_HOME: home } },
      { id: "codex", command: entry.command, args: ["/home/a/src/codex-acp/dist/index.js"], env: { CODEX_HOME: home } },
      { id: "codex", command: entry.command, args: [...entry.args, "--verbose"], env: { CODEX_HOME: home } },
      { id: "codex", command: entry.command, args: entry.args, env: { CODEX_HOME: "/home/a/.codex" } },
      { id: "codex", command: entry.command, args: entry.args },
      { id: "codex", type: "orca-daemon", profile: "lab", workflow: "w" },
      { id: "codex", command: "codex-acp", hostId: "builder" },
      { id: "codex", command: "codex-acp", env: ["A=1"] },
    ])
      expect(agentEntryPlan({ agents: [other] }, entry)).toMatchObject({
        kind: "conflict",
        reason: expect.stringMatching(/already has an agent called codex/),
      });
    expect(
      agentEntryPlan({ agents: [{ id: "codex", command: "codex-acp", env: { CODEX_HOME: home } }] }, entry),
    ).toMatchObject({ reason: expect.stringMatching(/not added from this server's install/) });
    expect(agentEntryPlan({ agents: "codex" }, entry)).toMatchObject({ kind: "conflict" });
  });
});

describe("the section", () => {
  it("adds an installed agent's entry to the draft while connected to its profile", async () => {
    const server = connect(
      [
        codex,
        {
          agent: "copilot",
          name: "GitHub Copilot CLI",
          version: "1.0.114",
          installed: false,
          signedIn: "no",
          signIn: "device-code",
        },
      ],
      lab,
    );
    render(<HostAgentsSection />);
    await server.reply();
    fireEvent.click(await screen.findByRole("button", { name: "Add to configuration" }));
    expect(studio.edits).toEqual([{ kind: "insert", path: ["agents"], index: 1, value: entry }]);
    expect(screen.queryByText(/GitHub Copilot CLI/)).toBeNull();
  });

  it("shows a conflicting entry's reason and stages nothing", async () => {
    studio.value = { agents: [{ id: "codex", command: "codex-acp", env: { CODEX_HOME: "/home/a/.codex" } }] };
    const server = connect([codex], lab);
    render(<HostAgentsSection />);
    await server.reply();
    const button = await screen.findByRole("button", { name: "Update in configuration" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/not added from this server.s install/)).toBeTruthy();
    fireEvent.click(button);
    expect(studio.edits).toEqual([]);
  });

  it("is not shown on a connection that is not a profile", () => {
    const server = connect([codex]);
    const { container } = render(<HostAgentsSection />);
    expect(container.textContent).toBe("");
    expect(server.hostAgents).not.toHaveBeenCalled();
  });

  it("drops a reply that arrives after the connection changed, even to the same profile", async () => {
    const server = connect([codex], lab);
    const { container } = render(<HostAgentsSection />);
    await vi.waitFor(() => expect(server.hostAgents).toHaveBeenCalledTimes(1));
    // Reconnected to the same profile before the first reply: a new epoch, so a new request,
    // made once the first is answered (one server read at a time per machine).
    server.move({ epoch: 2 });
    studio.target = { epoch: 2 };
    await server.reply([{ ...codex, entry: { ...entry, command: "/stale/node" } }]);
    expect(container.textContent).toBe("");
    await vi.waitFor(() => expect(server.hostAgents).toHaveBeenCalledTimes(2));
    await server.reply();
    fireEvent.click(await screen.findByRole("button", { name: "Add to configuration" }));
    expect(studio.edits).toEqual([{ kind: "insert", path: ["agents"], index: 1, value: entry }]);
  });

  it("stops offering a report once the connection or the draft's target moves on", async () => {
    const server = connect([codex], lab);
    const { container } = render(<HostAgentsSection />);
    await server.reply();
    const button = await screen.findByRole("button", { name: "Add to configuration" });
    // The draft now belongs to another target: the old report is neither shown nor staged.
    studio.target = { epoch: 2 };
    fireEvent.click(button);
    expect(studio.edits).toEqual([]);
    // A same-profile reconnect: the report is cleared and read again for the new connection.
    server.move({ epoch: 2 });
    expect(container.textContent).toBe("");
    await vi.waitFor(() => expect(server.hostAgents).toHaveBeenCalledTimes(2));
    await server.reply();
    fireEvent.click(await screen.findByRole("button", { name: "Add to configuration" }));
    expect(studio.edits).toHaveLength(1);
  });
});
