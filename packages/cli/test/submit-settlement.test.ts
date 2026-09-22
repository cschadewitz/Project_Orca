/** CLI submissions print and persist the same outcome-aware Request settlement as ACP. */
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, parseWorkflow, silentLogger } from "@orca/core";
import { PausingHumanInput } from "@orca/engine";
import * as bootstrapModule from "../src/bootstrap.js";
import { commands } from "../src/commands/index.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["success", "completed", 0],
  ["failure", "failed", 2],
  ["execution", "failed", 2],
  ["cancelled", "cancelled", 2],
  ["paused", "decomposing", 3],
] as const)("submit reports %s and persists %s", async (outcome, expected, exitCode) => {
  let atGate!: (runId: string) => void;
  const gate = new Promise<string>((resolve) => {
    atGate = resolve;
  });
  const app = await bootstrapModule.bootstrap({
    ephemeral: true,
    cwd: process.cwd(),
    config: parseOrcaConfig({ workflows: [], templates: [] }),
    logger: silentLogger,
    humanInput:
      outcome === "cancelled"
        ? {
            ask: async (query) => {
              atGate(query.runId);
              return new Promise<never>(() => {});
            },
          }
        : new PausingHumanInput(),
  });
  const node =
    outcome === "execution"
      ? '{ type: agent, agent: missing, prompt: "work" }'
      : outcome === "paused" || outcome === "cancelled"
        ? '{ type: gate, question: "Continue?", options: [yes, no] }'
        : `{ type: end, outcome: ${outcome === "failure" ? "failure" : "success"} }`;
  app.workflows.register(
    parseWorkflow(
      `id: program\nname: Program\nstart: s\nnodes:\n  s: { type: start }\n  end: ${node}\nedges: [{ from: s, to: end }]`,
    ),
  );
  // Only configuration discovery is replaced: the command drives the real ProgramService,
  // interpreter, human-input cancellation and in-memory stores.
  vi.spyOn(bootstrapModule, "bootstrap").mockResolvedValue(app);
  const output: string[] = [];
  const command = commands.submit!.run({
    cwd: process.cwd(),
    positionals: ["Requested task"],
    flags: { body: "Do the requested work", quiet: true },
    out: (line) => output.push(line),
    err: () => {},
  });
  if (outcome === "cancelled") await app.orchestrator.cancel(await gate, "operator cancelled");
  expect(await command).toBe(exitCode);
  const [request] = await app.orchestrator.stores.requests.list(() => true);
  expect(request).toMatchObject({ status: expected, title: "Requested task", body: "Do the requested work" });
  expect(output).toContain(`request ${request!.id}: ${expected}`);
  const state = await app.orchestrator.getState(request!.programRunId!);
  expect(output.join("\n")).toContain(`status=${state.run.status}`);
  if (outcome === "failure") expect(output.join("\n")).toContain("status=completed/failure");
});
