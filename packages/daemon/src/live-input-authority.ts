/** Execution-authority lifetimes belong to admitted runs, never to observing UI sockets. */
import { OrcaError, type MutationActor } from "@orca/core";

interface BoundAuthority {
  actor: MutationActor;
  runId: string;
  abort: AbortController;
}

export class LiveExecutionAuthorities {
  private readonly runs = new Map<string, BoundAuthority>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly isCurrent: (actor: MutationActor, runId: string) => boolean,
    revalidateMs = 1000,
  ) {
    if (!Number.isFinite(revalidateMs) || revalidateMs <= 0)
      throw new OrcaError("CONFIG_INVALID", "authority revalidation interval must be positive");
    this.timer = setInterval(() => this.revalidate(), revalidateMs);
    this.timer.unref();
  }

  /** Only the verified admission path calls this, after exact run ownership is durable. */
  bind(runId: string, actor: MutationActor): void {
    if (this.closed || this.runs.has(runId))
      throw new OrcaError("RUN_STATE", "execution authority already bound or closed");
    const bound = { actor: { ...actor }, runId, abort: new AbortController() };
    this.runs.set(runId, bound);
    this.check(bound);
  }

  /** Children retain the admitted root's authority; configuration changes cannot replace it. */
  inherit(runId: string, parentRunId: string): void {
    const parent = this.runs.get(parentRunId);
    if (!parent || this.runs.has(runId)) throw new OrcaError("RUN_STATE", "no unambiguous parent execution authority");
    this.runs.set(runId, parent);
  }

  signalFor(runId: string): AbortSignal {
    const bound = this.runs.get(runId);
    if (!bound) throw new OrcaError("NOT_SUPPORTED", "live input has no verified execution authority");
    this.check(bound);
    return bound.abort.signal;
  }

  /** Additional operation checks use the attached actor, never a caller's replacement. */
  allowsCurrent(runId: string, allows: (actor: Readonly<MutationActor>) => boolean): boolean {
    const bound = this.runs.get(runId);
    if (!bound) return false;
    this.check(bound);
    // Do not expose the retained actor object even to a synchronous internal check.
    return !bound.abort.signal.aborted && allows({ ...bound.actor });
  }

  revalidate(): void {
    for (const bound of new Set(this.runs.values())) this.check(bound);
  }

  private check(bound: BoundAuthority): void {
    try {
      if (!this.isCurrent(bound.actor, bound.runId)) bound.abort.abort("execution authority revoked");
    } catch {
      bound.abort.abort("execution authority unavailable");
    }
  }

  /** Drop bookkeeping after the interpreter and its callbacks have ended. */
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const bound of this.runs.values()) bound.abort.abort("daemon stopped");
    this.runs.clear();
  }
}
