/**
 * File-backed event store: one newline-delimited JSON file per run under
 * `<dir>/runs/<runId>.jsonl`. Simple, greppable, and safe to commit alongside
 * artifacts if a team wants run history in git.
 *
 * Sequencing, locking and torn-line recovery live in `JsonlLogDir`, shared
 * with the plan journal.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  newId,
  OrcaError,
  OrcaEventSchema,
  EventJournalCorrelationSchema,
  type EventJournalCorrelation,
  type Clock,
  type Logger,
  type OrcaEvent,
  type OrcaEventInput,
} from "@orca/core";
import {
  BaseEventStore,
  matchesRange,
  type EventRange,
  type DurableEventAppend,
  type EventObservation,
} from "./event-store.js";
import { JsonlLogDir } from "./jsonl-log.js";

export class JsonlEventStore extends BaseEventStore {
  private readonly logs: JsonlLogDir;

  constructor(dir: string, clock?: Clock, logger?: Logger) {
    super(clock);
    this.logs = new JsonlLogDir(join(dir, "runs"), { ...(logger ? { logger } : {}) });
  }

  protected write(runId: string, build: (seq: number) => OrcaEvent): Promise<OrcaEvent> {
    return this.logs.append(runId, build);
  }

  async readObservation(runId: string, limits: { maxEvents: number; maxBytes: number }): Promise<EventObservation> {
    const bounds = { maxRecords: limits.maxEvents, maxBytes: limits.maxBytes };
    const read = () => {
      const ids = new Set<string>();
      return this.logs.readObservation(runId, bounds, {
        parse: (raw) => {
          const event = OrcaEventSchema.parse(raw);
          if (event.runId !== runId || ids.has(event.id))
            throw new OrcaError("RUN_STATE", "Event observation identity is inconsistent");
          ids.add(event.id);
          return event;
        },
      });
    };
    const digest = (events: readonly OrcaEvent[]) => {
      const hash = createHash("sha256");
      for (const event of events) hash.update(JSON.stringify(event)).update("\n");
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
  /** Caller holds the run fence; the shared journal lock supplies sequence CAS and deduplication. */
  async appendDurableUnique(input: OrcaEventInput, options: DurableEventAppend): Promise<OrcaEvent> {
    const snapshot = structuredClone(input);
    const correlation = structuredClone(options.correlation);
    const { record, fresh } = await this.logs.appendDurableUnique(snapshot.runId, {
      expectedSeq: options.expectedSeq + 1,
      stale: () =>
        new OrcaError(
          correlation.kind === "continuation" ? "CONTINUATION_STALE" : "REVISION_STALE",
          "The durable journal boundary changed",
        ),
      findExisting: async (raw) => {
        const event = OrcaEventSchema.parse(raw);
        const journal = event.journal;
        if (
          !journal ||
          journal.kind !== correlation.kind ||
          journal.id !== correlation.id ||
          journal.revision !== correlation.revision
        )
          return undefined;
        if (event.runId !== snapshot.runId || event.type !== snapshot.type || !(await options.equivalent(event)))
          throw new OrcaError("RETRY_CONFLICT", "The durable journal correlation has different material");
        return event;
      },
      build: (seq) =>
        OrcaEventSchema.parse({
          ...snapshot,
          journal: correlation,
          id: newId("evt", this.clock.now()),
          seq,
          at: this.clock.isoNow(),
        }),
    });
    if (fresh) this.publish(record);
    return record;
  }

  async synchronizeJournal(runId: string, correlation: EventJournalCorrelation): Promise<void> {
    const expected = EventJournalCorrelationSchema.parse(correlation);
    await this.logs.synchronizeExisting(runId, (raw) => {
      const event = OrcaEventSchema.parse(raw);
      if (event.runId !== runId) throw new OrcaError("RUN_STATE", "Durable journal run identity is inconsistent");
      const journal = event.journal;
      return journal?.kind === expected.kind && journal.id === expected.id && journal.revision === expected.revision;
    });
  }

  async synchronizeEvent(expected: OrcaEvent): Promise<OrcaEvent> {
    const snapshot = OrcaEventSchema.parse(structuredClone(expected));
    let verified: OrcaEvent | undefined;
    await this.logs.synchronizeExisting(snapshot.runId, (raw) => {
      const event = OrcaEventSchema.parse(raw);
      if (event.runId !== snapshot.runId)
        throw new OrcaError("RUN_STATE", "Durable event run identity is inconsistent");
      if (event.id !== snapshot.id && event.seq !== snapshot.seq) return false;
      if (!isDeepStrictEqual(event, snapshot))
        throw new OrcaError("RUN_STATE", "The durable event has different material");
      verified = event;
      return true;
    });
    if (!verified) throw new OrcaError("RUN_STATE", "The durable event is missing");
    return verified;
  }

  read(runId: string): Promise<OrcaEvent[]> {
    return this.logs.read(runId, OrcaEventSchema);
  }
  /**
   * Filters on the raw line before parsing: `agent.update` lines carry the
   * bulk of a log and zod-parsing them to throw them away dominates listings.
   * The substring test only pre-selects - every surviving line is parsed and
   * its type re-checked, so a payload that happens to contain the needle is
   * harmless.
   */
  override async readTypes(runId: string, types: readonly OrcaEvent["type"][]): Promise<OrcaEvent[]> {
    const needles = types.map((t) => `"type":"${t}"`);
    const out: OrcaEvent[] = [];
    for (const line of await this.logs.lines(runId)) {
      if (!needles.some((n) => line.includes(n))) continue;
      const event = this.logs.parseLine(runId, line, OrcaEventSchema);
      if (event && types.includes(event.type)) out.push(event);
    }
    return out;
  }
  /**
   * A page without the log: `after` scans forward from the start and `before` scans backward
   * from the end, and either stops as soon as it has `limit` matching events. The same
   * pre-parse substring test as `readTypes` throws away the `agent.update` bulk before zod
   * sees it, so the events skipped on the way to the page cost a `String.includes` each.
   *
   * The cost is the distance from whichever end the scan starts at - documented on
   * `JsonlLogDir.scanLinesBackward`, and the reason a backward page is the cheap one: the
   * timeline pages back from the live tail. Reading a torn tail is `read()`'s problem
   * exactly, because it is the same `parseLine`: the torn line is not JSON, it is skipped
   * with a warning, and it is never part of a page.
   */
  override async readRange(runId: string, range: EventRange = {}): Promise<OrcaEvent[]> {
    const { after, before, limit } = range;
    const needles = range.types?.length ? range.types.map((t) => `"type":"${t}"`) : undefined;
    const accept = (line: string): OrcaEvent | undefined => {
      if (needles && !needles.some((n) => line.includes(n))) return undefined;
      const event = this.logs.parseLine(runId, line, OrcaEventSchema);
      return event && matchesRange(event, range) ? event : undefined;
    };
    const out: OrcaEvent[] = [];
    const enough = () => limit !== undefined && out.length >= limit;
    if (before !== undefined) {
      await this.logs.scanLinesBackward(runId, (line) => {
        const event = accept(line);
        if (event && event.seq < before) out.push(event);
        return !enough();
      });
      out.reverse();
    } else {
      await this.logs.scanLines(runId, (line) => {
        const event = accept(line);
        if (event && (after === undefined || event.seq > after)) out.push(event);
        return !enough();
      });
    }
    return out;
  }

  /** The last record's `seq`, from the end of the file: one chunk, whatever the log's size. */
  override async lastSeq(runId: string): Promise<number | undefined> {
    let seq: number | undefined;
    await this.logs.scanLinesBackward(runId, (line) => {
      const event = this.logs.parseLine(runId, line, OrcaEventSchema);
      if (!event) return true;
      seq = event.seq;
      return false;
    });
    return seq;
  }

  listRuns(): Promise<string[]> {
    return this.logs.keys();
  }
}
