// @vitest-environment happy-dom
/**
 * The editor's dry run (#183): the draft bar's Dry run opens a panel under the canvas, a gate
 * gets a fixture choice, and the result says what happened - "· dry" on its status, the
 * branches never taken, the nodes never reached - and draws the unreached on the canvas until
 * the draft moves on. The simulation itself is the daemon's and tested there
 * (`packages/daemon/test/dry-run-methods.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { WorkflowDraftDryRunResult } from "@orca/protocol";
import { editorNodeDomId } from "../src/workflow/editor/editor-canvas.js";
import { choicePoints, traceOf } from "../src/workflow/editor/dry-run-panel.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";
import { draftBridge, type Doc } from "./fixtures-workflow-drafts.js";

const teardown: (() => void)[] = [];
beforeEach(() => stubMatchMedia(1440));
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

const GATED: Doc = {
  id: "ai-sdlc",
  name: "Gated",
  version: "1",
  start: "start",
  nodes: {
    start: { type: "start" },
    gate: { type: "gate", question: "Ship it?", options: ["ship", { id: "hold", label: "Hold" }] },
    shipped: { type: "end" },
    held: { type: "end", outcome: "failure" },
  },
  edges: [
    { from: "start", to: "gate" },
    { from: "gate", to: "shipped", when: "choice == 'ship'" },
    { from: "gate", to: "held" },
  ],
};

/** What the daemon answers for a dry run that held at the gate. */
function held(revision: number): WorkflowDraftDryRunResult {
  return {
    runId: "run-dry",
    run: {
      id: "run-dry",
      name: "ai-sdlc",
      workflowId: "ai-sdlc",
      workflowVersion: "1+dryrun.0123456789abcdef",
      status: "failed",
      outcome: "failure",
      createdAt: "2026-10-10T12:00:00.000Z",
      dryRun: { definitionRevision: "sha256:def", draftRevision: revision },
    },
    report: {
      runId: "run-dry",
      status: "completed",
      outcome: "failure",
      dryRun: {
        definitionRevision: "sha256:def",
        draftRevision: revision,
        fixtures: "sha256:f",
        capabilities: "sha256:c",
      },
      runs: [{ runId: "run-dry", workflowId: "ai-sdlc", status: "completed" }],
      choices: [{ runId: "run-dry", nodeId: "gate", choice: "hold", source: "dry-run:fixture" }],
      untakenOptions: [{ runId: "run-dry", nodeId: "gate", options: ["ship"] }],
      untakenEdges: [{ runId: "run-dry", from: "gate", to: "shipped" }],
      unreachedNodes: [{ runId: "run-dry", nodeIds: ["shipped"] }],
      assumptions: [],
      failures: [],
      limits: "Simulated with fixtures: no agent, tool, integration or person took part.",
    },
    asOf: "2026-10-10T12:00:01.000Z",
  };
}

async function openEditor() {
  const fake = installBridge({ deepLink: "orca://workflow/ai-sdlc" });
  teardown.push(fake.install());
  const drafts = draftBridge(fake, { base: GATED, dryRun: (revision) => held(revision) });
  const h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const canvas = await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  await act(async () => {});
  return { canvas, drafts };
}

describe("the editor's dry run", () => {
  it("runs the draft at its revision with the gate's chosen fixture, and says what was never reached", async () => {
    const { drafts } = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    const panel = await screen.findByRole("region", { name: "Dry run" });

    // The gate is a choice point; pick "hold" for it.
    fireEvent.click(within(panel).getByRole("button", { name: /What gate answers in the dry run/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "hold" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Run a dry run" }));

    await waitFor(() => expect(within(panel).getByText("failed · dry")).toBeTruthy());
    const call = drafts.calls.find((c) => c.method === "workflowDrafts.dryRun");
    expect(call?.params).toEqual({
      workflowId: "ai-sdlc",
      expectedRevision: 0,
      fixtures: { choices: { gate: "hold" } },
    });
    expect(panel.textContent).toContain("gate: hold (dry-run:fixture)");
    expect(panel.textContent).toContain("gate → ship");
    expect(panel.textContent).toContain("Simulated with fixtures");

    // The node it never reached is drawn untaken on the canvas, and says so to a reader.
    const shipped = document.getElementById(editorNodeDomId("shipped"));
    expect(shipped?.closest(".orca-node--untaken") ?? shipped?.querySelector(".orca-node--untaken")).toBeTruthy();
  });

  it("keeps an older result readable but stops drawing it once the draft moves on", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    const panel = await screen.findByRole("region", { name: "Dry run" });
    fireEvent.click(within(panel).getByRole("button", { name: "Run a dry run" }));
    await waitFor(() => expect(within(panel).getByText("failed · dry")).toBeTruthy());
    expect(document.querySelectorAll(".orca-node--untaken").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    await waitFor(() => expect(panel.textContent).toContain("The draft has changed since"));
    expect(document.querySelectorAll(".orca-node--untaken")).toHaveLength(0);
  });
});

describe("dry run helpers", () => {
  it("lists gates and person-made decisions, not decisions an expression makes", () => {
    const points = choicePoints({
      start: "s",
      edges: [],
      nodes: [
        { id: "s", type: "start", raw: { type: "start" } },
        { id: "g", type: "gate", raw: { type: "gate", options: ["a", { id: "b" }] } },
        { id: "d", type: "decision", raw: { type: "decision", source: { kind: "human" }, options: [{ id: "x" }] } },
        {
          id: "e",
          type: "decision",
          raw: { type: "decision", source: { kind: "expression" }, options: [{ id: "y" }] },
        },
        { id: "gone", type: "gate", raw: { type: "gate", options: ["a"] }, state: "removed" },
      ],
    });
    expect(points).toEqual([
      { id: "g", type: "gate", options: ["a", "b"] },
      { id: "d", type: "decision", options: ["x"] },
    ]);
  });

  it("draws only the root run's trace", () => {
    const report = held(3).report;
    report.unreachedNodes.push({ runId: "run-child", nodeIds: ["inner"] });
    const trace = traceOf(report);
    expect([...trace.unreached]).toEqual(["shipped"]);
    expect(trace.untakenEdges.size).toBe(1);
  });
});
