/**
 * Scoped capabilities (#335) on the engine side: skill digests from the daemon's disk, and the
 * one place every caller - workflow validation, launch preflight, launch provenance and
 * session open - turns an agent step into a resolved manifest.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
/** Files and directories a skill may hold: each file becomes a block, even an empty one. */
const SKILL_MAX_ENTRIES = 1024;

/** One file of a skill as read: its path inside the skill (POSIX separators) and its bytes. */
export interface SkillFile {
  rel: string;
  bytes: Buffer;
}

/**
 * Linux only: `/proc/self/fd/<fd>` names the very directory an open descriptor holds, so a
 * walk through it is `openat`: renaming or replacing a directory on the path after it was
 * opened cannot move the walk elsewhere.
 */
const PROC_FD = process.platform === "linux" && existsSync("/proc/self/fd");
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

class SkillReadRefusal extends Error {
  constructor(
    message: string,
    readonly tooLarge = false,
  ) {
    super(message);
  }
}

/** The same filesystem object, by device and inode. */
function sameObject(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read at most `budget` bytes from `fd`, failing once there would be more: the allocation is
 * bounded by the budget, never by what the file says its size is.
 */
function readBounded(fd: number, sizeHint: number, budget: number, what: string): Buffer {
  let buf = Buffer.allocUnsafe(Math.min(Math.max(sizeHint, 0), budget) + 1);
  let length = 0;
  for (;;) {
    if (length === buf.length) {
      if (buf.length > budget) throw new SkillReadRefusal(what, true);
      const grown = Buffer.allocUnsafe(Math.min(buf.length * 2, budget + 1));
      buf.copy(grown, 0, 0, length);
      buf = grown;
    }
    const n = readSync(fd, buf, length, buf.length - length, null);
    if (n === 0) break;
    length += n;
    if (length > budget) throw new SkillReadRefusal(what, true);
  }
  return Buffer.from(buf.subarray(0, length));
}

/**
 * Whether no one but root or the daemon's own account can replace anything at `dir` or above
 * it: each directory up to `/` is owned by one of them and writable by neither group nor
 * others, unless it is sticky (like `/tmp`), where others cannot rename or remove what they
 * do not own.
 */
function trustedAncestors(dir: string): boolean {
  const uid = process.getuid?.();
  for (let at = dir; ; at = dirname(at)) {
    const info = lstatSync(at);
    if (!info.isDirectory()) return false;
    if (info.uid !== 0 && info.uid !== uid) return false;
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) return false;
    if (at === dirname(at)) return true;
  }
}

export interface ReadSkillOptions {
  /** The most content bytes, all files together; the read stops past it. */
  maxBytes?: number;
  /** The most files and directories together. */
  maxEntries?: number;
  /**
   * For delivery: walk only in ways that cannot be led outside the skill, and refuse where
   * that is not possible. The configured path is resolved once to its real path, every
   * directory above it must be one only root or the daemon's account can change, and a
   * directory skill is walked through its open directory descriptors (Linux). Elsewhere only
   * a single-file skill can be delivered, and on Windows none.
   */
  anchored?: boolean;
}

/**
 * Read a skill's files, within `maxBytes` and `maxEntries`. Each file and directory is opened
 * without following a symbolic link (`O_NOFOLLOW`), checked by its descriptor to be the
 * regular file or directory the walk found (same device and inode), and read through that
 * descriptor with the remaining budget as the bound. On Linux the walk goes through each
 * directory's open descriptor, so nothing outside the skill is ever opened, whatever is
 * renamed meanwhile. See `ReadSkillOptions.anchored` for what delivery requires. A
 * single-file skill is one file named by its own name. Sorted by path.
 */
