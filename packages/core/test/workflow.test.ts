import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseWorkflow, toMermaid, validateWorkflow, type WorkflowDefinition } from "@orca/core";

const root = new URL("../../../", import.meta.url);

describe("workflow definitions", () => {
  it("parses and validates the shipped workflows", async () => {
    for (const f of ["workflows/ai-sdlc.yaml", "workflows/program.yaml"]) {
      const def = parseWorkflow(await readFile(new URL(f, root), "utf8"), f);
      const result = validateWorkflow(def, {
        hasTemplate: (id) => id.startsWith("sdlc/") || id.startsWith("program/"),
        hasWorkflow: (id) => id === "ai-sdlc" || id === "program",
      });
      expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(toMermaid(def)).toContain("flowchart TD");
    }
  });
  it("catches structural mistakes", () => {
    const def: WorkflowDefinition = {
      id: "bad",
      name: "bad",
      version: "1",
      vars: {},
      inputs: {},
      start: "start",
      nodes: {
        start: { type: "start" },
        a: {
          type: "agent",
          agent: "x",
          inputs: [],
          produces: [],
          completion: { mode: "turn-end", maxFollowUps: 1, maxAttempts: 1 },
          vars: {},
        },
        d: { type: "decision", source: { kind: "expression", expr: "a ==" }, options: ["yes"] },
        orphan: { type: "set", vars: {} },
        end: { type: "end", outcome: "success" },
      },
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "d" },
        { from: "d", to: "end" },
        { from: "d", to: "end" },
        { from: "orphan", to: "end" },
        { from: "end", to: "a" },
        { from: "a", to: "missing" },
      ],
    };
    const r = validateWorkflow(def);
    const msgs = r.errors.map((e) => e.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/needs a 'template' id or an inline 'prompt'/),
        expect.stringMatching(/at most one unconditional/),
        expect.stringMatching(/unexpected token/),
        expect.stringMatching(/edge target 'missing' does not exist/),
        expect.stringMatching(/end node 'end' cannot have outgoing edges/),
      ]),
    );
    expect(r.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/'orphan' is unreachable/)]),
    );
  });
  it("warns when artifact-present has no required deliverable to wait for", () => {
    const def = parseWorkflow(`
id: optional-only
name: optional-only
start: s
nodes:
  s: { type: start }
  a:
    type: agent
    agent: x
    prompt: "write a plan if you like"
    produces: [{ kind: plan, path: plan.md, required: false }]
    completion: { mode: artifact-present }
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: e }]
`);
    const r = validateWorkflow(def);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      {
        path: "workflow(optional-only).nodes.a.completion.mode",
        message: expect.stringMatching(/no required deliverable/),
      },
    ]);

    // Marking one deliverable required (the default) clears the warning.
    const a = def.nodes.a;
    if (a?.type !== "agent") throw new Error("expected agent node");
    a.produces[0]!.required = true;
    expect(validateWorkflow(def).warnings).toEqual([]);
    // turn-end mode with only optional deliverables is fine: nothing is watched.
    a.produces[0]!.required = false;
    a.completion.mode = "turn-end";
    expect(validateWorkflow(def).warnings).toEqual([]);
  });
  it("checks '='-prefixed vars on every vars-bearing node, not just set", () => {
    const def = parseWorkflow(`
id: bad-vars
name: bad-vars
start: s
nodes:
  s: { type: start }
  a:
    type: agent
    agent: x
    prompt: "hi"
    vars: { slug: "=vars.slug +", ok: "=upper(vars.slug)", plain: "no equals here" }
  sub: { type: subworkflow, workflow: child, vars: { n: "=1 +" } }
  st: { type: set, vars: { m: "=2 +" } }
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: sub }, { from: sub, to: st }, { from: st, to: e }]
`);
    const r = validateWorkflow(def, { hasWorkflow: () => true });
    const paths = r.errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "workflow(bad-vars).nodes.a.vars.slug",
        "workflow(bad-vars).nodes.sub.vars.n",
        "workflow(bad-vars).nodes.st.vars.m",
      ]),
    );
    // Valid expressions and literals are left alone.
    expect(paths).not.toContain("workflow(bad-vars).nodes.a.vars.ok");
    expect(paths).not.toContain("workflow(bad-vars).nodes.a.vars.plain");
  });
  it("parses nested loop bodies and custom nodes", () => {
    const def = parseWorkflow(`
id: nested
name: nested
start: s
nodes:
  s: { type: start }
  l:
    type: loop
    mode: while
    condition: "iteration < 2"
    body:
      graph:
        start: s
        nodes:
          s: { type: start }
          c: { type: "custom:hello", greeting: hi }
          e: { type: end }
        edges: [{ from: s, to: c }, { from: c, to: e }]
  e: { type: end }
edges: [{ from: s, to: l }, { from: l, to: e }]
`);
    expect(validateWorkflow(def).ok).toBe(true);
    const loop = def.nodes.l;
    expect(loop?.type).toBe("loop");
    if (loop?.type === "loop" && "graph" in loop.body) expect(loop.body.graph.nodes.c?.type).toBe("custom:hello");
  });
});
