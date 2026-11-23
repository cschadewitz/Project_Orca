/**
 * One fixture draft per validation rule the editor's panel shows (#182, docs/design/70): each
 * is a clean workflow that uses every node family, with one thing broken, and it must produce
 * exactly one row - that rule's - placed on the graph, node or edge the row jumps to.
 *
 * The rows are written to `packages/app/renderer/test/fixtures/validation-rules.json`, which
 * the renderer's `workflow-editor-validation.test.tsx` opens in the real editor to press each
 * row and check where it lands. This test fails when that file is behind; regenerate it with
 *
 *     UPDATE_VALIDATION_RULES=1 pnpm vitest run packages/daemon/test/workflow-draft-validation-rules.test.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { DraftGraphPath, DraftIssue } from "@orca/protocol";
import { parseOrcaConfig, type ValidationContext } from "@orca/core";
import { AgentRegistry } from "@orca/agents";
import { capabilityChecker } from "../../engine/src/capabilities.js";
import { validateDraft } from "../src/workflow-drafts.js";

const GOLDEN = resolve("packages/app/renderer/test/fixtures/validation-rules.json");

/**
 * The agents, hosts, secrets and capability catalog of the active generation: a real registry,
 * so the capability and secret rows (#337) come from the same checker activation uses.
 */
const skills = mkdtempSync(join(tmpdir(), "orca-validation-rules-"));
writeFileSync(join(skills, "review.md"), "Review carefully.\n");
const registry = AgentRegistry.fromConfig(
  parseOrcaConfig({
    hosts: [
      { id: "local", type: "local" },
      { id: "build-box", type: "ssh", host: "build.example" },
    ],
    secrets: {
      "github-token": { host: "local", provider: "env", name: "GITHUB_TOKEN" },
      "deploy-key": { host: "build-box", provider: "env", name: "DEPLOY_KEY" },
    },
    capabilities: {
      mcpServers: {
        github: { command: "gh-mcp", env: { GITHUB_TOKEN: { secret: "github-token" } } },
        deploy: { command: "deploy-mcp", env: { DEPLOY_KEY: { secret: "deploy-key" } } },
        forbidden: { command: "forbidden-mcp" },
      },
      skills: {
        review: { path: "review.md" },
        pinned: { path: "review.md", digest: `sha256:${"0".repeat(64)}` },
      },
    },
    agents: [
      {
        id: "worker",
        command: "worker",
        roles: ["reviewer"],
        capabilities: {
          mcpServers: { available: ["github", "deploy"] },
          skills: { available: ["review", "pinned"] },
        },
      },
    ],
  }),
  { configDir: skills },
);

/** The active generation, as far as these drafts need one. */
const context: ValidationContext = {
  hasTemplate: (id) => id === "sdlc/review",
  hasWorkflow: (id) => id === "fix-it",
  hasAgent: (selector) => registry.canResolve(selector),
  checkCapabilities: capabilityChecker(registry),
  validateCustomNode: (node) => {
    if (node.type !== "custom:score") return undefined;
    const rubric = (node as { rubric?: unknown }).rubric;
    return {
      errors: rubric ? [] : [{ path: "rubric", message: "a score node needs a rubric" }],
      warnings: rubric === "loose" ? [{ path: "rubric", message: "a loose rubric scores everything the same" }] : [],
    };
  },
};

type Graph = { start: string; nodes: Record<string, Record<string, unknown>>; edges: Record<string, unknown>[] };
type Doc = Graph & { id: string; name: string; version: string };

const inner = (): Graph => ({
  start: "s",
  nodes: { s: { type: "start" }, step: { type: "set", vars: { seen: true } }, e: { type: "end" } },
  edges: [
    { from: "s", to: "step" },
    { from: "step", to: "e" },
  ],
});

/** Clean: every node family, a nested graph of each kind, and no finding at all. */
const clean = (): Doc => ({
  id: "ai-sdlc",
  name: "Every node family",
  version: "1",
  start: "start",
  nodes: {
    start: { type: "start" },
    plan: { type: "agent", agent: { role: "reviewer" }, template: "sdlc/review" },
    choose: {
      type: "decision",
      source: { kind: "expression", expr: "vars.ready" },
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
    ask: { type: "gate", question: "Ship it?" },
    note: { type: "set", vars: { attempt: "=1" } },
    again: { type: "loop", mode: "while", condition: "vars.attempt < 3", body: { graph: inner() } },
    fan: { type: "parallel", branches: { a: { graph: inner() }, b: { graph: inner() } } },
    each: { type: "parallel", forEach: { items: "vars.items", body: { graph: inner() } } },
    sub: { type: "subworkflow", workflow: "fix-it" },
    score: { type: "custom:score", rubric: "strict" },
    done: { type: "end" },
  },
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "choose" },
    { from: "choose", to: "ask", when: "choice == 'yes'" },
    { from: "choose", to: "done" },
    { from: "ask", to: "note", when: "choice == 'approve'" },
    { from: "ask", to: "done", when: "choice == 'reject'" },
    { from: "note", to: "again" },
    { from: "again", to: "fan" },
    { from: "fan", to: "each" },
    { from: "each", to: "sub" },
    { from: "sub", to: "score" },
    { from: "score", to: "done" },
  ],
});

