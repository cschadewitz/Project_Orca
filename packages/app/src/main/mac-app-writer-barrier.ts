/** Main dispatch drain, separate from durable admission and lifetime kernel ownership. */
export class MacAppWriterBarrier {
  private sealed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private paused: Promise<boolean> | undefined;
  get admitting(): boolean {
    return !this.sealed;
  }
  run<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new Error("App writers are paused for replacement"));
    // Reserve before dispatch so a synchronous callback cannot pause past this work.
    const operation = Promise.resolve().then(work);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  /** Seal before awaiting anything. Stop timers/producers and wait for their actual
   * storage settlement before releasing the app's lifetime kernel slots. A timeout
   * outside this operation cannot release ownership or create a second pause. */
  pause(stopBackground: () => Promise<void>, releaseWriter: () => Promise<void>): Promise<boolean> {
    this.sealed = true;
    return (this.paused ??= (async () => {
      try {
        await Promise.allSettled([...this.pending]);
        await stopBackground();
        await releaseWriter();
        return true;
      } catch {
        return false;
      }
    })());
  }
}
