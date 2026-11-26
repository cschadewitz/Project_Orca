// @vitest-environment happy-dom
/** Config navigation uses the merged controls and exact validated bytes, with separate Save and Apply. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { THEMES } from "@orca/design";
import type { ConfigGetResult, ConfigSetParams } from "@orca/protocol";
import type { OrcaBridge } from "../../src/bridge.js";
import type { FirstRunBridge, FirstRunStatus } from "../../src/first-run-contract.js";
import { FIRST_RUN_SAMPLE } from "../../src/first-run-sample.js";
import type { DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import { ConfigProvider } from "../src/config/config-context.js";
import { ConfigSurface } from "../src/config/config-surface.js";
import { fakeBridge } from "./fake-bridge.js";
import { CONFIG_GET, CONFIG_TEXT } from "./fixtures-config.js";
import { AS_OF } from "./fixtures.js";
import { harness, stubMatchMedia } from "./harness.js";
import { expectedToken, installDesignSystem, installSurfaceStyles, resolved, setTheme } from "./themes.js";

const cleanupFns: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (cleanupFns.length) cleanupFns.pop()?.();
});
const meta = { acceptsAbsent: true, acceptsNull: false, visibility: "non-secret", default: { state: "none" } } as const;
it("withholds current config source after read authority is withdrawn while retaining private edits", async () => {
  const f = setup();
  await screen.findByRole("group", { name: "Configuration" });
  fireEvent.change(command(), { target: { value: "private-retained-command" } });
  act(() => f.fake.connect({ ...f.fake.connection, methods: [] }));
  await screen.findByText("Configuration source withheld");
  expect(screen.queryByDisplayValue("private-retained-command")).toBeNull();
  expect(screen.queryByLabelText("orca.permissions.json")).toBeNull();
  act(() => f.fake.connect({ ...f.fake.connection, methods: ["config.get", "config.set", "config.apply"] }));
  await waitFor(() => expect(command().value).toBe("private-retained-command"));
  expect(f.writes).toHaveLength(0);
});
it("shows the judge's setup on the connected Config route, only from a daemon that lists judge.status (#701)", async () => {
  const f = setup();
  await screen.findByRole("group", { name: "Configuration" });
  expect(screen.queryByLabelText("Plain-language rule judge")).toBeNull();
  let reads = 0;
  f.fake.bridge.config.judgeStatus = async () => {
    reads++;
    return {
      ok: true,
      result: {
        active: false,
        enabled: false,
        config: { state: "none" },
        auth: "token",
        principal: "casey",
        grants: [],
        budget: { state: "uninitialized" },
      },
    };
  };
  act(() =>
    f.fake.connect({ ...f.fake.connection, methods: ["config.get", "config.set", "config.apply", "judge.status"] }),
  );
  const section = await screen.findByLabelText("Plain-language rule judge");
  await waitFor(() => expect(section.textContent).toContain("orca judge budget init"));
  expect(reads).toBeGreaterThan(0);
  // Another daemon: what was shown goes, and is read again for that one.
  const before = reads;
  act(() => f.changeTarget());
  await waitFor(() => expect(reads).toBeGreaterThan(before));
});
it("shows Remote daemons on the connected Config route, only from a daemon that lists remotes.list (#1206)", async () => {
  const f = setup();
  await screen.findByRole("group", { name: "Configuration" });
  expect(screen.queryByRole("region", { name: "Remote daemons" })).toBeNull();
  (f.fake.bridge as { remotes?: unknown }).remotes = {
    list: async () => ({ ok: true, result: { remotes: [], canIssue: true } }),
    enroll: async () => ({ ok: false, error: { code: "NOT_SUPPORTED", message: "unused" } }),
  };
  act(() =>
    f.fake.connect({
      ...f.fake.connection,
      methods: ["config.get", "config.set", "config.apply", "remotes.list", "remotes.enroll"],
    }),
  );
  const section = await screen.findByRole("region", { name: "Remote daemons" });
  await waitFor(() => expect(section.textContent).toContain("No remotes are configured"));
});
function setup({
  metadata = true,
  writable = true,
  deferIdentity = false,
  width = 1280,
  variant = false,
  firstRun,
  applyOutcome = "applied",
}: {
  metadata?: boolean;
  writable?: boolean;
  deferIdentity?: boolean;
  width?: number;
  variant?: boolean;
  firstRun?: FirstRunBridge;
  applyOutcome?: "applied" | "restart-required" | "invalid";
} = {}) {
  stubMatchMedia(width);
  const fake = fakeBridge();
  const bridge: OrcaBridge = fake.bridge;
  if (firstRun) Object.assign(bridge, { firstRun });
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
  if (variant && schema.root.kind === "object") {
    const agent = schema.root.fields.agents;
    if (agent?.kind !== "array") throw new Error("Expected agent array fixture.");
    const local = agent.item;
    if (local.kind !== "object") throw new Error("Expected local agent fixture.");
    agent.item = {
      ...meta,
      kind: "union",
      discriminator: "type",
      branches: {
        local,
        ssh: {
          ...meta,
          kind: "object",
          fields: {
            env: local.fields.env!,
            hostname: { ...meta, kind: "scalar", field: { path: "agents[].hostname", type: "string", required: true } },
          },
        },
      },
    };
  }
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
    agents: [
      {
        ...(variant ? { type: "local", extension: { nested: [false, 0, ""] } } : {}),
        id: "claude",
        command: "claude-code",
        roles: ["developer"],
        env: { TOKEN: "private-form-secret" },
      },
    ],
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
    if (applyOutcome !== "applied") {
      data = {
        ...data,
        generation: {
          ...data.generation!,
          state: applyOutcome,
          restartRequired: applyOutcome === "restart-required" ? ["agents"] : [],
        },
      };
      return {
        ok: true,
        result: {
          outcome: applyOutcome,
          status: data.generation!,
          validation: { errors: applyOutcome === "invalid" ? [{ path: "agents", message: "refused" }] : [] },
        },
      };
    }
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
    changeTarget: () => {
      target = {
        ...target,
        epoch: target.epoch + 1,
        identity: { workspaceId: "other-workspace", instanceId: "other-daemon" },
      };
      for (const listener of targets) listener(target);
    },
    applies: () => applyCount,
    resolveIdentity: () => {
      target = { ...target, identity: { workspaceId: "workspace", instanceId: "daemon" } };
      for (const listener of targets) listener(target);
    },
  };
}
const command = () => screen.getByLabelText<HTMLInputElement>(/^commandagents\[0\]\.command/);

describe.each(THEMES)("wired configuration route in %s", (theme) => {
  it("keeps a pending variant review across unrelated Studio rerenders", async () => {
    const f = setup({ variant: true });
    setTheme(theme);
    await screen.findByRole("group", { name: "Configuration" });
    fireEvent.change(command(), { target: { value: "draft-command" } });
    fireEvent.click(screen.getByRole("button", { name: "agents entry variant" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "ssh" }));
    expect(screen.getByRole("button", { name: "Confirm variant change" })).toBeTruthy();
    expect(f.writes).toHaveLength(0);
    // Same live connection: the provider rerenders and Studio.value recursively copies the draft.
    act(() => f.fake.connect({ ...f.fake.connection }));
    expect(screen.getByRole("button", { name: "Confirm variant change" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm variant change" }));
    expect(screen.queryByLabelText(/^commandagents/)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>(/^hostnameagents/).value).toBe("");
    expect(f.writes).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
    await waitFor(() => expect(f.writes.length).toBeGreaterThan(0));
    expect(f.writes[0]?.edits).toEqual([
      { kind: "set", path: ["agents", 0, "command"], value: "draft-command" },
      { kind: "remove", path: ["agents", 0, "command"] },
      { kind: "set", path: ["agents", 0, "type"], value: "ssh" },
    ]);
    expect(f.writes.every((write) => write.validateOnly)).toBe(true);
  });
  it("stacks narrow fields and wraps complete action labels", async () => {
    installDesignSystem();
    installSurfaceStyles();
    setup({ width: 600 });
    setTheme(theme);
    await screen.findByRole("group", { name: "Configuration" });
    expect(command().closest("[data-config-layout]")?.getAttribute("data-config-layout")).toBe("stacked");
    expect(resolved(command().closest(".orca-field")!, "grid-template-columns")).toBe("minmax(0, 1fr)");
    const action = screen.getByRole("button", { name: "Read current configuration" });
    expect(resolved(action, "white-space")).toBe("normal");
    expect(resolved(action, "overflow-wrap")).toBe("anywhere");
  });
  it("reviews then saves the daemon's bytes and offers explicit activation", async () => {
    installDesignSystem();
    setup();
    setTheme(theme);
    await screen.findByRole("group", { name: "Configuration" });
    expect(command().closest("[data-config-layout]")?.getAttribute("data-config-layout")).toBe("columns");
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
    // The status line follows the apply's reread, which can land a render after the outcome.
    expect(await screen.findByText(/Saved source state: active/)).toBeTruthy();
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

it.each(["navigation", "target", "read authority"])(
  "does not carry a pending variant confirmation across %s changes",
  async (change) => {
    const f = setup({ variant: true });
    await screen.findByRole("group", { name: "Configuration" });
    fireEvent.change(command(), { target: { value: "retained-command" } });
    fireEvent.click(screen.getByRole("button", { name: "agents entry variant" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "ssh" }));
    const confirm = screen.getByRole("button", { name: "Confirm variant change" });
    if (change === "navigation") {
      fireEvent.click(screen.getByRole("button", { name: "Go to Runs" }));
      fireEvent.click(screen.getByRole("button", { name: "Back to Config" }));
      expect(command().value).toBe("retained-command");
    } else if (change === "target") {
      act(() => f.changeTarget());
      await screen.findByText("Configuration source withheld");
    } else {
      act(() => f.fake.connect({ ...f.fake.connection, methods: [] }));
      await screen.findByText("Configuration source withheld");
      act(() => f.fake.connect({ ...f.fake.connection, methods: ["config.get", "config.set", "config.apply"] }));
      await waitFor(() => expect(command().value).toBe("retained-command"));
    }
    expect(screen.queryByRole("button", { name: "Confirm variant change" })).toBeNull();
    fireEvent.click(confirm);
    expect(f.writes).toHaveLength(0);
  },
);

describe("keeping the first-run workspace reopenable after a save (#1192)", () => {
  const unbound: FirstRunStatus = {
    state: "selection-required",
    reason: "The workspace's configuration was saved without being bound for reopening.",
    changedConfiguration: { workspace: "/workspace" },
  };
  function setupBridge(bind: () => ReturnType<NonNullable<FirstRunBridge["bindConfiguration"]>>, status = unbound) {
    return {
      status: vi.fn<FirstRunBridge["status"]>(async () => ({ ok: true, result: status })),
      choose: vi.fn<FirstRunBridge["choose"]>(),
      prepare: vi.fn<FirstRunBridge["prepare"]>(),
      connect: vi.fn<FirstRunBridge["connect"]>(),
      reviewConfiguration: vi.fn<NonNullable<FirstRunBridge["reviewConfiguration"]>>(async () => ({
        ok: true,
        result: {
          state: "configuration-review",
          review: { id: "review-1", revision: "reviewed-revision", agentCount: 1, checks: [] },
        },
      })),
      cancelConfigurationReview: vi.fn<NonNullable<FirstRunBridge["cancelConfigurationReview"]>>(),
      bindConfiguration: vi.fn<NonNullable<FirstRunBridge["bindConfiguration"]>>(bind),
    } satisfies FirstRunBridge;
  }
  const prepared: FirstRunStatus = {
    state: "prepared",
    project: "/project",
    workspace: "/workspace",
    sample: FIRST_RUN_SAMPLE,
  };
  async function saveThenApplyAtOnce() {
    await screen.findByRole("group", { name: "Configuration" });
    fireEvent.change(command(), { target: { value: "new-command" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
    await screen.findByText("Review configuration changes");
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed changes" }));
    // The person's very next act: Apply, with no wait for anything the save started.
    fireEvent.click(await screen.findByRole("button", { name: "Apply saved configuration" }));
  }

  it("keeps Apply available while the save is being bound, with no stale save tooltip (#1210)", async () => {
    let finish!: () => void;
    const firstRun = setupBridge(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, result: prepared });
        }),
    );
    setup({ firstRun });
    await screen.findByRole("group", { name: "Configuration" });
    fireEvent.change(command(), { target: { value: "new-command" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
    await screen.findByText("Review configuration changes");
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed changes" }));
    const apply = await screen.findByRole("button", { name: "Apply saved configuration" });
    await waitFor(() => expect(firstRun.bindConfiguration).toHaveBeenCalled());
    expect(document.querySelector('[data-reopen-binding="binding"]')).not.toBeNull();
    // Apply waits for the bind itself (#1192), so binding is not a reason to refuse the click.
    expect(apply.getAttribute("aria-disabled")).toBeNull();
    expect(apply.getAttribute("title")).toBeNull();
    await act(async () => finish());
  });

  it("holds Apply until a slow bind settles, then binds exactly the saved revision", async () => {
    let finish!: () => void;
    const firstRun = setupBridge(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, result: prepared });
        }),
    );
    const f = setup({ firstRun });
    await saveThenApplyAtOnce();
    await waitFor(() => expect(firstRun.bindConfiguration).toHaveBeenCalledWith("review-1"));
    expect(document.querySelector('[data-reopen-binding="binding"]')).not.toBeNull();
    expect(f.applies()).toBe(0);
    expect(screen.queryByText(/^Apply outcome/)).toBeNull();
    await act(async () => finish());
    await screen.findByText("Apply outcome: applied.");
    expect(f.applies()).toBe(1);
    expect(document.querySelector('[data-reopen-binding="bound"]')).not.toBeNull();
  });

  it("says a refused bind before any restart guidance, and still applies to the live daemon", async () => {
    const firstRun = setupBridge(async () => ({
      ok: false,
      error: { code: "FIRST_RUN_REFUSED", message: "The selected local workspace is no longer live." },
    }));
    const f = setup({ firstRun });
    await saveThenApplyAtOnce();
    await screen.findByText(/^Apply outcome: applied\. The saved configuration is not bound for reopening/);
    expect(f.applies()).toBe(1);
    const notice = document.querySelector('[data-reopen-binding="refused"]');
    expect(notice?.textContent).toContain("The selected local workspace is no longer live.");
    expect(notice?.textContent).toContain("Before quitting");
  });

  it("treats an unanswered setup status as unknown, not as nothing to bind", async () => {
    const firstRun = setupBridge(async () => ({ ok: true, result: prepared }));
    firstRun.status.mockResolvedValue({ ok: false, error: { code: "UNAVAILABLE", message: "Setup is busy." } });
    const f = setup({ firstRun });
    await saveThenApplyAtOnce();
    await screen.findByText(/not bound for reopening, so a restart will not open this workspace/);
    expect(f.applies()).toBe(1);
    expect(firstRun.bindConfiguration).not.toHaveBeenCalled();
    expect(document.querySelector('[data-reopen-binding="refused"]')?.textContent).toContain("Setup is busy.");
  });

  it("shows nothing and binds nothing for a workspace that is already bound", async () => {
    const firstRun = setupBridge(async () => ({ ok: true, result: prepared }), prepared);
    const f = setup({ firstRun });
    await saveThenApplyAtOnce();
    await screen.findByText("Apply outcome: applied.");
    expect(f.applies()).toBe(1);
    expect(firstRun.reviewConfiguration).not.toHaveBeenCalled();
    expect(document.querySelector("[data-reopen-binding]")).toBeNull();
  });
});

describe("a disabled Apply names the reason it is disabled (#1210)", () => {
  async function saveReviewed() {
    await screen.findByRole("group", { name: "Configuration" });
    fireEvent.change(command(), { target: { value: "new-command" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and review" }));
    await screen.findByText("Review configuration changes");
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed changes" }));
    return screen.findByRole("button", { name: "Apply saved configuration" });
  }

  it("is enabled with no tooltip once the reviewed draft is saved", async () => {
    setup();
    const apply = await saveReviewed();
    expect(apply.getAttribute("aria-disabled")).toBeNull();
    expect(apply.getAttribute("title")).toBeNull();
  });

  it.each([
    ["restart-required", "Already applied. The daemon must restart before this revision takes effect."],
    ["invalid", "The daemon refused this saved revision as invalid. Fix it and save a new revision before applying."],
  ] as const)(
    "says the saved revision was already applied after an Apply that came back %s",
    async (outcome, reason) => {
      const f = setup({ applyOutcome: outcome });
      fireEvent.click(await saveReviewed());
      await screen.findByText(`Apply outcome: ${outcome}.`);
      expect(f.applies()).toBe(1);
      const apply = screen.getByRole("button", { name: "Apply saved configuration" });
      expect(apply.getAttribute("aria-disabled")).toBe("true");
      expect(apply.getAttribute("title")).toBe(reason);
      expect(apply.getAttribute("title")).not.toMatch(/save the reviewed draft/i);
      fireEvent.click(apply);
      expect(f.applies()).toBe(1);
    },
  );

  it("says a read is in progress while Read current configuration is pending", async () => {
    const f = setup({ applyOutcome: "restart-required" });
    fireEvent.click(await saveReviewed());
    await screen.findByText("Apply outcome: restart-required.");
    const release = f.fake.hold("config.get");
    fireEvent.click(screen.getByRole("button", { name: "Read current configuration" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Apply saved configuration" }).getAttribute("title")).toBe(
        "Reading the current configuration…",
      ),
    );
    await act(async () => release());
  });

  it("asks for a save only while an unsaved draft is retained", async () => {
    const f = setup({ applyOutcome: "restart-required" });
    fireEvent.click(await saveReviewed());
    await screen.findByText("Apply outcome: restart-required.");
    fireEvent.change(command(), { target: { value: "newer-command" } });
    // The draft bar is back and Apply is gone: an edit is a new draft, not something to apply.
    await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(screen.queryByRole("button", { name: "Apply saved configuration" })).toBeNull();
    expect(f.applies()).toBe(1);
  });
});