export function readSkillFiles(
  skill: SkillDefinition,
  baseDir: string | undefined,
  options: ReadSkillOptions = {},
): { files: SkillFile[] } | { error: string; tooLarge?: true } {
  const maxBytes = options.maxBytes ?? SKILL_MAX_BYTES;
  const maxEntries = options.maxEntries ?? SKILL_MAX_ENTRIES;
  if (!isAbsolute(skill.path) && baseDir === undefined)
    return { error: `skill path '${skill.path}' is relative, and no config directory is known to resolve it against` };
  const configured = isAbsolute(skill.path) ? skill.path : resolve(baseDir!, skill.path);
  let root = configured;
  const tooLarge = `skill '${skill.path}' is larger than ${maxBytes} bytes`;
  const files: SkillFile[] = [];
  let total = 0;
  let entries = 0;
  const count = () => {
    if (++entries > maxEntries)
      throw new SkillReadRefusal(`skill '${skill.path}' has more than ${maxEntries} files and directories`);
  };
  const readFile = (path: string, rel: string, found: Stats) => {
    count();
    const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || !sameObject(opened, found))
        throw new SkillReadRefusal(`skill '${rel || skill.path}' changed while it was read`);
      const bytes = readBounded(fd, opened.size, maxBytes - total, tooLarge);
      total += bytes.length;
      files.push({ rel, bytes });
    } finally {
      closeSync(fd);
    }
  };
  const visit = (path: string, rel: string, found: Stats): void => {
    count();
    const fd = O_DIRECTORY ? openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW) : undefined;
    try {
      if (fd !== undefined && !sameObject(fstatSync(fd), found))
        throw new SkillReadRefusal(`skill '${rel || skill.path}' changed while it was read`);
      const dir = PROC_FD && fd !== undefined ? `/proc/self/fd/${fd}` : path;
      for (const name of readdirSync(dir).sort()) {
        const childRel = rel ? `${rel}/${name}` : name;
        const child = join(dir, name);
        const stat = lstatSync(child);
        if (stat.isSymbolicLink())
          throw new SkillReadRefusal(`skill '${childRel}' contains a symbolic link, which ORCA does not follow`);
        if (stat.isDirectory()) visit(child, childRel, stat);
        else if (stat.isFile()) readFile(child, childRel, stat);
        else
          throw new SkillReadRefusal(
            `skill path '${skill.path}' contains something that is neither a file nor a directory`,
          );
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  try {
    const named = lstatSync(configured);
    if (named.isSymbolicLink())
      return { error: `skill '${skill.path}' contains a symbolic link, which ORCA does not follow` };
    if (options.anchored) {
      if (process.platform === "win32" || O_NOFOLLOW === 0)
        return {
          error: `skill '${skill.path}' cannot be delivered from a Windows daemon: ORCA cannot read it safely there`,
        };
      root = realpathSync(configured);
      if (!trustedAncestors(dirname(root)))
        return {
          error: `skill '${skill.path}' is under a directory that someone other than root or the daemon's account can change, so it cannot be delivered`,
        };
      if (named.isDirectory() && !PROC_FD)
        return {
          error: `skill '${skill.path}' is a directory, which ORCA can deliver safely only from a Linux daemon; use a single-file skill here`,
        };
    }
    const top = lstatSync(root);
    if (!sameObject(top, named)) return { error: `skill '${skill.path}' changed while it was read` };
    if (top.isFile()) readFile(root, relative(resolve(configured, ".."), configured).split(sep).join("/"), top);
    else if (top.isDirectory()) visit(root, "", top);
    else return { error: `skill path '${skill.path}' contains something that is neither a file nor a directory` };
  } catch (error) {
    if (error instanceof SkillReadRefusal)
      return error.tooLarge ? { error: error.message, tooLarge: true } : { error: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    return {
      error:
        code === "ENOENT"
          ? `skill path '${skill.path}' does not exist`
          : code === "ELOOP"
            ? `skill '${skill.path}' contains a symbolic link, which ORCA does not follow`
            : `skill path '${skill.path}' cannot be read (${code ?? "error"})`,
    };
  }
  return { files: files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)) };
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
/** The most files and directories one skill may bring to a step's prompts. */
export const SKILL_DELIVERY_MAX_FILES = 64;

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
  /** What is left of the step's `SKILL_DELIVERY_MAX_BYTES`: the read stops past it. */
  budget: number = SKILL_DELIVERY_MAX_BYTES,
): { files: { rel: string; text: string }[]; digest: string; bytes: number } | { error: string; tooLarge?: true } {
  const read = readSkillFiles(skill, baseDir, {
    maxBytes: budget,
    maxEntries: SKILL_DELIVERY_MAX_FILES,
    anchored: true,
  });
  if ("error" in read) return read;
  const digest = skillFilesDigest(read.files);
  if (expected !== undefined && digest !== expected)
    return { error: `skill '${id}' changed since the run was launched (now ${digest}); start a new run to use it` };
  // `ignoreBOM` keeps a leading byte-order mark in the text, so the text sent is exactly the
  // bytes the digest names.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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
