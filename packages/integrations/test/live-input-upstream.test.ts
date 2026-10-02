/** ACP targets cannot answer another generation's callback or turn disconnect into a workflow decision. */
import { expect, it, vi } from "vitest";
import { autoHumanInput, HumanInputPending, type HumanInputQuery } from "@orca/engine";
import { UpstreamHumanInput, type UpstreamTarget } from "../src/acp-facade/upstream-human-input.js";

const query: HumanInputQuery = {
  runId: "run",
  stepRunId: "step",
  requestId: "input",
  kind: "decision",
  question: "Ship?",
  options: [{ id: "yes", label: "Yes" }],
  context: {},
};

it("retains automatic fallback for a durable gate with no bound upstream", async () => {
  const input = new UpstreamHumanInput({ fallback: autoHumanInput() });
  expect(await input.ask(query)).toBe("yes");
});

it("parks a durable gate when its upstream disconnects", async () => {
  const input = new UpstreamHumanInput({ fallback: autoHumanInput() });
  input.bind("run", {
    sessionId: "old",
    request: async () => {
      throw new Error("closed");
    },
  });
  await expect(input.ask(query)).rejects.toBeInstanceOf(HumanInputPending);
});

it("discards a late answer from a replaced upstream target", async () => {
  let resolve!: (value: { outcome: { outcome: "selected"; optionId: string } }) => void;
  const result = new Promise<{ outcome: { outcome: "selected"; optionId: string } }>((r) => {
    resolve = r;
  });
  const input = new UpstreamHumanInput({ fallback: autoHumanInput() });
  input.bind("run", { sessionId: "old", request: (() => result) as UpstreamTarget["request"] });
  const pending = input.ask(query);
  await Promise.resolve();
  input.bind("run", {
    sessionId: "new",
    request: async () => {
      throw new Error("unused");
    },
  });
  resolve({ outcome: { outcome: "selected", optionId: "yes" } });
  await expect(pending).rejects.toBeInstanceOf(HumanInputPending);
});

it("routes live asks through the authenticated fallback instead of treating an ACP option as a principal", async () => {
  const ask = vi.fn(async () => "yes");
  const upstream = vi.fn(async () => {
    throw new Error("must not forward");
  });
  const port = new UpstreamHumanInput({ fallback: { ask, recordsAnswer: () => true } });
  port.bind("run", { sessionId: "upstream", request: upstream });
  const q: HumanInputQuery = {
    ...query,
    kind: "permission",
    live: {
      identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
      signal: new AbortController().signal,
      withOwnership: async (f) => f(),
      emitOwned: async () => {},
    },
  };
  expect(await port.ask(q)).toBe("yes");
  expect(port.recordsAnswer(q)).toBe(true);
  expect(upstream).not.toHaveBeenCalled();
});
