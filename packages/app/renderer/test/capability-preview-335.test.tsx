// @vitest-environment happy-dom
/** #335: per-agent capability preview from the daemon's running and candidate sets. */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ConfigEffectiveCapabilities } from "@orca/protocol";
import { capabilityPreview } from "../src/config/capability-preview.js";
import { CapabilityPreview } from "../src/config/capability-preview-view.js";

afterEach(cleanup);

const set = (
  mcpServers: [string, string][],
  skills: [string, string][] = [],
  warnings: string[] = [],
): ConfigEffectiveCapabilities["agents"][string] => ({
  mcpServers: mcpServers.map(([id, source]) => ({ id, source, catalog: true })),
  skills: skills.map(([id, source]) => ({ id, source })),
  errors: [],
  warnings: warnings.map((path) => ({ path, message: "SYNTHETIC_MESSAGE" })),
});

describe("capability preview model", () => {
  it("marks added, removed, unchanged and re-sourced entries, and skips agents with no change", () => {
    const running = {
      agents: {
        builder: set([["github", "config.capabilities.workspace"]], [["review", "agents.builder.capabilities"]]),
        quiet: set([["github", "config.capabilities.workspace"]]),
      },
    };
    const candidate = {
      agents: {
        builder: set([
          ["github", "agents.builder.capabilities"],
          ["db", "agents.builder.capabilities"],
        ]),
        quiet: set([["github", "config.capabilities.workspace"]]),
        fresh: set([]),
      },
    };
    expect(capabilityPreview(running, candidate)).toEqual([
      {
        agent: "builder",
        entries: [
          { kind: "mcpServer", id: "github", source: "agents.builder.capabilities", change: "source-changed" },
          { kind: "mcpServer", id: "db", source: "agents.builder.capabilities", change: "added" },
          { kind: "skill", id: "review", source: "agents.builder.capabilities", change: "removed" },
        ],
        warnings: [],
      },
      { agent: "fresh", entries: [], warnings: [] },
    ]);
  });
  it("lists a removed or renamed agent's lost capabilities, not only the new name's", () => {
    const running = {
      agents: {
        builder: set([["github", "config.capabilities.workspace"]], [["review", "agents.builder.capabilities"]]),
      },
    };
    const candidate = { agents: { maker: set([["github", "config.capabilities.workspace"]]) } };
    expect(capabilityPreview(running, candidate)).toEqual([
      {
        agent: "builder",
        agentRemoved: true,
        entries: [
          { kind: "mcpServer", id: "github", source: "config.capabilities.workspace", change: "removed" },
          { kind: "skill", id: "review", source: "agents.builder.capabilities", change: "removed" },
        ],
        warnings: [],
      },
      {
        agent: "maker",
        entries: [{ kind: "mcpServer", id: "github", source: "config.capabilities.workspace", change: "added" }],
        warnings: [],
      },
    ]);
    expect(capabilityPreview(running, { agents: {} })).toEqual([
      expect.objectContaining({ agent: "builder", agentRemoved: true }),
    ]);
    const view = render(<CapabilityPreview agents={capabilityPreview(running, { agents: {} })!} />);
    expect(screen.getByRole("group", { name: "Capabilities of builder" }).textContent).toContain("Agent removed");
    view.unmount();
  });
  it("reports a new warning, and nothing when either side is unknown", () => {
    const running = { agents: { builder: set([]) } };
    const candidate = { agents: { builder: set([], [], ["agents.builder.capabilities.skills.disable"]) } };
    expect(capabilityPreview(running, candidate)).toEqual([
      { agent: "builder", entries: [], warnings: ["agents.builder.capabilities.skills.disable"] },
    ]);
    expect(capabilityPreview(undefined, candidate)).toBeUndefined();
    expect(capabilityPreview(running, undefined)).toBeUndefined();
  });
});

describe("capability preview view", () => {
  it("lists ids, changes and scopes per agent without daemon message text", () => {
    const preview = capabilityPreview(
      { agents: { builder: set([]) } },
      {
        agents: {
          builder: set(
            [["github", "config.capabilities.workspace"]],
            [],
            ["agents.builder.capabilities.skills.disable"],
          ),
        },
      },
    )!;
    const view = render(<CapabilityPreview agents={preview} />);
    const group = screen.getByRole("group", { name: "Capabilities of builder" });
    expect(within(group).getByText("github")).toBeTruthy();
    expect(group.textContent).toContain("added, from config.capabilities.workspace");
    expect(group.textContent).toContain("agents.builder.capabilities.skills.disable: this selection changes nothing.");
    expect(view.container.textContent).not.toContain("SYNTHETIC_MESSAGE");
  });
  it("renders nothing when no agent changes", () => {
    const view = render(<CapabilityPreview agents={[]} />);
    expect(view.container.textContent).toBe("");
  });
});
