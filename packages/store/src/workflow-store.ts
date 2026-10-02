/**
 * Versioned workflow definitions (#179). A run is pinned to the workflow version it started
 * on, so the definition it started with has to outlive the file on disk: `Orchestrator.startRun`
 * writes it here under `(id, version)` the first time that pair is seen, and a resumed run
 * reads it back rather than whatever the file says now.
 *
 * New snapshots are encrypted files under `private-workflows/<id>@v<version>.json`, rather than a
 * `JsonFileDocumentStore` collection: a definition is written once and never changed, so a
 * whole-collection rewrite under a lock for every new version would buy nothing but contention,
 * and one file per immutable thing is how the store already keeps run logs and artifacts. The
 * write is exclusive (a temp file hard-linked into place), so two processes seeing the same new
 * version race harmlessly: the first definition written is the one kept. Old plaintext
 * `workflows/` records remain readable without silently rewriting existing data.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OrcaError, WorkflowDefinitionSchema, type WorkflowDefinition } from "@orca/core";

import { readPrivateJson, writePrivateJson } from "./protected-file.js";

export interface WorkflowVersionStore {
  /** The definition recorded for `(id, version)`, or undefined when none was. */
  get(id: string, version: string): Promise<WorkflowDefinition | undefined>;
  /** Record `def` under `(def.id, def.version)` unless that pair is already recorded. True when this call wrote it. */
  put(def: WorkflowDefinition): Promise<boolean>;
  /** Every version recorded for `id`, in string order. */
  versions(id: string): Promise<string[]>;
}

export class InMemoryWorkflowVersionStore implements WorkflowVersionStore {
  private readonly defs = new Map<string, WorkflowDefinition>();
  async get(id: string, version: string): Promise<WorkflowDefinition | undefined> {
    const def = this.defs.get(key(id, version));
    return def ? structuredClone(def) : undefined;
  }
  async put(def: WorkflowDefinition): Promise<boolean> {
    const k = key(def.id, def.version);
    if (this.defs.has(k)) return false;
    this.defs.set(k, structuredClone(def));
    return true;
  }
  async versions(id: string): Promise<string[]> {
    return [...this.defs.values()]
      .filter((d) => d.id === id)
      .map((d) => d.version)
      .sort((a, b) => a.localeCompare(b));
  }
}

export class FileWorkflowVersionStore implements WorkflowVersionStore {
  private readonly dir: string;
  private readonly privateDir: string;
  constructor(storeDir: string) {
    this.dir = join(storeDir, "workflows");
    this.privateDir = join(storeDir, "private-workflows");
  }

  private path(id: string, version: string): string {
    return join(this.dir, fileName(id, version));
  }

  async get(id: string, version: string): Promise<WorkflowDefinition | undefined> {
    const privateValue = await readPrivateJson(this.privateDir, fileName(id, version));
    if (privateValue !== undefined) {
      const parsed = WorkflowDefinitionSchema.safeParse(privateValue);
      if (!parsed.success) throw new OrcaError("WORKFLOW_INVALID", "protected workflow snapshot is invalid");
      return parsed.data;
    }
    let raw: string;
    try {
      raw = await readFile(this.path(id, version), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    try {
      return WorkflowDefinitionSchema.parse(JSON.parse(raw));
    } catch {
      throw new OrcaError("WORKFLOW_INVALID", "stored workflow snapshot is invalid");
    }
  }

  async put(def: WorkflowDefinition): Promise<boolean> {
    // One protected location for every new snapshot keeps typed/untyped first-write races
    // write-once too. Existing legacy snapshots retain their original lookup precedence.
    if (await this.get(def.id, def.version)) return false;
    return writePrivateJson(this.privateDir, fileName(def.id, def.version), def);
  }

  async versions(id: string): Promise<string[]> {
    const listing = async (directory: string): Promise<string[]> => {
      try {
        return await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    };
    const names = [...new Set([...(await listing(this.dir)), ...(await listing(this.privateDir))])];
    const prefix = `${encodeURIComponent(id)}@v`;
    return names
      .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
      .map((n) => decodeURIComponent(n.slice(prefix.length, -".json".length)))
      .sort((a, b) => a.localeCompare(b));
  }
}

const key = (id: string, version: string) => `${id}\n${version}`;

/** `<id>@v<version>.json`; both parts are URI-encoded so a free-text version cannot leave the directory. */
function fileName(id: string, version: string): string {
  return `${encodeURIComponent(id)}@v${encodeURIComponent(version)}.json`;
}
