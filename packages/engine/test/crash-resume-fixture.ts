/**
 * The runtime both processes of crash-resume-357.test.ts build over one store directory: a
 * workflow with two side-effecting steps before a gate, each of which appends its node id to a
 * file outside the store, so the test counts real executions across processes.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import type { Stores } from "@orca/store";
import { builtinExecutors, completed, LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "../src/index.js";

export const CRASH_WORKFLOW = "crash-resume";

/** What the effects file says ran, in order. */
export function executions(effectsFile: string): string[] {
  return existsSync(effectsFile) ? readFileSync(effectsFile, "utf8").split("\n").filter(Boolean) : [];
}

export function crashRuntime(stores: Stores, effectsFile: string, onEffect?: (nodeId: string) => void) {
  const definition = parseWorkflow(`
id: ${CRASH_WORKFLOW}
name: Crash and resume
version: '1'
start: s
nodes:
  s: {type: start}
  provision: {type: 'custom:effect'}
  deploy: {type: 'custom:effect'}
  approve: {type: gate, question: Ship?, options: [ship]}
  done: {type: end}
edges:
  - {from: s, to: provision}
  - {from: provision, to: deploy}
  - {from: deploy, to: approve}
  - {from: approve, to: done}
`);
  const executors = builtinExecutors().register({
    type: "custom:effect",
    execute: async (ctx) => {
      appendFileSync(effectsFile, `${ctx.nodeId}\n`);
      onEffect?.(ctx.nodeId);
      return completed();
    },
  });
  return new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    executors,
    humanInput: new PausingHumanInput(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
  });
}
