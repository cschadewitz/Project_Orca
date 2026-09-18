/**
 * Plugin API. A plugin is an ES module exporting `default: OrcaPlugin`. It can
 * add node executors, prompt templates, workflows, hosts/agents, planning
 * signal extractors, or wrap the human-input port. Listed under `plugins:` in
 * orca.config.yaml.
 */
import type { AgentRegistry } from "@orca/agents";
import type { TemplateRegistry, WorkflowRegistry } from "@orca/core";
import type { NodeExecutorRegistry } from "./executors/types.js";
import type { HumanInputPort } from "./human-input.js";
import type { PlanService } from "./plan/service.js";
import type { WorkspaceProvider } from "./workspace/provider.js";

export interface PluginApi {
  executors: NodeExecutorRegistry;
  templates: TemplateRegistry;
  workflows: WorkflowRegistry;
  agents: AgentRegistry;
  /** The planning layer: register signal extractors, or read/mutate plans at startup. */
  plan: PlanService;
  setHumanInput(port: HumanInputPort): void;
  setWorkspaceProvider(provider: WorkspaceProvider): void;
}

export interface OrcaPlugin {
  name: string;
  register(api: PluginApi): void | Promise<void>;
}

export function definePlugin(plugin: OrcaPlugin): OrcaPlugin {
  return plugin;
}
