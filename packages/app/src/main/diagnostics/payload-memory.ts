/** Fixed reusable binary arena and continuous admission before external payload allocation. */
import { RECOVERY_LIMITS } from "./recovery-contract.js";

export interface PayloadLease {
  readonly bytes: Buffer;
  release(): void;
}

const ARENA_BYTES = 5 * RECOVERY_LIMITS.exportBytes;

/** One profile composition shares this owner across ring/controller/disk/key work.
 * This tracks controlled binary storage. Engine strings/objects and OS/provider
 * internals remain the separate measured managed/external/native evidence.
 */
export class ControlledPayloadMemory {
  private arena: Buffer | undefined;
  private free: { offset: number; size: number }[] = [];
  private leases = 0;
  private external = 0;
  private peak = 0;
  private allocations = 0;

  stats() {
    return {
      allocatedBytes: (this.arena?.length ?? 0) + this.external,
      peakBytes: this.peak,
      arenaBytes: this.arena?.length ?? 0,
      externalAllowanceBytes: this.external,
      leases: this.leases,
      allocations: this.allocations,
    };
  }

  private admit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.stats().allocatedBytes + bytes > RECOVERY_LIMITS.payloadBytes)
      throw new Error("capacity_limited");
  }

  /** Reserve before dispatch; the caller releases only after the underlying job settles. */
  allowance(bytes: number): () => void {
    this.admit(bytes);
    this.external += bytes;
    this.observe();
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.external -= bytes;
      this.disposeIfIdle();
    };
  }

  allocate(length: number): PayloadLease {
    if (!Number.isSafeInteger(length) || length < 0 || length > ARENA_BYTES) throw new Error("capacity_limited");
    const size = Math.max(8, Math.ceil(length / 8) * 8);
    if (!this.arena) {
      this.admit(ARENA_BYTES);
      this.arena = Buffer.alloc(ARENA_BYTES);
      this.free = [{ offset: 0, size: ARENA_BYTES }];
      this.observe();
    }
    const index = this.free.findIndex((entry) => entry.size >= size);
    if (index < 0) throw new Error("capacity_limited");
    const entry = this.free[index]!;
    const offset = entry.offset;
    entry.offset += size;
    entry.size -= size;
    if (!entry.size) this.free.splice(index, 1);
    this.leases++;
    this.allocations++;
    const bytes = this.arena.subarray(offset, offset + length);
    let live = true;
    return {
      bytes,
      release: () => {
        if (!live) return;
        live = false;
        // Erase before reusing, including alignment padding, without waiting for GC.
        this.arena!.fill(0, offset, offset + size);
        this.leases--;
        this.free.push({ offset, size });
        this.free.sort((a, b) => a.offset - b.offset);
        for (let i = 1; i < this.free.length;) {
          const previous = this.free[i - 1]!,
            current = this.free[i]!;
          if (previous.offset + previous.size === current.offset) {
            previous.size += current.size;
            this.free.splice(i, 1);
          } else i++;
        }
        this.disposeIfIdle();
      },
    };
  }

  from(input: string | Buffer): PayloadLease {
    const lease = this.allocate(typeof input === "string" ? Buffer.byteLength(input) : input.length);
    if (typeof input === "string") lease.bytes.write(input, "utf8");
    else input.copy(lease.bytes);
    return lease;
  }

  private observe(): void {
    this.peak = Math.max(this.peak, this.stats().allocatedBytes);
  }

  private disposeIfIdle(): void {
    if (this.leases || this.external || !this.arena) return;
    this.arena.fill(0);
    this.arena = undefined;
    this.free = [];
  }
}
