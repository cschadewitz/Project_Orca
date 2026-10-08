// @vitest-environment happy-dom
/** Guided launch accessibility, keyboard selections, typed values and safe recovery results. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GuidedLaunchController } from "../src/guided-launch/controller.js";
import { GuidedLaunch } from "../src/guided-launch/guided-launch.js";
import { useEscapeClosesTopLayer } from "../src/layers-context.js";
import { harness } from "./harness.js";
import { installDesignSystem, installSurfaceStyles, setTheme } from "./themes.js";
import { launchContext, launchDraft, launchPorts } from "./guided-launch-fixtures.js";

const teardown: (() => void)[] = [];
function Escape(): null {
  useEscapeClosesTopLayer();
  return null;
}
function mount(context = launchContext(), ports = launchPorts(), draft = launchDraft()) {
  const h = harness();
  teardown.push(h.dispose);
  const controller = new GuidedLaunchController(context, draft, ports);
  const onClose = vi.fn();
  const onConfiguration = vi.fn();
  const onConnections = vi.fn();
  render(
    <h.Providers>
      <Escape />
      <GuidedLaunch
        controller={controller}
        onClose={onClose}
        onConfiguration={onConfiguration}
        onConnections={onConnections}
      />
    </h.Providers>,
  );
  return { controller, ports, onClose, onConfiguration, onConnections };
}
afterEach(() => {
  cleanup();
  setTheme(undefined);
  while (teardown.length) teardown.pop()?.();
});
const press = (key: string) => fireEvent.keyDown(document.activeElement ?? window, { key, code: key });

describe("guided launch workspace", () => {
  it("maps authorized Request choices to roles, singular model and supported override fields", async () => {
    const h = harness();
    teardown.push(h.dispose);
    const ports = launchPorts();
    const controller = new GuidedLaunchController(launchContext(), { ...launchDraft(), mode: "request" }, ports);
    render(
      <h.Providers>
        <GuidedLaunch
          controller={controller}
          onClose={() => {}}
          onConfiguration={() => {}}
          onConnections={() => {}}
          overrideChoices={{
            roles: [{ id: "build", agents: [{ id: "agent-1", label: "Configured agent" }] }],
            models: [{ agentId: "agent-1", choices: [{ id: "model-1", label: "Configured model" }] }],
            itemWorkflows: [{ id: "item-1", label: "Configured item workflow" }],
            templatePacks: [{ id: "pack-1", label: "Configured pack" }],
            provenance: ["Authorized selection projection"],
          }}
        />
      </h.Providers>,
    );
    for (const label of ["Agent for build", "Model for agent-1", "Item workflow", "Template pack"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      press("ArrowDown");
      press("Enter");
    }
    expect(controller.read().draft.overrides).toEqual({
      roles: { build: "agent-1" },
      model: { "agent-1": "model-1" },
      itemWorkflow: "item-1",
      templatePack: "pack-1",
    });
    await act(() => controller.preview());
    expect(ports.preflight.mock.calls[0]![0].overrides).toEqual(controller.read().draft.overrides);
    fireEvent.click(screen.getByRole("button", { name: "Model for agent-1" }));
    press("Enter");
    expect(controller.read().draft.overrides?.model).toBeUndefined();
  });
  it("switches modes by keyboard, restores focus and separates Request fields", () => {
    const { controller } = mount();
    const trigger = screen.getByRole("button", { name: "Launch mode" });
    fireEvent.click(trigger);
    press("ArrowDown");
    press("Enter");
    expect(controller.read().draft.mode).toBe("request");
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByLabelText("Request title", { exact: false })).toBeDefined();
    expect(screen.getByLabelText("Request body", { exact: false })).toBeDefined();
    fireEvent.click(trigger);
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("omits defaults and sends typed false/zero without coercion", async () => {
    const { controller, ports } = mount();
    fireEvent.change(screen.getByLabelText(/^count/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/^enabled/), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview launch" }));
    await waitFor(() => expect(controller.read().phase).toBe("review"));
    expect(ports.preflight.mock.calls[0]![0].vars).toEqual({ task: "Make a small change", count: 0, enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(controller.read().phase).toBe("admitted"));
    expect(screen.getByText(/Admission admission-original/).textContent).toContain("run-original");
  });
  it("invalid typed text disables preview with described errors and removes stale values", () => {
    const { controller, ports } = mount();
    const count = screen.getByLabelText(/^count/);
    fireEvent.change(count, { target: { value: "4" } });
    fireEvent.change(count, { target: { value: "invalid" } });
    expect(count.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(count.getAttribute("aria-describedby")!.split(" ").at(-1)!)!.textContent).toContain(
      "valid JSON",
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview launch" }));
    expect(ports.preflight).not.toHaveBeenCalled();
    expect(controller.read().draft.vars.count).toBeUndefined();
  });
  it("withholds sensitive values from preview and uses password input", async () => {
    const { controller } = mount();
    const token = screen.getByLabelText(/^token/);
    expect(token.getAttribute("type")).toBe("password");
    fireEvent.change(token, { target: { value: "sensitive-text-never-previewed" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview launch" }));
    await waitFor(() => expect(controller.read().phase).toBe("review"));
    expect(screen.getByText("token: Withheld")).toBeDefined();
    expect(document.body.textContent).not.toContain("sensitive-text-never-previewed");
  });
  it("keeps lost acknowledgement visible and recovery uses the original handle", async () => {
    const ports = launchPorts();
    ports.submit.mockRejectedValue(new Error("lost"));
    const { controller } = mount(launchContext(), ports);
    fireEvent.click(screen.getByRole("button", { name: "Preview launch" }));
    await waitFor(() => expect(controller.read().phase).toBe("review"));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(screen.getByText(/acknowledgement is unavailable/)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Recover original launch" }));
    await waitFor(() => expect(controller.read().phase).toBe("admitted"));
    expect(ports.retain).toHaveBeenCalledTimes(1);
    expect(ports.recover).toHaveBeenCalledWith({ id: "protected-intent-1" });
  });
  it("makes current capability limits reachable on controls and adds no competing live region", () => {
    const { ports } = mount({ ...launchContext(), directReason: "Connection is read-only" });
    const preview = screen.getByRole("button", { name: "Preview launch" });
    expect(preview.getAttribute("aria-disabled")).toBe("true");
    expect(preview.getAttribute("title")).toBe("Connection is read-only");
    fireEvent.click(preview);
    expect(ports.preflight).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[aria-live]").length).toBe(0);
  });
  it("requires explicit target review and invalidates preview on target change", async () => {
    const { controller, ports } = mount();
    await act(() => controller.preview());
    const changed = launchContext();
    changed.target.endpointId = "other-target";
    act(() => controller.contextChanged(changed));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(ports.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review target" }));
    expect(controller.read().draftTarget.endpointId).toBe("other-target");
    expect(controller.read().draft.vars).toEqual(launchDraft().vars);
  });
  it("closing unsent work does not admit anything and settings links use injected navigation", () => {
    const { onClose, onConfiguration, onConnections, ports } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfiguration).toHaveBeenCalledTimes(1);
    expect(onConnections).toHaveBeenCalledTimes(1);
    expect(ports.submit).not.toHaveBeenCalled();
    expect(ports.retain).not.toHaveBeenCalled();
  });
  it.each(["light", "dark"] as const)("declares a bounded scrolling root in %s theme", (theme) => {
    installDesignSystem();
    installSurfaceStyles();
    setTheme(theme);
    mount();
    const root = screen.getByRole("region", { name: "Guided launch" });
    expect(getComputedStyle(root).overflowY).toBe("auto");
    expect(Number.parseFloat(getComputedStyle(root).minHeight)).toBe(0);
  });
});