const loopBody = (d: Doc) => (d.nodes.again!.body as { graph: Graph }).graph;
const branchA = (d: Doc) => (d.nodes.fan!.branches as Record<string, { graph: Graph }>).a!.graph;
const eachBody = (d: Doc) => (d.nodes.each!.forEach as { body: { graph: Graph } }).body.graph;

interface Rule {
  rule: string;
  severity: DraftIssue["severity"];
  /** What the draft has wrong. */
  breaks: (d: Doc) => void;
  /** Where its one row goes. */
  at: { graph?: DraftGraphPath; node?: string; edge?: number };
  message: RegExp;
}

const RULES: Rule[] = [
  /* ---------- errors: the schema and the runtime validator refuse them ---------- */
  {
    rule: "a dangling edge (its target does not exist)",
    severity: "error",
    breaks: (d) => d.edges.push({ from: "choose", to: "gone", when: "choice == 'maybe'" }),
    at: { edge: 12 },
    message: /^edge target 'gone' does not exist$/,
  },
  {
    rule: "a dangling edge (its source does not exist)",
    severity: "error",
    breaks: (d) => d.edges.push({ from: "gone", to: "done" }),
    at: { edge: 12 },
    message: /^edge source 'gone' does not exist$/,
  },
  {
    rule: "an edge out of an end",
    severity: "error",
    breaks: (d) => d.edges.push({ from: "done", to: "plan", when: "false" }),
    at: { edge: 12 },
    message: /^end node 'done' cannot have outgoing edges$/,
  },
  {
    rule: "an edge into the start",
    severity: "error",
    breaks: (d) => d.edges.push({ from: "score", to: "start", when: "false" }),
    at: { edge: 12 },
    message: /^edges cannot target the start node$/,
  },
  {
    rule: "a missing start",
    severity: "error",
    breaks: (d) => (d.start = "nowhere"),
    at: {},
    message: /^start node 'nowhere' does not exist$/,
  },
  {
    rule: "a start that is not a start node",
    severity: "error",
    breaks: (d) => {
      d.start = "begin";
      d.nodes.begin = { type: "set", vars: {} };
      d.edges.push({ from: "begin", to: "start" });
    },
    at: {},
    message: /^start node 'begin' must have type 'start'$/,
  },
  {
    rule: "a second start node",
    severity: "error",
    breaks: (d) => {
      d.nodes.restart = { type: "start" };
      d.edges.push({ from: "note", to: "restart", when: "false" }, { from: "restart", to: "done" });
    },
    at: {},
    message: /^graph must contain exactly one start node \(found 2\)$/,
  },
  {
    rule: "no end node",
    severity: "error",
    breaks: (d) => {
      // `score` is a custom node, which may end a run itself; it must not be a terminal here.
      d.nodes.score = { type: "set", vars: {} };
      d.nodes.done = { type: "set", vars: {} };
      d.edges.push({ from: "done", to: "note", when: "false" });
    },
    at: {},
    message: /^graph must contain at least one end node/,
  },
  {
    rule: "a node with no outgoing edge",
    severity: "error",
    breaks: (d) => {
      d.edges = d.edges.filter((edge) => edge.from !== "sub");
      d.edges.push({ from: "each", to: "score", when: "false" });
    },
    at: { node: "sub" },
    message: /^node 'sub' has no outgoing edges$/,
  },
  {
    rule: "a decision with two unconditional edges",
    severity: "error",
    breaks: (d) => d.edges.push({ from: "choose", to: "plan" }),
    at: { node: "choose" },
    message: /^decision nodes may have at most one unconditional \(default\) edge$/,
  },
  {
    rule: "a step with two unconditional edges",
    severity: "error",
    breaks: (d) => d.edges.push({ from: "note", to: "done" }),
    at: { node: "note" },
    message: /^node 'note' has multiple unconditional outgoing edges/,
  },
  {
    rule: "a role with no agent",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.agent = { role: "ghost" }),
    at: { node: "plan" },
    message: /^agent selector \{"role":"ghost"\} cannot be resolved$/,
  },
  {
    rule: "a template that does not exist",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.template = "sdlc/missing"),
    at: { node: "plan" },
    message: /^template 'sdlc\/missing' is not registered$/,
  },
  {
    rule: "an agent step with neither template nor prompt",
    severity: "error",
    breaks: (d) => delete d.nodes.plan!.template,
    at: { node: "plan" },
    message: /^agent step needs a 'template' id or an inline 'prompt'$/,
  },
  {
    rule: "a subworkflow that does not exist",
    severity: "error",
    breaks: (d) => (d.nodes.sub!.workflow = "missing"),
    at: { node: "sub" },
    message: /^referenced workflow 'missing' is not registered$/,
  },
  {
    rule: "a bad expression on an edge",
    severity: "error",
    breaks: (d) => (d.edges[2]!.when = "choice =="),
    at: { edge: 2 },
    message: /./,
  },
  {
    rule: "a bad expression in a node",
    severity: "error",
    breaks: (d) => (d.nodes.again!.condition = "vars.attempt <"),
    at: { node: "again" },
    message: /./,
  },
  {
    rule: "a default option that is not an option",
    severity: "error",
    breaks: (d) => (d.nodes.choose!.defaultOption = "maybe"),
    at: { node: "choose" },
    message: /^defaultOption must be one of options$/,
  },
  {
    rule: "a parallel node with neither branches nor items",
    severity: "error",
    breaks: (d) => delete d.nodes.fan!.branches,
    at: { node: "fan" },
    message: /^parallel node needs 'branches' or 'forEach'$/,
  },
  {
    rule: "a custom node its validator refuses",
    severity: "error",
    breaks: (d) => delete d.nodes.score!.rubric,
    at: { node: "score" },
    message: /^a score node needs a rubric$/,
  },
  {
    rule: "a field the schema refuses",
    severity: "error",
    breaks: (d) => (d.nodes.again!.maxIterations = 0),
    at: { node: "again" },
    message: /^nodes\.again: /,
  },
  {
    rule: "an unreachable node (an error in the editor)",
    severity: "error",
    breaks: (d) => (d.nodes.orphan = { type: "end" }),
    at: { node: "orphan" },
    message: /^node 'orphan' is unreachable from start$/,
  },

  /* ---------- capabilities and secret references (#335, #336, #337) ---------- */
  {
    rule: "a step selecting an MCP server the catalog does not have",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.capabilities = { mcpServers: { enable: ["ghost"] } }),
    at: { node: "plan" },
    message: /no MCP server 'ghost'/,
  },
  {
    rule: "a step selecting a skill the catalog does not have",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.capabilities = { skills: { enable: ["ghost"] } }),
    at: { node: "plan" },
    message: /no skill 'ghost'/,
  },
  {
    rule: "a step turning on an MCP server its agent may not use",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.capabilities = { mcpServers: { enable: ["forbidden"] } }),
    at: { node: "plan" },
    message: /cannot turn on MCP server 'forbidden': agent 'worker' is not permitted to use it/,
  },
  {
    rule: "a step listing an MCP server twice",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.capabilities = { mcpServers: { enable: ["github", "github"] } }),
    at: { node: "plan" },
    message: /lists MCP server 'github' twice/,
  },
  {
    rule: "a step giving its agent an MCP server whose secret lives on another host",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.capabilities = { mcpServers: { enable: ["deploy"] } }),
    at: { node: "plan" },
    message:
      /^MCP server 'deploy' reads secret 'deploy-key' \(DEPLOY_KEY\), which is bound to host 'build-box', but this step's agent runs on 'local'/,
  },
  {
    rule: "a skill whose content no longer matches its pin",
    severity: "error",
    breaks: (d) => (d.nodes.plan!.capabilities = { skills: { enable: ["pinned"] } }),
    at: {},
    message: /^skill 'pinned' content is sha256:[0-9a-f]{64}, but its pinned digest is sha256:0{64}/,
  },
  {
    rule: "a workflow-wide selection the catalog does not have",
    severity: "error",
    breaks: (d) => ((d as Doc & { capabilities?: unknown }).capabilities = { mcpServers: { enable: ["ghost"] } }),
    at: {},
    message: /no MCP server 'ghost'/,
  },
  {
    rule: "a step disabling an MCP server that is not on",
    severity: "warning",
    breaks: (d) => (d.nodes.plan!.capabilities = { mcpServers: { disable: ["github"] } }),
    at: { node: "plan" },
    message: /^MCP server 'github' is not enabled at this point, so disabling it changes nothing$/,
  },

  /* ---------- the same rules inside each kind of nested graph ---------- */
  {
    rule: "a node with no outgoing edge, in a loop body",
    severity: "error",
    breaks: (d) => {
      loopBody(d).edges.pop();
      loopBody(d).edges.push({ from: "s", to: "e", when: "false" });
    },
    at: { graph: [{ node: "again" }], node: "step" },
    message: /^node 'step' has no outgoing edges$/,
  },
  {
    rule: "an unreachable node, in a parallel branch",
    severity: "error",
    breaks: (d) => (branchA(d).nodes.lost = { type: "end" }),
    at: { graph: [{ node: "fan", branch: "a" }], node: "lost" },
    message: /^node 'lost' is unreachable from start$/,
  },
  {
    rule: "an edge out of an end, in a for-each body",
    severity: "error",
    breaks: (d) => eachBody(d).edges.push({ from: "e", to: "step", when: "false" }),
    at: { graph: [{ node: "each", forEach: true }], edge: 2 },
    message: /^end node 'e' cannot have outgoing edges$/,
  },

  /* ---------- warnings: they do not block publish ---------- */
  {
    rule: "a field the node's type does not use",
    severity: "warning",
    breaks: (d) => (d.nodes.note!.prompt = "left from an agent"),
    at: { node: "note" },
    message: /^'prompt' is not used by a set node/,
  },
  {
    rule: "a decision with no conditional edges",
    severity: "warning",
    breaks: (d) => {
      d.edges = d.edges.filter((edge) => !(edge.from === "choose" && edge.to === "done"));
      delete d.edges.find((edge) => edge.from === "choose")!.when;
    },
    at: { node: "choose" },
    message: /^decision node has no conditional edges/,
  },
  {
    rule: "a parallel node with one branch",
    severity: "warning",
    breaks: (d) => delete (d.nodes.fan!.branches as Record<string, unknown>).b,
    at: { node: "fan" },
    message: /^This parallel node has one branch/,
  },
  {
    rule: "a for-each ordered with no key",
    severity: "warning",
    breaks: (d) => ((d.nodes.each!.forEach as Record<string, unknown>).dependsOn = "item.after"),
    at: { node: "each" },
    message: /^forEach\.dependsOn without forEach\.key/,
  },
  {
    rule: "an agent waiting on no deliverable",
    severity: "warning",
    breaks: (d) => (d.nodes.plan!.completion = { mode: "artifact-present" }),
    at: { node: "plan" },
    message: /^completion\.mode 'artifact-present' has no required deliverable/,
  },
  {
    rule: "a custom node its validator warns about",
    severity: "warning",
    breaks: (d) => (d.nodes.score!.rubric = "loose"),
    at: { node: "score" },
    message: /^a loose rubric scores everything the same$/,
  },

  /* ---------- notes ---------- */
  {
    rule: "a gate that approves itself",
    severity: "note",
    breaks: (d) => (d.nodes.ask!.autoApproveWhen = "vars.trusted"),
    at: { node: "ask" },
    message: /^This gate approves itself when vars\.trusted\.$/,
  },
];

