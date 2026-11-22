/**
 * Scoped capabilities (#335): which outbound MCP servers and skills an agent session gets.
 *
 * Definitions live in one catalog, `capabilities.mcpServers` and `capabilities.skills` in
 * `orca.config.yaml`. Four scopes then select from it, each one applied over the last:
 *
 *   workspace  `capabilities.workspace`      config authority
 *   agent      `agents[].capabilities`       config authority (legacy `agents[].mcpServers` too)
 *   workflow   `capabilities` on a workflow  narrows, or opts in to what the agent permits
 *   node       `capabilities` on a node      the same, for one agent step or agent decision
 *
 * A selection is `replace`, or `enable` and/or `disable`. The two config scopes may also list
 * `available`: entries an agent does not get by default but a workflow or node may turn on.
 * Workflow and node scopes can never reach outside that permitted set, so a workflow file
 * cannot grant an agent anything the config owner did not.
 *
 * `resolveCapabilities` is the one resolver. Validation, launch preflight, launch provenance
 * and session open all call it with the same inputs, so they cannot disagree. It is pure: a
 * skill's content digest is computed by whoever can read the file (`skillDigest`).
 *
 * Availability is not permission: a selected MCP server's tool calls still go through the
 * agent's permission policy like any other tool call.
 */
import { z } from "zod";
import { EnvSchema, type Env } from "./secrets.js";

/** A catalog key: what selections, provenance and errors name an entry by. */
export const CapabilityIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "capability ids use letters, digits, '.', '_' and '-'");

const IdListSchema = z.array(CapabilityIdSchema);

/** What a workflow or node may write: narrow, or opt in to what the agent permits. */
export const CapabilitySelectionSchema = z
  .object({
    /** The whole set from here on. Cannot be combined with `enable` or `disable`. */
    replace: IdListSchema.optional(),
    enable: IdListSchema.optional(),
    disable: IdListSchema.optional(),
  })
  .strict();
export type CapabilitySelection = z.infer<typeof CapabilitySelectionSchema>;

/** What the config scopes may write: a selection plus entries workflows may opt in to. */
export const AuthorityCapabilitySelectionSchema = CapabilitySelectionSchema.extend({
  /** Not on by default, but a workflow or node may `enable` (or `replace` to) it. */
  available: IdListSchema.optional(),
}).strict();
export type AuthorityCapabilitySelection = z.infer<typeof AuthorityCapabilitySelectionSchema>;

export const CapabilityScopeSchema = z
  .object({
    mcpServers: CapabilitySelectionSchema.optional(),
    skills: CapabilitySelectionSchema.optional(),
  })
  .strict();
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;

export const AuthorityCapabilityScopeSchema = z
  .object({
    mcpServers: AuthorityCapabilitySelectionSchema.optional(),
    skills: AuthorityCapabilitySelectionSchema.optional(),
  })
  .strict();
export type AuthorityCapabilityScope = z.infer<typeof AuthorityCapabilityScopeSchema>;

/** An outbound MCP server passed to an agent in `session/new`. The catalog key is its name. */
export const McpServerDefinitionSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: EnvSchema.default({}),
  })
  .strict();
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

export const SkillDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "a digest is sha256:<64 hex digits>");

/**
 * A skill directory (or single file) on the daemon's machine. ORCA never fetches or installs
 * one. `digest` pins its content: a skill whose files no longer hash to it is refused.
 */
export const SkillDefinitionSchema = z
  .object({
    /** Relative to the config file's directory, or absolute. */
    path: z.string().min(1),
    /** The author's version label, recorded in provenance. ORCA does not interpret it. */
    version: z.string().min(1).optional(),
    digest: SkillDigestSchema.optional(),
    description: z.string().optional(),
  })
  .strict();
export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

export const CapabilitiesConfigSchema = z
  .object({
    mcpServers: z.record(CapabilityIdSchema, McpServerDefinitionSchema).default({}),
    skills: z.record(CapabilityIdSchema, SkillDefinitionSchema).default({}),
    /** The workspace scope: what every agent starts from. */
    workspace: AuthorityCapabilityScopeSchema.optional(),
  })
  .strict();
