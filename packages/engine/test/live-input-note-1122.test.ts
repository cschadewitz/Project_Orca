/**
 * A person's note on a live permission answer (#1122): handed to the asker's `onAnswerNote` with
 * the answer it was written for, and only with an answer that was delivered.
 */
import { expect, it, vi } from "vitest";
import { FakeClock, type OrcaEventInput } from "@orca/core";
import { memoryStores } from "@orca/store";
import { askHumanInput, type HumanInputQuery } from "../src/human-input.js";
import { LiveHumanInput, type LiveAnswerAuthority, type LiveDecisionTarget } from "../src/live-input.js";

async function fixture() {
  const stores = memoryStores();
  const lease = await stores.leases.acquire({ resource: "run:run", holder: "owner" });
  const port = new LiveHumanInput("boot");
  const writes: Omit<OrcaEventInput, "runId">[] = [];
  const emit = vi.fn(async (event: Omit<OrcaEventInput, "runId">) => {
    writes.push(event);
  });
  const turn = new AbortController();
  const live = {
    identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
    signal: turn.signal,
    withOwnership: <T>(write: () => Promise<T>) => stores.leases.withOwnership(lease, write),
    emitOwned: emit,
  };
  const notes: string[] = [];
  let query!: HumanInputQuery;
  const result = askHumanInput({
    port,
    emit,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "rm -rf build",
    options: [
      { id: "allow", label: "Allow" },
      { id: "reject", label: "Reject", destructive: true },
    ],
    live,
    onAnswerNote: (note) => notes.push(note),
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
  return { port, writes, result, target, authority, notes, turn };
}

it("hands the note to the asker with the answer, and records it", async () => {
  const f = await fixture();
  await f.port.answer({ target: f.target, optionId: "reject", note: "use make clean instead" }, f.authority);
  expect(await f.result).toBe("reject");
  expect(f.notes).toEqual(["use make clean instead"]);
  expect(f.writes.filter((e) => e.type === "human.answered")).toMatchObject([
    { payload: { answer: "reject", note: "use make clean instead" } },
  ]);
});

it("hands over nothing for an answer without a note", async () => {
  const f = await fixture();
  await f.port.answer({ target: f.target, optionId: "reject" }, f.authority);
  expect(await f.result).toBe("reject");
  expect(f.notes).toEqual([]);
});

it("hands over no note when the turn ended before the answer was delivered", async () => {
  const f = await fixture();
  f.turn.abort();
  await f.port.answer({ target: f.target, optionId: "reject", note: "too late" }, f.authority).catch(() => undefined);
  expect(await f.result).toBeUndefined();
  expect(f.notes).toEqual([]);
});
