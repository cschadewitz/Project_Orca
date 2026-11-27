/**
 * An agent's question (#1133, #1169) through the live port: held open with the agent's turn
 * like a permission ask, answered only with content that fits its form, never with a standing
 * answer, and never parked or answered on a person's behalf.
 */
import { expect, it, vi } from "vitest";
import { ELICITATION_DECLINE, FakeClock, type ElicitationForm, type OrcaEventInput } from "@orca/core";
import { memoryStores } from "@orca/store";
import { askHumanInput, autoHumanInput, PausingHumanInput, type HumanInputQuery } from "../src/human-input.js";
import { LiveHumanInput, type LiveAnswerAuthority, type LiveDecisionTarget } from "../src/live-input.js";

const form: ElicitationForm = {
  message: "Which database?",
  fields: [
    {
      key: "db",
      kind: "choice",
      required: true,
      options: [
        { value: "pg", label: "Postgres" },
        { value: "sqlite", label: "SQLite" },
      ],
    },
  ],
};

async function fixture() {
  const stores = memoryStores();
  const lease = await stores.leases.acquire({ resource: "run:run", holder: "owner" });
  const port = new LiveHumanInput("boot");
  const writes: Omit<OrcaEventInput, "runId">[] = [];
  const emit = vi.fn(async (event: Omit<OrcaEventInput, "runId">) => {
    writes.push(event);
  });
  const live = {
    identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
    signal: new AbortController().signal,
    withOwnership: <T>(write: () => Promise<T>) => stores.leases.withOwnership(lease, write),
    emitOwned: emit,
  };
  let query!: HumanInputQuery;
  const result = askHumanInput({
    port,
    emit,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "question",
    question: form.message,
    options: [],
    elicitation: form,
    context: { elicitation: form },
    live,
    onRequested: (q) => {
      query = q;
    },
  });
  void result.catch(() => undefined);
  await vi.waitFor(() => expect(query).toBeDefined());
  const target: LiveDecisionTarget = { ...live.identity, runId: "run", stepRunId: "step", requestId: query.requestId };
  await vi.waitFor(() => expect(port.inspect(target)).toBe("pending"));
  const authority: LiveAnswerAuthority = {
    actor: { principalId: "alice", credentialId: "credential" },
    authorize: vi.fn(async () => {}),
  };
  return { port, writes, result, target, authority, query };
}

it("is held live and takes an answer that fits the form", async () => {
  const f = await fixture();
  expect(f.port.recordsAnswer(f.query)).toBe(true);
  const answer = JSON.stringify({ action: "accept", content: { db: "pg" } });
  await f.port.answer({ target: f.target, optionId: answer }, f.authority);
  expect(await f.result).toBe(answer);
  expect(f.writes.filter((e) => e.type === "human.answered")).toMatchObject([{ payload: { answer } }]);
});

it("takes a decline", async () => {
  const f = await fixture();
  await f.port.answer({ target: f.target, optionId: ELICITATION_DECLINE }, f.authority);
  expect(await f.result).toBe(ELICITATION_DECLINE);
});

it.each([
  ["free text", "Postgres"],
  ["a value outside the options", JSON.stringify({ action: "accept", content: { db: "mysql" } })],
  ["a missing required field", JSON.stringify({ action: "accept", content: {} })],
])("refuses %s without consuming the question", async (_, bad) => {
  const f = await fixture();
  await expect(f.port.answer({ target: f.target, optionId: bad }, f.authority)).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  expect(f.port.inspect(f.target)).toBe("pending");
  expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(0);
  await f.port.answer({ target: f.target, optionId: ELICITATION_DECLINE }, f.authority);
  expect(await f.result).toBe(ELICITATION_DECLINE);
});

it("has no standing answer", async () => {
  const f = await fixture();
  await expect(
    f.port.answer({ target: f.target, optionId: ELICITATION_DECLINE, standing: true }, f.authority, async () => {}),
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  expect(f.port.inspect(f.target)).toBe("pending");
});

it("is never parked, and never answered by an unattended run", async () => {
  const query = {
    runId: "run",
    stepRunId: "step",
    requestId: "hi_1",
    kind: "question",
    question: form.message,
    options: [],
    elicitation: form,
    context: { elicitation: form },
  } satisfies HumanInputQuery;
  await expect(new PausingHumanInput().ask(query)).resolves.toBeUndefined();
  await expect(autoHumanInput("pg").ask(query)).resolves.toBeUndefined();
  // A workflow's own question still parks, as before.
  const { elicitation: _, ...gate } = query;
  await expect(new PausingHumanInput().ask({ ...gate, context: {} })).rejects.toMatchObject({
    code: "HUMAN_INPUT_PENDING",
  });
});
