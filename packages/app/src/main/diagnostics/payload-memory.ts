/** Bounded reusable binary regions and admission before backing/provider allocation. */
import { RECOVERY_LIMITS } from "./recovery-contract.js";

export interface PayloadLease {
  readonly bytes: Buffer;
  release(): void;
}

const ARENA_BYTES = 5 * RECOVERY_LIMITS.exportBytes;
// Metadata, keys and the 81,920-byte ring do not need a full report arena.
// Add only the required region without copying live views. All regions share
// the original ceiling, including unused space and provider allowances.
const ARENA_GRANULARITY = 128 * 1024;
interface Arena {
  bytes: Buffer;
  free: { offset: number; size: number }[];
}

/** One profile composition shares this owner across ring/controller/disk/key work.
 * This tracks controlled binary storage. Engine strings/objects and OS/provider
 * internals remain the separate measured managed/external/native evidence.
 */
export class ControlledPayloadMemory {
  private arenas: Arena[] = [];
  private leases = 0;
  private external = 0;
  private peak = 0;
  private allocations = 0;

  stats() {
    const arenaBytes = this.arenas.reduce((sum, arena) => sum + arena.bytes.length, 0);
    return {
      allocatedBytes: arenaBytes + this.external,
      peakBytes: this.peak,
      arenaBytes,
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
    let arena = this.arenas.find((candidate) => candidate.free.some((entry) => entry.size >= size));
    if (!arena) {
      const remaining = ARENA_BYTES - this.stats().arenaBytes;
      if (size > remaining) throw new Error("capacity_limited");
      const capacity = Math.min(remaining, Math.ceil(size / ARENA_GRANULARITY) * ARENA_GRANULARITY);
      this.admit(capacity);
      arena = { bytes: Buffer.alloc(capacity), free: [{ offset: 0, size: capacity }] };
      this.arenas.push(arena);
      this.observe();
    }
    const free = arena.free;
    const index = free.findIndex((entry) => entry.size >= size);
    const entry = free[index]!;
    const offset = entry.offset;
    entry.offset += size;
    entry.size -= size;
    if (!entry.size) free.splice(index, 1);
    this.leases++;
    this.allocations++;
    const bytes = arena.bytes.subarray(offset, offset + length);
    let live = true;
    return {
      bytes,
      release: () => {
        if (!live) return;
        live = false;
        // Erase before reusing, including alignment padding, without waiting for GC.
        arena.bytes.fill(0, offset, offset + size);
        this.leases--;
        free.push({ offset, size });
        free.sort((a, b) => a.offset - b.offset);
        for (let i = 1; i < free.length;) {
          const previous = free[i - 1]!,
            current = free[i]!;
          if (previous.offset + previous.size === current.offset) {
            previous.size += current.size;
            free.splice(i, 1);
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
    if (this.leases || this.external) return;
    for (const arena of this.arenas) arena.bytes.fill(0);
    this.arenas = [];
  }
}
