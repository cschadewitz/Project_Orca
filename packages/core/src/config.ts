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
    /** The git remote a delegated run's named ref is fetched from (#883). Default `origin`. */
    fetchRemote: z.string().min(1).optional(),
    /**
     * The refs a delegated run may name (#883): fully qualified (`refs/heads/main`), or a
     * prefix ending in `/*` (`refs/heads/release/*`). Absent or empty, every ref is refused.
     */
    allowedRefs: z
      .array(
        z.string().regex(/^refs\/(?:heads|tags)\/(?:[A-Za-z0-9._+@-]+\/)*(?:[A-Za-z0-9._+@-]+|\*)$/, {
          message: "a fully qualified branch or tag (refs/heads/… or refs/tags/…), or a prefix ending in /*",
        }),
      )
      .optional(),
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

/** The names config discovery looks for in each directory, in order. */
export const CONFIG_FILENAMES: readonly string[] = ["orca.config.yaml", "orca.config.yml", "orca.config.json"];
/**
 * The same names before the rename to Orrery, read with a warning when no current one is there
 * (until 0.10). Nothing writes them.
 */
export const LEGACY_CONFIG_FILENAMES: readonly string[] = [
  "orca.config.yaml", // rename-keep: pre-rename config name
  "orca.config.yml", // rename-keep: pre-rename config name
  "orca.config.json", // rename-keep: pre-rename config name
];

/** The config version that may hold `command` permission rules (#702). */
export const CONFIG_COMMAND_RULES_VERSION = 2;

export const OrcaConfigSchema = z
  .object({
    /**
     * 1, or 2 when an agent's permission rules use `command` (#702). Releases before 0.8 accept
     * only 1 and drop keys they do not know, so they would read `{kind: execute, command: "npm *"}`
     * as every command; asking for 2 makes them refuse the file instead.
     */
    version: z.union([z.literal(1), z.literal(CONFIG_COMMAND_RULES_VERSION)]).default(1),
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
    /**
     * Review judges (#701). `plainRules.judge` configures the hosted judge for plain-language
     * permission rules; it is validated where it is used (`@orca/agents`). A session gets a judge
     * only once the owner's grant and the daily budget are in place too (docs/plain-language-rules.md).
     */
    review: z
      .object({
        plainRules: z
          .object({
            judge: z.unknown().optional(),
            /**
             * The owner's opt-in to automatic decisions (#701 activation review): only `true` lets a judge be
             * prepared for a session at all. Absent or `false` (every config written before activation), nothing is
             * sent to the judge and every call a plain-language rule would cover goes to a person, whatever else is
             * set up. Pinned per run like the rest of `plainRules`; a change through the daemon needs
             * `permissions.grant`. Set it back to `false` (or remove it) to turn the judge off for new runs.
             */
            enabled: z.boolean().optional(),
            /**
             * Experimental, each off by default (#701, Cal 2026-11-23): kinds of call beyond reads and
             * searches a judge may be asked about. Each also needs its own owner disclosure grant
             * (`orca auth issue --judge-disclosure --judge-disclosure-kind ...`).
             *
             * - `edits`: advisory only (#701 review). A write ORCA performs itself through its file
             *   gate, to an existing file it resolved in the workspace: the judge's view is shown with
             *   the ask, and you answer it. A path does not show what a write changes.
             * - `mcpCalls`: a call to a tool on an MCP server ORCA runs, by a rule naming that server
             *   and tool in `mcp`; a covered verdict allows that one call once, while it stays
             *   eligible. Agent-reported MCP calls still ask.
             * - `commands`: advisory only. The judge's view is shown with the ask, and you answer it.
             *
             * A judge's answer is never saved as a standing grant, and typed deny and ask rules
             * still decide first.
             */
            experimental: z
              .object({
                kinds: z
                  .object({
                    edits: z.boolean().optional(),
                    mcpCalls: z.boolean().optional(),
                    commands: z.boolean().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .optional(),
      })
      .optional(),
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
    if (config.version < CONFIG_COMMAND_RULES_VERSION)
      config.agents.forEach((agent, i) =>
        agent.permissions.rules.forEach((rule, j) => {
          if (rule.match.command !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["agents", i, "permissions", "rules", j, "match", "command"],
              message: `a command rule needs version: ${CONFIG_COMMAND_RULES_VERSION} at the top of the config, so releases before 0.8 refuse it rather than read it as every command`,
            });
        }),
      );
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
