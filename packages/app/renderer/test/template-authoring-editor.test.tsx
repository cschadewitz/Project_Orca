// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TemplateAuthoringEditor } from "../src/template-authoring/editor.js";
import { TemplateAuthoringController } from "../src/template-authoring/controller.js";
import type { AuthoringPorts, AuthoringSnapshot } from "../src/template-authoring/model.js";
import { CommandPalette } from "../src/palette/command-palette.js";
import { useCommandPalette } from "../src/palette/use-command-palette.js";
import { harness, stubMatchMedia } from "./harness.js";

const source = "---\nid: sdlc/review # comment\nrequires: [spec]\ncustom: preserved\n---\nReview the spec\n";
const base: AuthoringSnapshot = {
  target: { workspaceId: "workspace", instanceId: "boot", epoch: 1 },
  revision: "r1",
  generation: "g1",
  assets: [
    {
      key: "review",
      id: "sdlc/review",
      version: "1",
      requires: ["spec"],
      partials: [],
      usedBy: ["ai-sdlc::review"],
      source: { state: "available", text: source },
    },
  ],
};
const disposers: (() => void)[] = [];

function PaletteHost() {
  return <CommandPalette controller={useCommandPalette()} />;
}

function mount(overrides: Partial<AuthoringPorts> = {}, snapshot = base, withPublication = true) {
  stubMatchMedia(1440);
  const h = harness();
  disposers.push(h.dispose);
  const publish = vi.fn<NonNullable<AuthoringPorts["publish"]>>(async () => ({
    status: "saved" as const,
    candidateRevision: "candidate",
    snapshot: { ...snapshot, revision: "r2" },
  }));
  const preview = vi.fn<AuthoringPorts["preview"]>(async (_candidate, id) => ({
    requestedId: id,
    resolvedId: id,
    fallback: true,
    partialIds: ["partials/context"],
    text: "Fixture prompt",
  }));
  const ports: AuthoringPorts = {
    read: async () => snapshot,
    validate: async () => ({
      candidateRevision: "candidate",
      errors: [],
      compatibility: "compatible",
      changes: ["Review body changed"],
    }),
    preview,
    ...(withPublication ? { publish } : {}),
    ...overrides,
  };
  const controller = new TemplateAuthoringController(snapshot, ports);
  const onExport = vi.fn();
  const result = render(
    <h.Providers>
      <TemplateAuthoringEditor controller={controller} onExport={onExport} />
      <PaletteHost />
    </h.Providers>,
  );
  return { controller, publish, preview, onExport, ...result };
}

afterEach(() => {
  cleanup();
  while (disposers.length) disposers.pop()?.();
});

const sourceControl = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: /Template source/ });

