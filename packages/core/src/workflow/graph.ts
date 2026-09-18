/** Graph helpers shared by validation, the engine and the CLI. */
import type { Edge, NodeDef, WorkflowGraph } from "../model/workflow.js";

export function outgoing(graph: WorkflowGraph, nodeId: string): Edge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

/** Nodes reachable from `start` following edges regardless of conditions. */
export function reachable(graph: WorkflowGraph): Set<string> {
  const seen = new Set<string>();
  const stack = [graph.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of outgoing(graph, id)) stack.push(e.to);
  }
  return seen;
}

function label(n: NodeDef, id: string): string {
  const name = n.name ?? id;
  switch (n.type) {
    case "start":
      return `${id}((start))`;
    case "end":
      return `${id}(((${name})))`;
    case "decision":
    case "gate":
      return `${id}{${name}}`;
    case "loop":
      return `${id}[[loop: ${name}]]`;
    case "parallel":
      return `${id}[[parallel: ${name}]]`;
    case "subworkflow":
      return `${id}[[sub: ${name}]]`;
    default:
      return `${id}[${name}]`;
  }
}

/** Render a graph as Mermaid (flowchart TD) for docs, PR descriptions and UIs. */
export function toMermaid(graph: WorkflowGraph, title?: string): string {
  const lines: string[] = [];
  if (title) lines.push("---", `title: ${title}`, "---");
  lines.push("flowchart TD");
  for (const [id, n] of Object.entries(graph.nodes)) lines.push(`  ${label(n, id)}`);
  for (const e of graph.edges) {
    const text = e.label ?? e.when;
    lines.push(text ? `  ${e.from} -->|${text.replace(/\|/g, "\\|")}| ${e.to}` : `  ${e.from} --> ${e.to}`);
  }
  return lines.join("\n");
}
