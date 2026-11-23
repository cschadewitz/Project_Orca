// @vitest-environment happy-dom
/** Mounted review evidence must stop being actionable when its draft or authority changes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { stringify } from "yaml";
import type { WorkflowDraftView } from "@orca/protocol";
import type { WorkflowDraftBridge } from "../../src/workflow-draft-bridge.js";
import type { DaemonConnectionBridge, DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import { App } from "../src/App.js";
import { ConnectionBoundary } from "../src/daemon-connection/boundary.js";
import * as draftHook from "../src/workflow/editor/use-workflow-draft.js";
import { draftBridge } from "./fixtures-workflow-drafts.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";

const teardown: (() => void)[] = [];
beforeEach(() => stubMatchMedia(1440));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  while (teardown.length) teardown.pop()?.();
});

type Answer = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
const base = {
  id: "ai-sdlc",
  name: "Base",
  version: "1",
  start: "start",
  nodes: { start: { type: "start" }, plan: { type: "agent", prompt: "Plan the work." }, done: { type: "end" } },
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "done" },
  ],
};

async function openEditor(options: { targetBoundary?: boolean } = {}) {
  const fake = installBridge({ deepLink: "orca://workflow/ai-sdlc" });
  teardown.push(fake.install());
  draftBridge(fake); // advertise the existing methods
  let opened = false;
  let revision = 1;
  let you = true;
  let current = true;
  let position = 1;
  const history = ["Base", "Edited", "Later edit"];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const delays = new Map<string, (answer: Answer) => Promise<Answer>>();
  let target: DaemonTargetSnapshot = {
    epoch: 1,
    url: "http://localhost:6722",
    source: "saved",
    environmentOverride: false,
  };
  const listeners = new Set<(target: DaemonTargetSnapshot) => void>();
  const targetBridge: DaemonConnectionBridge = {
    read: () => target,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onShow: () => () => {},
    show: () => {},
    cancel: () => {},
    activate: () => {},
    connect: async () => ({ ok: true }),
  };
  fake.bridge.daemonConnection = targetBridge;
  const view = (): WorkflowDraftView => ({
    workflowId: "ai-sdlc",
    owner: { principalId: you ? "local" : "other", you },
    revision,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    base: { version: "1", revision: "base", current, text: stringify(base), document: base },
    text: stringify({ ...base, name: history[position] }),
    document: { ...base, name: history[position] },
    layout: { graphs: {} },
    issues: [],
    dirty: true,
    canUndo: position > 0,
    canRedo: position < 2,
  });
  const respond = (method: string, params: Record<string, unknown>): Answer => {
    if (method === "workflowDrafts.get")
      return { ok: true, result: { draft: opened ? view() : null, layout: { graphs: {} }, editable: true } };
    if (method === "workflowDrafts.open") {
      opened = true;
      return { ok: true, result: view() };
    }
    if (
      params.expectedRevision !== revision ||
      (method === "workflowDrafts.publish" && params.reviewToken !== `token-${revision}`)
    )
      return { ok: false, error: { code: "CONFIG_STALE", message: "The draft changed." } };
    if (method === "workflowDrafts.review")
      return {
        ok: true,
        result: {
          revision,
          baseVersion: "1",
          nextVersion: "2",
          baseText: stringify(base),
          text: view().text,
          reviewToken: `token-${revision}`,
        },
      };
    if (method === "workflowDrafts.undo") position -= 1;
    if (method === "workflowDrafts.redo") position += 1;
    // The actual mutators replace the authoritative view and increment its revision.
    revision += 1;
    return { ok: true, result: view() };
  };
  fake.bridge.workflowDrafts = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const answer = respond(method, params);
      const delay = delays.get(method);
      delays.delete(method);
      return delay ? delay(answer) : answer;
    },
  } as unknown as WorkflowDraftBridge;
  let controller!: draftHook.WorkflowDraftController;
  const original = draftHook.useWorkflowDraft;
  vi.spyOn(draftHook, "useWorkflowDraft").mockImplementation((id) => (controller = original(id)));
  const h = harness();
  teardown.push(h.dispose);
  if (options.targetBoundary)
    render(
      <h.Providers>
        <ConnectionBoundary bridge={targetBridge}>
          <App />
        </ConnectionBoundary>
      </h.Providers>,
    );
  else renderChrome(h);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  return {
    fake,
    calls,
    reload: () => controller.reload(),
    changeTarget: () => {
      target = { ...target, epoch: target.epoch + 1 };
      listeners.forEach((listener) => listener(target));
    },
    change: (options: { owner?: boolean; baseCurrent?: boolean; advance?: boolean } = {}) => {
      if (options.advance !== false) revision += 1;
      if (options.owner !== undefined) you = options.owner;
      if (options.baseCurrent !== undefined) current = options.baseCurrent;
    },
    hold: (method: string) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      delays.set(method, async (answer) => {
        await held;
        return answer;
      });
      return release;
    },
  };
}

async function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  await screen.findByRole("button", { name: "Publish v2" });
}

it.each(["Undo", "Redo", "Tidy layout"])("invalidates review after the actual %s mutation", async (name) => {
  const { calls } = await openEditor();
  await review();
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() =>
    expect(
      calls.some((call) =>
        ["workflowDrafts.undo", "workflowDrafts.redo", "workflowDrafts.apply"].includes(call.method),
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull());
  expect(screen.queryByLabelText("Changes to the workflow file")).toBeNull();
  expect(calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);
  await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  await review(); // returning to editing permits a fresh review of the new revision
  expect(
    calls.filter((call) => call.method === "workflowDrafts.review").map((call) => call.params.expectedRevision),
  ).toEqual([1, 2]);
});

it("invalidates review when an external revision is read", async () => {
  const { change, reload, calls } = await openEditor();
  await review();
  change();
  await act(reload);
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  expect(calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);
});

it("retires a review as soon as a mutation is requested, before its response", async () => {
  const { hold, calls } = await openEditor();
  await review();
  const publish = screen.getByRole("button", { name: "Publish v2" });
  const release = hold("workflowDrafts.undo");
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(publish); // a retained callback must not enqueue the obsolete token
  });
  await waitFor(() => expect(calls.some((call) => call.method === "workflowDrafts.undo")).toBe(true));
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await act(async () => release());
  expect(calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);
});

it("does not restore a pending review when a mutation is queued behind it", async () => {
  const { hold, calls } = await openEditor();
  const release = hold("workflowDrafts.review");
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  await waitFor(() => expect(calls.some((call) => call.method === "workflowDrafts.review")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
  await act(async () => release());
  await waitFor(() => expect(calls.some((call) => call.method === "workflowDrafts.apply")).toBe(true));
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await review();
});

it("does not accept a review queued for a revision changed by an earlier mutation", async () => {
  const { calls } = await openEditor();
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  });
  await waitFor(() => expect(calls.filter((call) => call.method === "workflowDrafts.review")).toHaveLength(1));
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await review();
});

it("does not restore a review response after Back to editing", async () => {
  const { hold, calls } = await openEditor();
  await review();
  const back = screen.getByRole("button", { name: "Back to editing" });
  const release = hold("workflowDrafts.review");
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
    fireEvent.click(back);
  });
  await waitFor(() => expect(calls.filter((call) => call.method === "workflowDrafts.review")).toHaveLength(2));
  await act(async () => release());
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await review();
});

it("does not restore review after an external revision or a late older reload", async () => {
  const { change, reload, hold } = await openEditor();
  await review();
  const release = hold("workflowDrafts.get");
  let oldRead!: Promise<void>;
  act(() => {
    oldRead = reload();
  }); // capture the reviewed revision, then hold its response
  change();
  await act(reload);
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await act(async () => {
    release();
    await oldRead;
  });
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
});

it("drops a late review response when an external revision has already been read", async () => {
  const { change, reload, hold, calls } = await openEditor();
  const release = hold("workflowDrafts.review");
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  await waitFor(() => expect(calls.some((call) => call.method === "workflowDrafts.review")).toBe(true));
  change();
  await act(reload);
  await act(async () => release());
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await review();
});

it.each(["owner", "baseCurrent"] as const)(
  "retires review on %s revocation even without a new draft revision",
  async (key) => {
    const { change, reload } = await openEditor();
    await review();
    change({ [key]: false, advance: false });
    await act(reload);
    expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
    change({ [key]: true, advance: false });
    await act(reload);
    expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
    await review();
  },
);

it("retires review and pending responses across write revocation and restoration", async () => {
  const { fake, hold, calls } = await openEditor();
  await review();
  const release = hold("workflowDrafts.review");
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  await waitFor(() => expect(calls.filter((call) => call.method === "workflowDrafts.review")).toHaveLength(2));
  const live = fake.connection;
  act(() => fake.connect({ ...live, capabilities: [] }));
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  act(() => fake.connect(live));
  await act(async () => release());
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await review();
});

it("does not send a reviewed token to a replaced target before the boundary rerenders", async () => {
  const { changeTarget, calls } = await openEditor();
  await review();
  act(() => changeTarget());
  // A different target validates the draft again (#182), which retires the review at once.
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  await act(async () => {});
  expect(calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);
  expect(calls.at(-1)?.method).toBe("workflowDrafts.get");
});

it("does not restore an old target's pending review after boundary replacement", async () => {
  const { changeTarget, hold, calls } = await openEditor({ targetBoundary: true });
  const release = hold("workflowDrafts.review");
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  await waitFor(() => expect(calls.some((call) => call.method === "workflowDrafts.review")).toBe(true));
  act(() => changeTarget());
  await act(async () => release());
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Workflow draft" })).toBeNull();
  expect(calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);
});

it("clears stale review on a refused publish and external-revision recovery", async () => {
  const { change, calls } = await openEditor();
  await review();
  change(); // undelivered external changes remain the daemon's revision/token fence
  fireEvent.click(screen.getByRole("button", { name: "Publish v2" }));
  await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  expect(screen.queryByRole("button", { name: "Publish v2" })).toBeNull();
  expect(calls.find((call) => call.method === "workflowDrafts.publish")?.params).toMatchObject({
    expectedRevision: 1,
    reviewToken: "token-1",
  });
  await review();
});

it.each(["back", "external revision"])("keeps focus in the editor when review leaves through %s", async (reason) => {
  const { change, reload } = await openEditor();
  await review();
  const back = screen.getByRole("button", { name: "Back to editing" });
  act(() => back.focus());
  if (reason === "back") fireEvent.click(back);
  else {
    change();
    await act(reload);
  }
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close the editor" }));
});
