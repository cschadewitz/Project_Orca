/**
 * Static validation of workflow definitions. Runs at load time and from
 * `orca validate` so authoring mistakes surface before any agent is spawned.
 */
import { checkExpression } from "../expr/index.js";
import type { NodeDef, WorkflowDefinition, WorkflowGraph } from "../model/workflow.js";
import { checkTemplate } from "../template/render.js";
import { outgoing, reachable } from "./graph.js";
import { varExpression } from "./vars.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidationContext {
  /** Resolve referenced workflow ids (subworkflow / loop / parallel refs). */
  hasWorkflow?: (id: string) => boolean;
  /** Resolve template ids. */
  hasTemplate?: (id: string) => boolean;
  /** Resolve agent ids / roles. */
  hasAgent?: (selector: string | { id: string } | { role: string }) => boolean;
}

export function validateWorkflow(def: WorkflowDefinition, ctx: ValidationContext = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  validateGraph(def, `workflow(${def.id})`, ctx, errors, warnings);
  return { ok: errors.length === 0, errors, warnings };
}

function validateGraph(graph: WorkflowGraph, path: string, ctx: ValidationContext, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const err = (p: string, message: string) => errors.push({ path: p, message });
  const warn = (p: string, message: string) => warnings.push({ path: p, message });
  const ids = Object.keys(graph.nodes);

  const start = graph.nodes[graph.start];
  if (!start) err(`${path}.start`, `start node '${graph.start}' does not exist`);
  else if (start.type !== "start") err(`${path}.start`, `start node '${graph.start}' must have type 'start'`);
  const starts = ids.filter((id) => graph.nodes[id]!.type === "start");
  if (starts.length !== 1) err(`${path}.nodes`, `graph must contain exactly one start node (found ${starts.length})`);
  if (!ids.some((id) => graph.nodes[id]!.type === "end")) err(`${path}.nodes`, "graph must contain at least one end node");

  graph.edges.forEach((e, i) => {
    const p = `${path}.edges[${i}]`;
    if (!graph.nodes[e.from]) err(p, `edge source '${e.from}' does not exist`);
    if (!graph.nodes[e.to]) err(p, `edge target '${e.to}' does not exist`);
    if (e.when) {
      const m = checkExpression(e.when);
      if (m) err(`${p}.when`, m);
    }
    const from = graph.nodes[e.from];
    if (from?.type === "end") err(p, `end node '${e.from}' cannot have outgoing edges`);
    if (e.to === graph.start) err(p, "edges cannot target the start node");
  });

  for (const [id, n] of Object.entries(graph.nodes)) {
    const p = `${path}.nodes.${id}`;
    const outs = outgoing(graph, id);
    if (n.type !== "end" && outs.length === 0) err(p, `node '${id}' has no outgoing edges`);
    if (n.type === "decision" || n.type === "gate") {
      const unconditional = outs.filter((e) => !e.when);
      if (unconditional.length > 1) err(p, "decision nodes may have at most one unconditional (default) edge");
      if (outs.length > 0 && outs.every((e) => !e.when)) warn(p, "decision node has no conditional edges; every choice goes the same way");
    } else if (n.type === "start" || n.type === "agent" || n.type === "set" || n.type === "loop" || n.type === "parallel" || n.type === "subworkflow") {
      const unconditional = outs.filter((e) => !e.when);
      if (outs.length > 1 && unconditional.length > 1) err(p, `node '${id}' has multiple unconditional outgoing edges; add 'when' conditions or use a parallel node`);
    }
    validateNode(n, id, p, graph, ctx, errors, warnings);
  }

  const seen = reachable(graph);
  for (const id of ids) if (!seen.has(id)) warn(`${path}.nodes.${id}`, `node '${id}' is unreachable from start`);
}

