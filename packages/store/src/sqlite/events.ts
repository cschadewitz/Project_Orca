/**
 * The run event log in SQLite (#339). Same contract as `JsonlEventStore`: per-run gap-free
 * `seq` from 0, assigned and written in one step, subscribers told only after the commit.
 *
 * Choosing `seq` and inserting the event are one immediate transaction, so concurrent appends
 * from any number of handles or processes cannot share a number; the `(run_id, seq)` primary
 * key would refuse a duplicate even if they could. Pages and type reads are index range scans
 * on `(run_id, seq)` and `(run_id, type, seq)`: a page costs the page, from either end of the
 * log, rather than the distance from the start.
 *
 * Durable journal publication (`appendDurableUnique`) is one unique index on the correlation.
 * The caller's `equivalent` check may be asynchronous, so it runs outside the transaction, on
 * an existing marker - which is immutable once committed, so nothing can change under it.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  EventJournalCorrelationSchema,
  newId,
  OrcaError,
  OrcaEventSchema,
  type Clock,
  type EventJournalCorrelation,
  type OrcaEvent,
  type OrcaEventInput,
} from "@orca/core";
import {
  BaseEventStore,
  matchesRange,
  type DurableEventAppend,
  type EventObservation,
  type EventRange,
} from "../event-store.js";
import type { SqliteDatabase } from "./database.js";

interface Row {
  body: string;
}

/** How many rows a filtered page reads per step when `match` has to be applied in process. */
const CHUNK = 256;

/** Insert one event row; the caller's transaction has chosen `event.seq`. Shared with import. */
export function insertEvent(db: SqliteDatabase, event: OrcaEvent): void {
  db.prepare("INSERT OR IGNORE INTO runs (run_id) VALUES (?)").run(event.runId);
  db.prepare(
    "INSERT INTO events (run_id, seq, id, type, journal_kind, journal_id, journal_revision, body) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    event.runId,
    event.seq,
    event.id,
    event.type,
    event.journal?.kind ?? null,
    event.journal?.id ?? null,
    event.journal?.revision ?? null,
    JSON.stringify(event),
  );
}

export class SqliteEventStore extends BaseEventStore {
  constructor(
    private readonly db: SqliteDatabase,
    clock?: Clock,
  ) {
    super(clock);
  }

  private parse(body: string): OrcaEvent {
    return OrcaEventSchema.parse(JSON.parse(body));
  }

