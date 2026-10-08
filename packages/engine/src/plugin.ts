/**
 * Plugin API. A plugin is an ES module exporting `default: OrcaPlugin`. It can
 * add node executors, prompt templates, workflows, hosts/agents, planning
 * signal extractors, or wrap the human-input port. Listed under `plugins:` in
 * orca.config.yaml.
 *
 * An executor with a `validate(node)` has its custom node's fields checked when the
 * workflows are validated - bootstrap and `orca validate` both load the plugins first (#308).
 */
import type { AgentRegistry } from "@orca/agents";
import type { TemplateRegistry, WorkflowRegistry } from "@orca/core";
import type { NodeExecutor, NodeExecutorRegistry } from "./executors/types.js";
import type { HumanInputPort } from "./human-input.js";
import type { PlanService } from "./plan/service.js";
import type { WorkspaceProvider } from "./workspace/provider.js";
import { z } from "zod";
import { OrcaError } from "@orca/core";

/** Non-secret, explicitly validated behavioral inputs, never credentials or live authority. */
export type PluginRestorationData = { [key: string]: PluginRestorationValue };
export type PluginRestorationValue =
  string | number | boolean | null | PluginRestorationData | PluginRestorationValue[];
export const PluginRestorationIdentitySchema = z.strictObject({
  id: z.string().min(1).max(200),
  schemaVersion: z.number().int().positive(),
  /** Immutable identity of the whole implementation, not merely its entry module. */
  codeVersion: z.string().min(1).max(200),
  /** Immutable content identity of the complete dependency closure (e.g. a bundle/lock digest). */
  dependencyIdentity: z.string().min(1).max(200),
});
export type PluginRestorationIdentity = z.infer<typeof PluginRestorationIdentitySchema>;
/** Trusted composition verifies the whole implementation/dependency closure against installed release evidence. */
export type PluginRestorationIdentityVerifier = (candidate: {
  spec: string;
  identity: PluginRestorationIdentity;
  entry: { url: string; digest: string };
}) => boolean | Promise<boolean>;
export interface PluginRestoration {
  readonly identity: PluginRestorationIdentity;
  /** Capture the inputs used by register. Do not reread moving defaults or resolve credentials. */
  capture(): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Explicit allowlist/schema check: reject extra fields and all resolved secret values. */
  validate(data: unknown): boolean;
  /** Pure reconstruction only. No providers, provisioning, consent, grants, or current defaults. */
  restore(data: PluginRestorationData, api: PluginRestorationApi): void | Promise<void>;
}
/** v1 permits only custom executor registration; other callback categories refuse recovery. */
export interface PluginRestorationApi {
  executors: { register(executor: NodeExecutor): void };
}
export const PluginRestorationRecordSchema = z.strictObject({
  contractVersion: z.literal(1),
  spec: z.string().min(1).max(4096),
  entryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  identity: PluginRestorationIdentitySchema,
  data: z.json().refine((value) => value !== null && typeof value === "object" && !Array.isArray(value)),
  executors: z.array(z.string().regex(/^custom:.+/)).max(256),
});
export const PluginRestorationRecordsSchema = z.array(PluginRestorationRecordSchema).min(1).max(64);
export type PluginRestorationRecord = z.infer<typeof PluginRestorationRecordSchema>;
export type PluginRestorationReason =
  | "invalid_descriptor"
  | "incompatible_identity"
  | "identity_unverified"
  | "unavailable_plugin"
  | "unsupported_registration"
  | "legacy_generation"
  | "reconstruction_failed";
/** Stable non-secret diagnostic; never propagate plugin exceptions or descriptor values. */
export function pluginRestorationRefusal(reason: PluginRestorationReason): OrcaError {
  return new OrcaError(
    "RUN_STATE",
    `plugin restoration refused: ${reason}; use a compatible installation or the original process`,
    {
      pluginRestorationReason: reason,
    },
  );
}

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
  restoration?: PluginRestoration;
}

export function definePlugin(plugin: OrcaPlugin): OrcaPlugin {
  return plugin;
}
