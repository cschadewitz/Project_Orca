/** Journal summaries preserve structured JSON fields while guarding display fields. */
import { describe, expect, it } from "vitest";
import { formatPlanEvent } from "../src/format-plan-event.js";

function render(type: string, payload: unknown): string {
  return formatPlanEvent(
    { at: "2026-01-02T03:04:05.678Z", seq: 2, origin: { kind: "human", actor: "cli" }, type, payload },
    (id) => (id === "wi_1" ? "api" : id),
  );
}

describe("formatPlanEvent", () => {
  it.each([
    ["work-item.added", { workItem: { slug: "api" } }, "api"],
    ["work-item.updated", { workItemId: "wi_1", changes: { status: "done" } }, 'api {"status":"done"}'],
    [
      "dependency.added",
      { dependency: { from: "wi_1", target: { kind: "external", key: "spec" } } },
      'api -> {"kind":"external","key":"spec"}',
    ],
    [
      "dependency.resolved",
      { dependencyId: "dep_1", status: "satisfied", resolution: "ready" },
      "dep_1 satisfied: ready",
    ],
    ["dependency.resolved", { dependencyId: "dep_1", status: "open" }, "dep_1 open"],
    ["risk.raised", { risk: { key: "migration" } }, "migration"],
    ["risk.updated", { riskId: "risk_1", changes: { status: "closed" } }, 'risk_1 {"status":"closed"}'],
    ["decision.opened", { decision: { key: "storage" } }, "storage"],
    ["decision.resolved", { decisionId: "dec_1", chosen: "sql", decidedBy: "human" }, "dec_1 = sql (human)"],
    ["schedule.computed", { ready: ["wi_1"], waiting: ["wi_2"], held: [] }, "ready: api; waiting: 1; held: 0"],
    ["schedule.computed", { ready: [], waiting: [], held: [] }, "ready: -; waiting: 0; held: 0"],
    ["dispatch.started", { workItemId: "wi_1" }, "api"],
    ["dispatch.finished", { workItemId: "wi_1", status: "completed" }, "api completed"],
    ["dispatch.deferred", { workItemId: "wi_1", reason: "claimed" }, "api claimed"],
    ["request.linked", { requestId: "req_1" }, '{"requestId":"req_1"}'],
  ] satisfies [string, unknown, string][])("preserves the %s summary", (type, payload, expected) => {
    expect(render(type, payload)).toBe(`2026-01-02T03:04:05    2 ${type.padEnd(20)} ${"human".padEnd(13)} ${expected}`);
  });

  it.each([
    ["work-item.added", { workItem: { slug: {} } }],
    ["work-item.updated", { workItemId: {}, changes: {} }],
    ["dependency.added", { dependency: { from: {}, target: {} } }],
    ["dependency.resolved", { dependencyId: {}, status: {}, resolution: { secret: "canary" } }],
    ["risk.raised", { risk: { key: {} } }],
    ["risk.updated", { riskId: {}, changes: {} }],
    ["decision.opened", { decision: { key: {} } }],
    ["decision.resolved", { decisionId: {}, chosen: {}, decidedBy: {} }],
    ["schedule.computed", { ready: [{}], waiting: null, held: {} }],
    ["dispatch.started", { workItemId: {} }],
    ["dispatch.finished", { workItemId: {}, status: {} }],
    ["dispatch.deferred", { workItemId: {}, reason: {} }],
  ] satisfies [string, unknown][])("guards malformed %s fields", (type, payload) => {
    const before = JSON.stringify(payload);
    const line = render(type, payload);
    expect(line).toContain("[invalid]");
    expect(line).not.toContain("[object Object]");
    expect(line).not.toContain("canary");
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("tolerates legacy missing fields and nested objects", () => {
    expect(render("schedule.computed", {})).toContain("ready: -; waiting: 0; held: 0");
    expect(render("dependency.added", null)).toContain("undefined -> undefined");
    expect(render("dispatch.started", { workItemId: "wi_1" })).toMatch(/api$/);
  });
});
