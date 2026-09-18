/** Render a plan's dependency graph as Mermaid, for the CLI, schedule artifacts and PR descriptions. */
import type { Decision, Dependency } from "../model/plan.js";
import type { WorkItem } from "../model/request.js";

export interface PlanGraphInput {
  items: readonly WorkItem[];
  dependencies: readonly Dependency[];
  decisions?: readonly Decision[];
  title?: string;
}

const STATUS_CLASS: Record<WorkItem["status"], string> = {
  pending: "pending",
  ready: "ready",
  "in-progress": "running",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  cancelled: "failed",
};

const q = (s: string) => s.replace(/"/g, "'");
const nodeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_");

export function planToMermaid(input: PlanGraphInput): string {
  const lines: string[] = [];
  if (input.title) lines.push("---", `title: ${input.title}`, "---");
  lines.push("flowchart LR");
  const byId = new Map(input.items.map((i) => [i.id, i]));
  for (const i of input.items) lines.push(`  ${nodeId(i.id)}["${q(i.slug)}<br/><small>${i.status}</small>"]:::${STATUS_CLASS[i.status]}`);
  const decisions = new Map((input.decisions ?? []).map((d) => [d.id, d]));
  const externals = new Set<string>();
  for (const d of input.dependencies) {
    if (d.status === "waived") continue;
    const from = byId.get(d.from);
    if (!from) continue;
    let to: string;
    if (d.target.kind === "work-item") {
      if (!byId.has(d.target.workItemId)) continue;
      to = nodeId(d.target.workItemId);
    } else if (d.target.kind === "decision") {
      const dec = decisions.get(d.target.decisionId);
      to = nodeId(d.target.decisionId);
      if (dec && !lines.some((l) => l.startsWith(`  ${to}{`))) lines.push(`  ${to}{"decision: ${q(dec.key)}<br/><small>${dec.status}${dec.chosen ? " = " + q(dec.chosen) : ""}</small>"}:::decision`);
    } else {
      to = `ext_${nodeId(d.target.key)}`;
      if (!externals.has(to)) {
        externals.add(to);
        lines.push(`  ${to}[["external: ${q(d.target.key)}"]]:::external`);
      }
    }
    const label = [d.target.kind === "work-item" && d.target.stage ? `@${d.target.stage}` : "", d.requiredBy !== "start" ? `#${d.requiredBy}` : ""].filter(Boolean).join(" ");
    const arrow = d.type === "blocks" ? "-->" : d.type === "soft" ? "-.->" : "-. informs .->";
    lines.push(label && d.type !== "informs" ? `  ${nodeId(from.id)} ${arrow}|${label}| ${to}` : `  ${nodeId(from.id)} ${arrow} ${to}`);
  }
  lines.push(
    "  classDef pending fill:#f4f4f5,stroke:#a1a1aa",
    "  classDef ready fill:#dbeafe,stroke:#3b82f6",
    "  classDef running fill:#fef3c7,stroke:#f59e0b",
    "  classDef blocked fill:#fee2e2,stroke:#ef4444",
    "  classDef done fill:#dcfce7,stroke:#22c55e",
    "  classDef failed fill:#fecaca,stroke:#b91c1c",
    "  classDef decision fill:#ede9fe,stroke:#8b5cf6",
    "  classDef external fill:#e5e7eb,stroke:#6b7280,stroke-dasharray: 4 2",
  );
  return lines.join("\n");
}
