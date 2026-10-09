/** Binary ownership for one serialized disk operation, including opaque providers. */
import { randomFillSync } from "node:crypto";
import { ControlledPayloadMemory, type PayloadLease } from "./payload-memory.js";

export class PayloadScope {
  private readonly leases = new Map<Buffer, PayloadLease>();
  private readonly external: { bytes: Buffer; release: () => void }[] = [];

  constructor(private readonly memory: ControlledPayloadMemory) {}

  allocate(length: number): Buffer {
    const lease = this.memory.allocate(length);
    this.leases.set(lease.bytes, lease);
    return lease.bytes;
  }

  from(input: string | Buffer, encoding: BufferEncoding = "utf8"): Buffer {
    if (typeof input !== "string") {
      const bytes = this.allocate(input.length);
      input.copy(bytes);
      return bytes;
    }
    const bytes = this.allocate(Buffer.byteLength(input, encoding));
    bytes.write(input, encoding);
    return bytes;
  }

  random(length: number): Buffer {
    return randomFillSync(this.allocate(length));
  }

  concat(parts: readonly Buffer[]): Buffer {
    const bytes = this.allocate(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) offset += part.copy(bytes, offset);
    return bytes;
  }

  /** The provider cannot accept caller-owned storage. Admit its maximum first,
   * retain that allowance and output until the actual disk operation settles.
   */
  async provider(maximum: number, work: () => Promise<Buffer>): Promise<Buffer> {
    const release = this.memory.allowance(maximum);
    try {
      const bytes = await work();
      this.external.push({ bytes, release });
      if (bytes.length > maximum) throw new Error("capacity_limited");
      return bytes;
    } catch (error) {
      // A returned oversized buffer is still charged/erased by dispose().
      if (!this.external.some((entry) => entry.release === release)) release();
      throw error;
    }
  }

  crypto(maximum: number, work: () => Buffer): Buffer {
    const release = this.memory.allowance(maximum);
    try {
      const bytes = work();
      this.external.push({ bytes, release });
      if (bytes.length > maximum) throw new Error("capacity_limited");
      return bytes;
    } catch (error) {
      if (!this.external.some((entry) => entry.release === release)) release();
      throw error;
    }
  }

  /** Bounded synchronous crypto returns a binary string directly. Reserve the
   * temporary native output before dispatch; no returned full-report Buffer is
   * left waiting for GC. Engine strings remain part of the measured memory gate.
   */
  cryptoText(maximum: number, work: () => string): string {
    const release = this.memory.allowance(maximum);
    try {
      return work();
    } finally {
      release();
    }
  }

  /** Transfer an owned arena lease to a session key or returned plaintext. */
  take(bytes: Buffer): PayloadLease {
    const lease = this.leases.get(bytes);
    if (!lease) throw new Error("unavailable");
    this.leases.delete(bytes);
    return lease;
  }

  dispose(): void {
    for (const lease of this.leases.values()) lease.release();
    this.leases.clear();
    for (const entry of this.external) {
      entry.bytes.fill(0);
      entry.release();
    }
    this.external.length = 0;
  }
}
