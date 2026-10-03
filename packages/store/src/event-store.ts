/**
 * EventStore - append-only log of OrcaEvents, partitioned by run.
 *
 * Implementations must assign `seq` (per run, gap-free, starting at 0), `id`
 * and `at`, persist atomically per append, and fan out to subscribers *after*
 * the event is durable.
 */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  newId,
  OrcaError,
  OrcaEventSchema,
  type Clock,
  systemClock,
  type OrcaEvent,
  type OrcaEventInput,
  type EventJournalCorrelation,
} from "@orca/core";

export interface EventFilter {
  runId?: string;
  types?: readonly OrcaEvent["type"][];
}

export type EventListener = (event: OrcaEvent) => void;

/**
 * One page of a run's log, by sequence number. `after` walks forward from a cursor and
 * `before` walks backward from one; giving both is a caller error and reads as `before`.
 * The filters are an AND and they are applied *before* `limit`, so a page is always `limit`
 * matching events rather than `limit` events of which some match.
 */
export interface EventRange {
  /** Events with `seq` greater than this, oldest first. */
  after?: number | undefined;
  /** The `limit` events *immediately* before this `seq`, still oldest first. */
  before?: number | undefined;
  /** At most this many events, nearest the anchor. Unbounded when absent. */
  limit?: number | undefined;
  /**
   * Only these event types. Stated as plain strings because the caller is usually a client:
   * a type this build's engine does not emit matches nothing rather than failing.
   */
  types?: readonly string[] | undefined;
  /**
   * A further test on the parsed event, for filters the store cannot see in a raw line -
   * `stepRunId`, say, which lives in a payload. Applied after `types`, and counted against
   * `limit` like `types` is, so paging stays correct through it.
   */
  match?: ((event: OrcaEvent) => boolean) | undefined;
}

/** Journal publication under the caller-held run fence and the store's append lock. */
export interface DurableEventAppend {
  /** Current last sequence, or -1 for an empty run. Existing correlation is checked first. */
  expectedSeq: number;
  correlation: EventJournalCorrelation;
  /** Compare authenticated private command material before replaying an existing marker. */
  equivalent(existing: OrcaEvent): boolean | Promise<boolean>;
}

/** Internal public evidence with a bounded verifier that never hydrates private payloads. */
export interface EventObservation {
  events: OrcaEvent[];
  /** Re-read and sync public evidence, failing closed if the captured history changed. */
  verifyUnchanged(this: void): Promise<void>;
}

export interface EventStore {
  /**
   * Internal observation boundary: return a complete existing public history under the
   * append lock, without taking execution authority or repairing/creating persistence.
   * Disk stores synchronize existing bytes before returning. Missing, incomplete or
   * over-limit histories fail with RUN_STATE; limits never clip the returned history.
   * Protected stores keep payloads public; the caller authenticates private evidence
   * separately and verifies that its observation remained stable.
   */
  readObservation?(runId: string, limits: { maxEvents: number; maxBytes: number }): Promise<EventObservation>;
  /**
   * Internal admission boundary: verify and sync this exact existing public event without
   * publishing, reconstructing or notifying. Protected stores return its authenticated
   * execution original; callers must keep that result private and hold the run fence.
   * Missing support or any mismatch must fail closed at the caller.
   */
  synchronizeEvent?(expected: OrcaEvent): Promise<OrcaEvent>;
  /** Verify and sync an existing marker; never publish, reconstruct, or notify. */
  synchronizeJournal?(runId: string, correlation: EventJournalCorrelation): Promise<void>;
  /** Optional: production journal services refuse stores without durable unique publication. */
  appendDurableUnique?(input: OrcaEventInput, options: DurableEventAppend): Promise<OrcaEvent>;
  append(input: OrcaEventInput): Promise<OrcaEvent>;
  read(runId: string): Promise<OrcaEvent[]>;
  /**
   * Only the events of `types`, in order. Implementations may skip the rest
   * without materialising them, which is what makes summary projections cheap
   * on runs whose logs are dominated by `agent.update`.
   */
  readTypes(runId: string, types: readonly OrcaEvent["type"][]): Promise<OrcaEvent[]>;
  /**
   * One page of the run's log, oldest first whichever direction it was taken in.
   * Implementations may stop reading once `limit` is reached, which is what keeps a page
   * of a long log from costing the whole log.
   */
  readRange(runId: string, range?: EventRange): Promise<OrcaEvent[]>;
  /**
   * The highest `seq` in the run - the timeline's cursor - or `undefined` when the store has
   * no such run. Separate from the page because it is the answer regardless of any filter,
   * and because a store can know it without materialising the log.
   */
  lastSeq(runId: string): Promise<number | undefined>;
  /** All run ids known to the store, oldest first. */
  listRuns(): Promise<string[]>;
  subscribe(listener: EventListener, filter?: EventFilter): () => void;
}

/** Whether an event passes a range's filters. The anchors and `limit` are the caller's; these are not. */
export function matchesRange(event: OrcaEvent, range: EventRange): boolean {
  if (range.types?.length && !range.types.includes(event.type)) return false;
  return !range.match || range.match(event);
}

export abstract class BaseEventStore implements EventStore {
  private readonly listeners = new Set<{ listener: EventListener; filter?: EventFilter | undefined }>();
  constructor(protected readonly clock: Clock = systemClock) {}

  /**
   * Persist `build(seq)` as the next event of `runId` and return it. Choosing `seq` and
   * writing the event are one step, so the store decides where they are made atomic -
   * in memory, or on disk under a lock shared with other processes.
   */
  protected abstract write(runId: string, build: (seq: number) => OrcaEvent): Promise<OrcaEvent>;
  abstract read(runId: string): Promise<OrcaEvent[]>;
  abstract listRuns(): Promise<string[]>;

