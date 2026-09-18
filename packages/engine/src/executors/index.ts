import { agentExecutor } from "./agent-step.js";
import { decisionExecutor, endExecutor, gateExecutor, setExecutor, startExecutor } from "./basic.js";
import { loopExecutor, parallelExecutor, subworkflowExecutor } from "./containers.js";
import { materializeWorkItemsExecutor } from "../program/executors.js";
import { decisionMatrixExecutor, planAwaitExecutor, planDispatchExecutor, planRegisterExecutor, planScheduleExecutor } from "../plan/executors.js";
import { NodeExecutorRegistry } from "./types.js";

export * from "./types.js";
export { agentExecutor, runAgentTurn, validateArtifact, watchForArtifacts, type AgentTurnSpec, type AgentTurnOutcome } from "./agent-step.js";
export { startExecutor, endExecutor, setExecutor, decisionExecutor, gateExecutor, askHuman } from "./basic.js";
export { loopExecutor, parallelExecutor, subworkflowExecutor, pausedByChildren, FanOut } from "./containers.js";

/** All node types ORCA ships with, including the program-level and planning custom nodes. */
export function builtinExecutors(): NodeExecutorRegistry {
  return new NodeExecutorRegistry()
    .register(startExecutor)
    .register(endExecutor)
    .register(setExecutor)
    .register(agentExecutor)
    .register(decisionExecutor)
    .register(gateExecutor)
    .register(loopExecutor)
    .register(parallelExecutor)
    .register(subworkflowExecutor)
    .register(materializeWorkItemsExecutor)
    .register(planRegisterExecutor)
    .register(decisionMatrixExecutor)
    .register(planScheduleExecutor)
    .register(planDispatchExecutor)
    .register(planAwaitExecutor);
}
