/**
 * File-backed event store: one newline-delimited JSON file per run under
 * `<dir>/runs/<runId>.jsonl`. Simple, greppable, and safe to commit alongside
 * artifacts if a team wants run history in git.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OrcaEventSchema, appendJsonl, readJsonl, readJsonlLines, type Clock, type OrcaEvent } from "@orca/core";
import { BaseEventStore } from "./event-store.js";

export class JsonlEventStore extends BaseEventStore {
  private readonly counts = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private ready: Promise<void> | undefined;

  constructor(
    private readonly dir: string,
    clock?: Clock,
  ) {
    super(clock);
  }

  private get runsDir(): string {
    return join(this.dir, "runs");
  }
  private file(runId: string): string {
    return join(this.runsDir, `${runId}.jsonl`);
  }
  private init(): Promise<void> {
    this.ready ??= mkdir(this.runsDir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  protected async nextSeq(runId: string): Promise<number> {
    await this.init();
    let n = this.counts.get(runId);
    if (n === undefined) {
      n = (await this.read(runId)).length;
      this.counts.set(runId, n);
    }
    return n;
  }
  protected async persist(event: OrcaEvent): Promise<void> {
    await appendJsonl(this.file(event.runId), event);
    this.counts.set(event.runId, event.seq + 1);
  }
  override async append(input: Parameters<BaseEventStore["append"]>[0]): Promise<OrcaEvent> {
    const prev = this.locks.get(input.runId) ?? Promise.resolve();
    const next = prev.then(() => super.append(input));
    this.locks.set(input.runId, next.catch(() => undefined));
    return next;
  }
  private async lines(runId: string): Promise<string[]> {
    await this.init();
    return readJsonlLines(this.file(runId));
  }
  async read(runId: string): Promise<OrcaEvent[]> {
    await this.init();
    return readJsonl(this.file(runId), OrcaEventSchema);
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
    for (const line of await this.lines(runId)) {
      if (!needles.some((n) => line.includes(n))) continue;
      const event = OrcaEventSchema.parse(JSON.parse(line));
      if (types.includes(event.type)) out.push(event);
    }
    return out;
  }

  async listRuns(): Promise<string[]> {
    await this.init();
    const files = await readdir(this.runsDir);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort();
  }
}
