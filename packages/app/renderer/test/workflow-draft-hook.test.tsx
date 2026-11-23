// @vitest-environment happy-dom
/**
 * The editor's connection to its draft (#180, #181): `useWorkflowDraft` over a scripted
 * `window.orca.workflowDrafts`. What it must get right is the refusals - a stale revision
 * re-reads the draft and says so, any other refusal is said and the draft kept - and that
 * every call names the revision the previous one produced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { WorkflowDraftView } from "@orca/protocol";
import type { WorkflowDraftBridge } from "../../src/workflow-draft-bridge.js";
import { useWorkflowDraft } from "../src/workflow/editor/use-workflow-draft.js";
import { installBridge } from "./harness.js";

const teardown: (() => void)[] = [];
afterEach(() => {
  while (teardown.length) teardown.pop()?.();
});

const view = (revision: number): WorkflowDraftView => ({
  workflowId: "ai-sdlc",
  owner: { principalId: "local", you: true },
  revision,
  createdAt: "2026-10-10T12:00:00.000Z",
  updatedAt: "2026-10-10T12:00:00.000Z",
  base: { version: "1", revision: "sha256:base", current: true, text: "", document: {} },
  text: "",
  document: {},
  layout: { graphs: {} },
  issues: [],
  dirty: revision > 0,
  canUndo: revision > 0,
  canRedo: false,
});

type Answer = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
const refusal = (code: string, message = ""): Answer => ({ ok: false, error: { code, message } });

/** The draft bridge, answering each method from `answers` (a function of the params) or with the next view. */
function drafts(answers: Record<string, (params: Record<string, unknown>) => Answer | Promise<Answer>> = {}) {
  const fake = installBridge();
  teardown.push(fake.install());
  let revision = 0;
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<Answer> => {
    const answer = answers[method];
    if (answer) return answer(params);
    if (method === "workflowDrafts.open") return { ok: true, result: view(revision) };
    revision += 1;
    return { ok: true, result: view(revision) };
  });
  fake.bridge.workflowDrafts = { call } as unknown as WorkflowDraftBridge;
  return { fake, call };
}

async function ready(answers?: Parameters<typeof drafts>[0]) {
  const bridge = drafts(answers);
  const hook = renderHook(() => useWorkflowDraft("ai-sdlc"));
  await waitFor(() => expect(hook.result.current.state.phase).toBe("ready"));
  return { ...bridge, hook };
}

const revisionOf = (hook: Awaited<ReturnType<typeof ready>>["hook"]) => {
  const state = hook.result.current.state;
  return state.phase === "ready" ? state.draft.revision : undefined;
};