  private nextSeq(runId: string): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE run_id = ?").get(runId) as {
      seq: number | null;
    };
    return row.seq === null ? 0 : Number(row.seq) + 1;
  }

  protected write(runId: string, build: (seq: number) => OrcaEvent): Promise<OrcaEvent> {
    return this.db.write(() => {
      const event = build(this.nextSeq(runId));
      insertEvent(this.db, event);
      return event;
    });
  }

  read(runId: string): Promise<OrcaEvent[]> {
    return this.db.read(() =>
      (this.db.prepare("SELECT body FROM events WHERE run_id = ? ORDER BY seq").all(runId) as unknown as Row[]).map(
        (r) => this.parse(r.body),
      ),
    );
  }

  override readTypes(runId: string, types: readonly OrcaEvent["type"][]): Promise<OrcaEvent[]> {
    if (types.length === 0) return Promise.resolve([]);
    const marks = types.map(() => "?").join(", ");
    return this.db.read(() =>
      (
        this.db
          .prepare(`SELECT body FROM events WHERE run_id = ? AND type IN (${marks}) ORDER BY seq`)
          .all(runId, ...types) as unknown as Row[]
      ).map((r) => this.parse(r.body)),
    );
  }

  /**
   * The anchor, the types and the limit are SQL. A `match` predicate cannot be, so the page is
   * read in chunks and filtered here until it has `limit` matching events - the same answer,
   * still bounded by how far the matches are from the anchor rather than by the log.
   */
  override async readRange(runId: string, range: EventRange = {}): Promise<OrcaEvent[]> {
    const { after, before, limit } = range;
    const backward = before !== undefined;
    const types = range.types?.length ? range.types : undefined;
    const out: OrcaEvent[] = [];
    let cursor: number | undefined = backward ? before : after;
    for (;;) {
      const want = range.match ? CHUNK : limit;
      const clauses = ["run_id = ?"];
      const params: (string | number)[] = [runId];
      if (cursor !== undefined) {
        clauses.push(backward ? "seq < ?" : "seq > ?");
        params.push(cursor);
      }
      if (types) {
        clauses.push(`type IN (${types.map(() => "?").join(", ")})`);
        params.push(...types);
      }
      let sql = `SELECT body FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq ${backward ? "DESC" : "ASC"}`;
      if (want !== undefined) {
        sql += " LIMIT ?";
        params.push(want);
      }
      const rows = await this.db.read(() => this.db.prepare(sql).all(...params) as unknown as Row[]);
      for (const row of rows) {
        const event = this.parse(row.body);
        cursor = event.seq;
        if (!matchesRange(event, range)) continue;
        out.push(event);
        if (limit !== undefined && out.length >= limit) break;
      }
      if (!range.match || want === undefined || rows.length < want) break;
      if (limit !== undefined && out.length >= limit) break;
    }
    return backward ? out.reverse() : out;
  }

  override lastSeq(runId: string): Promise<number | undefined> {
    return this.db.read(() => {
      const seq = this.nextSeq(runId) - 1;
      return seq < 0 ? undefined : seq;
    });
  }

  listRuns(): Promise<string[]> {
    return this.db.read(() =>
      (this.db.prepare("SELECT run_id FROM runs ORDER BY rowid").all() as { run_id: string }[]).map((r) => r.run_id),
    );
  }

  // ---------------------------------------------------------------- journal publication

  private marker(runId: string, correlation: EventJournalCorrelation): OrcaEvent[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM events WHERE run_id = ? AND journal_kind = ? AND journal_id = ? AND journal_revision = ?",
        )
        .all(runId, correlation.kind, correlation.id, correlation.revision) as unknown as Row[]
    ).map((r) => this.parse(r.body));
  }

  /** Caller holds the run fence; the unique correlation index and the transaction do the rest. */
  async appendDurableUnique(input: OrcaEventInput, options: DurableEventAppend): Promise<OrcaEvent> {
    const snapshot = structuredClone(input);
    const correlation = EventJournalCorrelationSchema.parse(structuredClone(options.correlation));
    if (!Number.isSafeInteger(options.expectedSeq) || options.expectedSeq < -1)
      throw new OrcaError("RUN_STATE", "Invalid durable journal boundary");
    const replay = async (existing: OrcaEvent): Promise<OrcaEvent> => {
      if (existing.runId !== snapshot.runId || existing.type !== snapshot.type || !(await options.equivalent(existing)))
        throw new OrcaError("RETRY_CONFLICT", "The durable journal correlation has different material");
      return existing;
    };
    for (;;) {
      const [existing] = await this.db.read(() => this.marker(snapshot.runId, correlation));
      if (existing) return replay(existing);
      const outcome = await this.db.write((): { event: OrcaEvent; fresh: boolean } => {
        const [raced] = this.marker(snapshot.runId, correlation);
        if (raced) return { event: raced, fresh: false };
        const seq = this.nextSeq(snapshot.runId);
        if (seq !== options.expectedSeq + 1)
          throw new OrcaError(
            correlation.kind === "continuation" ? "CONTINUATION_STALE" : "REVISION_STALE",
            "The durable journal boundary changed",
          );
        const event = OrcaEventSchema.parse({
          ...snapshot,
          journal: correlation,
          id: newId("evt", this.clock.now()),
          seq,
          at: this.clock.isoNow(),
        });
        insertEvent(this.db, event);
        return { event, fresh: true };
      });
      if (!outcome.fresh) return replay(outcome.event);
      this.publish(outcome.event);
      return outcome.event;
    }
  }

  /** A committed marker is durable (`synchronous = FULL`); this confirms it is there, once. */
  async synchronizeJournal(runId: string, correlation: EventJournalCorrelation): Promise<void> {
    const expected = EventJournalCorrelationSchema.parse(correlation);
    const found = await this.db.read(() => this.marker(runId, expected));
    if (found.length === 0) throw new OrcaError("RUN_STATE", "The durable journal marker is missing");
    if (found.length > 1) throw new OrcaError("RUN_STATE", "Durable journal contains duplicate correlations");
    if (found[0]!.runId !== runId) throw new OrcaError("RUN_STATE", "Durable journal run identity is inconsistent");
  }

  async synchronizeEvent(expected: OrcaEvent): Promise<OrcaEvent> {
    const snapshot = OrcaEventSchema.parse(structuredClone(expected));
    const rows = await this.db.read(
      () =>
        this.db
          .prepare("SELECT body FROM events WHERE run_id = ? AND (id = ? OR seq = ?)")
          .all(snapshot.runId, snapshot.id, snapshot.seq) as unknown as Row[],
    );
    if (rows.length === 0) throw new OrcaError("RUN_STATE", "The durable event is missing");
    const event = this.parse(rows[0]!.body);
    if (rows.length > 1 || !isDeepStrictEqual(event, snapshot))
      throw new OrcaError("RUN_STATE", "The durable event has different material");
    return event;
  }

  async readObservation(runId: string, limits: { maxEvents: number; maxBytes: number }): Promise<EventObservation> {
    const { maxEvents, maxBytes } = limits;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new OrcaError("RUN_STATE", "Invalid event observation limits");
    const read = () =>
      this.db.read(() => {
        // Both bounds are checked in SQL, in the same snapshot, before a single body is read:
        // an over-limit history is refused without materialising it. A line's size is its
        // UTF-8 bytes plus the newline, as on the file backend.
        const size = this.db
          .prepare(
            "SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(body AS BLOB)) + 1), 0) AS bytes " +
              "FROM (SELECT body FROM events WHERE run_id = ? ORDER BY seq LIMIT ?)",
          )
          .get(runId, maxEvents + 1) as { n: number; bytes: number };
        if (Number(size.n) === 0) throw new OrcaError("RUN_STATE", "Event observation requires an existing history");
        if (Number(size.n) > maxEvents) throw new OrcaError("RUN_STATE", "Event observation exceeds its event limit");
        if (Number(size.bytes) > maxBytes) throw new OrcaError("RUN_STATE", "Event observation exceeds its byte limit");
        const rows = this.db
          .prepare("SELECT body FROM events WHERE run_id = ? ORDER BY seq")
          .all(runId) as unknown as Row[];
        const events: OrcaEvent[] = [];
        const ids = new Set<string>();
        let bytes = 0;
        for (const row of rows) {
          bytes += Buffer.byteLength(row.body) + 1;
          if (bytes > maxBytes) throw new OrcaError("RUN_STATE", "Event observation exceeds its byte limit");
          const event = this.parse(row.body);
          if (event.runId !== runId || event.seq !== events.length || ids.has(event.id))
            throw new OrcaError("RUN_STATE", "Event observation history is inconsistent");
          ids.add(event.id);
          events.push(event);
        }
        return events;
      });
    const digest = (history: readonly OrcaEvent[]) => {
      const hash = createHash("sha256");
      for (const event of history) hash.update(JSON.stringify(event)).update("\n");
      return hash.digest("hex");
    };
    const events = await read();
    const expected = digest(events);
    return {
      events,
      verifyUnchanged: async () => {
        if (digest(await read()) !== expected)
          throw new OrcaError("RUN_STATE", "Event observation history changed", { reason: "observation-changed" });
      },
    };
  }
}
