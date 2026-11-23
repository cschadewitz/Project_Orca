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

async function openEditor(options: { dryRunMethod?: boolean } = {}) {
  const fake = installBridge({ deepLink: "orca://workflow/ai-sdlc" });
  teardown.push(fake.install());
  const drafts = draftBridge(fake, { base: GATED, dryRun: (revision) => held(revision) });
  if (options.dryRunMethod === false)
    fake.connect({
      ...fake.connection,
      methods: (fake.connection.methods ?? []).filter((method) => method !== "workflowDrafts.dryRun"),
    });
  // The daemon target the app is pointed at; `retarget` points it somewhere else.
  let epoch = 1;
  fake.bridge.daemonConnection = {
    read: () => ({ epoch, url: "http://localhost:6722", source: "saved", environmentOverride: false }),
    subscribe: () => () => {},
    onShow: () => () => {},
    show: () => {},
    cancel: () => {},
    activate: () => {},
    connect: async () => ({ ok: true }),
  } as unknown as NonNullable<typeof fake.bridge.daemonConnection>;
  const h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const canvas = await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  await act(async () => {});
  return {
    canvas,
    drafts,
    retarget: () => (epoch += 1),
    // The grant on the same daemon moves (refused, then given back): a new authority, same target.
    regrant: () => fake.connect({ ...fake.connection, authority: (fake.connection.authority ?? 0) + 1 }),
  };
}

async function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  return screen.findByRole("region", { name: "Dry run" });
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

describe("the editor's dry run, against a moving draft or target", () => {
  it("runs nothing when a queued edit moves the draft past the revision the choices were made on", async () => {
    const { drafts } = await openEditor();
    const panel = await openPanel();
    const release = drafts.hold("workflowDrafts.apply");
    // Both pressed before either is answered: the edit is queued first, and the choices on
    // screen when the dry run was pressed are revision 0's.
    fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Run a dry run" }));
    await waitFor(() => expect(drafts.calls.some((c) => c.method === "workflowDrafts.apply")).toBe(true));
    await act(async () => release());
    await waitFor(() => expect(panel.textContent).toContain("The draft changed before the dry run started"));
    expect(drafts.calls.some((c) => c.method === "workflowDrafts.dryRun")).toBe(false);

    // Pressed again, now on the new revision: that one runs.
    fireEvent.click(within(panel).getByRole("button", { name: "Run a dry run" }));
    await waitFor(() => expect(within(panel).getByText("failed · dry")).toBeTruthy());
    expect(drafts.calls.find((c) => c.method === "workflowDrafts.dryRun")?.params.expectedRevision).toBe(1);
  });

  it("drops a result that answers after the app was pointed at another daemon", async () => {
    const { drafts, retarget } = await openEditor();
    const panel = await openPanel();
    const release = drafts.hold("workflowDrafts.dryRun");
    fireEvent.click(within(panel).getByRole("button", { name: "Run a dry run" }));
    await waitFor(() => expect(drafts.calls.some((c) => c.method === "workflowDrafts.dryRun")).toBe(true));
    retarget();
    await act(async () => release());
    await act(async () => {});
    expect(within(panel).queryByText("failed · dry")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Open in Runs" })).toBeNull();
    expect(document.querySelectorAll(".orca-node--untaken")).toHaveLength(0);
  });

  it("sends nothing when the app is pointed at another daemon while the dry run waits in the queue", async () => {
    const { drafts, retarget } = await openEditor();
    const panel = await openPanel();
    const release = drafts.hold("workflowDrafts.dryRun");
    // Pressed twice before either is answered, on the same revision: the second waits behind
    // the first, and the scope moves while it waits.
    const run = within(panel).getByRole("button", { name: "Run a dry run" });
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(drafts.calls.some((c) => c.method === "workflowDrafts.dryRun")).toBe(true));
    retarget();
    await act(async () => release());
    await act(async () => {});
    expect(drafts.calls.filter((c) => c.method === "workflowDrafts.dryRun")).toHaveLength(1);
    expect(within(panel).queryByText("failed · dry")).toBeNull();
  });

  it("sends nothing when the grant on the same daemon changes while the dry run waits in the queue", async () => {
    const { drafts, regrant } = await openEditor();
    const panel = await openPanel();
    const release = drafts.hold("workflowDrafts.dryRun");
    // Pressed twice before either is answered, on the same revision: the second waits behind
    // the first, and the scope moves while it waits.
    const run = within(panel).getByRole("button", { name: "Run a dry run" });
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(drafts.calls.some((c) => c.method === "workflowDrafts.dryRun")).toBe(true));
    await act(async () => regrant());
    await act(async () => release());
    await act(async () => {});
    expect(drafts.calls.filter((c) => c.method === "workflowDrafts.dryRun")).toHaveLength(1);
    expect(within(panel).queryByText("failed · dry")).toBeNull();
  });

  it("drops a result that answers after the grant on the same daemon changed", async () => {
    const { drafts, regrant } = await openEditor();
    const panel = await openPanel();
    const release = drafts.hold("workflowDrafts.dryRun");
    fireEvent.click(within(panel).getByRole("button", { name: "Run a dry run" }));
    await waitFor(() => expect(drafts.calls.some((c) => c.method === "workflowDrafts.dryRun")).toBe(true));
    await act(async () => regrant());
    await act(async () => release());
    await act(async () => {});
    expect(within(panel).queryByText("failed · dry")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Open in Runs" })).toBeNull();
    expect(document.querySelectorAll(".orca-node--untaken")).toHaveLength(0);

    // Pressed again under the new grant: that one is shown.
    fireEvent.click(within(panel).getByRole("button", { name: "Run a dry run" }));
    await waitFor(() => expect(within(panel).getByText("failed · dry")).toBeTruthy());
  });

  it("offers no dry run on a daemon that does not have it, and says why", async () => {
    await openEditor({ dryRunMethod: false });
    const button = screen.getByRole("button", { name: "Dry run" });
    expect(button.getAttribute("aria-disabled") ?? button.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(button);
    expect(screen.queryByRole("region", { name: "Dry run" })).toBeNull();
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
