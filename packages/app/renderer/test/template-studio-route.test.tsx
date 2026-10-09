// @vitest-environment happy-dom
/** Production mounting retains drafts, fences current source authority and keeps Save separate from Apply. */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TemplateCatalog, ConfigGetResult } from "@orca/protocol";
import type { TemplateBridge } from "../../src/template-bridge.js";
import { ConfigProvider } from "../src/config/config-context.js";
import { ConfigSurface } from "../src/config/config-surface.js";
import { fakeBridge } from "./fake-bridge.js";
import { CONFIG_GET } from "./fixtures-config.js";
import { harness, stubMatchMedia } from "./harness.js";
import { setTheme } from "./themes.js";
const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (disposers.length) disposers.pop()?.();
});
const source = "---\nid: sdlc/review # preserved\nrequires: [spec]\n---\nReview {{artifacts.spec.content}}\n";
function mount(holdSave = false, falseAssignment = false, errors: TemplateCatalog["errors"] = [], readOnly = false) {
  stubMatchMedia(1440);
  const fake = fakeBridge();
  const target = { workspaceId: "workspace", instanceId: "daemon" };
  fake.bridge.daemonConnection = {
    read: () => ({
      epoch: 1,
      identity: target,
      url: "http://localhost:7001",
      source: "bundled",
      environmentOverride: false,
    }),
    subscribe: () => () => {},
    show: () => {},
    onShow: () => () => {},
    connect: async () => ({ ok: true }),
    cancel: () => {},
    activate: () => {},
  };
  const methods = [
    "config.get",
    "config.set",
    "config.apply",
    "templates.get",
    "templates.validate",
    "templates.preview",
    "templates.save",
    "templates.publish",
    "templates.assign",
    "templates.history",
  ];
  fake.connect({
    ...fake.connection,
    methods: readOnly
      ? methods.filter((method) =>
          ["config.get", "templates.get", "templates.preview", "templates.history"].includes(method),
        )
      : methods,
  });
  const data: ConfigGetResult = {
    ...CONFIG_GET,
    generation: {
      savedRevision: CONFIG_GET.config.revision,
      activeRevision: CONFIG_GET.config.revision,
      activeGeneration: "generation-1",
      state: "active",
      restartRequired: [],
    },
  };
  fake.script({ "config.get": () => ({ ok: true, result: data }) });
  let catalog: TemplateCatalog = {
    target,
    catalogRevision: "catalog-1",
    contextRevision: "context-1",
    configRevision: data.config.revision,
    generation: "generation-1",
    assets: [
      {
        key: "review",
        id: "sdlc/review",
        version: "1",
        revision: "source-1",
        requires: ["spec"],
        partials: [],
        usedBy: [],
        source: { state: "available", text: source },
      },
    ],
    assignments: [
      {
        key: "workflow:review",
        workflowId: "review-work",
        nodeId: "review",
        revision: "workflow-1",
        templateId: "sdlc/review",
      },
    ],
    workflows: [{ id: "review-work", version: "1" }],
    errors,
  };
  const calls: { method: string; params: unknown }[] = [];
  let release: (() => void) | undefined;
  let denyReads = false;
  fake.bridge.templates = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "templates.get")
        return denyReads
          ? { ok: false, error: { code: "AUTH_FORBIDDEN", message: "Refused" } }
          : { ok: true, result: catalog };
      if (method === "templates.preview")
        return {
          ok: true,
          result: {
            requestedId: "sdlc/review",
            resolvedId: "sdlc/review",
            fallback: false,
            partialIds: [],
            text: "Fixture prompt from current catalog",
          },
        };
      if (method === "templates.validate")
        return {
          ok: true,
          result: {
            candidateRevision: "candidate-1",
            errors: [],
            compatibility: "compatible",
            changes: ["One source changed; values withheld."],
          },
        };
      if (method === "templates.save") {
        const candidate = (params as { candidate: { text: string } }).candidate;
        catalog = {
          ...catalog,
          catalogRevision: "catalog-2",
          assets: catalog.assets.map((asset) => ({
            ...asset,
            revision: "source-2",
            source: { state: "available", text: candidate.text },
          })),
        };
        // Real source changes use config.changed even when config-file revision stays unchanged.
        fake.notify({
          kind: "notification",
          method: "config.changed",
          params: {
            subscriptionId: "sub-1",
            document: "config",
            path: data.config.path,
            revision: data.config.revision,
            at: "2026-10-09T03:00:00Z",
            kind: "saved",
          },
        });
        if (holdSave)
          await new Promise<void>((done) => {
            release = done;
          });
        return { ok: true, result: { status: "saved", candidateRevision: "candidate-1", snapshot: catalog } };
      }
      if (method === "templates.publish") {
        const validateOnly = (params as { validateOnly?: boolean }).validateOnly;
        return {
          ok: true,
          result: {
            outcome: validateOnly ? "validated" : "applied",
            status: {
              savedRevision: data.config.revision,
              activeRevision: data.config.revision,
              activeGeneration: validateOnly ? catalog.generation : "generation-2",
              state: "active",
              restartRequired: [],
            },
            validation: { errors: [] },
          },
        };
      }
      if (method === "templates.assign") {
        const command = params as { validateOnly?: boolean; templateId: string; version: string };
        if (command.validateOnly || falseAssignment)
          return { ok: true, result: { written: false, candidateRevision: "assignment-2", snapshot: catalog } };
        catalog = {
          ...catalog,
          catalogRevision: "assigned-catalog",
          contextRevision: "assigned-context",
          assignments: catalog.assignments.map((choice) => ({
            ...choice,
            revision: "assignment-2",
            templateId: command.templateId,
          })),
          workflows: catalog.workflows.map((workflow) => ({ ...workflow, version: command.version })),
        };
        return { ok: true, result: { written: true, candidateRevision: "assignment-2", snapshot: catalog } };
      }
      throw new Error("Unexpected method");
    },
  } as TemplateBridge;
  disposers.push(fake.install());
  const h = harness();
  disposers.push(h.dispose);
  function Navigation() {
    const [config, show] = useState(true);
    return (
      <>
        <button onClick={() => show(!config)}>{config ? "Go to Runs" : "Back to Config"}</button>
        {config ? <ConfigSurface connection="live" /> : <p>Runs</p>}
      </>
    );
  }
  render(
    <h.Providers>
      <ConfigProvider>
        <Navigation />
      </ConfigProvider>
    </h.Providers>,
  );
  const withdraw = () => {
    denyReads = true;
    fake.connect({ ...fake.connection, methods: ["config.get"] });
  };
  const external = (changeGeneration = false) => {
    catalog = {
      ...catalog,
      catalogRevision: "external",
      ...(changeGeneration ? { generation: "generation-2" } : {}),
      assets: catalog.assets.map((asset) => ({
        ...asset,
        revision: "external-source",
        source: { state: "available", text: source + "External change\n" },
      })),
    };
    fake.notify({
      kind: "notification",
      method: "config.changed",
      params: {
        subscriptionId: "sub-1",
        document: "config",
        path: data.config.path,
        revision: data.config.revision,
        at: "2026-10-09T03:01:00Z",
        kind: "saved",
      },
    });
  };
  return { calls, withdraw, external, release: () => release?.() };
}
const edit = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Templates" }));
  const control = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: /^Template source/ });
  await waitFor(() => expect(control.value).toBe(source));
  fireEvent.change(control, { target: { value: source + "Retained instruction\n" } });
  return control;
};
it("refreshes clean read-only sources and previews using the current catalog revision and generation", async () => {
  const f = mount(false, false, [], true);
  fireEvent.click(await screen.findByRole("button", { name: "Templates" }));
  const control = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: /^Template source/ });
  await waitFor(() => expect(control.value).toBe(source));
  act(() => f.external(true));
  await waitFor(() => expect(control.value).toBe(source + "External change\n"));
  expect(control.readOnly).toBe(true);
  expect(screen.getByRole("button", { name: "Save reviewed source" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
  expect(await screen.findByLabelText("Rendered prompt")).toHaveProperty(
    "textContent",
    "Fixture prompt from current catalog",
  );
  expect(f.calls.find((call) => call.method === "templates.preview")?.params).toMatchObject({
    expectedCatalogRevision: "external",
    expectedConfigGeneration: "generation-2",
  });
});

it("renders authoritative saved catalog diagnostics through the production adapter", async () => {
  mount(false, false, [{ code: "compatibility", message: "Saved pack changes the base instruction contract." }]);
  fireEvent.click(await screen.findByRole("button", { name: "Templates" }));
  expect(await screen.findByText("Saved pack changes the base instruction contract.")).toBeTruthy();
});

for (const theme of ["light", "dark"] as const)
  describe(`template studio in ${theme}`, () => {
    it("mounts labelled controls, saves exact reviewed source, and requires separate Apply review", async () => {
      const f = mount();
      setTheme(theme);
      await edit();
      fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
      const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save reviewed source" });
      await waitFor(() => expect(save.getAttribute("aria-disabled")).not.toBe("true"));
      fireEvent.click(save);
      await waitFor(() => expect(screen.getByText("0 changed sources")).toBeTruthy());
      expect(f.calls.some((call) => call.method === "templates.publish")).toBe(false);
      const apply = screen.getByRole<HTMLButtonElement>("button", { name: "Apply reviewed template catalog" });
      expect(apply.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Review saved catalog for Apply" }));
      await waitFor(() => expect(apply.getAttribute("aria-disabled")).not.toBe("true"));
      fireEvent.click(apply);
      await waitFor(() => expect(screen.getByText("Apply outcome: applied.")).toBeTruthy());
      expect(f.calls.filter((call) => call.method === "templates.publish")).toHaveLength(2);
      expect(document.querySelectorAll("[aria-live]").length).toBe(0);
    });
  });
it("retains the template source through Config navigation and hides it when source authority is withdrawn", async () => {
  const f = mount();
  await edit();
  fireEvent.click(screen.getByRole("button", { name: "Go to Runs" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to Config" }));
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: /^Template source/ }).value).toContain(
    "Retained instruction",
  );
  act(() => f.withdraw());
  await waitFor(() =>
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: /^Template source/ }).value).toBe(""),
  );
  expect(screen.queryByText(/Retained instruction/)).toBeNull();
});
it("keeps an exact pending source echo alive until Save acknowledges", async () => {
  const f = mount(true);
  await edit();
  fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save reviewed source" });
  await waitFor(() => expect(save.getAttribute("aria-disabled")).not.toBe("true"));
  fireEvent.click(save);
  await waitFor(() => expect(f.calls.some((call) => call.method === "templates.save")).toBe(true));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText(/Reconcile this draft/)).toBeNull();
  await act(async () => {
    f.release();
  });
  await waitFor(() => expect(screen.getByText("0 changed sources")).toBeTruthy());
});
it("observes same-config-revision external source changes and offers explicit replacement reconciliation", async () => {
  const f = mount();
  await edit();
  act(() => f.external());
  await waitFor(() => expect(screen.getByText(/Review current sources and the retained replacement/)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Retain replacement text on current sources" }));
  await waitFor(() => expect(screen.getByText(/Retained source rebased explicitly/)).toBeTruthy());
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Save reviewed source" }).getAttribute("aria-disabled"),
  ).toBe("true");
});
it.each([false, true])(
  "reviews labelled node assignment and checks the Save receipt (false receipt: %s)",
  async (falseReceipt) => {
    const f = mount(false, falseReceipt);
    fireEvent.click(await screen.findByRole("button", { name: "Templates" }));
    fireEvent.change(await screen.findByRole("combobox", { name: /^Workflow node/ }), {
      target: { value: "workflow:review" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Instruction template/ }), {
      target: { value: "sdlc/review" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^New workflow version/ }), { target: { value: "2" } });
    const save = screen.getByRole("button", { name: "Save reviewed template assignment" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Review template assignment" }));
    await waitFor(() => expect(save.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(save);
    await screen.findByText(
      falseReceipt
        ? "Assignment refused or not acknowledged. Read current source and review again."
        : "Instruction assignment saved. Review and Apply the catalog separately.",
    );
    const assignments = f.calls.filter((call) => call.method === "templates.assign");
    expect(assignments).toHaveLength(2);
    expect(assignments[1]?.params).toMatchObject({
      candidateRevision: "assignment-2",
      templateId: "sdlc/review",
      version: "2",
      validateOnly: false,
    });
    expect(f.calls.some((call) => call.method === "templates.publish")).toBe(false);
  },
);
