/**
 * File-backed event store: one newline-delimited JSON file per run under
 * `<dir>/runs/<runId>.jsonl`. Simple, greppable, and safe to commit alongside
 * artifacts if a team wants run history in git.
 */
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OrcaEventSchema, type Clock, type OrcaEvent } from "@orca/core";
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
    await appendFile(this.file(event.runId), JSON.stringify(event) + "\n", "utf8");
    this.counts.set(event.runId, event.seq + 1);
  }
  override async append(input: Parameters<BaseEventStore["append"]>[0]): Promise<OrcaEvent> {
    const prev = this.locks.get(input.runId) ?? Promise.resolve();
    const next = prev.then(() => super.append(input));
    this.locks.set(input.runId, next.catch(() => undefined));
    return next;
  }
  async read(runId: string): Promise<OrcaEvent[]> {
    await this.init();
    let text: string;
    try {
      text = await readFile(this.file(runId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => OrcaEventSchema.parse(JSON.parse(l)));
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
