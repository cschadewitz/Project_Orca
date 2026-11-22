/** Launch selection lines: the plain-text projection of a preflight's resolved choices. */
import { describe, expect, it } from "vitest";
import { launchSelectionLines, launchSelectionProvenance } from "../src/launch-provenance.js";

describe("launchSelectionLines", () => {
  it("lists agent, model, instruction and each step's MCP servers and skills with their source", () => {
    expect(
      launchSelectionLines({
        selections: [
          {
            nodeId: "build",
            role: "builder",
            agent: { value: "claude", source: "config.roles" },
            model: { value: "opus", source: "agent.defaultModel" },
            template: { value: "build", revision: "r1", source: "workflow.template" },
            capabilities: {
              mcpServers: [{ id: "github", source: "config.capabilities.workspace" }],
              skills: [
                { id: "review", source: "workflow.nodes.build.capabilities", version: "2", digest: "sha256:ab" },
                { id: "style", source: "agents.claude.capabilities" },
              ],
            },
          },
          { nodeId: "plan", agent: { value: "codex", source: "workflow.agent" } },
        ],
        itemWorkflow: { value: "item", source: "config.program.itemWorkflow" },
        templatePack: { value: "focused", source: "run.overrides.templatePack" },
      }),
    ).toEqual([
      "build: agent claude (config.roles); role builder.",
      "build: model opus (agent.defaultModel).",
      "build: instruction build / r1 (workflow.template).",
      "build: MCP server github (config.capabilities.workspace).",
      "build: skill review 2 / sha256:ab (workflow.nodes.build.capabilities).",
      "build: skill style (agents.claude.capabilities).",
      "plan: agent codex (workflow.agent).",
      "plan: model provenance is unavailable for this review.",
      "Item workflow item (config.program.itemWorkflow).",
      "Template pack focused (run.overrides.templatePack).",
    ]);
  });

  it("projects nothing when a preflight carried no choices", () => {
    expect(launchSelectionProvenance({})).toBeUndefined();
    expect(launchSelectionLines({})).toEqual([]);
  });
});
