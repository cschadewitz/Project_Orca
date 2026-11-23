// @vitest-environment happy-dom
/**
 * The validation panel (#182) in the real editor. Every rule in docs/design/70 has a fixture
 * draft whose one finding comes from the daemon's own validator
 * (`packages/daemon/test/workflow-draft-validation-rules.test.ts` writes
 * `fixtures/validation-rules.json` and fails when it is behind): opened here, the panel shows
 * exactly that row, and pressing it selects what it names in the outline, the canvas and the
 * inspector, inside the nested graph it is in. Then what binds the panel to the current
 * revision: a late answer never replaces newer findings, losing the daemon or a configuration
 * change makes them `checking` until they are validated again, and the live region speaks
 * only when the draft crosses between clean and not.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DraftIssue, NotificationMessage, WorkflowDraftView } from "@orca/protocol";
import type { WorkflowDraftBridge } from "../../src/workflow-draft-bridge.js";
import type { DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import type { FakeBridge } from "./fake-bridge.js";
import { draftBridge } from "./fixtures-workflow-drafts.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";
import RULES from "./fixtures/validation-rules.json";

const teardown: (() => void)[] = [];
beforeEach(() => stubMatchMedia(1440));
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

type Answer = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
type Graph = { start: string; nodes: Record<string, Record<string, unknown>>; edges: { from: string; to: string }[] };
type Rule = { rule: string; document: Graph & { id: string }; issue: DraftIssue };

/**
 * A draft service answering from `state`: the document and findings a test sets, at a
 * revision every write moves on. `hold` keeps the next answer to a method back until released.
 */
function service(fake: FakeBridge, document: unknown, issues: DraftIssue[]) {
  draftBridge(fake); // advertises the draft methods on the connection
  const state = { document, issues, revision: 0 };
  /** The viewer offers Edit before a draft exists, Continue editing after. */
  let opened = false;
  const calls: string[] = [];
  const held = new Map<string, Promise<void>>();
  const view = (): WorkflowDraftView => ({
    workflowId: "ai-sdlc",
    owner: { principalId: "local", you: true },
    revision: state.revision,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    base: { version: "1", revision: "sha256:base", current: true, text: "", document },
    text: "",
    document: structuredClone(state.document),
    layout: { graphs: {} },
    issues: structuredClone(state.issues),
    dirty: true,
    canUndo: true,
    canRedo: false,
    ...(state.issues.some((issue) => issue.severity === "error")
      ? { publishBlocked: "Fix the validation errors before publishing." }
      : {}),
  });
  const call = async (method: string): Promise<Answer> => {
    calls.push(method);
    let answer: Answer;
    if (method === "workflowDrafts.get")
      answer = { ok: true, result: { draft: opened ? view() : null, layout: { graphs: {} }, editable: true } };
    else {
      if (method === "workflowDrafts.open") opened = true;
      else state.revision += 1;
      answer = { ok: true, result: view() };
    }
    const wait = held.get(method);
    held.delete(method);
    if (wait) await wait;
    return answer;
  };
  fake.bridge.workflowDrafts = { call } as unknown as WorkflowDraftBridge;
  return {
    state,
    calls,
    hold: (method: string) => {
      let release!: () => void;
      held.set(method, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
  };
}

async function openEditor(document: unknown, issues: DraftIssue[]) {
  const fake = installBridge({ deepLink: "orca://workflow/ai-sdlc" });
  teardown.push(fake.install());
  const drafts = service(fake, document, issues);
  const h = harness();
  teardown.push(h.dispose);
  const said: string[] = [];
  teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));
  renderChrome(h);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const canvas = await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  return { fake, drafts, said, canvas };
}

const panel = () => screen.getByRole("region", { name: "Validation" });
/** What the panel says, with `counted`'s no-break spaces read as spaces. */
const said = () => (panel().textContent ?? "").replace(/\u00a0/g, " ");
const rows = () => within(panel()).queryAllByRole("listitem");
const inspector = () => screen.getByRole("complementary", { name: "Inspector" });
const outline = () => screen.getByRole("list", { name: "Nodes, in file order" });

/** The graph a finding is in: the top graph, or the one its path steps into. */
function graphAt(document: Graph, issue: DraftIssue): Graph {
  let graph = document;
  for (const step of issue.graph) {
    const node = graph.nodes[step.node]!;
    graph =
      step.branch !== undefined
        ? (node.branches as Record<string, { graph: Graph }>)[step.branch]!.graph
        : step.forEach
          ? (node.forEach as { body: { graph: Graph } }).body.graph
          : (node.body as { graph: Graph }).graph;
  }
  return graph;
}

