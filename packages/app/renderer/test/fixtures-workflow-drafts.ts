/**
 * A workflow-draft bridge in memory (#180, #181): the few draft operations the renderer tests
 * make, applied to a plain document, with every call recorded. The real service is the
 * daemon's and is tested there (packages/daemon/test/workflow-drafts-service.test.ts).
 */
import { stringify } from "yaml";
import {
  WORKFLOW_DRAFT_METHOD_CONTRACTS,
  type DraftIssue,
  type DraftLayout,
  type DraftOperation,
  type WorkflowDraftView,
} from "@orca/protocol";
import type { WorkflowDraftBridge } from "../../src/workflow-draft-bridge.js";
import type { FakeBridge } from "./fake-bridge.js";

export type Doc = {
  id: string;
  name: string;
  version: string;
  start: string;
  nodes: Record<string, Record<string, unknown>>;
  edges: { from: string; to: string; when?: string }[];
};

const BASE: Doc = {
  id: "ai-sdlc",
  name: "AI-native SDLC loop",
  version: "1",
  start: "start",
  nodes: {
    start: { type: "start" },
    plan: { type: "agent", agent: { role: "planner" }, prompt: "Plan the work." },
    done: { type: "end" },
  },
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "done" },
  ],
};

/**
 * The draft service, in memory: the operations these tests send, applied to a plain document.
 * Each batch is one undo step, as in the daemon, so `workflowDrafts.undo` puts back the document
 * and the layout as they were before it.
 */
export function draftBridge(
  fake: FakeBridge,
  options: {
    owner?: string;
    issues?: DraftIssue[];
    /** The workflow the draft starts from; `BASE` when absent. */
    base?: Doc;
    /** `workflowDrafts.dryRun`'s answer, given the revision and the call's params (#183). */
    dryRun?: (revision: number, params: Record<string, unknown>) => unknown;
  } = {},
) {
  const BASE_DOC = options.base ?? BASE;
  let doc: Doc = structuredClone(BASE_DOC);
  let layout: DraftLayout = { graphs: {} };
  let revision = 0;
  const undo: { doc: Doc; layout: DraftLayout }[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const you = (options.owner ?? "local") === "local";

  const view = (): WorkflowDraftView => ({
    workflowId: "ai-sdlc",
    owner: { principalId: options.owner ?? "local", you },
    revision,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    base: { version: "1", revision: "sha256:base", current: true, text: stringify(BASE_DOC), document: BASE_DOC },
    text: stringify(doc),
    document: structuredClone(doc),
    layout,
    issues: options.issues ?? [],
    dirty: revision > 0,
    canUndo: you && undo.length > 0,
    canRedo: false,
    ...(revision > 0 && you
      ? {}
      : { publishBlocked: you ? "Nothing has changed yet." : "Only the person who opened this draft can publish it." }),
  });

  const apply = (op: DraftOperation) => {
    switch (op.op) {
      case "addNode":
        doc.nodes[op.id] = op.node;
        return;
      case "insertNode": {
        const edge = doc.edges[op.edge]!;
        doc.nodes[op.id] = op.node;
        doc.edges.splice(op.edge + 1, 0, { from: op.id, to: edge.to });
        edge.to = op.id;
        return;
      }
      case "addEdge":
        doc.edges.push({ from: op.from, to: op.to });
        return;
      case "removeNode":
        delete doc.nodes[op.id];
        if (op.detach) doc.edges = doc.edges.filter((e) => e.from !== op.id && e.to !== op.id);
        return;
      case "removeEdge":
        doc.edges.splice(op.index, 1);
        return;
      case "place":
        layout = { graphs: { ...layout.graphs, "": { ...layout.graphs[""], [op.id]: { x: op.x, y: op.y } } } };
        return;
      default:
        return;
    }
  };

  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    switch (method) {
      case "workflowDrafts.get":
        return { ok: true, result: { draft: null, layout: { graphs: {} }, editable: true } };
      case "workflowDrafts.open":
        return { ok: true, result: view() };
      case "workflowDrafts.apply":
        undo.push({ doc: structuredClone(doc), layout });
        for (const op of params.ops as DraftOperation[]) apply(op);
        revision += 1;
        return { ok: true, result: view() };
      case "workflowDrafts.undo": {
        const step = undo.pop();
        if (!step) return { ok: false, error: { code: "CONFIG_INVALID", message: "There is nothing to undo." } };
        ({ doc, layout } = step);
        revision += 1;
        return { ok: true, result: view() };
      }
      case "workflowDrafts.review":
        return {
          ok: true,
          result: {
            revision,
            baseVersion: "1",
            nextVersion: "2",
            baseText: stringify(BASE_DOC),
            text: stringify({ ...doc, version: "2" }),
            reviewToken: "token-1",
          },
        };
      case "workflowDrafts.publish":
        return {
          ok: true,
          result: {
            workflowId: "ai-sdlc",
            version: "2",
            apply: {
              outcome: "applied",
              status: {
                savedRevision: "r",
                activeGeneration: "g",
                activeRevision: "r",
                state: "active",
                restartRequired: [],
              },
              validation: { errors: [] },
            },
          },
        };
      case "workflowDrafts.discard":
        return { ok: true, result: { discarded: true } };
      case "workflowDrafts.dryRun":
        if (params.expectedRevision !== revision)
          return { ok: false, error: { code: "CONFIG_STALE", message: "The draft moved on." } };
        return options.dryRun
          ? { ok: true, result: options.dryRun(revision, params) }
          : { ok: false, error: { code: "PROTOCOL_METHOD", message: method } };
      default:
        return { ok: false, error: { code: "PROTOCOL_METHOD", message: method } };
    }
  };
  fake.bridge.workflowDrafts = { call } as unknown as WorkflowDraftBridge;
  fake.connect({
    ...fake.connection,
    methods: [...(fake.connection.methods ?? []), ...Object.keys(WORKFLOW_DRAFT_METHOD_CONTRACTS)],
  });
  return {
    calls,
    ops: () =>
      calls.filter((c) => c.method === "workflowDrafts.apply").flatMap((c) => c.params.ops as DraftOperation[]),
  };
}
