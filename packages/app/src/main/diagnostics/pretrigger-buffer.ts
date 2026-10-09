/** Opt-in, volatile metadata ring. No production caller exists until consent/producers land. */
import { randomUUID } from "node:crypto";
import {
  allowedEvent,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_LIMITS,
  omissionCount,
  type DiagnosticCode,
  type DiagnosticPhase,
} from "./profile.js";
import {
  canonicalDiagnosticReport,
  canonicalDiagnosticReportAsync,
  diagnosticReport,
  DIAGNOSTIC_ENVELOPE_BYTES,
  eventReservation,
  type DiagnosticReport,
} from "./snapshot.js";
import { ControlledPayloadMemory, type PayloadLease } from "./payload-memory.js";

const pairs = (Object.keys(DIAGNOSTIC_CODES) as DiagnosticPhase[]).flatMap((phase) =>
  DIAGNOSTIC_CODES[phase].map((code) => ({ phase, code, bytes: eventReservation(phase, code) })),
);
const pairIndex = new Map(pairs.map((pair, index) => [`${pair.phase}:${pair.code}`, index]));

export interface PretriggerOptions {
  readonly minutes?: number;
  /** May lower, never raise, the draft ceilings. Includes the complete report envelope. */
  readonly maxEvents?: number;
  readonly maxReportBytes?: number;
  /** Trusted monotonic clock in ms. Suspend/uncertain elapsed time must call stop(). */
  readonly now?: () => number;
  readonly payload?: ControlledPayloadMemory;
}

export interface FrozenDiagnosticSnapshot {
  readonly json: string;
  readonly byteLength: number;
}