export type CapabilitiesConfig = z.infer<typeof CapabilitiesConfigSchema>;

export const EMPTY_CAPABILITIES: CapabilitiesConfig = { mcpServers: {}, skills: {} };

export type CapabilityKind = "mcpServers" | "skills";
export const CAPABILITY_KINDS: readonly CapabilityKind[] = ["mcpServers", "skills"];

export interface CapabilityIssue {
  path: string;
  message: string;
}

/** The `session/new` shape: legacy `agents[].mcpServers` entries already look like this. */
export interface ResolvedMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  /** Secret references stay references here; they are read at session open (#336). */
  env: Env;
}

export interface ResolvedMcpServer {
  id: string;
  /** The scope that decided this entry is in the set, e.g. `workflow.nodes.review.capabilities`. */
  source: string;
  server: ResolvedMcpServerConfig;
  /** From the shared catalog, rather than the agent's own legacy inline `mcpServers`. */
  catalog: boolean;
}
export interface ResolvedSkill {
  id: string;
  source: string;
  path: string;
  version?: string;
  digest?: string;
}
export interface CapabilityManifest {
  mcpServers: ResolvedMcpServer[];
  skills: ResolvedSkill[];
}

/** What provenance, previews and events may carry: identities and sources, never definitions. */
export const RedactedCapabilityManifestSchema = z.object({
  mcpServers: z.array(z.object({ id: z.string(), source: z.string() })),
  skills: z.array(
    z.object({ id: z.string(), source: z.string(), version: z.string().optional(), digest: z.string().optional() }),
  ),
});
export type RedactedCapabilityManifest = z.infer<typeof RedactedCapabilityManifestSchema>;

export function redactCapabilityManifest(manifest: CapabilityManifest): RedactedCapabilityManifest {
  return {
    mcpServers: manifest.mcpServers.map(({ id, source }) => ({ id, source })),
    skills: manifest.skills.map(({ id, source, version, digest }) => ({
      id,
      source,
      ...(version === undefined ? {} : { version }),
      ...(digest === undefined ? {} : { digest }),
    })),
  };
}

/** Stable comparison key for two redacted manifests (a pooled session, a launch record). */
export function capabilityManifestKey(manifest: RedactedCapabilityManifest): string {
  return JSON.stringify([manifest.mcpServers.map((m) => m.id), manifest.skills.map((s) => [s.id, s.digest ?? null])]);
}

export type SkillDigestResult = { digest: string } | { error: string };

export interface ResolveCapabilitiesInput {
  catalog: CapabilitiesConfig | undefined;
  agent: {
    id: string;
    mcpServers: ResolvedMcpServerConfig[];
    capabilities?: AuthorityCapabilityScope | undefined;
  };
  /** `path` prefixes error paths; `source` is what a manifest entry records. */
  workflow?: { path: string; source?: string; scope?: CapabilityScope | undefined } | undefined;
  node?: { path: string; source: string; scope?: CapabilityScope | undefined } | undefined;
  /** Digest a selected skill's content. Absent: skills resolve without a digest (static checks). */
  skillDigest?: ((id: string, skill: SkillDefinition) => SkillDigestResult) | undefined;
}

export interface ResolveCapabilitiesResult {
  manifest: CapabilityManifest;
  errors: CapabilityIssue[];
  warnings: CapabilityIssue[];
}

const NOUN: Record<CapabilityKind, string> = { mcpServers: "MCP server", skills: "skill" };

/**
 * Resolve one agent session's capabilities: workspace, then the agent (legacy inline MCP
 * servers first, then `agents[].capabilities`), then the workflow, then the node.
 *
 * Every problem is reported, not just the first, each under the field that caused it:
 * unknown, duplicate, conflicting and ambiguous references, and any workflow or node attempt
 * to turn on something outside the agent's permitted set. A result with errors must not be
 * used to start a session.
 */
