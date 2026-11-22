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

/**
 * `sha256:` over a skill's files: each file's path relative to the skill (POSIX separators),
 * its size and its bytes, in sorted path order. A single-file skill hashes the same way with
 * its own name as the path. A symbolic link is refused rather than followed, so a digest
 * always describes files that are inside the skill.
 */
export function skillDigest(skill: SkillDefinition, baseDir: string | undefined): SkillDigestResult {
  if (!isAbsolute(skill.path) && baseDir === undefined)
    return { error: `skill path '${skill.path}' is relative, and no config directory is known to resolve it against` };
  const root = isAbsolute(skill.path) ? skill.path : resolve(baseDir!, skill.path);
  const files: { rel: string; abs: string; size: number }[] = [];
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
    files.push({ rel, abs, size: stat.size });
    return undefined;
  };
  try {
    const top = lstatSync(root);
    const problem = top.isFile()
      ? (files.push({ rel: relative(resolve(root, ".."), root).split(sep).join("/"), abs: root, size: top.size }),
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
  const hash = createHash("sha256");
  try {
    for (const file of files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
      hash.update(`${file.rel}\0${file.size}\0`);
      hash.update(readFileSync(file.abs));
    }
  } catch (error) {
    return { error: `skill path '${skill.path}' cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  return { digest: `sha256:${hash.digest("hex")}` };
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
 * What ORCA can hand an agent today. MCP servers go in `session/new`. Skills resolve, with an
 * identity and a content digest, but no agent session can receive one yet, so a step that
 * selects any is refused rather than started without them.
 */
export function deliveryIssues(result: ResolveCapabilitiesResult, nodePath: string): CapabilityIssue[] {
  return result.manifest.skills.length
    ? [
        {
          path: `${nodePath}.capabilities.skills`,
          message: `selects skill${result.manifest.skills.length > 1 ? "s" : ""} ${result.manifest.skills
            .map((s) => `'${s.id}'`)
            .join(", ")}, but this version of ORCA cannot deliver skills to an agent session yet. Remove ${
            result.manifest.skills.length > 1 ? "them" : "it"
          } from the agent's or workflow's selection to run this step`,
        },
      ]
    : [];
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

/** Every agent instruction in a definition, nested inline graphs included (not subworkflow refs). */
export function agentInstructions(
  graph: WorkflowGraph,
  prefix = "workflow",
): { nodeId: string; nodePath: string; agent: AgentSelector; scope: CapabilityScope | undefined }[] {
  const out: { nodeId: string; nodePath: string; agent: AgentSelector; scope: CapabilityScope | undefined }[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const path = `${prefix}.nodes.${nodeId}`;
    if (node.type === "agent") out.push({ nodeId, nodePath: path, agent: node.agent, scope: node.capabilities });
    else if (node.type === "decision" && node.source.kind === "agent")
      out.push({ nodeId, nodePath: `${path}.source`, agent: node.source.agent, scope: node.source.capabilities });
    else if (node.type === "loop" && "graph" in node.body)
      out.push(...agentInstructions(node.body.graph, `${path}.body`));
    else if (node.type === "parallel") {
      if (node.forEach?.body && "graph" in node.forEach.body)
        out.push(...agentInstructions(node.forEach.body.graph, `${path}.forEach.body`));
      for (const [branch, ref] of Object.entries(node.branches ?? {}))
        if ("graph" in ref) out.push(...agentInstructions(ref.graph, `${path}.branches.${branch}`));
    }
  }
  return out;
}

/**
 * Launch preflight: every agent step in the definition, under the run's role overrides, must
 * resolve and be deliverable. Throws the first step's refusal, naming its fields.
 */
export function preflightCapabilities(registry: AgentRegistry, def: WorkflowDefinition): void {
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
    const issues = [...result.errors, ...deliveryIssues(result, step.nodePath)];
    if (issues.length) throw capabilityRefusal(step.nodeId, issues);
  }
}