  /** Correct for any store; override when the backing format allows skipping the other events. */
  async readTypes(runId: string, types: readonly OrcaEvent["type"][]): Promise<OrcaEvent[]> {
    return (await this.read(runId)).filter((e) => types.includes(e.type));
  }

  /**
   * Correct for any store, and for an in-memory one it is also the cheap answer - the log is
   * already an array. A store that reads from disk overrides it so the page, not the log, is
   * what it reads.
   */
  async readRange(runId: string, range: EventRange = {}): Promise<OrcaEvent[]> {
    const matching = (await this.read(runId)).filter((e) => matchesRange(e, range));
    const { after, before, limit } = range;
    if (before !== undefined) {
      const earlier = matching.filter((e) => e.seq < before);
      return limit === undefined ? earlier : earlier.slice(Math.max(0, earlier.length - limit));
    }
    const later = after === undefined ? matching : matching.filter((e) => e.seq > after);
    return limit === undefined ? later : later.slice(0, limit);
  }

  /** Correct for any store; override when the end of the log can be found without reading it. */
  async lastSeq(runId: string): Promise<number | undefined> {
    const events = await this.read(runId);
    return events[events.length - 1]?.seq;
  }

  async append(input: OrcaEventInput): Promise<OrcaEvent> {
    const event = await this.write(input.runId, (seq) => ({
      ...input,
      id: newId("evt", this.clock.now()),
      seq,
      at: this.clock.isoNow(),
    }));
    this.publish(event);
    return event;
  }

  /** Notify only after the concrete append has reached its promised durability boundary. */
  protected publish(event: OrcaEvent): void {
    for (const { listener, filter } of this.listeners) {
      if (filter?.runId && filter.runId !== event.runId) continue;
      if (filter?.types && !filter.types.includes(event.type)) continue;
      try {
        listener(event);
      } catch {
        /* listeners must not break the log */
      }
    }
  }

  subscribe(listener: EventListener, filter?: EventFilter): () => void {
    const entry = { listener, filter };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  }
}

export class InMemoryEventStore extends BaseEventStore {
  private readonly runs = new Map<string, OrcaEvent[]>();

  /** Complete isolated public evidence; this backend makes no disk-durability promise. */
  async readObservation(runId: string, limits: { maxEvents: number; maxBytes: number }): Promise<EventObservation> {
    const bounds = { ...limits };
    const events = this.observationEvents(runId, bounds);
    const digest = (history: readonly OrcaEvent[]) => {
      const hash = createHash("sha256");
      for (const event of history) hash.update(JSON.stringify(event)).update("\n");
      return hash.digest("hex");
    };
    const expected = digest(events);
    return {
      events,
      verifyUnchanged: async () => {
        if (digest(this.observationEvents(runId, bounds)) !== expected)
          throw new OrcaError("RUN_STATE", "Event observation history changed");
      },
    };
  }

  private observationEvents(runId: string, limits: { maxEvents: number; maxBytes: number }): OrcaEvent[] {
    const { maxEvents, maxBytes } = limits;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new OrcaError("RUN_STATE", "Invalid event observation limits");
    const history = this.runs.get(runId);
    if (!history?.length) throw new OrcaError("RUN_STATE", "Event observation requires an existing history");
    if (history.length > maxEvents) throw new OrcaError("RUN_STATE", "Event observation exceeds its event limit");
    const events: OrcaEvent[] = [];
    const ids = new Set<string>();
    let bytes = 0;
    for (const raw of history) {
      const parsed = OrcaEventSchema.safeParse(raw);
      if (!parsed.success) throw new OrcaError("RUN_STATE", "Event observation contains an invalid record");
      const event = parsed.data;
      if (event.runId !== runId || event.seq !== events.length || ids.has(event.id))
        throw new OrcaError("RUN_STATE", "Event observation history is inconsistent");
      bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes > maxBytes) throw new OrcaError("RUN_STATE", "Event observation exceeds its byte limit");
      ids.add(event.id);
      events.push(structuredClone(event));
    }
    return events;
  }

  /** Exact existing evidence for the memory backend; this makes no disk-durability promise. */
  async synchronizeEvent(expected: OrcaEvent): Promise<OrcaEvent> {
    const snapshot = OrcaEventSchema.parse(structuredClone(expected));
    const events = structuredClone(this.runs.get(snapshot.runId) ?? []);
    let verified: OrcaEvent | undefined;
    for (const [seq, raw] of events.entries()) {
      const event = OrcaEventSchema.parse(raw);
      if (event.runId !== snapshot.runId || event.seq !== seq)
        throw new OrcaError("RUN_STATE", "Existing event history is inconsistent");
      if (event.id !== snapshot.id && event.seq !== snapshot.seq) continue;
      if (verified || !isDeepStrictEqual(event, snapshot))
        throw new OrcaError("RUN_STATE", "The existing event has different material");
      verified = event;
    }
    if (!verified) throw new OrcaError("RUN_STATE", "The existing event is missing");
    return verified;
  }

  /** Synchronous from reading the length to pushing, so concurrent appends cannot share a seq. */
  protected async write(runId: string, build: (seq: number) => OrcaEvent): Promise<OrcaEvent> {
    const list = this.runs.get(runId) ?? [];
    const event = build(list.length);
    list.push(event);
    this.runs.set(runId, list);
    return event;
  }
  async read(runId: string): Promise<OrcaEvent[]> {
    return [...(this.runs.get(runId) ?? [])];
  }
  async listRuns(): Promise<string[]> {
    return [...this.runs.keys()];
  }
}
