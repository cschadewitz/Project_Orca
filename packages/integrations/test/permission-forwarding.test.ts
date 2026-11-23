/** C4-07: original ACP permission semantics survive the non-live in-process bridge. */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost, resolvePermission, type AgentSession } from "@orca/agents";
import {
  AgentSpecSchema,
  FakeClock,
  parseWorkflow,
  TemplateRegistry,
  WorkflowRegistry,
  type OrcaEventInput,
} from "@orca/core";
import { askHumanInput, Orchestrator, LocalWorkspaceProvider, type HumanInputQuery } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { UpstreamHumanInput, type UpstreamTarget } from "@orca/integrations";

// IDs and names deliberately contradict semantics. Include an empty name to prove exact labels.
const offered: acp.PermissionOption[] = [
  { optionId: "opaque-a", name: "Nur einmal", kind: "allow_always" },
  { optionId: "deny", name: "Refuser", kind: "allow_once" },
  { optionId: "allow", name: "Autoriser", kind: "reject_once" },
  { optionId: "opaque-z", name: "", kind: "reject_always" },
];

const workflow = parseWorkflow(`
id: forwarding
name: Permission forwarding
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: fake, prompt: "synthetic permission" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`);

describe("permission forwarding through orchestrator → human input → facade → original callback", () => {
  it.each([
    { order: [0, 1, 2, 3], kind: "reject_once" },
    { order: [3, 2, 1, 0], kind: "reject_always" },
    { order: [2, 0, 3, 1], kind: "allow_once" },
    { order: [1, 3, 0, 2], kind: "allow_always" },
    { order: [0, 1, 2, 3], kind: "cancel" },
    { order: [0, 1, 2, 3], kind: "unknown" },
  ])(
    "retains offered one-time options in order $order, selecting $kind without a standing write",
    async ({ order, kind }) => {
      const dir = await mkdtemp(join(tmpdir(), "orca-forwarding-"));
      try {
        const options = order.map((i) => offered[i]!);
        const requests: acp.RequestPermissionRequest[] = [];
        const answers: Awaited<ReturnType<typeof resolvePermission>>[] = [];
        const port = new UpstreamHumanInput();
        const stores = memoryStores();
        const orchestrator = new Orchestrator({
          stores,
          agents: new AgentRegistry()
            .addHost(new LocalHost({ id: "local", type: "local" }))
            .addAgent(AgentSpecSchema.parse({ id: "fake", command: "unused", permissions: { default: "ask" } })),
          workflows: new WorkflowRegistry().register(workflow),
          templates: new TemplateRegistry(),
          workspaceProvider: new LocalWorkspaceProvider(dir),
          clock: new FakeClock(),
          humanInput: port,
          sessionFactory: async (o) => {
            const session: AgentSession = {
              id: "mock-session",
              agentId: o.agent.id,
              hostId: o.host.id,
              cwd: o.cwd,
              acpSessionId: "original",
              configOptions: [],
              setConfigOption: async () => [],
              closed: new Promise(() => {}),
              async prompt() {
                answers.push(
                  await resolvePermission(
                    { default: "ask", rules: [] },
                    {
                      request: {
                        sessionId: "original",
                        toolCall: { toolCallId: "synthetic", title: "Synthetic ask", kind: "edit" },
                        options,
                      },
                      ask: (req) => o.askPermission!(req),
                    },
                  ),
                );
                return { stopReason: "end_turn", durationMs: 1 };
              },
              onUpdate: () => () => {},
              cancel: async () => {},
              close: async () => {},
            };
            return session;
          },
        });
        const runId = await orchestrator.startRun({ workflowId: "forwarding" });
        port.bind(runId, {
          sessionId: "upstream",
          request: (async (
            _method: string,
            req: acp.RequestPermissionRequest,
          ): Promise<acp.RequestPermissionResponse> => {
            requests.push(req);
            if (kind === "cancel") return { outcome: { outcome: "cancelled" } };
            const selected = kind === "unknown" ? "never-offered" : req.options.find((o) => o.kind === kind)?.optionId;
            return { outcome: { outcome: "selected", optionId: selected ?? "no-matching-kind" } };
          }) as UpstreamTarget["request"],
        });
        const state = await orchestrator.run(runId);
        expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
        expect(requests).toHaveLength(1);
        // Only the one-time choices are forwarded, in the agent's order (#702): a remembered
        // option would have the agent stop asking, out of reach of any later ORCA rule.
        const oneTime = options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once");
        expect(requests[0]!.options).toEqual(oneTime);
        const original = oneTime.find((o) => o.kind === kind);
        expect(answers).toEqual([
          original
            ? {
                response: { outcome: { outcome: "selected", optionId: original.optionId } },
                decision: `ask:${original.kind}`,
              }
            : { response: { outcome: { outcome: "cancelled" } }, decision: "ask:cancelled" },
        ]);
        const events = await stores.events.read(runId);
        const requested = events.find((e) => e.type === "human.requested")!;
        expect(requested.payload).toEqual({
          stepRunId: expect.any(String),
          requestId: expect.any(String),
          kind: "permission",
          question: "Synthetic ask",
          options: oneTime.map((o) => ({
            id: o.optionId,
            label: o.name,
            ...(o.kind.startsWith("reject_") ? { destructive: true } : {}),
          })),
          agent: { id: "fake", hostId: "local" },
          context: { toolCall: { toolCallId: "synthetic", title: "Synthetic ask", kind: "edit" } },
        });
        // Both raw events and their folded public state omit the runtime metadata/kinds.
        expect(JSON.stringify(events)).not.toContain("permissionOptions");
        expect(JSON.stringify(state.humanInputs)).not.toContain("permissionOptions");
        for (const option of offered) {
          expect(JSON.stringify(requested)).not.toContain(option.kind);
          expect(JSON.stringify(state.humanInputs)).not.toContain(option.kind);
        }
        expect(await readdir(dir)).not.toContain("orca.permissions.json");
        expect((await readdir(dir)).filter((name) => name.startsWith("orca.permissions.json"))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

it.each(["unbound", "disconnect", "replacement"])(
  "retains permission fallback after %s with valid metadata",
  async (mode) => {
    const fallback = vi.fn(async () => "allow"); // Original reject_once, despite its ID.
    const port = new UpstreamHumanInput({ fallback: { ask: fallback } });
    const q: HumanInputQuery = { ...permissionQuery(), permissionOptions: metadata };
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let respond!: (response: acp.RequestPermissionResponse) => void;
    const response = new Promise<acp.RequestPermissionResponse>((resolve) => {
      respond = resolve;
    });
    if (mode !== "unbound")
      port.bind("run", {
        sessionId: "old",
        request: (async () => {
          started();
          if (mode === "disconnect") throw new Error("synthetic disconnect");
          return response;
        }) as UpstreamTarget["request"],
      });
    const pending = resolvePermission(
      { default: "ask", rules: [] },
      {
        request: { sessionId: "original", toolCall: { toolCallId: "synthetic" }, options: offered },
        ask: () => port.ask(q),
      },
    );
    if (mode === "replacement") {
      await requested;
      port.bind("run", { sessionId: "new", request: vi.fn() });
      respond({ outcome: { outcome: "selected", optionId: "opaque-a" } });
    }
    expect(await pending).toEqual({
      response: { outcome: { outcome: "selected", optionId: "allow" } },
      decision: "ask:reject_once",
    });
    expect(fallback).toHaveBeenCalledExactlyOnceWith(q);
  },
);

it("cannot deliver a late forwarded approval after the original callback expires", async () => {
  const controller = new AbortController();
  const port = new UpstreamHumanInput();
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let respond!: (response: acp.RequestPermissionResponse) => void;
  const response = new Promise<acp.RequestPermissionResponse>((resolve) => {
    respond = resolve;
  });
  port.bind("run", {
    sessionId: "upstream",
    request: (async () => {
      started();
      return response;
    }) as UpstreamTarget["request"],
  });
  const pending = resolvePermission(
    { default: "ask", rules: [] },
    {
      request: { sessionId: "original", toolCall: { toolCallId: "synthetic" }, options: offered },
      ask: () => port.ask({ ...permissionQuery(), permissionOptions: metadata, signal: controller.signal }),
      signal: controller.signal,
    },
  );
  await requested;
  controller.abort("turn ended");
  expect(await pending).toEqual({ response: { outcome: { outcome: "cancelled" } }, decision: "ask:expired" });
  respond({ outcome: { outcome: "selected", optionId: "opaque-a" } });
  await response;
});

const permissionQuery = (): HumanInputQuery => ({
  runId: "run",
  stepRunId: "step",
  requestId: "ask",
  kind: "permission",
  question: "Synthetic?",
  options: offered.map((o) => ({ id: o.optionId, label: o.name })),
  context: {},
});
const metadata = offered.map((o) => ({ optionId: o.optionId, kind: o.kind }));

describe("permission forwarding refuses untrusted or absent kinds", () => {
  it.each([
    undefined,
    null,
    {},
    [],
    metadata.slice(1),
    metadata.map((o, i) => (i === 0 ? { ...o, kind: "unknown" } : o)),
    metadata.map((o, i) => (i === 0 ? { ...o, kind: undefined } : o)),
    metadata.map((o, i) => (i === 0 ? { ...o, optionId: "other" } : o)),
    [...metadata].reverse(),
    [null, ...metadata.slice(1)],
  ])("refuses malformed runtime metadata %# without forwarding or fallback", async (permissionOptions) => {
    const upstream = vi.fn(async () => ({ outcome: { outcome: "selected", optionId: "opaque-a" } }));
    const fallback = vi.fn(async () => "opaque-a");
    const port = new UpstreamHumanInput({ fallback: { ask: fallback } });
    port.bind("run", { sessionId: "upstream", request: upstream as UpstreamTarget["request"] });
    // Deliberately bypass static typing to exercise malformed runtime callers.
    const q = { ...permissionQuery(), permissionOptions } as unknown as HumanInputQuery;
    expect(await port.ask(q)).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("refuses empty and ambiguous duplicate-ID permissions rather than fabricating an ok option", async () => {
    const upstream = vi.fn();
    const port = new UpstreamHumanInput();
    port.bind("run", { sessionId: "upstream", request: upstream });
    for (const options of [[], [offered[0]!, { ...offered[1]!, optionId: offered[0]!.optionId }]]) {
      const q = {
        ...permissionQuery(),
        options: options.map((o) => ({ id: o.optionId, label: o.name })),
        permissionOptions: options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
      };
      expect(await port.ask(q)).toBeUndefined();
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("discards unknown upstream IDs and already-aborted permission asks", async () => {
    const upstream = vi.fn(async () => ({ outcome: { outcome: "selected", optionId: "unknown" } }));
    const port = new UpstreamHumanInput();
    port.bind("run", { sessionId: "upstream", request: upstream as UpstreamTarget["request"] });
    const q = { ...permissionQuery(), permissionOptions: metadata };
    expect(await port.ask(q)).toBeUndefined();
    upstream.mockClear();
    expect(await port.ask({ ...q, signal: AbortSignal.abort() })).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
  });
});

it("passes typed metadata through askHumanInput while excluding it from raw event payloads", async () => {
  const emitted: Omit<OrcaEventInput, "runId">[] = [];
  const ask = vi.fn(async (q: HumanInputQuery) => {
    expect(q.permissionOptions).toEqual(metadata);
    return "allow";
  });
  const q: HumanInputQuery = { ...permissionQuery(), permissionOptions: metadata };
  expect(
    await askHumanInput({
      ...q,
      clock: new FakeClock(),
      port: { ask },
      emit: async (event) => {
        emitted.push(event);
      },
    }),
  ).toBe("allow");
  expect(ask).toHaveBeenCalledOnce();
  expect(emitted.map((e) => e.type)).toEqual(["human.requested", "step.waiting", "human.answered"]);
  expect(emitted[0]!.payload).toEqual({
    stepRunId: q.stepRunId,
    requestId: expect.any(String),
    kind: q.kind,
    question: q.question,
    options: q.options,
    context: {},
  });
  expect(JSON.stringify(emitted)).not.toContain("permissionOptions");
});

it.each(["decision", "question"] as const)(
  "preserves ordinary %s positional mapping, consequences and empty-option default",
  async (kind) => {
    const requests: acp.RequestPermissionRequest[] = [];
    const port = new UpstreamHumanInput();
    port.bind("run", {
      sessionId: "upstream",
      request: (async (_method: string, req: acp.RequestPermissionRequest) => {
        requests.push(req);
        return { outcome: { outcome: "selected", optionId: req.options[0]!.optionId } };
      }) as UpstreamTarget["request"],
    });
    const q = {
      ...permissionQuery(),
      kind,
      options: [
        { id: "x", label: "First", consequence: "Continue" },
        { id: "y", label: "Second" },
      ],
    };
    expect(await port.ask(q)).toBe("x");
    expect(await port.ask({ ...q, options: [] })).toBe("ok");
    expect(requests.map((req) => req.options)).toEqual([
      [
        { optionId: "x", name: "First - Continue", kind: "allow_once" },
        { optionId: "y", name: "Second", kind: "reject_once" },
      ],
      [{ optionId: "ok", name: "ok", kind: "allow_once" }],
    ]);
  },
);
