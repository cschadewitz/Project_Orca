// @vitest-environment happy-dom
/** Regression tests for protected restore races and historical input confidentiality in the actual UI. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LaunchPorts } from "../src/guided-launch/contracts.js";
import { GuidedLaunchController } from "../src/guided-launch/controller.js";
import { GuidedLaunch } from "../src/guided-launch/guided-launch.js";
import { harness } from "./harness.js";
import { deferred, launchContext, launchDraft, launchPorts } from "./guided-launch-fixtures.js";

const disposers: (() => void)[] = [];
function mount(controller: GuidedLaunchController): void {
  const h = harness();
  disposers.push(h.dispose);
  render(
    <h.Providers>
      <GuidedLaunch controller={controller} onClose={() => {}} onConfiguration={() => {}} onConnections={() => {}} />
    </h.Providers>,
  );
}
afterEach(() => {
  cleanup();
  while (disposers.length) disposers.pop()?.();
});

describe("protected restore state and confidentiality", () => {
  it.each(["draft", "launch"] as const)(
    "keeps inputs intact on delayed %s read refusal, then accepts a real new edit",
    async (kind) => {
      const ports = launchPorts();
      const waiting = deferred<undefined>();
      const injected: LaunchPorts =
        kind === "draft"
          ? { ...ports, drafts: { save: async () => {}, load: () => waiting.promise } }
          : { ...ports, restore: () => waiting.promise };
      const controller = new GuidedLaunchController(launchContext(), launchDraft(), injected);
      mount(controller);
      await act(() => controller.preview());
      fireEvent.click(
        screen.getByRole("button", { name: kind === "draft" ? "Restore protected draft" : "Restore protected launch" }),
      );
      const task = screen.getByLabelText<HTMLInputElement>(/^task/);
      expect(task.disabled).toBe(true);
      expect(controller.read().busy).toBe(true);
      fireEvent.change(task, { target: { value: "Rejected while reading" } });
      await act(async () => {
        waiting.reject(new Error("Protected store unavailable"));
        await waiting.promise.catch(() => {});
      });
      expect(controller.read().busy).toBe(false);
      expect(task.disabled).toBe(false);
      expect(task.value).toBe(launchDraft().vars.task);
      expect(controller.read().review).toBeUndefined();
      fireEvent.change(task, { target: { value: "New task after refusal" } });
      expect(controller.read().draft.vars.task).toBe(task.value);
      await act(() => controller.preview());
      await act(() => controller.submit());
      expect(ports.retain.mock.calls[0]![0].command.params.vars?.task).toBe("New task after refusal");
    },
  );
  it.each(["draft", "launch"] as const)(
    "keeps the busy lock and fences stale %s restore after a target switch",
    async (kind) => {
      const ports = launchPorts();
      const savedDraft = { ...launchDraft(), vars: { task: "Old protected task" } };
      const original = new GuidedLaunchController(launchContext(), savedDraft, ports);
      await original.preview();
      const review = original.read().review!;
      const draftRead = deferred<typeof savedDraft>();
      const launchRead = deferred<{ review: typeof review; draft: typeof savedDraft; intent: { id: string } }>();
      const controller = new GuidedLaunchController(
        launchContext(),
        launchDraft(),
        kind === "draft"
          ? { ...ports, drafts: { save: async () => {}, load: () => draftRead.promise } }
          : { ...ports, restore: () => launchRead.promise },
      );
      mount(controller);
      fireEvent.click(
        screen.getByRole("button", { name: kind === "draft" ? "Restore protected draft" : "Restore protected launch" }),
      );
      const changed = launchContext();
      changed.target.endpointId = "other-target";
      act(() => controller.contextChanged(changed));
      const task = screen.getByLabelText<HTMLInputElement>(/^task/);
      expect(task.disabled).toBe(true);
      expect(controller.read().phase).toBe("blocked");
      fireEvent.change(task, { target: { value: "Unaccepted edit while target changes" } });
      await act(async () => {
        if (kind === "draft") {
          draftRead.resolve(savedDraft);
          await draftRead.promise;
        } else {
          launchRead.resolve({ review, draft: savedDraft, intent: { id: "old-intent" } });
          await launchRead.promise;
        }
      });
      expect(controller.read().draft).toEqual(launchDraft());
      expect(task.value).toBe(launchDraft().vars.task);
      expect(controller.read().intent).toBeUndefined();
      expect(controller.read().review).toBeUndefined();
      expect(controller.read().busy).toBe(false);
      expect(ports.submit).not.toHaveBeenCalled();
    },
  );
  it("does not replace an unresolved current atomic intent with a different restored launch", async () => {
    const ports = launchPorts();
    const original = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await original.preview();
    const oldReview = original.read().review!;
    const restore = vi
      .fn<NonNullable<LaunchPorts["restore"]>>()
      .mockResolvedValue({ review: oldReview, draft: launchDraft(), intent: { id: "older-other-intent" } });
    const controller = new GuidedLaunchController(
      launchContext(),
      { ...launchDraft(), vars: { task: "Current exact intent" } },
      {
        ...ports,
        restore,
        launch: async () => {
          throw new Error("Atomic acknowledgement lost");
        },
      },
    );
    mount(controller);
    await act(() => controller.preview());
    await act(() => controller.submit());
    const unresolved = controller.read().unresolvedReview;
    fireEvent.click(screen.getByRole("button", { name: "Restore protected launch" }));
    expect(restore).not.toHaveBeenCalled();
    expect(controller.read().unresolvedReview).toEqual(unresolved);
    expect(controller.read().draft.vars.task).toBe("Current exact intent");
    expect(controller.read().intent).toBeUndefined();
  });
  it("withholds unclassified protected draft values in a new preview", async () => {
    const current = launchContext();
    current.workflows[0]!.inputSchema!.fields.token = { type: "string", sensitive: false };
    const protectedDraft = { ...launchDraft(), vars: { task: "Restored task", token: "unclassified-protected-value" } };
    const controller = new GuidedLaunchController(current, launchDraft(), {
      ...launchPorts(),
      drafts: { save: async () => {}, load: async () => protectedDraft },
    });
    mount(controller);
    await act(() => controller.loadDraft());
    await act(() => controller.preview());
    expect(document.body.textContent).not.toContain("unclassified-protected-value");
    expect(screen.getByLabelText<HTMLInputElement>(/^token/).type).toBe("password");
    expect(screen.getByText("token: Withheld")).toBeDefined();
  });
  it("does not downgrade a sensitive in-session input when current declarations change", async () => {
    const ports = launchPorts();
    const controller = new GuidedLaunchController(
      launchContext(),
      { ...launchDraft(), vars: { task: "Current task", token: "existing-sensitive-value" } },
      ports,
    );
    mount(controller);
    await act(() => controller.preview());
    expect(Object.isFrozen(controller.read().review!.visibleInputs)).toBe(true);
    const changed = launchContext();
    changed.activeGeneration = "generation-2";
    changed.workflows[0]!.revision = "digest-2";
    changed.workflows[0]!.inputSchema!.fields.token = { type: "string", sensitive: false };
    act(() => controller.contextChanged(changed));
    expect(screen.getByLabelText<HTMLInputElement>(/^token/).type).toBe("password");
    ports.preflight.mockResolvedValue({
      target: changed.target,
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-2",
      expectedConfigGeneration: "generation-2",
      rootId: "disposable-root",
      rootRevision: "root-evidence-1",
      validation: { ok: true, errors: [], warnings: [] },
    });
    await act(() => controller.preview());
    expect(document.body.textContent).not.toContain("existing-sensitive-value");
    expect(screen.getByText("token: Withheld")).toBeDefined();
  });
  it.each(["draft", "launch"] as const)(
    "keeps visible task bound to the reviewed command during delayed empty %s restore",
    async (kind) => {
      const ports = launchPorts();
      const waiting = deferred<undefined>();
      const injected: LaunchPorts =
        kind === "draft"
          ? { ...ports, drafts: { save: async () => {}, load: () => waiting.promise } }
          : { ...ports, restore: () => waiting.promise };
      const controller = new GuidedLaunchController(launchContext(), launchDraft(), injected);
      mount(controller);
      await act(() => controller.preview());
      const task = screen.getByLabelText<HTMLInputElement>(/^task/);
      fireEvent.click(
        screen.getByRole("button", { name: kind === "draft" ? "Restore protected draft" : "Restore protected launch" }),
      );
      const wasDisabled = task.disabled;
      fireEvent.change(task, { target: { value: "Visible replacement task" } });
      await act(async () => {
        waiting.resolve(undefined);
        await waiting.promise;
      });
      expect(task.value).toBe(controller.read().draft.vars.task);
      expect(wasDisabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Launch" }));
      await act(() => Promise.resolve());
      expect(ports.retain.mock.calls[0]![0].command.params.vars?.task).toBe(task.value);
    },
  );
  it("does not render historical protected values through newer non-sensitive declarations", async () => {
    const context = launchContext();
    context.workflows[0]!.inputSchema!.fields.repo = {
      type: "object",
      properties: { credential: { type: "string", sensitive: true } },
    };
    const draft = {
      ...launchDraft(),
      vars: {
        task: "Original task",
        token: "historical-protected-token",
        repo: { credential: "historical-nested-secret" },
      },
    };
    const ports = launchPorts();
    const original = new GuidedLaunchController(context, draft, ports);
    await original.preview();
    const review = original.read().review!;
    const current = launchContext();
    current.target.epoch = 2;
    current.activeGeneration = "generation-2";
    current.workflows[0]!.revision = "digest-2";
    current.workflows[0]!.inputSchema!.fields.token = { type: "string", sensitive: false };
    current.workflows[0]!.inputSchema!.fields.repo = {
      type: "object",
      properties: { credential: { type: "string", sensitive: false } },
    };
    const controller = new GuidedLaunchController(current, launchDraft(), {
      ...ports,
      restore: async () => ({ review, draft, intent: { id: "historical-intent" } }),
    });
    mount(controller);
    await act(() => controller.restore());
    expect(document.body.textContent).not.toContain("historical-protected-token");
    expect(document.body.textContent).not.toContain("historical-nested-secret");
    expect(screen.getByLabelText<HTMLInputElement>(/^token/).type).toBe("password");
    expect(screen.getByLabelText<HTMLInputElement>(/^repo/).type).toBe("password");
    expect(screen.getByText("token: Withheld")).toBeDefined();
    expect(screen.getByText("repo: Withheld")).toBeDefined();
    await act(() => controller.recover());
    expect(ports.recover).toHaveBeenCalledWith({ id: "historical-intent" });
    expect(document.body.textContent).not.toContain("historical-protected-token");
    ports.preflight.mockResolvedValue({
      target: current.target,
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-2",
      expectedConfigGeneration: "generation-2",
      rootId: "disposable-root",
      rootRevision: "root-evidence-1",
      validation: { ok: true, errors: [], warnings: [] },
    });
    await act(() => controller.newWork());
    await act(() => controller.preview());
    expect(document.body.textContent).not.toContain("historical-protected-token");
    expect(document.body.textContent).not.toContain("historical-nested-secret");
    expect(screen.getByLabelText<HTMLInputElement>(/^token/).type).toBe("password");
  });
});
