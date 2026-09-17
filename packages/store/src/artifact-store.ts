/**
 * ArtifactStore - content-addressed blob storage plus an index of Artifact
 * metadata. The engine decides ids/versions; the store just persists.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSchema, OrcaError, appendJsonl, readJsonl, type Artifact } from "@orca/core";

export interface ArtifactQuery {
  runId?: string;
  kind?: string;
  name?: string;
}

export interface ArtifactStore {
  put(artifact: Artifact, content: string): Promise<void>;
  get(id: string): Promise<Artifact | undefined>;
  content(id: string): Promise<string>;
  list(query?: ArtifactQuery): Promise<Artifact[]>;
}

function matches(a: Artifact, q: ArtifactQuery): boolean {
  return (!q.runId || a.producedBy.runId === q.runId) && (!q.kind || a.kind === q.kind) && (!q.name || a.name === q.name);
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly index = new Map<string, Artifact>();
  private readonly blobs = new Map<string, string>();
  async put(artifact: Artifact, content: string): Promise<void> {
    this.index.set(artifact.id, artifact);
    this.blobs.set(artifact.contentHash, content);
  }
  async get(id: string): Promise<Artifact | undefined> {
    return this.index.get(id);
  }
  async content(id: string): Promise<string> {
    const a = this.index.get(id);
    const c = a && this.blobs.get(a.contentHash);
    if (c === undefined) throw new OrcaError("ARTIFACT_MISSING", `artifact ${id} not in store`);
    return c;
  }
  async list(query: ArtifactQuery = {}): Promise<Artifact[]> {
    return [...this.index.values()].filter((a) => matches(a, query));
  }
}

/** `<dir>/artifacts/blobs/<sha256>` + `<dir>/artifacts/index.jsonl`. */
export class FileArtifactStore implements ArtifactStore {
  private cache: Map<string, Artifact> | undefined;
  constructor(private readonly dir: string) {}

  private get base(): string {
    return join(this.dir, "artifacts");
  }
  private get index(): string {
    return join(this.base, "index.jsonl");
  }
  private async load(): Promise<Map<string, Artifact>> {
    if (this.cache) return this.cache;
    await mkdir(join(this.base, "blobs"), { recursive: true });
    const map = new Map<string, Artifact>();
    for (const a of await readJsonl(this.index, ArtifactSchema)) map.set(a.id, a);
    this.cache = map;
    return map;
  }
  async put(artifact: Artifact, content: string): Promise<void> {
    const map = await this.load();
    await writeFile(join(this.base, "blobs", artifact.contentHash), content, "utf8");
    await appendJsonl(this.index, artifact);
    map.set(artifact.id, artifact);
  }
  async get(id: string): Promise<Artifact | undefined> {
    return (await this.load()).get(id);
  }
  async content(id: string): Promise<string> {
    const a = await this.get(id);
    if (!a) throw new OrcaError("ARTIFACT_MISSING", `artifact ${id} not in store`);
    return readFile(join(this.base, "blobs", a.contentHash), "utf8");
  }
  async list(query: ArtifactQuery = {}): Promise<Artifact[]> {
    return [...(await this.load()).values()].filter((a) => matches(a, query));
  }
}