/** This seam is not consent: future main-process wiring must check a session grant first. */
export class PretriggerBuffer {
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxReportBytes: number;
  private readonly payload: ControlledPayloadMemory;
  private ring: PayloadLease | undefined;
  private times: Float64Array | undefined;
  private codes: Uint16Array | undefined;
  private minutes: number;
  private head = 0;
  private size = 0;
  private bytes = DIAGNOSTIC_ENVELOPE_BYTES;
  private collecting = false;
  private lastTime = 0;
  private historyStart = 0;
  private lastCapacityLoss = -Infinity;
  private budget = 0;
  private expired = 0;
  private invalid = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PretriggerOptions = {}) {
    this.minutes = checkedInteger(
      options.minutes ?? DIAGNOSTIC_LIMITS.defaultMinutes,
      DIAGNOSTIC_LIMITS.minMinutes,
      DIAGNOSTIC_LIMITS.maxMinutes,
    );
    this.maxEvents = checkedInteger(options.maxEvents ?? DIAGNOSTIC_LIMITS.maxEvents, 1, DIAGNOSTIC_LIMITS.maxEvents);
    this.maxReportBytes = checkedInteger(
      options.maxReportBytes ?? DIAGNOSTIC_LIMITS.maxReportBytes,
      DIAGNOSTIC_ENVELOPE_BYTES,
      DIAGNOSTIC_LIMITS.maxReportBytes,
    );
    this.now = options.now ?? (() => performance.now());
    this.payload = options.payload ?? new ControlledPayloadMemory();
  }

  get enabled(): boolean {
    return this.collecting;
  }

  /** New explicit session only. Repeated start cannot refresh/reset existing history. */
  start(): boolean {
    if (this.enabled) return true;
    const now = this.readTime();
    if (now === undefined) return false;
    this.ring = this.payload.allocate(this.maxEvents * 10);
    this.times = new Float64Array(this.ring.bytes.buffer, this.ring.bytes.byteOffset, this.maxEvents);
    this.codes = new Uint16Array(
      this.ring.bytes.buffer,
      this.ring.bytes.byteOffset + this.maxEvents * 8,
      this.maxEvents,
    );
    this.historyStart = now;
    this.collecting = true;
    return true;
  }

  /** Opt-out, close, suspend or clock uncertainty: discard all retained references. */
  stop(): void {
    this.disarm();
    this.ring?.release();
    this.ring = this.times = this.codes = undefined;
    this.head = this.size = 0;
    this.bytes = DIAGNOSTIC_ENVELOPE_BYTES;
    this.collecting = false;
    this.lastTime = this.historyStart = 0;
    this.lastCapacityLoss = -Infinity;
    this.budget = this.expired = this.invalid = 0;
  }

  setMinutes(minutes: number): void {
    const next = checkedInteger(minutes, DIAGNOSTIC_LIMITS.minMinutes, DIAGNOSTIC_LIMITS.maxMinutes);
    // Expire against BOTH windows; increasing retention cannot resurrect idle history.
    const now = this.tick();
    this.minutes = next;
    if (now !== undefined) {
      this.expire(now);
      this.arm(now);
    }
  }

  /** Accept only two closed primitive enums, never a log/error/event/RPC payload. */
  record(phase: DiagnosticPhase, code: DiagnosticCode): boolean {
    const now = this.tick();
    if (now === undefined) return false;
    if (!allowedEvent(phase, code)) {
      this.invalid = increment(this.invalid);
      return false;
    }
    const bytes = eventReservation(phase, code);
    if (bytes > DIAGNOSTIC_LIMITS.maxEventBytes || bytes + DIAGNOSTIC_ENVELOPE_BYTES > this.maxReportBytes) {
      this.budget = increment(this.budget);
      this.lastCapacityLoss = now;
      return false;
    }
    while (this.size >= this.maxEvents || this.bytes + bytes > this.maxReportBytes) {
      const removed = this.removeOldest();
      this.lastCapacityLoss = Math.max(this.lastCapacityLoss, removed);
      this.budget = increment(this.budget);
    }
    const position = (this.head + this.size) % this.maxEvents;
    this.times![position] = now;
    this.codes![position] = pairIndex.get(`${phase}:${code}`)!;
    this.size += 1;
    this.bytes += bytes;
    this.arm(now);
    return true;
  }

  /** Freeze one complete canonical report synchronously; later collection cannot change it. */
  snapshot(): FrozenDiagnosticSnapshot | undefined {
    const report = this.freezeReport();
    return report && this.freezeJson(canonicalDiagnosticReport(report));
  }

  /** Freeze the ring atomically, then serialize independent bounded batches. */
  async snapshotAsync(): Promise<FrozenDiagnosticSnapshot | undefined> {
    const report = this.freezeReport(false);
    if (!report) return undefined;
    const size = this.size,
      historyStart = this.historyStart;
    if (!size) return this.freezeJson(await canonicalDiagnosticReportAsync(report, this.payload));
    // Freeze compact owned bytes atomically. Yielded serialization creates one
    // event at a time instead of retaining another 8192-object report tree.
    const frozen = this.payload.allocate(size * 10);
    const times = new Float64Array(frozen.bytes.buffer, frozen.bytes.byteOffset, size);
    const codes = new Uint16Array(frozen.bytes.buffer, frozen.bytes.byteOffset + size * 8, size);
    for (let index = 0; index < size; index++) {
      const position = (this.head + index) % this.maxEvents;
      times[index] = this.times![position]!;
      codes[index] = this.codes![position]!;
    }
    function* events() {
      for (let index = 0; index < size; index++) {
        const pair = pairs[codes[index]!]!;
        yield {
          phase: pair.phase,
          code: pair.code,
          offsetMs: times[index]! - historyStart,
          entityAlias: "unknown" as const,
        };
      }
    }
    try {
      return this.freezeJson(await canonicalDiagnosticReportAsync(report, this.payload, { size, events: events() }));
    } finally {
      frozen.release();
    }
  }

  private freezeReport(includeEvents = true): DiagnosticReport | undefined {
    const now = this.tick();
    if (now === undefined) return undefined;
    const oldest = this.size ? this.times![this.head] : undefined;
    // Exported identities belong only to this snapshot, including preparation retries.
    return diagnosticReport(
      randomUUID(),
      randomUUID(),
      {
        requestedWindowMs: this.minutes * 60_000,
        observedWindowMs: now - this.historyStart,
        retainedWindowMs: oldest === undefined ? 0 : now - oldest,
        capacityLimited:
          this.lastCapacityLoss >= this.historyStart && this.lastCapacityLoss > now - this.minutes * 60_000,
      },
      {
        budget: omissionCount(this.budget),
        expired: omissionCount(this.expired),
        invalid: omissionCount(this.invalid),
      },
      includeEvents
        ? Array.from({ length: this.size }, (_, index) => {
            const position = (this.head + index) % this.maxEvents;
            const event = pairs[this.codes![position]!]!;
            return {
              phase: event.phase,
              code: event.code,
              offsetMs: this.times![position]! - this.historyStart,
              entityAlias: "unknown" as const,
            };
          })
        : [],
    );
  }

  private freezeJson(json: string): FrozenDiagnosticSnapshot | undefined {
    const byteLength = Buffer.byteLength(json);
    // Defense against future envelope edits invalidating the reservation proof.
    if (byteLength > this.maxReportBytes) {
      this.stop();
      return undefined;
    }
    return Object.freeze({ json, byteLength });
  }

  private readTime(): number | undefined {
    try {
      const time = this.now();
      if (!Number.isFinite(time) || time < this.lastTime || time < 0 || time > Number.MAX_SAFE_INTEGER) {
        this.stop();
        return undefined;
      }
      this.lastTime = time;
      return Math.floor(time);
    } catch {
      this.stop();
      return undefined;
    }
  }

  private tick(): number | undefined {
    if (!this.enabled) return undefined;
    const now = this.readTime();
    if (now !== undefined) this.expire(now);
    return now;
  }

  private expire(now: number): void {
    this.historyStart = Math.max(this.historyStart, now - this.minutes * 60_000);
    while (this.size > 0 && this.times![this.head]! <= now - this.minutes * 60_000) {
      this.removeOldest();
      this.expired = increment(this.expired);
    }
  }

  private removeOldest(): number {
    const at = this.times![this.head]!;
    this.bytes -= pairs[this.codes![this.head]!]!.bytes;
    this.times![this.head] = 0;
    this.codes![this.head] = 0;
    this.head = (this.head + 1) % this.maxEvents;
    this.size -= 1;
    return at;
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(now: number): void {
    this.disarm();
    const oldest = this.size ? this.times![this.head] : undefined;
    if (oldest === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const current = this.tick();
        if (current !== undefined) this.arm(current);
      },
      Math.max(1, oldest + this.minutes * 60_000 - now),
    );
    this.timer.unref?.();
  }
}

function checkedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError("Invalid diagnostics limit");
  return value;
}

function increment(value: number): number {
  return Math.min(65_535, value + 1);
}
