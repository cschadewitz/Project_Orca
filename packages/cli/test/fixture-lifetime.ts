/** Own acquired test resources until setup, calls and resource shutdown have actually settled. */
export class FixtureLifetime {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly resources: (() => Promise<unknown>)[] = [];
  private readonly roots: (() => Promise<unknown>)[] = [];
  private closing: Promise<void> | undefined;

  run<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Fixture is closing"));
    const operation = Promise.resolve().then(work);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  own(cleanup: () => Promise<unknown>): void {
    this.resources.push(cleanup);
  }

  root(remove: () => Promise<unknown>): void {
    this.roots.push(remove);
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      // Work registered before close may still acquire a resource. Collect cleanup
      // only after that work settles, rather than snapshotting the stack too early.
      await Promise.allSettled(this.pending);
      const errors: unknown[] = [];
      for (const cleanup of this.resources.splice(0).reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      // Failure to prove resource cessation preserves the disposable evidence root.
      if (errors.length) throw new AggregateError(errors, "Fixture shutdown failed; roots retained");
      for (const remove of this.roots.splice(0).reverse()) await remove();
    });
    return this.closing;
  }
}
