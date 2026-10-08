/** Validates the app's fixed sample against production parser/digest/interpreter without a daemon or agent. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry, validateWorkflowInputs } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput, workflowRevision } from "@orca/engine";
import { memoryStores } from "@orca/store";
import {
  FIRST_RUN_SAMPLE,
  FIRST_RUN_SAMPLE_ASSETS,
  FIRST_RUN_SAMPLE_FILES,
  FIRST_RUN_SAMPLE_TASK,
} from "../../app/src/first-run-sample.js";

it("pins the normalized workflow and each task/instruction/result/accepted #420 fixture digest", async () => {
  const definition = parseWorkflow(FIRST_RUN_SAMPLE_FILES["first-run/workflow.yaml"]);
  expect({ id: definition.id, version: definition.version, revision: workflowRevision(definition) }).toEqual(
    FIRST_RUN_SAMPLE,
  );
  const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  for (const asset of Object.values(FIRST_RUN_SAMPLE_ASSETS)) {
    expect(digest(FIRST_RUN_SAMPLE_FILES[asset.path])).toBe(asset.revision);
  }
  const meta = definition.meta!.firstRunSample as {
    assets: unknown;
    codingFixture: { id: string; assets: Record<string, string> };
  };
  expect(meta.assets).toEqual(FIRST_RUN_SAMPLE_ASSETS);
  expect(meta.codingFixture.id).toBe("beta-first-job-v1");
  for (const [path, revision] of Object.entries(meta.codingFixture.assets)) {
    expect(digest(await readFile(resolve(path), "utf8"))).toBe(revision);
  }
  expect(validateWorkflowInputs(definition, { task: FIRST_RUN_SAMPLE_TASK }).validation.ok).toBe(true);
  expect(validateWorkflowInputs(definition, { task: "Run a paid provider" }).validation.ok).toBe(false);
  expect(validateWorkflowInputs(definition, { task: FIRST_RUN_SAMPLE_TASK, extra: "undeclared" }).validation.ok).toBe(
    false,
  );
});
it("completes the real start/set/end interpreter with no agent and leaves selected project bytes unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "orca-agent-free-sample-"));
  try {
    const sentinel = join(root, "sentinel.txt");
    await writeFile(sentinel, "unchanged project\n");
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(FIRST_RUN_SAMPLE_FILES["first-run/workflow.yaml"]));
    const orchestrator = new Orchestrator({
      stores: memoryStores(),
      agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
      workflows,
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider(root),
      humanInput: new PausingHumanInput(),
      sessionFactory: async () => {
        throw new Error("An agent session must never open for this sample");
      },
    });
    const state = await orchestrator.startAndRun({
      workflowId: FIRST_RUN_SAMPLE.id,
      vars: { task: FIRST_RUN_SAMPLE_TASK },
    });
    expect(state.run.status).toBe("completed");
    expect(state.run.vars.sampleResult).toEqual({ kind: "agent-free-local-check", assets: FIRST_RUN_SAMPLE_ASSETS });
    expect(state.stepOrder.map((id) => state.steps[id]!.nodeId)).toEqual(["start", "record", "end"]);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged project\n");
    expect(await readdir(root)).toEqual(["sentinel.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
