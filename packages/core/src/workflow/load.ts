/** Load workflow definitions from YAML/JSON text or files. */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { OrcaError } from "../errors.js";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../model/workflow.js";
import { expandPatterns } from "../util/glob.js";
import { validateWorkflow, type ValidationContext } from "./validate.js";

export function parseWorkflow(text: string, sourceName = "<inline>"): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = sourceName.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new OrcaError("WORKFLOW_INVALID", `cannot parse ${sourceName}: ${(e as Error).message}`, {}, { cause: e });
  }
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OrcaError("WORKFLOW_INVALID", `${sourceName} does not match the workflow schema`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

export async function loadWorkflowFile(file: string, ctx?: ValidationContext): Promise<WorkflowDefinition> {
  const def = parseWorkflow(await readFile(file, "utf8"), basename(file));
  const result = validateWorkflow(def, ctx);
  if (!result.ok) throw new OrcaError("WORKFLOW_INVALID", `${file} failed validation`, { errors: result.errors, warnings: result.warnings });
  return def;
}

/** Load every workflow matched by `patterns` (relative ones resolved against `baseDir`) into a registry. */
export async function loadWorkflows(patterns: string[], baseDir: string): Promise<WorkflowRegistry> {
  const reg = new WorkflowRegistry();
  for (const f of await expandPatterns(patterns, baseDir)) reg.register(parseWorkflow(await readFile(f, "utf8"), f));
  return reg;
}

export class WorkflowRegistry {
  private readonly defs = new Map<string, WorkflowDefinition>();
  register(def: WorkflowDefinition): this {
    this.defs.set(def.id, def);
    return this;
  }
  has(id: string): boolean {
    return this.defs.has(id);
  }
  get(id: string): WorkflowDefinition {
    const d = this.defs.get(id);
    if (!d) throw new OrcaError("WORKFLOW_NOT_FOUND", `workflow '${id}' not registered`, { known: [...this.defs.keys()] });
    return d;
  }
  list(): WorkflowDefinition[] {
    return [...this.defs.values()];
  }
}
