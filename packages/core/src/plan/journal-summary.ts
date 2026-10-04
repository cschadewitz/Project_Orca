/** Shared human-readable plan journal summary; structured fallback remains explicit JSON. */
import { EventPayload } from "../events/event-payload.js";

export function planEventSummary(e: { type: string; payload: unknown }, slug: (id: string) => string): string {
  const p = new EventPayload(e.payload);
  switch (e.type) {
    case "work-item.added":
      return p.record("workItem").text("slug");
    case "work-item.updated":
      return `${slug(p.text("workItemId"))} ${JSON.stringify(p.field("changes"))}`;
    case "dependency.added":
      return `${slug(p.record("dependency").text("from"))} -> ${JSON.stringify(p.record("dependency").field("target"))}`;
    case "dependency.resolved":
      return `${p.text("dependencyId")} ${p.text("status")}${p.optionalText("resolution") ? `: ${p.text("resolution")}` : ""}`;
    case "risk.raised":
      return p.record("risk").text("key");
    case "risk.updated":
      return `${p.text("riskId")} ${JSON.stringify(p.field("changes"))}`;
    case "decision.opened":
      return p.record("decision").text("key");
    case "decision.resolved":
      return `${p.text("decisionId")} = ${p.text("chosen")} (${p.text("decidedBy")})`;
    case "schedule.computed":
      return `ready: ${p.strings("ready").map(slug).join(", ") || "-"}; waiting: ${p.list("waiting").length}; held: ${p.list("held").length}`;
    case "dispatch.started":
    case "dispatch.finished":
    case "dispatch.deferred":
      return `${slug(p.text("workItemId"))}${p.optionalText("status") ? ` ${p.text("status")}` : ""}${p.optionalText("reason") ? ` ${p.text("reason")}` : ""}`;
    default:
      return JSON.stringify(e.payload) ?? "undefined";
  }
}
