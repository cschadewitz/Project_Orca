/**
 * ArtifactStore - content-addressed blob storage plus an index of Artifact
 * metadata. The engine decides ids/versions; the store just persists.
 *
 * **A blob is bytes** (#226). It used to be a `string`, which meant a PNG or a PDF an agent
 * produced could not come back out of the store the way it went in: it was decoded as UTF-8
 * on the way in, and every byte that was not valid UTF-8 became U+FFFD on the way back. So
 * `put` takes `string | Uint8Array` and the bytes are what is written and what is hashed.
 *
 * There are two ways to read one back, because there are two kinds of caller:
 *
 * - `content(id)` decodes UTF-8 and returns a `string`. Every artifact ORCA produces today
 *   is text - specs, plans, diffs, reports - and this is unchanged for all of them: a
 *   string put in is the same string read out, and the hash of it is the hash it always was,
 *   because hashing a string in Node is hashing its UTF-8 bytes.
 * - `bytes(id)` returns the blob untouched, for a caller that knows it is not text.
 *
 * The index says which one is meaningful, and it already did: `mediaType` is the producer's
 * claim about the body and `size` is how big it is. Nothing new is written for this - the
 * store holds bytes and offers both views, rather than recording a second answer to the
 * question `mediaType` answers.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSchema, OrcaError, appendJsonl, readJsonl, type Artifact } from "@orca/core";

export interface ArtifactQuery {
  runId?: string;
  kind?: string;
  name?: string;
}

/** What a body may be on the way in. A `string` is stored as its UTF-8 bytes. */
export type ArtifactContent = string | Uint8Array;

export interface ArtifactStore {
  put(artifact: Artifact, content: ArtifactContent): Promise<void>;
  get(id: string): Promise<Artifact | undefined>;
  /** The body decoded as UTF-8. Text callers want this; on a binary artifact it is mojibake, honestly. */
  content(id: string): Promise<string>;
  /** The body exactly as it was put, byte for byte. */
  bytes(id: string): Promise<Uint8Array>;
  list(query?: ArtifactQuery): Promise<Artifact[]>;
}

/** The bytes of a body, copied so the store never aliases a buffer a caller still holds. */
function toBytes(content: ArtifactContent): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function matches(a: Artifact, q: ArtifactQuery): boolean {
  return (
    (!q.runId || a.producedBy.runId === q.runId) && (!q.kind || a.kind === q.kind) && (!q.name || a.name === q.name)
  );
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly index = new Map<string, Artifact>();
  private readonly blobs = new Map<string, Buffer>();
  async put(artifact: Artifact, content: ArtifactContent): Promise<void> {
    this.index.set(artifact.id, artifact);
    this.blobs.set(artifact.contentHash, toBytes(content));
  }
  async get(id: string): Promise<Artifact | undefined> {
    return this.index.get(id);
  }
  async content(id: string): Promise<string> {
    return (await this.blob(id)).toString("utf8");
  }
  async bytes(id: string): Promise<Uint8Array> {
    return Buffer.from(await this.blob(id));
  }
  private async blob(id: string): Promise<Buffer> {
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
  async put(artifact: Artifact, content: ArtifactContent): Promise<void> {
    const map = await this.load();
    await writeFile(join(this.base, "blobs", artifact.contentHash), toBytes(content));
    await appendJsonl(this.index, artifact);
    map.set(artifact.id, artifact);
  }
  async get(id: string): Promise<Artifact | undefined> {
    return (await this.load()).get(id);
  }
  async content(id: string): Promise<string> {
    return (await this.blob(id)).toString("utf8");
  }
  async bytes(id: string): Promise<Uint8Array> {
    return this.blob(id);
  }
  /**
   * A blob is a file named by its hash, and it is read as bytes whichever view the caller
   * wanted - decoding is `content`'s, so a file written before #226 (which was the same
   * UTF-8 bytes under the same hash) reads back identically.
   */
  private async blob(id: string): Promise<Buffer> {
    const a = await this.get(id);
    if (!a) throw new OrcaError("ARTIFACT_MISSING", `artifact ${id} not in store`);
    return readFile(join(this.base, "blobs", a.contentHash));
  }
  async list(query: ArtifactQuery = {}): Promise<Artifact[]> {
    return [...(await this.load()).values()].filter((a) => matches(a, query));
  }
}
