/**
 * End to end for #1133 and #1169: a real scripted agent over a real ACP session asks a
 * question mid-turn (`elicitation/create`, in the shapes claude-agent-acp and codex-acp send),
 * the run records it as an agent `question` with its form, the answer reaches the agent, and
 * the agent writes what it got back into its deliverable.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost, openAcpSession, type OpenSessionOptions } from "@orca/agents";
import {
  ELICITATION_DECLINE,
  encodeElicitationAnswer,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
  type OrcaEvent,
} from "@orca/core";
import {
  autoHumanInput,
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

const WORKFLOW = `
id: ask
name: Agent asks
start: start
nodes:
  start: { type: start }
  build:
    type: agent
    agent: { role: builder }
    prompt: "Write the note."
    produces:
      - { kind: note, path: "note.md" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: build }
  - { from: build, to: done }
`;

/** claude-agent-acp's `AskUserQuestion` form. */
const CLAUDE_ASK = {
  message: "Which database should the service use?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Database",
        oneOf: [
          { const: "Postgres", title: "Postgres" },
          { const: "SQLite", title: "SQLite" },
        ],
      },
      question_0_custom: { type: "string", title: "Other" },
    },
  },
};

/** codex-acp's `request_user_input` form. */
const CODEX_ASK = {
  message: "Codex needs your input to continue.",
  requestedSchema: {
    type: "object",
    properties: {
      env: { type: "string", title: "Which environment?", oneOf: [{ const: "staging", title: "staging" }] },
      env__note: { type: "string", title: "Additional answer or note" },
    },
    required: ["env"],
  },
};

class Answering implements HumanInputPort {
  readonly asked: HumanInputQuery[] = [];
  constructor(private readonly answer: (q: HumanInputQuery) => string | undefined) {}
  async ask(q: HumanInputQuery): Promise<string | undefined> {
    this.asked.push(q);
    return this.answer(q);
  }
}

async function run(elicit: Record<string, unknown>, humanInput: HumanInputPort) {
  const dir = await mkdtemp(join(tmpdir(), "orca-question-e2e-"));
  dirs.push(dir);
  const agent = scriptedAgentSpec({
    id: "scripted",
    playbookJson: { kinds: { note: [{ elicit, body: "answer={answer}\n" }] } },
    stateFile: join(dir, ".orca-test", "state.json"),
    roles: ["builder"],
  });
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })).addAgent(agent),
    workflows: new WorkflowRegistry().register(parseWorkflow(WORKFLOW)),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    humanInput,
    sessionFactory: (options: OpenSessionOptions) => openAcpSession(options),
    logger: silentLogger,
  });
  const state = await orchestrator.startAndRun({ workflowId: "ask" });
  expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
  const events = await orchestrator.events(state.run.id);
  const produced = Object.values(state.artifacts).find((a) => a.kind === "note");
  const note = await readFile(produced!.path!, "utf8");
  const answer = /answer=(.*)/.exec(note)?.[1];
  return { events, answer: answer ? (JSON.parse(answer) as unknown) : undefined };
}

const requested = (events: OrcaEvent[]) =>
  events.filter((e) => e.type === "human.requested").map((e) => e.payload as Record<string, unknown>);

describe("an agent's question mid-turn (#1133, #1169)", () => {
  it("reaches the person as a question with its form, and the answer reaches the agent (Claude's shape)", async () => {
    const port = new Answering(() =>
      encodeElicitationAnswer({ action: "accept", content: { question_0: "Postgres" } }),
    );
    const { events, answer } = await run(CLAUDE_ASK, port);
    expect(port.asked).toHaveLength(1);
    expect(port.asked[0]!.elicitation?.fields.map((f) => f.key)).toEqual(["question_0", "question_0_custom"]);
    const [ask] = requested(events);
    expect(ask).toMatchObject({
      kind: "question",
      question: "Which database should the service use?",
      options: [],
      agent: { id: "scripted", hostId: "local" },
      context: { elicitation: { message: CLAUDE_ASK.message }, toolCallId: "write-note-1" },
    });
    expect(events.find((e) => e.type === "human.answered")?.payload).toMatchObject({
      answer: JSON.stringify({ action: "accept", content: { question_0: "Postgres" } }),
    });
    expect(answer).toEqual({ action: "accept", content: { question_0: "Postgres" } });
  });

  it("delivers Codex's question and its required answer", async () => {
    const port = new Answering(() => encodeElicitationAnswer({ action: "accept", content: { env: "staging" } }));
    const { answer } = await run(CODEX_ASK, port);
    expect(port.asked[0]!.elicitation?.fields.map((f) => [f.key, f.required])).toEqual([
      ["env", true],
      ["env__note", false],
    ]);
    expect(answer).toEqual({ action: "accept", content: { env: "staging" } });
  });

  it("tells the agent decline when the person declines", async () => {
    const { answer } = await run(CLAUDE_ASK, new Answering(() => ELICITATION_DECLINE));
    expect(answer).toEqual({ action: "decline" });
  });

  it("asks nobody in an unattended run: the agent hears cancel", async () => {
    // Even an auto port configured to pick an option does not fill an agent's form.
    const { answer } = await run(CLAUDE_ASK, autoHumanInput("Postgres"));
    expect(answer).toEqual({ action: "cancel" });
  });

  it("declines a form that asks for a secret before anybody sees it", async () => {
    const port = new Answering(() => ELICITATION_DECLINE);
    const secret = {
      message: "API key?",
      requestedSchema: {
        type: "object",
        properties: { key: { type: "string", _meta: { codex: { isSecret: true } } } },
      },
    };
    const { events, answer } = await run(secret, port);
    expect(port.asked).toHaveLength(0);
    expect(requested(events)).toHaveLength(0);
    expect(answer).toEqual({ action: "decline" });
  });
});
