/** Malformed deliverables use the existing bounded repair loop; operational failures still escape it. */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError, parseWorkflow, WorkflowRegistry } from "@orca/core";
import { memoryStores } from "@orca/store";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const malformed = "---\ntitle: Fix: the bug\n---\nMalformed report.\n";
const corrected = '---\ntitle: "Fix: the bug"\n---\nCorrected report.\n';

function workflows(required = true, maxFollowUps = 1): WorkflowRegistry {
  return new WorkflowRegistry().register(
    parseWorkflow(`
id: artifact-parsing
name: Artifact parsing
start: write
nodes:
  write:
    type: agent
    agent: { role: builder }
    prompt: Write the reports.
    completion: { mode: turn-end, maxFollowUps: ${maxFollowUps}, maxAttempts: 1 }
    produces:
      - { kind: report, path: report.md, required: ${required}, validate: { requiredFields: [title] } }
      - { kind: sibling, path: sibling.md }
  done: { type: end }
edges: [{ from: write, to: done }]
`),
  );
}

async function setup(contents: string[], required = true, maxFollowUps = 1) {
  const stores = memoryStores();
  const h = await harness(
    {
      kinds: {
        report: contents.map((content) => ({ content })),
        sibling: [{ data: { status: "done" }, body: "Valid sibling." }],
      },
    },
    { stores, workflows: workflows(required, maxFollowUps) },
  );
  dirs.push(h.dir);
  return { ...h, stores };
}

describe("artifact parsing failures", () => {
  it("rejects malformed required YAML, sends one repair prompt, and records the corrected report", async () => {
    const h = await setup([malformed, corrected]);
    const state = await h.orchestrator.startAndRun({ workflowId: "artifact-parsing" });
    expect(state.run.status).toBe("completed");
    const events = await h.orchestrator.events(state.run.id);
    const rejected = events.filter((e) => e.type === "artifact.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toMatchObject({ kind: "report", reason: expect.stringContaining("parse") });
    expect(events.filter((e) => e.type === "agent.turn.started").map((e) => e.payload.followUp)).toEqual([0, 1]);
    const prompts = await h.prompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toContain("deliverables are missing or invalid");
    expect(prompts[1]!.text).toContain(rejected[0]!.payload.reason);
    expect(prompts[1]!.text).toContain(rejected[0]!.payload.path);
    const reports = Object.values(state.artifacts).filter((a) => a.kind === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.data.title).toBe("Fix: the bug");
    expect(await h.stores.artifacts.content(reports[0]!.id)).toBe(corrected);
  });

  it("rejects/skips malformed optional YAML and collects the required sibling without a repair", async () => {
    const h = await setup([malformed], false);
    const state = await h.orchestrator.startAndRun({ workflowId: "artifact-parsing" });
    expect(state.run.status).toBe("completed");
    expect(await h.prompts()).toHaveLength(1);
    const rejected = (await h.orchestrator.events(state.run.id)).filter((e) => e.type === "artifact.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload.kind).toBe("report");
    expect(Object.values(state.artifacts).map((a) => a.kind)).toEqual(["sibling"]);
  });

  it.each([0, 1])("fails normally after the configured %i repair budget is exhausted", async (budget) => {
    const h = await setup([malformed], true, budget);
    const state = await h.orchestrator.startAndRun({ workflowId: "artifact-parsing" });
    expect(state.run).toMatchObject({ status: "failed", error: { code: "ARTIFACT_MISSING" } });
    const events = await h.orchestrator.events(state.run.id);
    const rejected = events.filter((e) => e.type === "artifact.rejected");
    expect(rejected).toHaveLength(budget + 1);
    expect(await h.prompts()).toHaveLength(budget + 1);
    expect(events.filter((e) => e.type === "agent.turn.started").map((e) => e.payload.followUp)).toEqual(
      Array.from({ length: budget + 1 }, (_, i) => i),
    );
    expect(state.run.error!.message).toContain(rejected[0]!.payload.reason);
    expect(state.stepOrder.map((id) => state.steps[id]!).filter((s) => s.nodeId === "write")).toHaveLength(1);
    expect(Object.values(state.artifacts).some((a) => a.kind === "report")).toBe(false);
  });

  it.each(["read", "store", "record", "reject", "lease", "authorization"] as const)(
    "preserves an unrelated %s failure without issuing an artifact repair",
    async (operation) => {
      const h = await setup([operation === "reject" ? malformed : corrected]);
      const code = operation === "lease" ? "RUN_LEASED" : operation === "authorization" ? "RUN_STATE" : "STORE_WRITE";
      const failure = new OrcaError(code, `synthetic ${operation} refusal`, { marker: operation });
      const append = h.stores.events.append.bind(h.stores.events);
      if (operation === "read") {
        const { host } = h.orchestrator.agents.resolve({ role: "builder" });
        vi.spyOn(host.fs, "readFile").mockRejectedValueOnce(failure);
      } else if (operation === "record" || operation === "reject") {
        vi.spyOn(h.stores.events, "append").mockImplementation(async (event) => {
          if (event.type === (operation === "record" ? "artifact.recorded" : "artifact.rejected")) throw failure;
          return append(event);
        });
      } else {
        vi.spyOn(h.stores.artifacts, "put").mockRejectedValueOnce(failure);
      }
      const execution = h.orchestrator.startAndRun({ workflowId: "artifact-parsing" });
      if (operation === "lease") {
        // Lease loss stops the interpreter without writing a terminal run event.
        await expect(execution).rejects.toMatchObject({ code: "RUN_LEASED" });
        expect(await h.prompts()).toHaveLength(1);
        return;
      }
      const state = await execution;
      expect(state.run.status).toBe("failed");
      expect(state.run.error).toEqual(failure.toJSON());
      expect(await h.prompts()).toHaveLength(1);
      const events = await h.orchestrator.events(state.run.id);
      expect(events.filter((e) => e.type === "artifact.rejected")).toEqual([]);
      expect(events.filter((e) => e.type === "agent.turn.started").map((e) => e.payload.followUp)).toEqual([0]);
    },
  );
});
