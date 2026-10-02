/**
 * EventStore - append-only log of OrcaEvents, partitioned by run.
 *
 * Implementations must assign `seq` (per run, gap-free, starting at 0), `id`
 * and `at`, persist atomically per append, and fan out to subscribers *after*
 * the event is durable.
 */
import {
  newId,
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

export interface EventStore {
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