function draftOf(rule: Rule): Doc {
  const doc = clean();
  rule.breaks(doc);
  return doc;
}

describe("the validation panel's rules, one fixture draft each (#182)", () => {
  it("starts from a clean draft that uses every node family and every kind of nested graph", () => {
    const doc = clean();
    expect(validateDraft(stringify(doc), "ai-sdlc", context)).toEqual([]);
    // A step that uses a catalog server and a skill its agent may use is clean too.
    const using = clean();
    using.nodes.plan!.capabilities = { mcpServers: { enable: ["github"] }, skills: { enable: ["review"] } };
    expect(validateDraft(stringify(using), "ai-sdlc", context)).toEqual([]);
    const types = new Set(Object.values(doc.nodes).map((node) => String(node.type)));
    expect([...types].sort()).toEqual(
      ["agent", "custom:score", "decision", "end", "gate", "loop", "parallel", "set", "start", "subworkflow"].sort(),
    );
  });

  it.each(RULES)("$rule: exactly its row, where it jumps to", (rule) => {
    const issues = validateDraft(stringify(draftOf(rule)), "ai-sdlc", context);
    expect(issues, JSON.stringify(issues)).toHaveLength(1);
    const [issue] = issues as [DraftIssue];
    expect(issue.severity).toBe(rule.severity);
    expect(issue.message).toMatch(rule.message);
    expect({ graph: issue.graph, node: issue.node, edge: issue.edge }).toEqual({
      graph: rule.at.graph ?? [],
      node: rule.at.node,
      edge: rule.at.edge,
    });
  });

  it("keeps the renderer's copy of these rows current", async () => {
    const rows = RULES.map((rule) => {
      const document = draftOf(rule);
      const [issue] = validateDraft(stringify(document), "ai-sdlc", context);
      return { rule: rule.rule, document, issue };
    });
    if (process.env.UPDATE_VALIDATION_RULES) await writeFile(GOLDEN, `${JSON.stringify(rows, null, 2)}\n`);
    // Compared as data: the file is formatted by the repository's formatter, not by this test.
    const held: unknown = JSON.parse(await readFile(GOLDEN, "utf8").catch(() => "null"));
    expect(held).toEqual(JSON.parse(JSON.stringify(rows)));
  });
});
