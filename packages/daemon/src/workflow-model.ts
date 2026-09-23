/**
 * The workflow projection: a `WorkflowDefinition` from the registry in, the display shapes
 * of `@orca/protocol` out. Pure functions over the definition - no store, no clock - so the
 * fold from ten node types to one display record is testable on its own and is the same fold
 * for a top-level workflow and for a graph written inline inside one.
 *
 * Two things happen here that no client should have to do for itself:
 *
 * - **The per-type field fold.** A `NodeDef` is a union whose bodies carry artifact specs,
 *   completion policies and whole nested graphs. `WorkflowNodeView.fields` is the flat record
 *   of what the viewer actually shows per type (`workflows.ts` has the table), so drawing an
 *   `agent` node does not mean re-implementing `AgentSelector` in the renderer.
 * - **Inline graphs become addressable workflows.** A loop body, a `forEach` body and each
 *   named `parallel` branch is a graph of its own with no id in the file. The engine gives it
 *   one when it runs it - `parent::node`, `parent::node::branch` - and this gives it the same
 *   one, so a nested graph on the wire and a nested graph fetched by id are one thing. The
 *   spelling is `Orchestrator.resolveDefinition`'s and it is published as
 *   `INLINE_WORKFLOW_SEPARATOR`.
 */
import { isContainerNode, type Edge, type NodeDef, type WorkflowDefinition, type WorkflowGraph } from "@orca/core";
import {
  INLINE_WORKFLOW_SEPARATOR,
  type WorkflowEdgeView,
  type WorkflowNodeView,
  type WorkflowSummaryView,
  type WorkflowView,
} from "@orca/protocol";

/** The base fields every node has; they are lifted onto the view, so they are not `fields`. */
const BASE_NODE_KEYS = new Set(["type", "name", "description", "meta", "maxAttempts"]);

function edgeView(e: Edge): WorkflowEdgeView {
  return { from: e.from, to: e.to, ...(e.when ? { when: e.when } : {}), ...(e.label ? { label: e.label } : {}) };
}

/** `{ role }`, `{ id }` or the bare string an `agent` node's selector may be, flattened. */
function agentFields(selector: unknown): Record<string, unknown> {
  if (typeof selector === "string") return { agentId: selector };
  if (selector && typeof selector === "object") {
    const s = selector as { id?: unknown; role?: unknown };
    if (typeof s.role === "string") return { role: s.role };
    if (typeof s.id === "string") return { agentId: s.id };
  }
  return {};
}

/** A container's body when it names a registered workflow rather than writing one inline. */
function referencedWorkflow(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object" || !("workflow" in ref)) return undefined;
  return typeof ref.workflow === "string" ? ref.workflow : undefined;
}

/**
 * What the inspector shows for this node, by type. A `custom:<name>` node is a plugin's and
 * the protocol has nothing true to say about its shape, so everything but the base fields
 * goes through - which is also the fallback for a node type added to `core` before this fold
 * hears about it, and is why an unknown type degrades to "all of it" rather than to nothing.
 */
export function nodeFields(node: NodeDef): Record<string, unknown> {
  const n = node as NodeDef & Record<string, unknown>;
  switch (node.type) {
    case "start":
      return {};
    case "end":
      return { outcome: node.outcome, ...(node.message === undefined ? {} : { message: node.message }) };
    case "agent":
      return {
        ...agentFields(node.agent),
        ...(node.template === undefined ? {} : { template: node.template }),
        ...(node.prompt === undefined ? {} : { prompt: node.prompt }),
        inputs: node.inputs,
        produces: node.produces,
        completion: node.completion,
        ...(Object.keys(node.vars).length ? { vars: node.vars } : {}),
      };
    case "decision":
      return {
        source: node.source,
        options: node.options,
        ...(node.defaultOption === undefined ? {} : { defaultOption: node.defaultOption }),
      };
    case "gate":
      return {
        question: node.question,
        options: node.options,
        ...(node.autoApproveWhen === undefined ? {} : { autoApproveWhen: node.autoApproveWhen }),
        ...(node.autoOption === undefined ? {} : { autoOption: node.autoOption }),
      };
    case "set":
      return { vars: node.vars };
    case "loop":
      return {
        mode: node.mode,
        ...(node.condition === undefined ? {} : { condition: node.condition }),
        ...(node.items === undefined ? {} : { items: node.items }),
        itemVar: node.itemVar,
        indexVar: node.indexVar,
        maxIterations: node.maxIterations,
        breakOnFailure: node.breakOnFailure,
        // The body is either a registered workflow (named here) or an inline graph (which
        // arrives as `nested` instead) - never the graph itself, inside `fields`.
        ...(referencedWorkflow(node.body) ? { workflow: referencedWorkflow(node.body) } : {}),
      };
    case "parallel":
      return {
        concurrency: node.concurrency,
        join: node.join,
        failFast: node.failFast,
        ...(node.branches ? { branches: Object.keys(node.branches) } : {}),
        ...(node.forEach
          ? {
              forEach: {
                items: node.forEach.items,
                itemVar: node.forEach.itemVar,
                indexVar: node.forEach.indexVar,
                ...(node.forEach.key === undefined ? {} : { key: node.forEach.key }),
                ...(node.forEach.dependsOn === undefined ? {} : { dependsOn: node.forEach.dependsOn }),
                ...(node.forEach.workflow === undefined ? {} : { workflow: node.forEach.workflow }),
                ...(node.forEach.workItemId === undefined ? {} : { workItemId: node.forEach.workItemId }),
                ...(referencedWorkflow(node.forEach.body) ? { body: referencedWorkflow(node.forEach.body) } : {}),
              },
            }
          : {}),
      };
    case "subworkflow":
      return { workflow: node.workflow, vars: node.vars };
    default: {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(n)) if (!BASE_NODE_KEYS.has(key)) fields[key] = value;
      return fields;
    }
  }
}

