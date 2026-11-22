/**
 * Scoped capabilities (#335) on the engine side: skill digests from the daemon's disk, and the
 * one place every caller - workflow validation, launch preflight, launch provenance and
 * session open - turns an agent step into a resolved manifest.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  OrcaError,
  resolveCapabilities,
  secretRefs,
  type AgentSelector,
  type AgentSpec,
  type CapabilityCheck,
  type CapabilityIssue,
  type CapabilityScope,
  type NodeDef,
  type ResolveCapabilitiesResult,
  type SkillDefinition,
  type SkillDigestResult,
  type WorkflowDefinition,
  type WorkflowGraph,
} from "@orca/core";
import type { AgentRegistry } from "@orca/agents";

/** A skill larger than this is refused rather than hashed: skills are instructions, not data. */
const SKILL_MAX_BYTES = 16 * 1024 * 1024;

/** One file of a skill as read: its path inside the skill (POSIX separators) and its bytes. */
export interface SkillFile {
  rel: string;
  bytes: Buffer;
}

/**
 * Read a skill's files, refusing a symbolic link rather than following it, so a skill is
 * always files that are inside it. A single-file skill is one file named by its own name.
 * Sorted by path.
 */
export function readSkillFiles(
  skill: SkillDefinition,
  baseDir: string | undefined,
): { files: SkillFile[] } | { error: string } {
  if (!isAbsolute(skill.path) && baseDir === undefined)
    return { error: `skill path '${skill.path}' is relative, and no config directory is known to resolve it against` };
  const root = isAbsolute(skill.path) ? skill.path : resolve(baseDir!, skill.path);
  const found: { rel: string; abs: string; size: number }[] = [];
  let total = 0;
  const visit = (abs: string, rel: string): string | undefined => {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink())
      return `skill '${rel || skill.path}' contains a symbolic link, which ORCA does not follow`;
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        const problem = visit(join(abs, name), rel ? `${rel}/${name}` : name);
        if (problem) return problem;
      }
      return undefined;
    }
    if (!stat.isFile()) return `skill path '${skill.path}' contains something that is neither a file nor a directory`;
    total += stat.size;
    if (total > SKILL_MAX_BYTES) return `skill '${skill.path}' is larger than ${SKILL_MAX_BYTES} bytes`;
    found.push({ rel, abs, size: stat.size });
    return undefined;
  };
  try {
    const top = lstatSync(root);
    const problem = top.isFile()
      ? (found.push({ rel: relative(resolve(root, ".."), root).split(sep).join("/"), abs: root, size: top.size }),
        top.size > SKILL_MAX_BYTES ? `skill '${skill.path}' is larger than ${SKILL_MAX_BYTES} bytes` : undefined)
      : visit(root, "");
    if (problem) return { error: problem };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      error:
        code === "ENOENT"
          ? `skill path '${skill.path}' does not exist`
          : `skill path '${skill.path}' cannot be read (${code ?? "error"})`,
    };
  }
  try {
    return {
      files: found
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
        .map((f) => ({ rel: f.rel, bytes: readFileSync(f.abs) })),
    };
  } catch (error) {
    return { error: `skill path '${skill.path}' cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
}

/**
 * `sha256:` over a skill's files: each file's path relative to the skill (POSIX separators),
 * its size and its bytes, in sorted path order. Computed from the bytes given, so content
 * read once can be both hashed and delivered.
 */
export function skillFilesDigest(files: readonly SkillFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.rel}\0${file.bytes.length}\0`);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** A skill's content digest as it is on disk now (`skillFilesDigest` over `readSkillFiles`). */
export function skillDigest(skill: SkillDefinition, baseDir: string | undefined): SkillDigestResult {
  const read = readSkillFiles(skill, baseDir);
  return "error" in read ? read : { digest: skillFilesDigest(read.files) };
}

/** The `capabilities` field of the agent instruction a node carries, if it has one. */
export function nodeCapabilityScope(node: NodeDef | undefined): { scope: CapabilityScope | undefined; sub: string } {
  if (node?.type === "agent") return { scope: node.capabilities, sub: "" };
  if (node?.type === "decision" && node.source.kind === "agent")
    return { scope: node.source.capabilities, sub: ".source" };
  return { scope: undefined, sub: "" };
}

export interface NodeCapabilityInput {
  registry: AgentRegistry;
  agent: Pick<AgentSpec, "id" | "mcpServers" | "capabilities">;
  workflow: CapabilityScope | undefined;
  nodeId: string;
  node: CapabilityScope | undefined;
  /** Prefix for the node's issue paths; `workflow.nodes.<id>` by default. */
  nodePath?: string;
  workflowPath?: string;
  /** Hash selected skills (true everywhere a run is involved). */
  digests: boolean;
}

/** Resolve one agent step. The single entry point all callers share. */
export function resolveNodeCapabilities(input: NodeCapabilityInput): ResolveCapabilitiesResult {
  const { catalog, baseDir } = input.registry.capabilities();
  const nodePath = input.nodePath ?? `workflow.nodes.${input.nodeId}`;
  return resolveCapabilities({
    catalog,
    agent: { id: input.agent.id, mcpServers: input.agent.mcpServers, capabilities: input.agent.capabilities },
    workflow: { path: input.workflowPath ?? "workflow", source: "workflow.capabilities", scope: input.workflow },
    // The source names the node, not the path validation printed, so every caller records the same one.
    node: { path: nodePath, source: `workflow.nodes.${input.nodeId}.capabilities`, scope: input.node },
    ...(input.digests ? { skillDigest: (_id: string, skill: SkillDefinition) => skillDigest(skill, baseDir) } : {}),
  });
}

/**
 * What a step's resolved set needs that this orchestrator cannot give a session.
 *
 * Catalog MCP servers and skills (#337) are given to a session only through the
 * server-verified use decision (the run owner's `capabilities` grant). A caller with no such
 * decision (`catalog: false`) refuses them. Whether the host has each server's command, and
 * whether the agent accepts skills, is checked when the session opens.
 *
 * The agent's own legacy inline `mcpServers` need neither: config authority put them on it.
 */
export function deliveryIssues(
  result: ResolveCapabilitiesResult,
  nodePath: string,
  delivery: { catalog: boolean } = { catalog: true },
): CapabilityIssue[] {
  if (delivery.catalog) return [];
  const issues: CapabilityIssue[] = [];
  const list = (ids: string[]) => ids.map((id) => `'${id}'`).join(", ");
  const servers = result.manifest.mcpServers.filter((m) => m.catalog).map((m) => m.id);
  if (servers.length)
    issues.push({
      path: `${nodePath}.capabilities.mcpServers`,
      message: `selects catalog MCP server${servers.length > 1 ? "s" : ""} ${list(servers)}, and this daemon has no server-verified use check to give ${
        servers.length > 1 ? "them" : "it"
      } to a session with. Run it through a daemon or an admitted run, or define the server inline on the agent`,
    });
  const skills = result.manifest.skills.map((s) => s.id);
  if (skills.length)
    issues.push({
      path: `${nodePath}.capabilities.skills`,
      message: `selects skill${skills.length > 1 ? "s" : ""} ${list(skills)}, and this daemon has no server-verified use check to give ${
        skills.length > 1 ? "them" : "it"
      } to a session with. Run it through a daemon or an admitted run`,
    });
  return issues;
}

/** The most skill content one step may carry inline in its prompts. */
export const SKILL_DELIVERY_MAX_BYTES = 256 * 1024;

/**
 * A selected skill as it will be delivered: its files read once, digest computed over the
 * very bytes that will be sent, and each file decoded as UTF-8 text. Refused when it no
 * longer hashes to `expected` (what the launch recorded), is not text, or the step's skills
 * together are larger than `SKILL_DELIVERY_MAX_BYTES`.
 */
export function readSkillForDelivery(
  id: string,
  skill: SkillDefinition,
  baseDir: string | undefined,
  expected: string | undefined,
): { files: { rel: string; text: string }[]; digest: string; bytes: number } | { error: string } {
  const read = readSkillFiles(skill, baseDir);
  if ("error" in read) return read;
  const digest = skillFilesDigest(read.files);
  if (expected !== undefined && digest !== expected)
    return { error: `skill '${id}' changed since the run was launched (now ${digest}); start a new run to use it` };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: { rel: string; text: string }[] = [];
  let bytes = 0;
  for (const file of read.files) {
    bytes += file.bytes.length;
    try {
      files.push({ rel: file.rel, text: decoder.decode(file.bytes) });
    } catch {
      return { error: `skill '${id}' file '${file.rel}' is not UTF-8 text, and skills are delivered as text` };
    }
  }
  return { files, digest, bytes };
}

/** The refusal a launch or a session open throws for a step whose capabilities do not resolve. */
export function capabilityRefusal(nodeId: string, issues: CapabilityIssue[]): OrcaError {
  const listed = issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`);
  return new OrcaError(
    "CONFIG_INVALID",
    `capabilities for step '${nodeId}' do not resolve: ${listed.join("; ")}${
      issues.length > 3 ? `; and ${issues.length - 3} more` : ""
    }`,
    { nodeId, errors: issues },
  );
}

/** `ValidationContext.checkCapabilities` over a registry: a step that cannot run is a warning at load. */
export function capabilityChecker(registry: AgentRegistry) {
  return (check: CapabilityCheck) => {
    if (!registry.canResolve(check.agent)) return { errors: [], warnings: [] };
    const { agent } = registry.resolve(check.agent);
    const result = resolveNodeCapabilities({
      registry,
      agent,
      workflow: check.workflow,
      workflowPath: check.workflowPath,
      nodeId: check.nodeId,
      node: check.node,
      nodePath: check.nodePath,
      digests: true,
    });
    return { errors: result.errors, warnings: [...result.warnings, ...deliveryIssues(result, check.nodePath)] };
  };
}

/** One agent instruction (an agent node, or an agent decision's source) anywhere in a definition. */
export interface AgentInstruction {
  /** The node's id inside its own graph: what the step runs as. */
  nodeId: string;
  /**
   * Unique across the definition: the node id, prefixed for a nested graph by the inline path a
   * child run's workflow id carries (`loop::build`, `fan::branch::review`).
   */
  qualifiedId: string;
  nodePath: string;
  agent: AgentSelector;
  template?: string | undefined;
  scope: CapabilityScope | undefined;
}

/** Every agent instruction in a definition, nested inline graphs included (not subworkflow refs). */
export function agentInstructions(graph: WorkflowGraph, prefix = "workflow", inline = ""): AgentInstruction[] {
  const out: AgentInstruction[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const path = `${prefix}.nodes.${nodeId}`;
    const qualify = (id: string) => (inline ? `${inline}${INLINE_PATH_SEP}${id}` : id);
    if (node.type === "agent")
      out.push({
        nodeId,
        qualifiedId: qualify(nodeId),
        nodePath: path,
        agent: node.agent,
        template: node.template,
        scope: node.capabilities,
      });
    else if (node.type === "decision" && node.source.kind === "agent")
      out.push({
        nodeId,
        qualifiedId: qualify(nodeId),
        nodePath: `${path}.source`,
        agent: node.source.agent,
        template: node.source.template,
        scope: node.source.capabilities,
      });
    else if (node.type === "loop" && "graph" in node.body)
      out.push(...agentInstructions(node.body.graph, `${path}.body`, qualify(nodeId)));
    else if (node.type === "parallel") {
      if (node.forEach?.body && "graph" in node.forEach.body)
        out.push(...agentInstructions(node.forEach.body.graph, `${path}.forEach.body`, qualify(nodeId)));
      for (const [branch, ref] of Object.entries(node.branches ?? {}))
        if ("graph" in ref)
          out.push(
            ...agentInstructions(
              ref.graph,
              `${path}.branches.${branch}`,
              qualify(`${nodeId}${INLINE_PATH_SEP}${branch}`),
            ),
          );
    }
  }
  return out;
}

/** The orchestrator's `INLINE_SEP`, repeated here to keep this module free of an import cycle. */
const INLINE_PATH_SEP = "::";

/**
 * Launch preflight: every agent step in the definition, under the run's role overrides, must
 * resolve and be deliverable. Throws the first step's refusal, naming its fields.
 */
export function preflightCapabilities(
  registry: AgentRegistry,
  def: WorkflowDefinition,
  delivery: { catalog: boolean } = { catalog: true },
): void {
  for (const step of agentInstructions(def)) {
    if (!registry.canResolve(step.agent)) continue;
    const { agent } = registry.resolve(step.agent);
    const result = resolveNodeCapabilities({
      registry,
      agent,
      workflow: def.capabilities,
      nodeId: step.nodeId,
      node: step.scope,
      nodePath: step.nodePath,
      digests: true,
    });
    const issues = [...result.errors, ...deliveryIssues(result, step.nodePath, delivery)];
    if (issues.length) throw capabilityRefusal(step.nodeId, issues);
  }
}

/**
 * Launch preflight without a secret use check (#336): an agent step whose agent (its own env
 * or an inline MCP server's) uses a secret reference cannot be given it, so the launch is
 * refused, naming the step and the references, rather than failing at the step.
 */
export function preflightSecretReferences(registry: AgentRegistry, def: WorkflowDefinition): void {
  for (const step of agentInstructions(def)) {
    if (!registry.canResolve(step.agent)) continue;
    const { agent } = registry.resolve(step.agent);
    const ids = [
      ...new Set(
        [agent.env, ...agent.mcpServers.map((m) => m.env)].flatMap((env) => secretRefs(env).map((r) => r.ref.secret)),
      ),
    ];
    if (ids.length)
      throw new OrcaError(
        "CONFIG_INVALID",
        `step '${step.nodeId}' runs agent '${agent.id}', which uses secret reference${ids.length > 1 ? "s" : ""} ${ids
          .map((id) => `'${id}'`)
          .join(
            ", ",
          )}, and this daemon has no server-verified use check to deliver ${ids.length > 1 ? "them" : "it"} with yet`,
        { nodeId: step.nodeId, agentId: agent.id, secrets: ids, reason: "unauthorized" },
      );
  }
}
