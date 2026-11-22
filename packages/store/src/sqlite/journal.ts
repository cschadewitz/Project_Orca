/** The plan journal in SQLite (#339): per-plan gap-free `seq`, assigned and written in one transaction. */
import { PlanEventSchema, type Clock, type PlanEvent } from "@orca/core";
import { BasePlanJournal } from "../plan-store.js";
import type { SqliteDatabase } from "./database.js";

export class SqlitePlanJournal extends BasePlanJournal {
  constructor(
    private readonly db: SqliteDatabase,
    clock?: Clock,
  ) {
    super(clock);
  }
  protected write(planId: string, build: (seq: number) => PlanEvent): Promise<PlanEvent> {
    return this.db.write(() => {
      const row = this.db.prepare("SELECT MAX(seq) AS seq FROM plan_events WHERE plan_id = ?").get(planId) as {
        seq: number | null;
      };
      const event = build(row.seq === null ? 0 : Number(row.seq) + 1);
      this.db.prepare("INSERT OR IGNORE INTO plan_journals (plan_id) VALUES (?)").run(planId);
      this.db
        .prepare("INSERT INTO plan_events (plan_id, seq, body) VALUES (?, ?, ?)")
        .run(planId, event.seq, JSON.stringify(event));
      return event;
    });
  }
  read(planId: string): Promise<PlanEvent[]> {
    return this.db.read(() =>
      (
        this.db.prepare("SELECT body FROM plan_events WHERE plan_id = ? ORDER BY seq").all(planId) as {
          body: string;
        }[]
      ).map((r) => PlanEventSchema.parse(JSON.parse(r.body))),
    );
  }
  listPlans(): Promise<string[]> {
    return this.db.read(() =>
      (this.db.prepare("SELECT plan_id FROM plan_journals ORDER BY rowid").all() as { plan_id: string }[]).map(
        (r) => r.plan_id,
      ),
    );
  }
}
