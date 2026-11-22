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
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ArtifactSchema, OrcaError, sha256, type Artifact, type Logger } from "@orca/core";
import { JsonlLogDir } from "./jsonl-log.js";

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

function invalidBlob(artifact: Artifact): OrcaError {
  return new OrcaError("ARTIFACT_INVALID", `artifact ${artifact.id} content does not match its SHA-256 hash`, {
    id: artifact.id,
    name: artifact.name,
    version: artifact.version,
    contentHash: artifact.contentHash,
  });
}

function verifyBlob(artifact: Artifact, bytes: Uint8Array): void {
  if (sha256(bytes) !== artifact.contentHash) throw invalidBlob(artifact);
}

/** Never interpret an invalid hash from an old or damaged index as a filesystem path. */
function blobPath(dir: string, artifact: Artifact): string {
  if (!/^[a-f0-9]{64}$/.test(artifact.contentHash)) throw invalidBlob(artifact);
  return join(dir, artifact.contentHash);
}

/** Re-sync even an existing winner: an earlier publisher may have lost its acknowledgement. */
async function synchronizeBlob(file: string, artifact: Artifact): Promise<boolean> {
  const handle = await open(file, process.platform === "win32" ? "r+" : "r").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return false;
  try {
    verifyBlob(artifact, await handle.readFile());
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}

/** Blob and newly created ancestor entries must be durable before publishing metadata. */
async function synchronizeBlobDirectories(dir: string): Promise<void> {
  // Node cannot portably fsync directories on Windows. As with the protected store,
  // Windows gets file synchronization, without a directory-entry power-loss guarantee.
  if (process.platform === "win32") return;
  for (let path = resolve(dir); ; path = dirname(path)) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (dirname(path) === path) break;
  }
}

/** Only a fully written, synced file can win the hash name; no publisher replaces it. */
async function publishBlob(dir: string, artifact: Artifact, bytes: Buffer): Promise<void> {
  const file = blobPath(dir, artifact);
  await mkdir(dir, { recursive: true });
  if (!(await synchronizeBlob(file, artifact))) {
    const temporary = join(dir, `.${artifact.contentHash}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx");
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Another publisher won. EEXIST alone does not establish valid/durable bytes.
        if (!(await synchronizeBlob(file, artifact))) throw error;
      }
    } finally {
      // Only this publication's scratch file is disposable. Never repair/remove a blob.
      await unlink(temporary).catch(() => undefined);
    }
  }
  await synchronizeBlobDirectories(dir);
}

function matches(a: Artifact, q: ArtifactQuery): boolean {
  return (
    (!q.runId || a.producedBy.runId === q.runId) && (!q.kind || a.kind === q.kind) && (!q.name || a.name === q.name)
  );
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly index = new Map<string, Artifact>();
  private readonly blobs = new Map<string, Buffer>();
  /**
   * Not hash-verified: test fixtures across the workspace put hand-written hashes through it.
   * The capability matrix says so (`artifact.verifiedContent: false`, #338).
   */
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
  private readonly log: JsonlLogDir;
  constructor(
    private readonly dir: string,
    logger?: Logger,
  ) {
    this.log = new JsonlLogDir(join(dir, "artifacts"), logger ? { logger } : {});
  }

  protected get base(): string {
    return join(this.dir, "artifacts");
  }
  /** The whole index, by id, in first-written order. A backend with its own index overrides this. */
  protected async load(): Promise<Map<string, Artifact>> {
    await mkdir(join(this.base, "blobs"), { recursive: true });
    const map = new Map<string, Artifact>();
    for (const a of await this.log.readCommitted("index", ArtifactSchema)) map.set(a.id, a);
    return map;
  }
  async put(artifact: Artifact, content: ArtifactContent): Promise<void> {
    const record = structuredClone(artifact);
    const bytes = toBytes(content);
    verifyBlob(record, bytes);
    await publishBlob(join(this.base, "blobs"), record, bytes);
    await this.index(record);
  }
  /** Record `artifact` in the index once its blob is durable; the commit point of a `put`. */
  protected async index(artifact: Artifact): Promise<void> {
    await this.log.append("index", () => artifact);
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
    const bytes = await readFile(blobPath(join(this.base, "blobs"), a)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new OrcaError(
        "ARTIFACT_MISSING",
        `artifact ${id} blob is missing`,
        {
          id,
          name: a.name,
          version: a.version,
          contentHash: a.contentHash,
        },
        { cause: error },
      );
    });
    verifyBlob(a, bytes);
    return bytes;
  }
  async list(query: ArtifactQuery = {}): Promise<Artifact[]> {
    return [...(await this.load()).values()].filter((a) => matches(a, query));
  }

  /**
   * Blob hashes no index record references, sorted. `put` publishes the blob before it appends the index record, so a put whose index
   * append failed leaves exactly such a blob - invisible to `get`, `list` and every reader, and
   * adopted again by a retried `put` of the same content. This is the compensation inventory
   * (#338): it only reports, and never deletes, because a concurrent `put` may be between its
   * blob and its record. The answer is a projection of the index as it is now, not permission to
   * reclaim: a reclaimer re-checks under its own fence, or after a grace period, before deleting.
   * Scratch files from an interrupted publish are not blobs and are skipped.
   */
  async unreferencedBlobs(): Promise<string[]> {
    const referenced = new Set([...(await this.load()).values()].map((a) => a.contentHash));
    const names = await readdir(join(this.base, "blobs"));
    return names.filter((n) => /^[a-f0-9]{64}$/.test(n) && !referenced.has(n)).sort();
  }
}
