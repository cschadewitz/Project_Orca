// @vitest-environment happy-dom
/**
 * Agents installed on a managed server, on its Config surface (#1235): the entry goes into the
 * draft (replacing one with the same id), and the section shows only while connected to a profile
 * whose server reports installed agents.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostAgentView } from "../../src/daemon-connection.js";

const studio = {
  value: { agents: [{ id: "local", command: "x" }] } as unknown,
  edits: [] as unknown[],
  subscribe: () => () => {},
  editAccess: () => ({ allowed: true as const }),
  edit(edits: unknown[]) {
    this.edits.push(...edits);
  },
};
vi.mock("../src/config/configuration-studio-context.js", () => ({ useConfigurationStudio: () => studio }));

const { HostAgentsSection, agentEntryEdit } = await import("../src/config/host-agents-section.js");

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  studio.edits = [];
});

function connect(agents: HostAgentView[], profile?: { id: string; name: string; destination: string }) {
  vi.stubGlobal("orca", {
    daemonConnection: {
      read: () => ({ profile }),
      subscribe: () => () => {},
      profiles: { hostAgents: vi.fn(async () => ({ ok: true as const, value: agents })) },
    },
  });
}

describe("the agents: entry for an installed agent", () => {
  it("is appended, replaces one with its id, or starts the list", () => {
    expect(agentEntryEdit({ agents: [{ id: "local" }] }, entry)).toEqual({
      kind: "insert",
      path: ["agents"],
      index: 1,
      value: entry,
    });
    expect(agentEntryEdit({ agents: [{ id: "local" }, { id: "codex", command: "old" }] }, entry)).toEqual({
      kind: "set",
      path: ["agents", 1],
      value: entry,
    });
    expect(agentEntryEdit({}, entry)).toEqual({ kind: "set", path: ["agents"], value: [entry] });
    expect(agentEntryEdit(undefined, entry)).toEqual({ kind: "set", path: ["agents"], value: [entry] });
  });
});

describe("the section", () => {
  it("adds an installed agent's entry to the draft while connected to its profile", async () => {
    connect(
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
      {
        id: "lab",
        name: "Lab",
        destination: "casey@lab",
      },
    );
    render(<HostAgentsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to configuration" }));
    expect(studio.edits).toEqual([{ kind: "insert", path: ["agents"], index: 1, value: entry }]);
    expect(screen.queryByText(/GitHub Copilot CLI/)).toBeNull();
  });

  it("is not shown on a connection that is not a profile", () => {
    connect([codex]);
    const { container } = render(<HostAgentsSection />);
    expect(container.textContent).toBe("");
    expect(window.orca.daemonConnection!.profiles!.hostAgents).not.toHaveBeenCalled();
  });
});