describe("one fixture draft per rule (#182)", () => {
  it("has a fixture for every severity and every kind of nested graph", () => {
    const rules = RULES as Rule[];
    expect(new Set(rules.map((rule) => rule.issue.severity))).toEqual(new Set(["error", "warning", "note"]));
    expect(rules.some((rule) => rule.issue.graph.some((step) => step.branch !== undefined))).toBe(true);
    expect(rules.some((rule) => rule.issue.graph.some((step) => step.forEach))).toBe(true);
    expect(rules.some((rule) => rule.issue.graph.length === 1 && !rule.issue.graph[0]!.branch)).toBe(true);
  });

  it.each((RULES as Rule[]).map((rule) => [rule.rule, rule] as const))(
    "%s: its one row selects what it names",
    async (_name, { document, issue }) => {
      const { canvas } = await openEditor(document, [issue]);
      expect(rows()).toHaveLength(1);
      const row = rows()[0]!;
      expect(row.textContent).toContain(issue.message);
      expect(said()).toContain(
        `${issue.severity === "error" ? "1 error" : "0 errors"} · ${issue.severity === "warning" ? "1 warning" : "0 warnings"} · ${issue.severity === "note" ? "1 note" : "0 notes"}`,
      );
      const go = within(row).queryByRole("button");
      if (issue.node === undefined && issue.edge === undefined && issue.graph.length === 0) {
        // About the whole workflow: nowhere to go, and still on screen.
        expect(go).toBeNull();
        return;
      }
      fireEvent.click(go!);
      const trail = screen.queryByRole("navigation", { name: "Graph" });
      if (issue.graph.length === 0) expect(trail).toBeNull();
      else expect(within(trail!).getAllByRole("button").at(-1)!.getAttribute("aria-current")).toBe("location");
      if (issue.node !== undefined) {
        expect(canvas.getAttribute("aria-activedescendant")).toBe(`orca-wfedit-node-${issue.node}`);
        const item = within(outline()).getByRole("button", { name: new RegExp(`\\b${issue.node}\\b`) });
        expect(item.getAttribute("aria-current")).toBe("true");
        expect(inspector().textContent).toContain(`nodes.${issue.node}`);
        // The node's own findings head its inspector.
        expect(inspector().textContent).toContain(issue.message);
      } else {
        const edge = graphAt(document, issue).edges[issue.edge!]!;
        expect(inspector().textContent).toContain(`${edge.from} → ${edge.to}`);
      }
    },
  );
});