describe("useWorkflowDraft", () => {
  it("is unavailable on a daemon with no draft methods, and reloading there does nothing", async () => {
    const fake = installBridge();
    teardown.push(fake.install());
    const { result } = renderHook(() => useWorkflowDraft("ai-sdlc"));
    expect(result.current.state).toEqual({
      phase: "unavailable",
      reason: "This app cannot edit workflows on this daemon.",
    });
    await act(() => result.current.reload());
    expect(await result.current.apply([{ op: "tidy" }])).toBe(false);
  });

  it("says why a draft could not be opened, by message or else by code", async () => {
    drafts({ "workflowDrafts.open": () => refusal("UNAUTHORIZED", "Not yours.") });
    const named = renderHook(() => useWorkflowDraft("ai-sdlc"));
    await waitFor(() => expect(named.result.current.state).toEqual({ phase: "error", error: "Not yours." }));
    named.unmount();
    drafts({ "workflowDrafts.open": () => refusal("NOT_FOUND") });
    const coded = renderHook(() => useWorkflowDraft("ai-sdlc"));
    await waitFor(() => expect(coded.result.current.state).toEqual({ phase: "error", error: "NOT_FOUND" }));
  });

  it("drops an open that answers after the editor is gone", async () => {
    let answer!: (value: Answer) => void;
    drafts({ "workflowDrafts.open": () => new Promise<Answer>((resolve) => (answer = resolve)) });
    const { result, unmount } = renderHook(() => useWorkflowDraft("ai-sdlc"));
    unmount();
    await act(async () => answer({ ok: true, result: view(0) }));
    expect(result.current.state.phase).toBe("loading");
  });

  it("sends edits one at a time, each against the revision the last one produced", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { hook, call } = await ready({
      "workflowDrafts.apply": async (params) => {
        await held;
        return { ok: true, result: view((params.expectedRevision as number) + 1) };
      },
    });
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = hook.result.current.apply([{ op: "tidy" }]);
      second = hook.result.current.apply([{ op: "tidy" }]);
    });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));
    // The second waits for the first: one call is out, not two.
    expect(call.mock.calls.filter(([method]) => method === "workflowDrafts.apply")).toHaveLength(1);
    release();
    await act(async () => {
      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });
    const applies = call.mock.calls.filter(([method]) => method === "workflowDrafts.apply");
    expect(applies.map(([, params]) => params.expectedRevision)).toEqual([0, 1]);
    expect(revisionOf(hook)).toBe(2);
    expect(hook.result.current.busy).toBe(false);
  });

  it("re-reads the draft when another window moved it on, and says so", async () => {
    const { hook, call } = await ready({
      "workflowDrafts.apply": () => refusal("CONFIG_STALE", "The draft changed in another window."),
      "workflowDrafts.get": () => ({
        ok: true,
        result: { draft: view(7), layout: { graphs: {} }, editable: true },
      }),
    });
    await act(async () => expect(await hook.result.current.apply([{ op: "tidy" }])).toBe(false));
    expect(call).toHaveBeenCalledWith("workflowDrafts.get", { workflowId: "ai-sdlc" });
    expect(hook.result.current.conflict).toBe("The draft changed in another window.");
    expect(revisionOf(hook)).toBe(7);
    act(() => hook.result.current.clearMessage());
    expect(hook.result.current.conflict).toBeUndefined();
  });

  it("keeps the draft when the re-read is refused or finds no draft", async () => {
    let reread: Answer = refusal("TRANSPORT", "The daemon went away.");
    const { hook } = await ready({
      "workflowDrafts.undo": () => refusal("CONFIG_STALE"),
      "workflowDrafts.get": () => reread,
    });
    await act(() => hook.result.current.undo());
    expect(hook.result.current.message).toBe("The daemon went away.");
    expect(revisionOf(hook)).toBe(0);
    reread = { ok: true, result: { draft: null, layout: { graphs: {} }, editable: true } };
    await act(() => hook.result.current.reload());
    expect(revisionOf(hook)).toBe(0);
  });

  it("says any other refusal and keeps the draft, for every call", async () => {
    const no = () => refusal("VALIDATION", "No.");
    const { hook } = await ready({
      "workflowDrafts.apply": no,
      "workflowDrafts.redo": no,
      "workflowDrafts.review": no,
      "workflowDrafts.publish": no,
      "workflowDrafts.discard": no,
    });
    await act(async () => expect(await hook.result.current.apply([{ op: "tidy" }])).toBe(false));
    expect(hook.result.current.message).toBe("No.");
    act(() => hook.result.current.clearMessage());
    await act(() => hook.result.current.redo());
    expect(hook.result.current.message).toBe("No.");
    await act(async () => expect(await hook.result.current.review()).toBeUndefined());
    await act(async () => expect(await hook.result.current.publish("token")).toBeUndefined());
    await act(async () => expect(await hook.result.current.discard()).toBe(false));
    expect(revisionOf(hook)).toBe(0);
  });

  it("undoes and redoes, and clears what the last refusal said", async () => {
    let refuse = true;
    const { hook } = await ready({
      "workflowDrafts.apply": () => (refuse ? refusal("VALIDATION", "No.") : { ok: true, result: view(1) }),
    });
    await act(() => hook.result.current.apply([{ op: "tidy" }]));
    expect(hook.result.current.message).toBe("No.");
    refuse = false;
    await act(() => hook.result.current.undo());
    expect(hook.result.current.message).toBeUndefined();
    await act(() => hook.result.current.redo());
    expect(revisionOf(hook)).toBe(2);
  });

  it("reviews, then publishes that review, after which nothing more is sent", async () => {
    const review = { revision: 0, baseVersion: "1", nextVersion: "2", baseText: "", text: "", reviewToken: "t-1" };
    const published = { workflowId: "ai-sdlc", version: "2" };
    const { hook, call } = await ready({
      "workflowDrafts.review": () => ({ ok: true, result: review }),
      "workflowDrafts.publish": () => ({ ok: true, result: published }),
    });
    await act(async () => expect(await hook.result.current.review()).toEqual(review));
    await act(async () => expect(await hook.result.current.publish("t-1")).toEqual(published));
    expect(call).toHaveBeenLastCalledWith("workflowDrafts.publish", {
      workflowId: "ai-sdlc",
      expectedRevision: 0,
      reviewToken: "t-1",
    });
    await act(async () => expect(await hook.result.current.apply([{ op: "tidy" }])).toBe(false));
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("discards the draft, after which nothing more is sent", async () => {
    const { hook, call } = await ready({ "workflowDrafts.discard": () => ({ ok: true, result: { discarded: true } }) });
    await act(async () => expect(await hook.result.current.discard()).toBe(true));
    await act(() => hook.result.current.undo());
    expect(call.mock.calls.map(([method]) => method)).toEqual(["workflowDrafts.open", "workflowDrafts.discard"]);
  });

  it("sends nothing once the editor is gone, and ignores a re-read that lands after", async () => {
    let answer!: (value: Answer) => void;
    const { hook, call } = await ready({
      "workflowDrafts.get": () => new Promise<Answer>((resolve) => (answer = resolve)),
    });
    const reload = hook.result.current.reload();
    hook.unmount();
    answer(refusal("TRANSPORT", "late"));
    await reload;
    expect(hook.result.current.message).toBeUndefined();
    expect(await hook.result.current.apply([{ op: "tidy" }])).toBe(false);
    expect(call.mock.calls.map(([method]) => method)).toEqual(["workflowDrafts.open", "workflowDrafts.get"]);
  });
  it("keeps the newest revision: a re-read older than an edit's result, or than a later re-read, is dropped (#182)", async () => {
    const answers: ((value: Answer) => void)[] = [];
    const { hook } = await ready({
      "workflowDrafts.get": () => new Promise<Answer>((resolve) => answers.push(resolve)),
    });
    const got = (revision: number): Answer => ({
      ok: true,
      result: { draft: view(revision), layout: { graphs: {} }, editable: true },
    });
    let first!: Promise<void>;
    act(() => void (first = hook.result.current.revalidate()));
    expect(hook.result.current.checking).toBe(true);
    await act(async () => void (await hook.result.current.apply([{ op: "tidy" }])));
    expect(revisionOf(hook)).toBe(1);
    // An edit's result is validated by the daemon that produced it.
    expect(hook.result.current.checking).toBe(false);
    await act(async () => {
      answers[0]!(got(0));
      await first;
    });
    expect(revisionOf(hook)).toBe(1);

    // Of two re-reads, only the one asked last counts, whichever answers first.
    let second!: Promise<void>;
    let third!: Promise<void>;
    act(() => {
      second = hook.result.current.revalidate();
      third = hook.result.current.revalidate();
    });
    await act(async () => {
      answers[2]!(got(3));
      await third;
    });
    expect(revisionOf(hook)).toBe(3);
    expect(hook.result.current.checking).toBe(false);
    await act(async () => {
      answers[1]!(got(2));
      await second;
    });
    expect(revisionOf(hook)).toBe(3);
  });

  it("takes a re-opened draft's lower revision: a new creation is newer news", async () => {
    const { hook } = await ready({
      "workflowDrafts.get": () => ({
        ok: true,
        result: {
          draft: { ...view(0), createdAt: "2026-10-11T12:00:00.000Z" },
          layout: { graphs: {} },
          editable: true,
        },
      }),
    });
    await act(async () => void (await hook.result.current.apply([{ op: "tidy" }])));
    expect(revisionOf(hook)).toBe(1);
    await act(() => hook.result.current.reload());
    expect(revisionOf(hook)).toBe(0);
  });
});