async function paletteCommand(label: string) {
  sourceControl().focus();
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
  const query = await screen.findByRole("combobox", { name: "Command palette" });
  fireEvent.change(query, { target: { value: label } });
  await screen.findByRole("option", { name: new RegExp(label) });
  fireEvent.keyDown(query, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
}

describe("template authoring editor", () => {
  it("creates and previews an editable variant before publication with the same fixture inputs", async () => {
    const { preview, publish } = mount({
      variant: async () => ({ key: "house-review", text: source.replace("sdlc/review", "house/sdlc/review") }),
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Pack/ }), { target: { value: "house" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pack variant" }));
    await screen.findByRole("option", { name: "house-review (draft variant)" });
    fireEvent.change(screen.getByRole("combobox", { name: /^Template/ }), { target: { value: "house-review" } });
    expect(sourceControl().value).toContain("house/sdlc/review # comment");
    fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(preview.mock.calls[0]?.[1]).toBe("house/sdlc/review");
    expect(preview.mock.calls[0]?.[2]).toBeUndefined();
    expect(preview.mock.calls[0]?.[3]).toEqual({ values: {}, artifacts: {} });
    expect(publish).not.toHaveBeenCalled();
  });
  it("uses labelled native controls and preserves source through explicit import/export", () => {
    const { onExport } = mount();
    expect(sourceControl().value).toBe(source);
    fireEvent.change(screen.getByRole("textbox", { name: /Import source/ }), { target: { value: source + "Extra\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Import into draft" }));
    expect(sourceControl().value).toBe(source + "Extra\n");
    fireEvent.click(screen.getByRole("button", { name: "Export source" }));
    expect(onExport).toHaveBeenCalledWith("review", source + "Extra\n");
  });

  it("shows fixture-only preview fallback and exact partial resolution with identical inputs", async () => {
    const { preview } = mount();
    const fixture = { values: { workItem: { title: "Sample" } }, artifacts: { spec: "A synthetic spec" } };
    fireEvent.change(screen.getByRole("textbox", { name: /Preview fixtures/ }), {
      target: { value: JSON.stringify(fixture) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
    await screen.findByLabelText("Rendered prompt");
    fireEvent.change(screen.getByRole("textbox", { name: /^Pack/ }), { target: { value: "strict" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(preview.mock.calls[0]?.[3]).toEqual(fixture);
    expect(preview.mock.calls[1]?.[3]).toEqual(fixture);
    expect(preview.mock.calls[1]?.[2]).toBe("strict");
    expect(screen.getByText(/Rendered sdlc\/review \(base fallback\).*partials\/context/)).toBeTruthy();
  });

  it("blocks malformed artifact fixtures and links errors to the fixture control", () => {
    const { preview } = mount();
    fireEvent.change(screen.getByRole("textbox", { name: /Preview fixtures/ }), {
      target: { value: '{"values":{},"artifacts":{"spec":123}}' },
    });
    expect(screen.getByRole("textbox", { name: /Preview fixtures/ }).getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
    expect(preview).not.toHaveBeenCalled();
  });

  it("validates, saves and cancels through the existing keyboard palette with focus restored", async () => {
    const { publish } = mount();
    sourceControl().focus();
    fireEvent.change(sourceControl(), { target: { value: source + "Edited via keyboard input\n" } });
    await paletteCommand("Validate template draft");
    await screen.findByText("Review body changed");
    expect(document.activeElement).toBe(sourceControl());
    await paletteCommand("Publish reviewed template revision");
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Revision saved. Apply is a separate/)).toBeTruthy();
    fireEvent.change(sourceControl(), { target: { value: "Another draft" } });
    await paletteCommand("Cancel template edits");
    expect(sourceControl().value).toBe(source);
    expect(document.activeElement).toBe(sourceControl());
  });

  it("shows authoritative malformed front matter/reference errors and refuses publication", async () => {
    const { publish } = mount({
      validate: async () => ({
        candidateRevision: "candidate",
        compatibility: "compatible",
        changes: [],
        errors: [
          { key: "review", code: "front-matter", message: "Front matter must be a mapping" },
          { key: "review", code: "reference", message: "Missing exact-ID partial: context" },
        ],
      }),
    });
    fireEvent.change(sourceControl(), { target: { value: "invalid draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
    await screen.findByText(/Front matter must be a mapping/);
    expect(screen.getByText(/Missing exact-ID partial: context/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish revision" }));
    expect(publish).not.toHaveBeenCalled();
    expect(sourceControl().value).toBe("invalid draft");
  });

  it("freezes a changed-target draft and retains it on refresh", async () => {
    const { controller } = mount();
    fireEvent.change(sourceControl(), { target: { value: "retained draft" } });
    act(() => controller.observe({ ...base, target: { ...base.target, instanceId: "new-boot" } }));
    expect(sourceControl().readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved state" }));
    await waitFor(() => expect(screen.getByText(/Reconcile this draft before publishing/)).toBeTruthy());
    expect(sourceControl().value).toBe("retained draft");
  });

  it("keeps protected source out of controls and export", () => {
    const { onExport } = mount({}, { ...base, assets: [{ ...base.assets[0]!, source: { state: "withheld" } }] });
    expect(sourceControl().readOnly).toBe(true);
    expect(sourceControl().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Export source" }));
    expect(onExport).not.toHaveBeenCalled();
    expect(screen.getByText(/Source is unavailable or protected/)).toBeTruthy();
  });

  it.each(["light", "dark"])(
    "renders in the %s theme with accessible disabled publication and no rival live region",
    (theme) => {
      document.documentElement.dataset.theme = theme;
      const { ports } = new TemplateAuthoringController(base, {
        read: async () => base,
        validate: async () => ({
          candidateRevision: "candidate",
          errors: [],
          compatibility: "unavailable",
          changes: [],
        }),
        preview: async () => ({
          requestedId: "sdlc/review",
          resolvedId: "sdlc/review",
          fallback: false,
          partialIds: [],
          text: "fixture",
        }),
      });
      const { container } = mount(ports, base, false);
      expect(screen.getByRole("button", { name: "Publish revision" }).getAttribute("aria-disabled")).toBe("true");
      expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
      expect(screen.getByRole("textbox", { name: /Template source/ }).getAttribute("aria-describedby")).toBeTruthy();
      delete document.documentElement.dataset.theme;
    },
  );
});