export function resolveCapabilities(input: ResolveCapabilitiesInput): ResolveCapabilitiesResult {
  const catalog = input.catalog ?? EMPTY_CAPABILITIES;
  const errors: CapabilityIssue[] = [];
  const warnings: CapabilityIssue[] = [];
  const agentPath = `agents.${input.agent.id}`;

  // Legacy inline servers are agent-local catalog entries named by `name`.
  const legacy = new Map<string, ResolvedMcpServerConfig>();
  input.agent.mcpServers.forEach((server, index) => {
    const path = `${agentPath}.mcpServers[${index}]`;
    if (legacy.has(server.name))
      errors.push({ path, message: `two MCP servers on agent '${input.agent.id}' are named '${server.name}'` });
    else if (Object.hasOwn(catalog.mcpServers, server.name))
      errors.push({
        path,
        message: `'${server.name}' is ambiguous: it names both this inline server and capabilities.mcpServers.${server.name}. Rename one, or move the inline server into the catalog`,
      });
    else legacy.set(server.name, server);
  });

  const state = {
    mcpServers: { active: new Map<string, string>(), permitted: new Set<string>() },
    skills: { active: new Map<string, string>(), permitted: new Set<string>() },
  };

  const known = (kind: CapabilityKind, id: string, agentLocal: boolean): boolean =>
    Object.hasOwn(catalog[kind], id) || (agentLocal && kind === "mcpServers" && legacy.has(id));

  const apply = (
    kind: CapabilityKind,
    selection: AuthorityCapabilitySelection | undefined,
    where: { path: string; source: string; authority: boolean; agentLocal: boolean; label: string },
  ) => {
    if (!selection) return;
    const { active, permitted } = state[kind];
    const base = `${where.path}.${kind}`;
    const lists = (["replace", "enable", "disable", "available"] as const).filter((op) => selection[op] !== undefined);
    let ok = true;
    for (const op of lists) {
      const seen = new Set<string>();
      selection[op]!.forEach((id, i) => {
        if (seen.has(id)) {
          errors.push({ path: `${base}.${op}[${i}]`, message: `lists ${NOUN[kind]} '${id}' twice` });
          ok = false;
        }
        seen.add(id);
        if (!known(kind, id, where.agentLocal)) {
          errors.push({
            path: `${base}.${op}[${i}]`,
            message: `no ${NOUN[kind]} '${id}' is defined in capabilities.${kind}${
              kind === "mcpServers" && where.agentLocal ? ` or on agent '${input.agent.id}'` : ""
            }`,
          });
          ok = false;
        }
      });
    }
    if (selection.replace && (selection.enable || selection.disable)) {
      errors.push({ path: base, message: "'replace' cannot be combined with 'enable' or 'disable'" });
      ok = false;
    }
    const disabled = new Set(selection.disable ?? []);
    for (const op of ["enable", "available"] as const)
      for (const id of selection[op] ?? [])
        if (disabled.has(id)) {
          errors.push({ path: `${base}.disable`, message: `${NOUN[kind]} '${id}' is both in '${op}' and 'disable'` });
          ok = false;
        }
    if (!where.authority)
      for (const op of ["replace", "enable"] as const)
        (selection[op] ?? []).forEach((id, i) => {
          if (!known(kind, id, where.agentLocal) || permitted.has(id)) return;
          errors.push({
            path: `${base}.${op}[${i}]`,
            message: `${where.label} cannot turn on ${NOUN[kind]} '${id}': agent '${input.agent.id}' is not permitted to use it. Enable it, or list it under 'available', in agents[].capabilities.${kind} or capabilities.workspace.${kind}`,
          });
          ok = false;
        });
    if (!ok) return;

    if (selection.replace) {
      active.clear();
      for (const id of selection.replace) active.set(id, where.source);
      if (where.authority) {
        permitted.clear();
        for (const id of selection.replace) permitted.add(id);
      }
    }
    for (const id of selection.enable ?? []) {
      active.set(id, where.source);
      if (where.authority) permitted.add(id);
    }
    for (const id of selection.disable ?? []) {
      if (!active.has(id) && !(where.authority && permitted.has(id)))
        warnings.push({
          path: `${base}.disable`,
          message: `${NOUN[kind]} '${id}' is not enabled at this point, so disabling it changes nothing`,
        });
      active.delete(id);
      if (where.authority) permitted.delete(id);
    }
    if (where.authority) for (const id of selection.available ?? []) permitted.add(id);
  };

  for (const kind of CAPABILITY_KINDS)
    apply(kind, catalog.workspace?.[kind], {
      path: "capabilities.workspace",
      source: "config.capabilities.workspace",
      authority: true,
      agentLocal: false,
      label: "capabilities.workspace",
    });
  for (const name of legacy.keys()) {
    state.mcpServers.active.set(name, `${agentPath}.mcpServers`);
    state.mcpServers.permitted.add(name);
  }
  for (const kind of CAPABILITY_KINDS)
    apply(kind, input.agent.capabilities?.[kind], {
      path: `${agentPath}.capabilities`,
      source: `${agentPath}.capabilities`,
      authority: true,
      agentLocal: true,
      label: `agent '${input.agent.id}'`,
    });
  if (input.workflow)
    for (const kind of CAPABILITY_KINDS)
      apply(kind, input.workflow.scope?.[kind], {
        path: `${input.workflow.path}.capabilities`,
        source: input.workflow.source ?? "workflow.capabilities",
        authority: false,
        agentLocal: true,
        label: "the workflow",
      });
  if (input.node)
    for (const kind of CAPABILITY_KINDS)
      apply(kind, input.node.scope?.[kind], {
        path: `${input.node.path}.capabilities`,
        source: input.node.source,
        authority: false,
        agentLocal: true,
        label: "this node",
      });

  const manifest: CapabilityManifest = { mcpServers: [], skills: [] };
  for (const [id, source] of state.mcpServers.active) {
    const inline = legacy.get(id);
    const def = inline ?? catalog.mcpServers[id];
    if (!def) continue;
    manifest.mcpServers.push({
      id,
      source,
      server: { name: id, command: def.command, args: [...def.args], env: { ...def.env } },
      catalog: inline === undefined,
    });
  }
  for (const [id, source] of state.skills.active) {
    const def = catalog.skills[id];
    if (!def) continue;
    const entry: ResolvedSkill = {
      id,
      source,
      path: def.path,
      ...(def.version === undefined ? {} : { version: def.version }),
    };
    if (input.skillDigest) {
      const digest = input.skillDigest(id, def);
      if ("error" in digest) errors.push({ path: `capabilities.skills.${id}`, message: digest.error });
      else if (def.digest && def.digest !== digest.digest)
        errors.push({
          path: `capabilities.skills.${id}.digest`,
          message: `skill '${id}' content is ${digest.digest}, but its pinned digest is ${def.digest}. Review the change, then update the pin`,
        });
      else entry.digest = digest.digest;
    } else if (def.digest) entry.digest = def.digest;
    manifest.skills.push(entry);
  }
  return { manifest, errors, warnings };
}

/**
 * Static checks for the config scopes alone: catalog references in `capabilities.workspace`
 * and every agent's `capabilities` and inline servers. Workflow and node scopes are checked
 * when the workflow is validated.
 */
export function validateCapabilitiesConfig(config: {
  capabilities?: CapabilitiesConfig | undefined;
  agents: { id: string; mcpServers: ResolvedMcpServerConfig[]; capabilities?: AuthorityCapabilityScope | undefined }[];
}): { errors: CapabilityIssue[]; warnings: CapabilityIssue[] } {
  const errors: CapabilityIssue[] = [];
  const warnings: CapabilityIssue[] = [];
  const seen = new Set<string>();
  const add = (into: CapabilityIssue[], issues: CapabilityIssue[]) => {
    for (const issue of issues) {
      const key = `${issue.path}\0${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      into.push(issue);
    }
  };
  const agents = config.agents.length ? config.agents : [{ id: "(any)", mcpServers: [] }];
  for (const agent of agents) {
    const result = resolveCapabilities({ catalog: config.capabilities, agent });
    add(errors, result.errors);
    add(warnings, result.warnings);
  }
  return { errors, warnings };
}