describe("findings bound to the current revision", () => {
  const CLEAN = (RULES as Rule[])[0]!.document;
  const problem = (message: string): DraftIssue => ({
    severity: "error",
    message,
    path: "nodes.plan",
    graph: [],
    node: "plan",
  });

  it("never lets an earlier re-read replace a later one's findings", async () => {
    const { fake, drafts } = await openEditor(CLEAN, [problem("first finding")]);
    // A configuration change asks for a re-read that answers late, after a second change's.
    const releaseFirst = drafts.hold("workflowDrafts.get");
    act(() => fake.notify(configChanged()));
    await waitFor(() => expect(drafts.calls).toContain("workflowDrafts.get"));
    drafts.state.issues = [problem("second finding")];
    act(() => fake.notify(configChanged()));
    await waitFor(() => expect(said()).toContain("second finding"));
    expect(said()).not.toContain("Checking");
    await act(async () => releaseFirst());
    expect(said()).toContain("second finding");
    expect(said()).not.toContain("first finding");
  });

  it("marks findings as checking while the daemon is away, and validates again when it is back", async () => {
    const { fake, drafts } = await openEditor(CLEAN, []);
    expect(panel().textContent).toContain("No problems");
    const live = fake.connection;
    act(() => fake.connect({ ...live, state: "reconnecting" }));
    expect(panel().textContent).not.toContain("No problems");
    expect(panel().textContent).toContain("Checking");
    // Nothing can publish on findings nobody has confirmed (here the writes are gone too).
    const button = screen.queryByRole("button", { name: "Review and publish" });
    expect(button === null || button.getAttribute("aria-disabled") === "true").toBe(true);
    // It comes back with a finding the configuration it reconnected to produces.
    drafts.state.issues = [problem("agent selector cannot be resolved")];
    const before = drafts.calls.filter((method) => method === "workflowDrafts.get").length;
    act(() => fake.connect(live));
    await waitFor(() => expect(panel().textContent).toContain("agent selector cannot be resolved"));
    expect(drafts.calls.filter((method) => method === "workflowDrafts.get").length).toBe(before + 1);
    expect(panel().textContent).not.toContain("Checking");
  });

  it("never says a draft is clean until the re-read after a reconnect answers", async () => {
    const { fake, drafts } = await openEditor(CLEAN, []);
    const live = fake.connection;
    act(() => fake.connect({ ...live, state: "reconnecting" }));
    const release = drafts.hold("workflowDrafts.get");
    act(() => fake.connect(live));
    await waitFor(() => expect(drafts.calls).toContain("workflowDrafts.get"));
    expect(panel().textContent).toContain("Checking the draft");
    expect(panel().textContent).not.toContain("No problems");
    await act(async () => release());
    expect(panel().textContent).toContain("No problems");
  });

  it.each(["config.changed", "a different daemon"])(
    "keeps an edit's reply from before %s from clearing the check while the re-read is out",
    async (change) => {
      const { fake, drafts } = await openEditor(CLEAN, [problem("old finding")]);
      let epoch = 1;
      const listeners = new Set<(target: DaemonTargetSnapshot) => void>();
      const target = (): DaemonTargetSnapshot => ({
        epoch,
        url: "http://localhost:6722",
        source: "saved",
        environmentOverride: false,
      });
      if (change !== "config.changed") {
        // Installed before the editor would be too late for this hook: re-open it under one.
        fake.bridge.daemonConnection = {
          read: target,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
          },
          onShow: () => () => {},
          show: () => {},
          cancel: () => {},
          activate: () => {},
          connect: async () => ({ ok: true }),
        };
        fireEvent.click(screen.getByRole("button", { name: "Close the editor" }));
        fireEvent.click(await screen.findByRole("button", { name: /Continue editing|Edit/ }));
        await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
      }
      // An edit goes out under the old context, whose answer calls the draft clean, and is held.
      drafts.state.issues = [];
      const releaseEdit = drafts.hold("workflowDrafts.apply");
      fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
      await waitFor(() => expect(drafts.calls).toContain("workflowDrafts.apply"));
      // The new context finds a problem.
      drafts.state.issues = [problem("new context finding")];
      const releaseRead = drafts.hold("workflowDrafts.get");
      const reads = drafts.calls.filter((method) => method === "workflowDrafts.get").length;
      if (change === "config.changed") act(() => fake.notify(configChanged()));
      else
        act(() => {
          epoch += 1;
          listeners.forEach((listener) => listener(target()));
        });
      await waitFor(() =>
        expect(drafts.calls.filter((method) => method === "workflowDrafts.get").length).toBe(reads + 1),
      );
      await act(async () => releaseEdit());
      // The old context's reply is dropped: the last rows stay, as stale, and nothing is clean.
      expect(said()).toContain("Checking");
      expect(said()).toContain("old finding");
      expect(said()).not.toContain("No problems");
      expect(screen.getByRole("button", { name: "Review and publish" }).getAttribute("aria-disabled")).toBe("true");
      // The new context's validation is what clears it.
      await act(async () => releaseRead());
      await waitFor(() => expect(said()).toContain("new context finding"));
      expect(said()).not.toContain("Checking");
    },
  );

  it("validates again when the configuration it was checked against changes", async () => {
    const { fake, drafts } = await openEditor(CLEAN, []);
    drafts.state.issues = [problem("template 'sdlc/review' is not registered")];
    act(() => fake.notify(configChanged()));
    await waitFor(() => expect(panel().textContent).toContain("template 'sdlc/review' is not registered"));
  });

  it("speaks only when the draft crosses between clean and not", async () => {
    const { drafts, said } = await openEditor(CLEAN, []);
    const tidy = async () => {
      const at = drafts.state.revision;
      fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
      await waitFor(() => expect(drafts.state.revision).toBe(at + 1));
      await act(async () => {});
    };
    drafts.state.issues = [problem("one")];
    await tidy();
    drafts.state.issues = [problem("one"), problem("two")];
    await tidy();
    drafts.state.issues = [problem("two")];
    await tidy();
    drafts.state.issues = [];
    await tidy();
    await tidy();
    const validation = said
      .filter((sentence) => /validation error/.test(sentence))
      .map((s) => s.replace(/\u00a0/g, " "));
    expect(validation).toEqual(["The draft has 1 validation error.", "The draft has no validation errors."]);
  });
});

function configChanged(): NotificationMessage {
  return {
    kind: "notification",
    method: "config.changed",
    params: {
      subscriptionId: "sub-1",
      document: "config",
      revision: "next",
      path: "/workspace/orca.config.yaml",
      at: "2026-10-10T12:00:00.000Z",
    },
  };
}
