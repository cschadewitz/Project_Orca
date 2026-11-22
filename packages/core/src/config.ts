/**
 * `orca.config.yaml` - project-level configuration.
 *
 * Everything the engine needs to know about *where* agents run and *which*
 * agents fill which roles lives here, so workflow definitions stay portable
 * between machines and teams.
 */
import { z } from "zod";
import {
  AgentSpecSchema,
  CapabilitiesConfigSchema,
  HostSpecSchema,
  LOCAL_HOST_ID,
  RemoteDaemonSpecSchema,
  SecretsConfigSchema,
  validateCapabilitiesConfig,
  validateSecretReferences,
} from "./model/agent.js";
import { RiskMatrixInputSchema, SchedulingPolicySchema } from "./model/plan.js";

export const WorkspaceProviderConfigSchema = z.discriminatedUnion("provider", [
  /** Use `root` (or the current directory) as-is for every run. */
  z.object({ provider: z.literal("local"), root: z.string().optional(), hostId: z.string().default(LOCAL_HOST_ID) }),
  /** One git worktree + branch per work item under `worktreeRoot`. */
  z.object({
    provider: z.literal("git-worktree"),
    repo: z.string(),
    worktreeRoot: z.string().optional(),
    baseBranch: z.string().default("main"),
    branchPrefix: z.string().default("orca/"),
    /** Opt-in owned direct/root worktrees on the built-in local Linux host. */
    isolateRoots: z.boolean().optional(),
    hostId: z.string().default(LOCAL_HOST_ID),
  }),
  /** Inside a Kepler task: reuse the task's worktrees. */
  z.object({
    provider: z.literal("kepler"),
    taskDir: z.string().optional(),
    hostId: z.string().default(LOCAL_HOST_ID),
  }),
]);
export type WorkspaceProviderConfig = z.infer<typeof WorkspaceProviderConfigSchema>;

export const HumanInputConfigSchema = z.discriminatedUnion("mode", [
  /**
   * Gates/decisions needing a human answer park the run (`run.paused`, the process exits);
   * `orca answer <requestId> <option>` records the answer from any process and resumes it.
   * Agent `ask` permissions cannot be parked and are cancelled.
   */
  z.object({ mode: z.literal("pause") }),
  /** Interactive prompt on the terminal (CLI). */
  z.object({ mode: z.literal("cli") }),
  /**
   * Pick the first option (or `option`) for gates and questions. For unattended demos and
   * tests. An agent `ask` permission is *refused* rather than auto-allowed unless `option`
   * names one of the ids the agent offered — there is nobody here to approve it (#140).
   */
  z.object({ mode: z.literal("auto"), option: z.string().optional() }),
]);
export type HumanInputConfig = z.infer<typeof HumanInputConfigSchema>;

export const OrcaConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    /** Where event logs, artifacts and indexes are stored (relative to the config file). */
    storeDir: z.string().default(".orca"),
    admissionRetry: z
      .object({
        maxClaimsPerWorkspace: z.number().int().positive().default(100_000),
        maxClaimsPerPrincipal: z.number().int().positive().default(10_000),
      })
      .optional(),
    /**
     * Daemon-wide ceilings (#873). Absent means unlimited, the default: a cap applies only when
     * it is written here, and none is derived from the machine. Per-agent and per-host caps are
     * `agents[].maxSessions` and `hosts[].maxSessions`.
     */
    limits: z
      .object({
        /** At most this many agent sessions open at once in this daemon, across every run. */
        maxAgentSessions: z.number().int().positive().optional(),
        /**
         * How long a step may wait for an agent slot before it fails with `STEP_TIMEOUT`. Absent
         * means no deadline: a long queue drains however long the turns ahead of it take. Set it
         * to bound waits the queue reports as possibly never granted (per-run sessions of runs
         * that are themselves waiting).
         */
        agentSlotWaitMs: z.number().int().positive().optional(),
      })
      .optional(),
    /**
     * Outbound MCP servers and skills agents may be given, and the workspace scope that every
     * agent starts from (#335). Agents, workflows and nodes select from this catalog.
     */
    capabilities: CapabilitiesConfigSchema.optional(),
    /**
     * Where each referenced credential lives, and on which host (#336). Env values elsewhere
     * name one as `{ secret: <id> }`; the value is read on that host when it is needed.
     */
    secrets: SecretsConfigSchema.optional(),
    hosts: z.array(HostSpecSchema).default([{ id: LOCAL_HOST_ID, type: "local" }]),
    agents: z.array(AgentSpecSchema).default([]),
    /** Other ORCA daemons that `type: orca-daemon` agents delegate steps to (#883). */
    remotes: z.array(RemoteDaemonSpecSchema).default([]),
    /** Explicit role -> agent id mapping. Falls back to the first agent listing the role. */
    roles: z.record(z.string(), z.string()).default({}),
    /** Glob patterns (relative to the config file) for workflow YAML files. */
    workflows: z.array(z.string()).default(["workflows/**/*.yaml", "workflows/**/*.yml"]),
    /** Glob patterns for prompt template markdown files. */
    templates: z.array(z.string()).default(["templates/**/*.md"]),
    program: z
      .object({
        /** Workflow that accepts a Request and decomposes it. */
        workflow: z.string().default("program"),
        /** Workflow run per work item. */
        itemWorkflow: z.string().default("ai-sdlc"),
      })
      .default({ workflow: "program", itemWorkflow: "ai-sdlc" }),
    /** Long-term planning defaults applied to plans created by ORCA (see docs/PLANNING.md). */
    planning: z
      .object({
        /** Plan requests join unless the request says otherwise (`--var plan=<key>`). */
        plan: z.string().default("default"),
        planName: z.string().default("Default plan"),
        policy: SchedulingPolicySchema.partial().default({}),
        /** Partial: thresholds left out follow `scale` (see `RiskMatrixConfigSchema`). */
        riskMatrix: RiskMatrixInputSchema.default({}),
      })
      .default({ plan: "default", planName: "Default plan", policy: {}, riskMatrix: {} }),
    workspace: WorkspaceProviderConfigSchema.default({ provider: "local", hostId: LOCAL_HOST_ID }),
    humanInput: HumanInputConfigSchema.default({ mode: "pause" }),
    /** Plugin module specifiers (ESM) loaded at startup; see docs/EXTENSIBILITY.md. */
    plugins: z.array(z.string()).default([]),
  })
  .superRefine((config, ctx) => {
    // Catalog references in the config scopes are checked here, so a typo fails the config
    // rather than the first run that reaches the agent (#335).
    for (const issue of [...validateCapabilitiesConfig(config).errors, ...validateSecretReferences(config)])
      ctx.addIssue({ code: "custom", path: issue.path.split("."), message: issue.message });
    const remotes = new Set<string>();
    config.remotes.forEach((remote, i) => {
      if (remotes.has(remote.id))
        ctx.addIssue({ code: "custom", path: ["remotes", i, "id"], message: `duplicate remote id ${remote.id}` });
      remotes.add(remote.id);
    });
    config.agents.forEach((agent, i) => {
      if (agent.type === "orca-daemon" && agent.profile !== undefined && !remotes.has(agent.profile))
        ctx.addIssue({
          code: "custom",
          path: ["agents", i, "profile"],
          message: `no remotes[] entry has id ${agent.profile}`,
        });
    });
  });
export type OrcaConfig = z.infer<typeof OrcaConfigSchema>;

export function parseOrcaConfig(raw: unknown): OrcaConfig {
  return OrcaConfigSchema.parse(raw ?? {});
}
