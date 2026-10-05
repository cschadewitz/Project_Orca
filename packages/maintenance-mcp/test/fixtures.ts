/** Synthetic, bounded observations only: never read the executing host or real logs. */
import type { ObservationAdapter, ReadBudget, ReadRequest } from "../src/adapter.js";
export const FIXTURE_BOOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export function hostFixture(observedAt = new Date().toISOString()) {
  return {
    observedAt,
    bootId: FIXTURE_BOOT,
    uptimeSeconds: 120,
    memoryTotalBytes: 4096,
    memoryAvailableBytes: 2048,
    rootTotalBytes: 8192,
    rootAvailableBytes: 4096,
  };
}
export class FixtureAdapter implements ObservationAdapter {
  readonly calls: { request: ReadRequest; budget: ReadBudget }[] = [];
  constructor(readonly value: unknown) {}
  async read(request: ReadRequest, budget: ReadBudget): Promise<Uint8Array> {
    this.calls.push({ request, budget });
    budget.signal.throwIfAborted();
    const bytes = encode(this.value);
    if (bytes.byteLength > budget.maxBytes) throw new Error("fixture budget exceeded");
    return bytes;
  }
}
