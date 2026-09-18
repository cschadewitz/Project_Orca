/**
 * Persistence for the planning layer: document collections for plans,
 * dependencies, risks and decisions, plus the append-only plan journal.
 *
 * Files: `<dir>/plans.json`, `<dir>/dependencies.json`, `<dir>/risks.json`,
 * `<dir>/decisions.json`, `<dir>/plans/<planId>.jsonl` (journal).
 */
import { join } from "node:path";
import { DecisionSchema, DependencySchema, newId, PlanEventSchema, PlanSchema, RiskSchema, systemClock, type Clock, type Decision, type Dependency, type Logger, type Plan, type PlanEvent, type PlanEventInput, type Risk } from "@orca/core";
import { InMemoryDocumentStore, JsonFileDocumentStore, type DocumentStore } from "./document-store.js";
import { JsonlLogDir } from "./jsonl-log.js";

export type PlanEventListener = (event: PlanEvent) => void;

export interface PlanJournal {
  append(input: PlanEventInput): Promise<PlanEvent>;
  read(planId: string): Promise<PlanEvent[]>;
  listPlans(): Promise<string[]>;
  subscribe(listener: PlanEventListener, planId?: string): () => void;
}

abstract class BasePlanJournal implements PlanJournal {
  private readonly listeners = new Set<{ listener: PlanEventListener; planId?: string | undefined }>();
  constructor(protected readonly clock: Clock = systemClock) {}

  /** Persist `build(seq)` as the next event of `planId`; see `BaseEventStore.write`. */
  protected abstract write(planId: string, build: (seq: number) => PlanEvent): Promise<PlanEvent>;
  abstract read(planId: string): Promise<PlanEvent[]>;
  abstract listPlans(): Promise<string[]>;

  async append(input: PlanEventInput): Promise<PlanEvent> {
    const event = await this.write(input.planId, (seq) => ({ ...input, id: newId("pev", this.clock.now()), seq, at: this.clock.isoNow() }));
    for (const { listener, planId } of this.listeners) {
      if (planId && planId !== event.planId) continue;
      try {
        listener(event);
      } catch {
        /* listeners must not break the journal */
      }
    }
    return event;
  }

  subscribe(listener: PlanEventListener, planId?: string): () => void {
    const entry = { listener, planId };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  }
}

export class InMemoryPlanJournal extends BasePlanJournal {
  private readonly plans = new Map<string, PlanEvent[]>();
  protected async write(planId: string, build: (seq: number) => PlanEvent): Promise<PlanEvent> {
    const list = this.plans.get(planId) ?? [];
    const event = build(list.length);
    list.push(event);
    this.plans.set(planId, list);
    return event;
  }
  async read(planId: string): Promise<PlanEvent[]> {
    return [...(this.plans.get(planId) ?? [])];
  }
  async listPlans(): Promise<string[]> {
    return [...this.plans.keys()];
  }
}

/** `<dir>/plans/<planId>.jsonl`, one JSON event per line; sequenced on disk by `JsonlLogDir`. */
export class JsonlPlanJournal extends BasePlanJournal {
  private readonly logs: JsonlLogDir;
  constructor(dir: string, clock?: Clock, logger?: Logger) {
    super(clock);
    this.logs = new JsonlLogDir(join(dir, "plans"), { ...(logger ? { logger } : {}) });
  }
  protected write(planId: string, build: (seq: number) => PlanEvent): Promise<PlanEvent> {
    return this.logs.append(planId, build);
  }
  read(planId: string): Promise<PlanEvent[]> {
    return this.logs.read(planId, PlanEventSchema);
  }
  listPlans(): Promise<string[]> {
    return this.logs.keys();
  }
}

export interface PlanStores {
  plans: DocumentStore<Plan>;
  dependencies: DocumentStore<Dependency>;
  risks: DocumentStore<Risk>;
  decisions: DocumentStore<Decision>;
  journal: PlanJournal;
}

export function filePlanStores(dir: string, clock?: Clock, logger?: Logger): PlanStores {
  return {
    plans: new JsonFileDocumentStore<Plan>(join(dir, "plans.json"), PlanSchema),
    dependencies: new JsonFileDocumentStore<Dependency>(join(dir, "dependencies.json"), DependencySchema),
    risks: new JsonFileDocumentStore<Risk>(join(dir, "risks.json"), RiskSchema),
    decisions: new JsonFileDocumentStore<Decision>(join(dir, "decisions.json"), DecisionSchema),
    journal: new JsonlPlanJournal(dir, clock, logger),
  };
}

export function memoryPlanStores(clock?: Clock): PlanStores {
  return {
    plans: new InMemoryDocumentStore<Plan>(),
    dependencies: new InMemoryDocumentStore<Dependency>(),
    risks: new InMemoryDocumentStore<Risk>(),
    decisions: new InMemoryDocumentStore<Decision>(),
    journal: new InMemoryPlanJournal(clock),
  };
}
