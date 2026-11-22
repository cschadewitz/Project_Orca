/**
 * Artifacts with the index in SQLite (#339). The blobs are exactly `FileArtifactStore`'s:
 * content-addressed files under `<dir>/artifacts/blobs`, written, synced and verified the same
 * way. Only where the index lives changes, so `put` still publishes the blob first and the index
 * row is its commit point, and a blob whose row never committed is what `unreferencedBlobs`
 * reports - against the index as it is now, which is an inventory, not permission to delete.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSchema, type Artifact } from "@orca/core";
import { FileArtifactStore, type ArtifactQuery } from "../artifact-store.js";
import type { SqliteDatabase } from "./database.js";

export class SqliteArtifactStore extends FileArtifactStore {
  constructor(
    dir: string,
    private readonly db: SqliteDatabase,
  ) {
    super(dir);
  }

  private parse(body: string): Artifact {
    return ArtifactSchema.parse(JSON.parse(body));
  }

  /** A re-put of an id replaces its record in place, keeping its position, as on file. */
  protected override async index(artifact: Artifact): Promise<void> {
    await this.db.write(() => {
      this.db
        .prepare(
          "INSERT INTO artifacts (id, content_hash, run_id, kind, name, body) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (id) DO UPDATE SET content_hash = excluded.content_hash, run_id = excluded.run_id, " +
            "kind = excluded.kind, name = excluded.name, body = excluded.body",
        )
        .run(
          artifact.id,
          artifact.contentHash,
          artifact.producedBy.runId,
          artifact.kind,
          artifact.name,
          JSON.stringify(artifact),
        );
    });
  }

  protected override async load(): Promise<Map<string, Artifact>> {
    await mkdir(join(this.base, "blobs"), { recursive: true });
    const rows = await this.db.read(
      () => this.db.prepare("SELECT body FROM artifacts ORDER BY rowid").all() as { body: string }[],
    );
    return new Map(rows.map((r) => [JSON.parse(r.body).id as string, this.parse(r.body)]));
  }

  override async get(id: string): Promise<Artifact | undefined> {
    const row = await this.db.read(
      () => this.db.prepare("SELECT body FROM artifacts WHERE id = ?").get(id) as { body: string } | undefined,
    );
    return row && this.parse(row.body);
  }

  override async list(query: ArtifactQuery = {}): Promise<Artifact[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [column, value] of [
      ["run_id", query.runId],
      ["kind", query.kind],
      ["name", query.name],
    ] as const) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.db.read(
      () => this.db.prepare(`SELECT body FROM artifacts${where} ORDER BY rowid`).all(...params) as { body: string }[],
    );
    return rows.map((r) => this.parse(r.body));
  }
}
