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
  /**
   * Only the events of `types`, in order. Implementations may skip the rest
   * without materialising them, which is what makes summary projections cheap
   * on runs whose logs are dominated by `agent.update`.
   */
  readTypes(runId: string, types: readonly OrcaEvent["type"][]): Promise<OrcaEvent[]>;
  /** All run ids known to the store, oldest first. */
  listRuns(): Promise<string[]>;
  subscribe(listener: EventListener, filter?: EventFilter): () => void;
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

  async append(input: OrcaEventInput): Promise<OrcaEvent> {
    const event = await this.write(input.runId, (seq) => ({ ...input, id: newId("evt", this.clock.now()), seq, at: this.clock.isoNow() }));
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
