/**
 * Persistence for the planning layer: document collections for plans,
 * dependencies, risks and decisions, plus the append-only plan journal.
 *
 * Files: `<dir>/plans.json`, `<dir>/dependencies.json`, `<dir>/risks.json`,
 * `<dir>/decisions.json`, `<dir>/plans/<planId>.jsonl` (journal).
 */
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";
import { DecisionSchema, DependencySchema, newId, PlanEventSchema, PlanSchema, RiskSchema, systemClock, type Clock, type Decision, type Dependency, type Plan, type PlanEvent, type PlanEventInput, type Risk } from "@orca/core";
import { InMemoryDocumentStore, JsonFileDocumentStore, type DocumentStore } from "./document-store.js";

export type PlanEventListener = (event: PlanEvent) => void;

export interface PlanJournal {
  append(input: PlanEventInput): Promise<PlanEvent>;
  read(planId: string): Promise<PlanEvent[]>;
  listPlans(): Promise<string[]>;
  subscribe(listener: PlanEventListener, planId?: string): () => void;
}

abstract class BasePlanJournal implements PlanJournal {
  private readonly listeners = new Set<{ listener: PlanEventListener; planId?: string | undefined }>();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(protected readonly clock: Clock = systemClock) {}

  protected abstract nextSeq(planId: string): Promise<number>;
  protected abstract persist(event: PlanEvent): Promise<void>;
  abstract read(planId: string): Promise<PlanEvent[]>;
  abstract listPlans(): Promise<string[]>;

  append(input: PlanEventInput): Promise<PlanEvent> {
    const prev = this.locks.get(input.planId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const seq = await this.nextSeq(input.planId);
      const event = { ...input, id: newId("pev", this.clock.now()), seq, at: this.clock.isoNow() } as PlanEvent;
      await this.persist(event);
      for (const { listener, planId } of this.listeners) {
        if (planId && planId !== event.planId) continue;
        try {
          listener(event);
        } catch {
          /* listeners must not break the journal */
        }
      }
      return event;
    });
    this.locks.set(input.planId, next.catch(() => undefined));
    return next;
  }

  subscribe(listener: PlanEventListener, planId?: string): () => void {
    const entry = { listener, planId };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  }
}

export class InMemoryPlanJournal extends BasePlanJournal {
  private readonly plans = new Map<string, PlanEvent[]>();
  protected async nextSeq(planId: string): Promise<number> {
    return this.plans.get(planId)?.length ?? 0;
  }
  protected async persist(event: PlanEvent): Promise<void> {
    const list = this.plans.get(event.planId) ?? [];
    list.push(event);
    this.plans.set(event.planId, list);
  }
  async read(planId: string): Promise<PlanEvent[]> {
    return [...(this.plans.get(planId) ?? [])];
  }
  async listPlans(): Promise<string[]> {
    return [...this.plans.keys()];
  }
}

/** `<dir>/plans/<planId>.jsonl`, one JSON event per line. */
export class JsonlPlanJournal extends BasePlanJournal {
  private readonly counts = new Map<string, number>();
  private ready: Promise<void> | undefined;
  constructor(
    private readonly dir: string,
    clock?: Clock,
  ) {
    super(clock);
  }
  private get plansDir(): string {
    return join(this.dir, "plans");
  }
  private init(): Promise<void> {
    this.ready ??= mkdir(this.plansDir, { recursive: true }).then(() => undefined);
    return this.ready;
  }
  protected async nextSeq(planId: string): Promise<number> {
    let n = this.counts.get(planId);
    if (n === undefined) {
      n = (await this.read(planId)).length;
      this.counts.set(planId, n);
    }
    return n;
  }
  protected async persist(event: PlanEvent): Promise<void> {
    await this.init();
    await appendFile(join(this.plansDir, `${event.planId}.jsonl`), JSON.stringify(event) + "\n", "utf8");
    this.counts.set(event.planId, event.seq + 1);
  }
  async read(planId: string): Promise<PlanEvent[]> {
    await this.init();
    let text: string;
    try {
      text = await readFile(join(this.plansDir, `${planId}.jsonl`), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => PlanEventSchema.parse(JSON.parse(l)));
  }
  async listPlans(): Promise<string[]> {
    await this.init();
    return (await readdir(this.plansDir))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort();
  }
}

export interface PlanStores {
  plans: DocumentStore<Plan>;
  dependencies: DocumentStore<Dependency>;
  risks: DocumentStore<Risk>;
  decisions: DocumentStore<Decision>;
  journal: PlanJournal;
}

export function filePlanStores(dir: string, clock?: Clock): PlanStores {
  return {
    plans: new JsonFileDocumentStore<Plan>(join(dir, "plans.json"), PlanSchema as unknown as ZodType<Plan>),
    dependencies: new JsonFileDocumentStore<Dependency>(join(dir, "dependencies.json"), DependencySchema as unknown as ZodType<Dependency>),
    risks: new JsonFileDocumentStore<Risk>(join(dir, "risks.json"), RiskSchema as unknown as ZodType<Risk>),
    decisions: new JsonFileDocumentStore<Decision>(join(dir, "decisions.json"), DecisionSchema as unknown as ZodType<Decision>),
    journal: new JsonlPlanJournal(dir, clock),
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