/** The graphs written inline inside one node, with the ids the engine addresses them by. */
function nestedGraphs(nodeId: string, node: NodeDef): { id: string; graph: WorkflowGraph }[] {
  if (!isContainerNode(node)) return [];
  const out: { id: string; graph: WorkflowGraph }[] = [];
  if (node.type === "loop" && "graph" in node.body) out.push({ id: nodeId, graph: node.body.graph });
  if (node.type === "parallel") {
    if (node.forEach?.body && "graph" in node.forEach.body) out.push({ id: nodeId, graph: node.forEach.body.graph });
    for (const [branch, ref] of Object.entries(node.branches ?? {}))
      if ("graph" in ref) out.push({ id: `${nodeId}${INLINE_WORKFLOW_SEPARATOR}${branch}`, graph: ref.graph });
  }
  return out;
}

function nodeView(parentId: string, id: string, node: NodeDef, version: string): WorkflowNodeView {
  const nested = nestedGraphs(id, node).map(({ id: suffix, graph }) =>
    graphView(`${parentId}${INLINE_WORKFLOW_SEPARATOR}${suffix}`, graph, version),
  );
  return {
    id,
    type: node.type,
    fields: nodeFields(node),
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.description === undefined ? {} : { description: node.description }),
    ...(node.maxAttempts === undefined ? {} : { maxAttempts: node.maxAttempts }),
    ...(nested.length ? { nested } : {}),
  };
}

/**
 * A nested graph as a `WorkflowView` of its own. It is named after its id and stamped with
 * its parent's version, because that is what it has: an inline graph is part of its parent's
 * file and has no version, no description and no declared inputs of its own. It carries no
 * `versions` either - the version list is the top-level workflow's.
 */
function graphView(id: string, graph: WorkflowGraph, version: string): WorkflowView {
  return {
    id,
    name: id,
    version,
    start: graph.start,
    nodes: Object.entries(graph.nodes).map(([nodeId, node]) => nodeView(id, nodeId, node, version)),
    edges: graph.edges.map(edgeView),
  };
}

/** One workflow, whole, with the versions the daemon can see for it (`WorkflowView.versions`). */
export function workflowView(def: WorkflowDefinition, versions: readonly string[], pinned = false): WorkflowView {
  return {
    ...graphView(def.id, def, def.version),
    name: def.name,
    ...(def.description === undefined ? {} : { description: def.description }),
    ...(Object.keys(def.inputs).length ? { inputs: def.inputs } : {}),
    ...(Object.keys(def.vars).length ? { vars: def.vars } : {}),
    versions: [...versions],
    pinned,
  };
}

/** One workflow as a row. Counts the top-level graph only; nested graphs are their own. */
export function workflowSummaryView(def: WorkflowDefinition): WorkflowSummaryView {
  return {
    id: def.id,
    name: def.name,
    version: def.version,
    nodeCount: Object.keys(def.nodes).length,
    edgeCount: def.edges.length,
    start: def.start,
    ...(def.description === undefined ? {} : { description: def.description }),
  };
}