function validateNode(n: NodeDef, id: string, p: string, graph: WorkflowGraph, ctx: ValidationContext, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const err = (message: string, sub = "") => errors.push({ path: p + sub, message });
  const warn = (message: string, sub = "") => warnings.push({ path: p + sub, message });
  const checkRef = (ref: { workflow: string } | { graph: WorkflowGraph }, sub: string) => {
    if ("workflow" in ref) {
      if (ctx.hasWorkflow && !ctx.hasWorkflow(ref.workflow)) err(`referenced workflow '${ref.workflow}' is not registered`, sub);
    } else validateGraph(ref.graph, p + sub, ctx, errors, warnings);
  };
  const checkAgentPrompt = (o: { template?: string | undefined; prompt?: string | undefined; agent: string | { id: string } | { role: string } }, sub: string) => {
    if (!o.template && !o.prompt) err("agent step needs a 'template' id or an inline 'prompt'", sub);
    if (o.template && o.prompt) err("agent step must not set both 'template' and 'prompt'", sub);
    if (o.template && ctx.hasTemplate && !ctx.hasTemplate(o.template)) err(`template '${o.template}' is not registered`, `${sub}.template`);
    if (o.prompt) {
      const m = checkTemplate(o.prompt);
      if (m) err(m, `${sub}.prompt`);
    }
    if (ctx.hasAgent && !ctx.hasAgent(o.agent)) err(`agent selector ${JSON.stringify(o.agent)} cannot be resolved`, `${sub}.agent`);
  };
  /** Every vars-bearing node (set, agent, subworkflow) evaluates "="-prefixed values as expressions. */
  const checkVars = (vars: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(vars)) {
      const expr = varExpression(v);
      if (expr === undefined) continue;
      const m = checkExpression(expr);
      if (m) err(m, `.vars.${k}`);
    }
  };
  switch (n.type) {
    case "agent":
      checkAgentPrompt(n, "");
      checkVars(n.vars);
      n.inputs.forEach((r, i) => {
        if (r.fromNode && !graph.nodes[r.fromNode]) err(`input references unknown node '${r.fromNode}'`, `.inputs[${i}]`);
        if (!r.kind && !r.name && !r.fromNode) err("artifact ref needs kind, name or fromNode", `.inputs[${i}]`);
      });
      n.produces.forEach((s, i) => {
        const m = checkTemplate(s.path);
        if (m) err(m, `.produces[${i}].path`);
      });
      // artifact-present only ever waits for *required* deliverables; with none there is nothing to
      // watch and the step silently behaves like turn-end.
      if (n.completion.mode === "artifact-present" && !n.produces.some((s) => s.required)) {
        warn("completion.mode 'artifact-present' has no required deliverable to wait for; the step behaves like 'turn-end' (mark a deliverable required: true or use mode: turn-end)", ".completion.mode");
      }
      break;
    case "decision": {
      const s = n.source;
      if (s.kind === "expression") {
        const m = checkExpression(s.expr);
        if (m) err(m, ".source.expr");
      } else if (s.kind === "agent") checkAgentPrompt(s, ".source");
      if (n.defaultOption && !n.options.includes(n.defaultOption)) err("defaultOption must be one of options", ".defaultOption");
      break;
    }
    case "gate":
      if (n.autoApproveWhen) {
        const m = checkExpression(n.autoApproveWhen);
        if (m) err(m, ".autoApproveWhen");
        if (n.autoOption && !n.options.includes(n.autoOption)) err("autoOption must be one of options", ".autoOption");
      }
      break;
    case "set":
      checkVars(n.vars);
      break;
    case "loop":
      if (n.mode === "forEach") {
        if (!n.items) err("forEach loop needs 'items'", ".items");
        else {
          const m = checkExpression(n.items);
          if (m) err(m, ".items");
        }
      } else {
        if (!n.condition) err(`${n.mode} loop needs 'condition'`, ".condition");
        else {
          const m = checkExpression(n.condition);
          if (m) err(m, ".condition");
        }
      }
      checkRef(n.body, ".body");
      break;
    case "parallel":
      if (!n.branches && !n.forEach) err("parallel node needs 'branches' or 'forEach'");
      if (n.branches && n.forEach) err("parallel node must not set both 'branches' and 'forEach'");
      if (n.branches) for (const [b, ref] of Object.entries(n.branches)) checkRef(ref, `.branches.${b}`);
      if (n.forEach) {
        for (const field of ["items", "key", "dependsOn", "workflow", "workItemId"] as const) {
          const expr = n.forEach[field];
          if (!expr) continue;
          const m = checkExpression(expr);
          if (m) err(m, `.forEach.${field}`);
        }
        if (n.forEach.dependsOn && !n.forEach.key) warn("forEach.dependsOn without forEach.key compares against item indexes; set 'key' to something stable", ".forEach.dependsOn");
        checkRef(n.forEach.body, ".forEach.body");
      }
      break;
    case "subworkflow":
      checkRef({ workflow: n.workflow }, ".workflow");
      checkVars(n.vars);
      break;
    case "start":
    case "end":
      break;
    default:
      if (!String(n.type).startsWith("custom:")) err(`unknown node type '${String((n as { type: string }).type)}'`);
  }
}
