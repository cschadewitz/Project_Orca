/**
 * EventStore - append-only log of OrcaEvents, partitioned by run.
 *
 * Implementations must assign `seq` (per run, gap-free, starting at 0), `id`
 * and `at`, persist atomically per append, and fan out to subscribers *after*
 * the event is durable.
 */
import { newId, type Clock, systemClock, type OrcaEvent, type OrcaEventInput } from "@orca/core";

export interface EventFilter {
  runId?: string;
  types?: readonly OrcaEvent["type"][];
}

export type EventListener = (event: OrcaEvent) => void;

export interface EventStore {
  append(input: OrcaEventInput): Promise<OrcaEvent>;
  read(runId: string): Promise<OrcaEvent[]>;
  /** All run ids known to the store, oldest first. */
  listRuns(): Promise<string[]>;
  subscribe(listener: EventListener, filter?: EventFilter): () => void;
}

export abstract class BaseEventStore implements EventStore {
  private readonly listeners = new Set<{ listener: EventListener; filter?: EventFilter | undefined }>();
  constructor(protected readonly clock: Clock = systemClock) {}

  protected abstract nextSeq(runId: string): Promise<number>;
  protected abstract persist(event: OrcaEvent): Promise<void>;
  abstract read(runId: string): Promise<OrcaEvent[]>;
  abstract listRuns(): Promise<string[]>;

  async append(input: OrcaEventInput): Promise<OrcaEvent> {
    const seq = await this.nextSeq(input.runId);
    const event = { ...input, id: newId("evt", this.clock.now()), seq, at: this.clock.isoNow() } as OrcaEvent;
    await this.persist(event);
    for (const { listener, filter } of this.listeners) {
      if (filter?.runId && filter.runId !== event.runId) continue;
      if (filter?.types && !filter.types.includes(event.type)) continue;
      try {
        listener(event);
      } catch {
        /* listeners must not break the log */
      }
    }
    return event;
  }

  subscribe(listener: EventListener, filter?: EventFilter): () => void {
    const entry = { listener, filter };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  }
}

export class InMemoryEventStore extends BaseEventStore {
  private readonly runs = new Map<string, OrcaEvent[]>();
  /** Serialises appends per run so seq numbers never collide under concurrency. */
  private readonly locks = new Map<string, Promise<unknown>>();

  protected async nextSeq(runId: string): Promise<number> {
    return this.runs.get(runId)?.length ?? 0;
  }
  protected async persist(event: OrcaEvent): Promise<void> {
    const list = this.runs.get(event.runId) ?? [];
    list.push(event);
    this.runs.set(event.runId, list);
  }
  override async append(input: OrcaEventInput): Promise<OrcaEvent> {
    const prev = this.locks.get(input.runId) ?? Promise.resolve();
    const next = prev.then(() => super.append(input));
    this.locks.set(input.runId, next.catch(() => undefined));
    return next;
  }
  async read(runId: string): Promise<OrcaEvent[]> {
    return [...(this.runs.get(runId) ?? [])];
  }
  async listRuns(): Promise<string[]> {
    return [...this.runs.keys()];
  }
}
