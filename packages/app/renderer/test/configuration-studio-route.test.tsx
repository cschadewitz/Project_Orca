// @vitest-environment happy-dom
/** Config navigation uses the merged controls and exact validated bytes, with separate Save and Apply. */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { THEMES } from "@orca/design";
import type { ConfigGetResult, ConfigSetParams } from "@orca/protocol";
import type { OrcaBridge } from "../../src/bridge.js";
import type { DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import { ConfigProvider } from "../src/config/config-context.js";
import { ConfigSurface } from "../src/config/config-surface.js";
import { fakeBridge } from "./fake-bridge.js";
import { CONFIG_GET, CONFIG_TEXT } from "./fixtures-config.js";
import { AS_OF } from "./fixtures.js";
import { harness } from "./harness.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";

const cleanupFns: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (cleanupFns.length) cleanupFns.pop()?.();
});
const meta = { acceptsAbsent: true, acceptsNull: false, visibility: "non-secret", default: { state: "none" } } as const;
function setup({ metadata = true, writable = true, deferIdentity = false } = {}) {
  const fake = fakeBridge();
  const bridge: OrcaBridge = fake.bridge;
  let target: DaemonTargetSnapshot = {
    epoch: 1,
    url: "http://localhost:7331",
    source: "bundled",
    environmentOverride: false,
    ...(!deferIdentity ? { identity: { workspaceId: "workspace", instanceId: "daemon" } } : {}),
  };
  const targets = new Set<(value: DaemonTargetSnapshot) => void>();
  bridge.daemonConnection = {
    read: () => target,
    subscribe: (fn) => {
      targets.add(fn);
      return () => targets.delete(fn);
    },
    show: () => {},
    onShow: () => () => {},
    connect: async () => ({ ok: true }),
    cancel: () => {},
    activate: () => {},
  };
  const schema: NonNullable<ConfigGetResult["formSchema"]> = {
    version: 1,
    root: {
      ...meta,
      kind: "object",
      acceptsAbsent: false,
      fields: {
        agents: {
          ...meta,
          kind: "array",
          item: {
            ...meta,
            kind: "object",
            fields: {
              command: { ...meta, kind: "scalar", field: { path: "agents[].command", type: "string", required: true } },
              env: {
                ...meta,
                visibility: "withheld",
                kind: "record",
                value: { ...meta, kind: "scalar", field: { path: "agents[].env", type: "string", required: false } },
              },
            },
          },
        },
      },
    },
  };
  let data: ConfigGetResult = {
    ...structuredClone(CONFIG_GET),
    ...(metadata ? { formSchema: schema } : {}),
    generation: {
      savedRevision: CONFIG_GET.config.revision,
      activeRevision: CONFIG_GET.config.revision,
      activeGeneration: "generation-1",
      state: "active",
      restartRequired: [],
    },
  };
  data.config.parsed = {
    agents: [{ id: "claude", command: "claude-code", roles: ["developer"], env: { TOKEN: "private-form-secret" } }],
  };
  const writes: ConfigSetParams[] = [];
  let applyCount = 0;
  fake.connect({
    ...fake.connection,
    methods: writable ? ["config.get", "config.set", "config.apply"] : ["config.get"],
  });
  fake.script({
    "config.get": () => ({ ok: true, result: structuredClone(data) }),
    "config.set": (params) => {
      writes.push(params);
      const last = params.edits?.at(-1);
      const text =
        params.text ??
        CONFIG_TEXT.replace(
          "command: claude-code",
          `command: ${String(last?.kind === "set" ? last.value : "claude-code")}`,
        );
      const document = {
        ...data.config,
        revision: "reviewed-revision",
        text,
        parsed: { agents: [{ id: "claude", command: "new-command", roles: ["developer"] }] },
      };
      if (params.validateOnly)
        return { ok: true, result: { document, written: false, validation: { errors: [] }, asOf: AS_OF } };
      data = {
        ...data,
        config: document,
        generation: { ...data.generation!, savedRevision: document.revision, state: "pending" },
      };
      return { ok: true, result: { document, written: true, generation: data.generation!, asOf: AS_OF } };
    },
  });
  bridge.config.apply = async (params) => {
    applyCount++;
    expect(params).toEqual({ expectedRevision: "reviewed-revision", expectedGeneration: "generation-1" });
    data = {
      ...data,
      generation: {
        ...data.generation!,
        activeRevision: "reviewed-revision",
        activeGeneration: "generation-2",
        state: "active",
      },
    };
    return { ok: true, result: { outcome: "applied", status: data.generation!, validation: { errors: [] } } };
  };
  cleanupFns.push(fake.install());
  const h = harness("darwin", bridge.preferences);
  cleanupFns.push(h.dispose);
  function Navigation() {
    const [config, setConfig] = useState(true);
    return (
      <>
        <button onClick={() => setConfig((v) => !v)}>{config ? "Go to Runs" : "Back to Config"}</button>
        {config ? <ConfigSurface connection="live" /> : <p>Runs surface</p>}
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
  return {
    fake,
    writes,
    applies: () => applyCount,
    resolveIdentity: () => {
      target = { ...target, identity: { workspaceId: "workspace", instanceId: "daemon" } };
      for (const listener of targets) listener(target);
    },
  };
}
const command = () => screen.getByLabelText<HTMLInputElement>(/^commandagents\[0\]\.command/);

describe.each(THEMES)("wired configuration route in %s", (theme) => {
  it("reviews then saves the daemon's bytes and offers explicit activation", async () => {
    installDesignSystem();
    setup();
    setTheme(theme);
    await screen.findByRole("group", { name: "Configuration" });
    expect(resolved(command(), "border-top-color")).toBe(expectedToken(theme, "border-control"));
    expect(document.body.textContent).not.toContain("private-form-secret");
    fireEvent.change(command(), { target: { value: "new-command" } });
    const save = screen.getByRole("button", { name: "Save reviewed changes" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
    await screen.findByText("Review configuration changes");
    expect(screen.queryByLabelText("Reviewed configuration candidate")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review private YAML" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Reviewed configuration candidate").value).toContain(
      "# The agent that does the work",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed changes" }));
    await screen.findByRole("button", { name: "Apply saved configuration" });
    expect(screen.getByText(/Saved source state: pending/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply saved configuration" }));
    await screen.findByText("Apply outcome: applied.");
    expect(screen.getByText(/Saved source state: active/)).toBeTruthy();
  });
});
it("keeps the draft across surface navigation and asks before replacing it with Raw", async () => {
  const f = setup();
  await screen.findByRole("group", { name: "Configuration" });
  fireEvent.change(command(), { target: { value: "retained-command" } });
  fireEvent.click(screen.getByRole("button", { name: "Go to Runs" }));
  expect(screen.queryByRole("group", { name: "Configuration" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to Config" }));
  expect(command().value).toBe("retained-command");
  expect(f.fake.calls.filter((c) => c.method === "config.get")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));
  expect(screen.getByRole("region", { name: "Replace configuration draft" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(command().value).toBe("retained-command");
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard draft and switch" }));
  expect(screen.getByLabelText<HTMLTextAreaElement>("orca.config.yaml").value).toBe(CONFIG_TEXT);
  expect(f.writes).toHaveLength(0);
});
it("shows structured metadata absence honestly and keeps raw writes authority-gated", async () => {
  const f = setup({ metadata: false, writable: false });
  await screen.findByText("Structured metadata unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));
  expect(screen.getByLabelText<HTMLTextAreaElement>("orca.config.yaml").readOnly).toBe(true);
  expect(f.writes).toHaveLength(0);
});
it("keeps the independent permission sidecar current without replacing a config draft", async () => {
  const f = setup();
  await screen.findByRole("group", { name: "Configuration" });
  fireEvent.change(command(), { target: { value: "retained-command" } });
  f.fake.script({
    "config.get": () => ({
      ok: true,
      result: {
        ...CONFIG_GET,
        permissions: { ...CONFIG_GET.permissions, revision: "sidecar-new", text: "new sidecar bytes" },
      },
    }),
  });
  act(() =>
    f.fake.notify({
      kind: "notification",
      method: "config.changed",
      params: {
        subscriptionId: "sub-1",
        document: "permissions",
        revision: "sidecar-new",
        path: CONFIG_GET.permissions.path,
        at: AS_OF,
      },
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLTextAreaElement>("orca.permissions.json").value).toBe("new sidecar bytes"),
  );
  expect(command().value).toBe("retained-command");
  expect(f.writes).toHaveLength(0);
});
it("rereads when the initial authoritative identity arrives, instead of mounting unbound values", async () => {
  const f = setup({ deferIdentity: true });
  await screen.findByText("Waiting for an authoritative daemon target");
  f.resolveIdentity();
  await screen.findByRole("group", { name: "Configuration" });
  await waitFor(() => expect(f.fake.calls.filter((c) => c.method === "config.get")).toHaveLength(2));
});
