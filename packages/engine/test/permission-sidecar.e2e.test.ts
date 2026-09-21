/**
 * End to end for #271: a standing grant recorded while a run is in flight decides that
 * run's next tool call.
 *
 * A real scripted agent (`@orca/testing`) over a real ACP session asks twice for the same
 * tool call - the same path, from two steps sharing one `per-run` session. The first ask
 * reaches the answerer, which answers it *and* records the rule the answer justifies, the
 * way the daemon's `inputs.answer` with `always` does. The second ask must be decided
 * `allow` by the policy: no second `human.requested`, nobody asked.
 *
 * Two deliberate departures from the sketch in #271, both forced by what the engine does
 * today rather than by what is convenient here:
 *
 * - The grant is written with `recordAlwaysDecision` rather than by calling the daemon's
 *   `inputs.answer`. `answerAndResume` only answers a **parked** run, and a permission ask
 *   never parks one: it cannot outlive the agent session that raised it, so
 *   `PausingHumanInput` cancels it (see `human-input.ts`) and a live port like the one here
 *   is the only thing that answers it. `recordAlwaysDecision` is the whole of what
 *   `ControlModel.recordAlways` does to the file, and `packages/daemon/test` already
 *   exercises the method around it.
 * - The session factory is built here rather than imported: it is the closure
 *   `makeSessionFactory` in `packages/cli/src/bootstrap.ts` builds, and `@orca/engine` sits
 *   to the left of the CLI. `packages/cli/test/bootstrap-permissions.test.ts` is what holds
 *   the real one to the same shape.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AgentRegistry,
  LocalHost,
  openAcpSession,
  permissionPolicyPath,
  recordAlwaysDecision,
  type OpenSessionOptions,
} from "@orca/agents";
import { parseWorkflow, silentLogger, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import {
  humanInputCancelled,
  LocalWorkspaceProvider,
  Orchestrator,
  type HumanInputPort,
  type HumanInputQuery,
} from "@orca/engine";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec } from "@orca/testing";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Two steps, one path: the second step's tool call is the one the grant has to cover. */
const WORKFLOW = `
id: sidecar
name: Sidecar grants
start: start
nodes:
  start: { type: start }
  first:
    type: agent
    agent: { role: builder }
    prompt: "Write the note."
    produces:
      - { kind: note, path: "note.md" }
  second:
    type: agent
    agent: { role: builder }
    prompt: "Write the note again."
    produces:
      - { kind: note, path: "note.md" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: first }
  - { from: first, to: second }
  - { from: second, to: done }
`;

/**
 * A port that answers permission asks in process - what a host does while a run is live -
 * and records the standing rule the first answer justifies, under the run's own workspace.
 */
class GrantingHumanInput implements HumanInputPort {
  readonly asked: HumanInputQuery[] = [];
  constructor(
    private readonly file: string,
    private readonly agentId: string,
    private readonly workspaceCwd: string,
  ) {}
  async ask(query: HumanInputQuery): Promise<string | undefined> {
    if (query.signal?.aborted) throw humanInputCancelled(query.signal);
    this.asked.push(query);
    if (query.kind !== "permission") return query.options[0]?.id;
    const toolCall = query.context["toolCall"];
    await recordAlwaysDecision({
      file: this.file,
      agentId: this.agentId,
      request: { sessionId: "", toolCall, options: [] } as never,
      decision: "allow",
      workspaceCwd: this.workspaceCwd,
    });
    return query.options.find((o) => o.id === "allow")?.id ?? query.options[0]?.id;
  }
}

describe("a grant recorded mid-run", () => {
  it("decides the very next ask, without a second human.requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-sidecar-e2e-"));
    dirs.push(dir);
    const file = permissionPolicyPath(dir);
    const agent = scriptedAgentSpec({
      id: "scripted",
      // Both occurrences ask; whether the second one *reaches* the port is the test.
      playbookJson: { kinds: { note: [{ askPermission: true }, { askPermission: true }] } },
      stateFile: join(dir, ".orca-test", "state.json"),
      roles: ["builder"],
      // One session for the whole run, so the second ask is evaluated by a session that was
      // opened before the rule existed. A policy read at `session/new` could not see it.
      sessionMode: "per-run",
      // Explicit `ask`, and so no default rules either (#140): every tool call is decided by
      // the configured list and the sidecar alone.
      permissions: { default: "ask", rules: [] },
    });
    const humanInput = new GrantingHumanInput(file, agent.id, dir);
    const orchestrator = new Orchestrator({
      stores: memoryStores(),
      agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })).addAgent(agent),
      workflows: new WorkflowRegistry().register(parseWorkflow(WORKFLOW)),
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider(dir),
      humanInput,
      // The closure `bootstrap` builds: the sidecar the answer is written to is the sidecar
      // the next ask is evaluated against.
      sessionFactory: (options: OpenSessionOptions) => openAcpSession({ ...options, permissionFiles: [file] }),
      logger: silentLogger,
    });

    const state = await orchestrator.startAndRun({ workflowId: "sidecar" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");

    const events = await orchestrator.events(state.run.id);
    const decisions = events
      .filter((e) => e.type === "agent.permission")
      .map((e) => (e.payload as { decision: string }).decision);
    // Two asks from the agent; the first went to a person, the second was decided by the
    // rule the first one wrote. Before #271 both read `ask:allow_once`.
    expect(decisions).toEqual(["ask:allow_once", "allow"]);
    expect(events.filter((e) => e.type === "human.requested")).toHaveLength(1);
    expect(humanInput.asked).toHaveLength(1);

    // The grant is in the file, workspace-relative, written once.
    const doc = JSON.parse(await readFile(file, "utf8")) as {
      agents: Record<string, { rules: { match: { path?: string; kind?: string }; decision: string }[] }>;
    };
    expect(doc.agents["scripted"]?.rules).toMatchObject([
      { match: { kind: "edit", path: "note.md" }, decision: "allow" },
    ]);
  });
});
