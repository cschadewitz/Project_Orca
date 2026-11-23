/** The "always" preview offers no standing allow for a call that claims an MCP tool (#1021). */
import { describe, expect, it } from "vitest";
import { standingRulePreview } from "../src/standing-preview.js";

const request = (toolCall: Record<string, unknown>) => ({
  id: "hi_1",
  runId: "run_1",
  stepRunId: "s1",
  kind: "permission" as const,
  context: { toolCall },
});
const state = { run: { workspace: { cwd: "/w" } } } as Parameters<typeof standingRulePreview>[1];
const geminiCall = {
  toolCallId: "t",
  kind: "other",
  title: "create_issue(title: x)",
  _meta: { "gemini-cli": { mcp: { server_name: "github", tool_name: "create_issue" } } },
};

describe("standing rule preview for a claimed MCP tool (#1021)", () => {
  it("refuses an allow and previews a deny by server: tool", () => {
    expect(standingRulePreview(request(geminiCall), state, "g", "allow")).toMatchObject({
      refused: { reason: "unverified-identity" },
    });
    expect(standingRulePreview(request(geminiCall), state, "g", "deny")).toMatchObject({
      rules: [{ match: { kind: "other", titlePattern: "^github: create_issue$" }, decision: "deny" }],
    });
  });

  it("still previews an allow for a call that claims nothing", () => {
    const { _meta: _, ...plain } = geminiCall;
    expect(standingRulePreview(request(plain), state, "g", "allow")).toMatchObject({
      rules: [{ match: { kind: "other", titlePattern: "^create_issue\\(title: x\\)$" }, decision: "allow" }],
    });
  });
});
