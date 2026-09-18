/**
 * File-backed event store: one newline-delimited JSON file per run under
 * `<dir>/runs/<runId>.jsonl`. Simple, greppable, and safe to commit alongside
 * artifacts if a team wants run history in git.
 *
 * Sequencing, locking and torn-line recovery live in `JsonlLogDir`, shared
 * with the plan journal.
 */
import { join } from "node:path";
import { OrcaEventSchema, type Clock, type Logger, type OrcaEvent } from "@orca/core";
import { BaseEventStore } from "./event-store.js";
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
  listRuns(): Promise<string[]> {
    return this.logs.keys();
  }
}
