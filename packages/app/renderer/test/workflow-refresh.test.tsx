// @vitest-environment happy-dom
/** Mounted definition invalidations must not own an editor's local text or draft revision. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NotificationMessage, WorkflowsGetResult } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import type { DaemonConnectionBridge, DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import { App } from "../src/App.js";
import { ConnectionBoundary } from "../src/daemon-connection/boundary.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";
import { draftBridge } from "./fixtures-workflow-drafts.js";
import { WORKFLOW_VIEWS } from "./fixtures-workflows.js";

const teardown: (() => void)[] = [];
beforeEach(() => stubMatchMedia(1440));
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});
const changed = (id = "ai-sdlc"): NotificationMessage => ({
  kind: "notification",
  method: "workflows.changed",
  params: { subscriptionId: "sub-1", id, version: "2", at: "2026-10-25T20:00:00Z" },
});
const definition = (id = "ai-sdlc", version = "2"): BridgeResult<WorkflowsGetResult> => ({
  ok: true,
  result: { workflow: { ...WORKFLOW_VIEWS[id]!, version }, asOf: "2026-10-25T20:00:00Z" },
});
function setup(url = "orca://workflow/ai-sdlc") {
  const fake = installBridge({ deepLink: url });
  teardown.push(fake.install());
  const drafts = draftBridge(fake);
  const h = harness();
  teardown.push(h.dispose);
  return { fake, drafts, h };
}
async function edit() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  fireEvent.click(
    within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
  );
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: /^Prompt/ });
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "Still typing this prompt" } });
  return input;
}
function kept(input: HTMLTextAreaElement) {
  expect(screen.getByRole("textbox", { name: /^Prompt/ })).toBe(input);
  expect(input.value).toBe("Still typing this prompt");
  expect(document.activeElement).toBe(input);
}

it.each(["success", "failure"] as const)(
  "keeps typed inspector text mounted through a held refresh and %s",
  async (outcome) => {
    const { fake, drafts, h } = setup();
    renderChrome(h);
    const input = await edit();
    const before = drafts.calls.length;
    let answer!: (value: BridgeResult<WorkflowsGetResult>) => void;
    fake.script({
      "workflows.get": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    await act(async () => fake.notify(changed()));
    kept(input);
    expect(screen.getByText(/Refreshing the workflow definition/)).toBeTruthy();
    expect(screen.getByText(/This draft keeps its original base/)).toBeTruthy();
    await act(async () =>
      answer(
        outcome === "success"
          ? definition()
          : { ok: false, error: { code: "AUTH_FORBIDDEN", message: "Read refused." } },
      ),
    );
    kept(input);
    expect(drafts.calls).toHaveLength(before);
    expect(drafts.ops()).toEqual([]);
    expect(screen.getByRole("group", { name: "Workflow draft" }).textContent).toContain("Draft of ai-sdlc v1");
    if (outcome === "success") {
      expect(screen.getByText("ai-sdlc v2")).toBeTruthy();
      expect(screen.getByText(/The workflow definition changed/)).toBeTruthy();
    } else {
      expect(screen.getByText(/Could not refresh.*AUTH_FORBIDDEN: Read refused/)).toBeTruthy();
      fake.script({ "workflows.get": () => definition() });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByText("ai-sdlc v2");
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe("Still typing this prompt");
    }
    // A refresh never commits text. The person's later commit still names the draft revision.
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    expect(drafts.calls.find((call) => call.method === "workflowDrafts.apply")?.params).toMatchObject({
      workflowId: "ai-sdlc",
      expectedRevision: 0,
      ops: [{ op: "updateNode", id: "plan", set: { prompt: "Still typing this prompt" } }],
    });
    expect(drafts.calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);
  },
);

it("ignores unrelated workflow pushes without rereading or reopening the active draft", async () => {
  const { fake, drafts, h } = setup();
  renderChrome(h);
  const input = await edit();
  const reads = fake.calls.filter((call) => call.method === "workflows.get").length;
  const before = drafts.calls.length;
  await act(async () => fake.notify(changed("sdlc")));
  kept(input);
  expect(fake.calls.filter((call) => call.method === "workflows.get")).toHaveLength(reads);
  expect(drafts.calls).toHaveLength(before);
  expect(screen.queryByText(/This draft keeps its original base/)).toBeNull();
});

it("lets an explicit exit unmount the editor during a held refresh and does not reopen it", async () => {
  const { fake, drafts, h } = setup();
  renderChrome(h);
  const input = await edit();
  const release = fake.hold("workflows.get");
  teardown.push(release);
  await act(async () => fake.notify(changed()));
  fireEvent.click(screen.getByRole("button", { name: "Close the editor" }));
  expect(input.isConnected).toBe(false);
  expect(screen.getByRole("listbox", { name: /graph$/ })).toBeTruthy();
  await act(async () => release());
  expect(screen.queryByRole("group", { name: "Workflow draft" })).toBeNull();
  expect(drafts.calls.filter((call) => call.method === "workflowDrafts.open")).toHaveLength(1);
  expect(drafts.ops()).toEqual([]);
});

it("starts a different workflow afresh and ignores the old workflow's delayed answer", async () => {
  const { fake, h } = setup();
  renderChrome(h);
  const input = await edit();
  let answer!: (value: BridgeResult<WorkflowsGetResult>) => void;
  fake.script({
    "workflows.get": ({ id }) =>
      id === "ai-sdlc"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : definition(id, "3"),
  });
  await act(async () => fake.notify(changed()));
  await act(async () => fake.link("orca://workflow/sdlc"));
  await screen.findByText("sdlc v3");
  expect(input.isConnected).toBe(false);
  await act(async () => answer(definition("ai-sdlc", "99")));
  expect(screen.getByText("sdlc v3")).toBeTruthy();
  expect(screen.queryByText("ai-sdlc v99")).toBeNull();
  expect(screen.queryByRole("group", { name: "Workflow draft" })).toBeNull();
});

it("keeps viewer selection and the run's recorded pin while refreshing the current definition", async () => {
  const { fake, h } = setup("orca://workflow/sdlc?run=run-parent");
  renderChrome(h);
  const canvas = await screen.findByRole("listbox", { name: /graph$/ });
  fireEvent.click(within(canvas).getByRole("option", { name: /gate, Approve spec/ }));
  await screen.findByRole("complementary", { name: "Node detail: Approve spec" });
  const selected = canvas.getAttribute("aria-activedescendant");
  fake.script({ "workflows.get": () => definition("sdlc", "4") });
  const release = fake.hold("workflows.get");
  teardown.push(release);
  await act(async () => fake.notify(changed("sdlc")));
  expect(screen.getByRole("listbox", { name: /graph$/ })).toBe(canvas);
  expect(canvas.getAttribute("aria-activedescendant")).toBe(selected);
  await act(async () => release());
  expect(canvas.getAttribute("aria-activedescendant")).toBe(selected);
  expect(screen.getByRole("complementary", { name: "Node detail: Approve spec" })).toBeTruthy();
  expect(screen.getByText(/pinned to v2.*graph drawn is v4/)).toBeTruthy();
  expect(fake.calls.filter((call) => call.method === "runs.get")).toHaveLength(1);
  expect(
    fake.calls
      .filter((call) => call.method === "workflows.get")
      .every((call) => !Object.hasOwn(call.params ?? {}, "version")),
  ).toBe(true);
});

it("rejects a superseded refresh result while preserving the editor", async () => {
  const { fake, h } = setup();
  renderChrome(h);
  const input = await edit();
  const answers: ((value: BridgeResult<WorkflowsGetResult>) => void)[] = [];
  fake.script({
    "workflows.get": () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
  });
  await act(async () => fake.notify(changed()));
  await act(async () => fake.notify(changed()));
  expect(answers).toHaveLength(2);
  await act(async () => answers[1]!(definition("ai-sdlc", "3")));
  await act(async () => answers[0]!(definition("ai-sdlc", "2")));
  kept(input);
  expect(screen.getByText("ai-sdlc v3")).toBeTruthy();
  expect(screen.queryByText("ai-sdlc v2")).toBeNull();
});

it("unmounts the old editor on an actual target epoch change before activating the new target", async () => {
  const { fake, drafts, h } = setup();
  let target: DaemonTargetSnapshot = {
    epoch: 1,
    url: "http://localhost:6722",
    source: "saved",
    environmentOverride: false,
  };
  let listener: ((value: DaemonTargetSnapshot) => void) | undefined;
  const activations: { epoch: number; oldInputConnected: boolean }[] = [];
  const pendingInput: { current?: HTMLTextAreaElement } = {};
  const bridge: DaemonConnectionBridge = {
    read: () => target,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    onShow: () => () => {},
    show: () => {},
    cancel: () => {},
    connect: async () => ({ ok: true }),
    activate: (epoch) => {
      activations.push({ epoch, oldInputConnected: pendingInput.current?.isConnected ?? false });
    },
  };
  render(
    <h.Providers>
      <ConnectionBoundary bridge={bridge}>
        <App />
      </ConnectionBoundary>
    </h.Providers>,
  );
  const input = await edit();
  pendingInput.current = input;
  let answer!: (value: BridgeResult<WorkflowsGetResult>) => void;
  fake.script({
    "workflows.get": () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  await act(async () => fake.notify(changed()));
  // The existing connection boundary owns target replacement, not definition refresh state.
  await act(async () => {
    target = { ...target, epoch: 2 };
    listener?.(target);
  });
  expect(input.isConnected).toBe(false);
  expect(activations).toEqual([
    { epoch: 1, oldInputConnected: false },
    { epoch: 2, oldInputConnected: false },
  ]);
  await act(async () => answer(definition("ai-sdlc", "99")));
  expect(screen.queryByText("ai-sdlc v99")).toBeNull();
  expect(drafts.ops()).toEqual([]);
});

it.each(["review", "publish"] as const)(
  "still refuses stale %s after a definition refresh, with the original draft revision",
  async (operation) => {
    const { fake, drafts, h } = setup();
    renderChrome(h);
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    const calls: { method: string; params: unknown }[] = [];
    const bridge = fake.bridge.workflowDrafts!;
    const original = bridge.call.bind(bridge);
    bridge.call = async (method, params) => {
      calls.push({ method, params });
      if (method === `workflowDrafts.${operation}`)
        return {
          ok: false,
          error: {
            code: "CONFIG_STALE",
            message: "The workflow file changed since this draft was taken; it cannot be published.",
          },
        };
      return original(method, params);
    };
    // In the publish case the review already exists when another window changes the file.
    if (operation === "publish") {
      fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
      await screen.findByRole("button", { name: "Publish v2" });
    }
    fake.script({ "workflows.get": () => definition() });
    await act(async () => fake.notify(changed()));
    expect(screen.getByText("ai-sdlc v2")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Workflow draft" }).textContent).toContain("Draft of ai-sdlc v1");
    fireEvent.click(screen.getByRole("button", { name: operation === "review" ? "Review and publish" : "Publish v2" }));
    await screen.findByText(/Reloaded: The workflow file changed/);
    expect(calls.filter((call) => call.method === `workflowDrafts.${operation}`)).toEqual([
      {
        method: `workflowDrafts.${operation}`,
        params: {
          workflowId: "ai-sdlc",
          expectedRevision: 1,
          ...(operation === "publish" ? { reviewToken: "token-1" } : {}),
        },
      },
    ]);
    expect(calls.filter((call) => call.method === "workflowDrafts.get")).toHaveLength(1);
    expect(drafts.calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);
    expect(screen.getByRole("group", { name: "Workflow draft" })).toBeTruthy();
  },
);

it("still gates editing on the initial definition read", async () => {
  const { fake, drafts, h } = setup("orca://workflow/ai-sdlc?edit");
  fake.fail("workflows.get", { code: "AUTH_FORBIDDEN", message: "Read refused." });
  renderChrome(h);
  await screen.findByText("Could not load the workflow");
  expect(drafts.calls.some((call) => call.method === "workflowDrafts.open")).toBe(false);
  expect(screen.queryByRole("group", { name: "Workflow draft" })).toBeNull();
});

it("retains the draft's in-flight write queue and revision ownership across a refresh", async () => {
  const { fake, drafts, h } = setup();
  renderChrome(h);
  const input = await edit();
  const bridge = fake.bridge.workflowDrafts!;
  const original = bridge.call.bind(bridge);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let first = true;
  bridge.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "workflowDrafts.apply" && first) {
      first = false;
      await held;
    }
    return result;
  };
  fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
  await waitFor(() => expect(drafts.ops()).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
  fake.script({ "workflows.get": () => definition() });
  await act(async () => fake.notify(changed()));
  kept(input);
  expect(drafts.ops()).toHaveLength(1);
  await act(async () => finish());
  await waitFor(() => expect(drafts.ops()).toHaveLength(2));
  expect(
    drafts.calls.filter((call) => call.method === "workflowDrafts.apply").map((call) => call.params.expectedRevision),
  ).toEqual([0, 1]);
  expect(drafts.calls.filter((call) => call.method === "workflowDrafts.open")).toHaveLength(1);
  expect(input.isConnected).toBe(true);
  expect(input.value).toBe("Still typing this prompt");
});
