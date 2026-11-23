/** `agents[].diagnostics` (#1000): off unless turned on, bounded retention. */
import { describe, expect, it } from "vitest";
import { AgentSpecSchema, HookTelemetryLineSchema, parseOrcaConfig } from "@orca/core";

const acp = { id: "claude", command: "claude-agent-acp" };

describe("agents[].diagnostics", () => {
  it("is absent by default, and keeps nothing when only partly given", () => {
    expect(AgentSpecSchema.parse(acp).diagnostics).toBeUndefined();
    expect(AgentSpecSchema.parse({ ...acp, diagnostics: {} }).diagnostics).toEqual({
      toolCalls: "off",
      retainDays: 30,
    });
    expect(
      parseOrcaConfig({ agents: [{ ...acp, diagnostics: { toolCalls: "keep" } }] }).agents[0]!.diagnostics,
    ).toEqual({
      toolCalls: "keep",
      retainDays: 30,
    });
  });

  it("refuses unknown options and unbounded retention", () => {
    for (const diagnostics of [
      { toolCalls: "on" },
      { retainDays: 0 },
      { retainDays: 366 },
      { retainDays: 1.5 },
      { toolCalls: "keep", everything: true },
    ])
      expect(AgentSpecSchema.safeParse({ ...acp, diagnostics }).success, JSON.stringify(diagnostics)).toBe(false);
  });

  it("does not apply to an orca-daemon agent", () => {
    const result = AgentSpecSchema.safeParse({
      id: "remote",
      type: "orca-daemon",
      profile: "p",
      workflow: "w",
      diagnostics: { toolCalls: "keep" },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("toolCalls");
  });
});

describe("HookTelemetryLineSchema", () => {
  it("takes exactly a v1 line", () => {
    const line = { v: 1, at: "2026-11-23T10:00:00Z", tool: "Bash", decision: "deny", latencyMs: 2 };
    expect(HookTelemetryLineSchema.safeParse(line).success).toBe(true);
    expect(HookTelemetryLineSchema.safeParse({ ...line, sessionId: "sess_x" }).success).toBe(false);
    expect(HookTelemetryLineSchema.safeParse({ ...line, latencyMs: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});
