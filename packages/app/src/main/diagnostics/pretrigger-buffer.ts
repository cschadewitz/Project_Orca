/** Opt-in, volatile metadata ring. No production caller exists until consent/producers land. */
import { randomUUID } from "node:crypto";
import {
  allowedEvent,
  DIAGNOSTIC_LIMITS,
  omissionCount,
  type DiagnosticCode,
  type DiagnosticPhase,
} from "./profile.js";
import { canonicalJson, diagnosticReport, DIAGNOSTIC_ENVELOPE_BYTES, eventReservation } from "./snapshot.js";

interface RetainedEvent {
  readonly at: number;
  readonly phase: DiagnosticPhase;
  readonly code: DiagnosticCode;
  readonly bytes: number;
}

export interface PretriggerOptions {
  readonly minutes?: number;
  /** May lower, never raise, the draft ceilings. Includes the complete report envelope. */
  readonly maxEvents?: number;
  readonly maxReportBytes?: number;
  /** Trusted monotonic clock in ms. Suspend/uncertain elapsed time must call stop(). */
  readonly now?: () => number;
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
  private readonly ring: (RetainedEvent | undefined)[];
  private minutes: number;
  private head = 0;
  private size = 0;
  private bytes = DIAGNOSTIC_ENVELOPE_BYTES;
  private sessionId: string | undefined;
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
    this.ring = new Array<RetainedEvent | undefined>(this.maxEvents);
  }

  get enabled(): boolean {
    return this.sessionId !== undefined;
  }

  /** New explicit session only. Repeated start cannot refresh/reset existing history. */
  start(): boolean {
    if (this.enabled) return true;
    const now = this.readTime();
    if (now === undefined) return false;
    this.historyStart = now;
    this.sessionId = randomUUID();
    return true;
  }

  /** Opt-out, close, suspend or clock uncertainty: discard all retained references. */
  stop(): void {
    this.disarm();
    this.ring.fill(undefined);
    this.head = this.size = 0;
    this.bytes = DIAGNOSTIC_ENVELOPE_BYTES;
    this.sessionId = undefined;
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
      this.lastCapacityLoss = Math.max(this.lastCapacityLoss, removed.at);
      this.budget = increment(this.budget);
    }
    this.ring[(this.head + this.size) % this.maxEvents] = { at: now, phase, code, bytes };
    this.size += 1;
    this.bytes += bytes;
    this.arm(now);
    return true;
  }

  /** Freeze one complete canonical report synchronously; later collection cannot change it. */
  snapshot(): FrozenDiagnosticSnapshot | undefined {
    const now = this.tick();
    if (now === undefined || this.sessionId === undefined) return undefined;
    const oldest = this.ring[this.head];
    const report = diagnosticReport(
      randomUUID(),
      this.sessionId,
      {
        requestedWindowMs: this.minutes * 60_000,
        observedWindowMs: now - this.historyStart,
        retainedWindowMs: oldest === undefined ? 0 : now - oldest.at,
        capacityLimited:
          this.lastCapacityLoss >= this.historyStart && this.lastCapacityLoss > now - this.minutes * 60_000,
      },
      {
        budget: omissionCount(this.budget),
        expired: omissionCount(this.expired),
        invalid: omissionCount(this.invalid),
      },
      Array.from({ length: this.size }, (_, index) => {
        const event = this.ring[(this.head + index) % this.maxEvents]!;
        return {
          phase: event.phase,
          code: event.code,
          offsetMs: event.at - this.historyStart,
          entityAlias: "unknown" as const,
        };
      }),
    );
    const json = canonicalJson(report);
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
    while (this.size > 0 && this.ring[this.head]!.at <= now - this.minutes * 60_000) {
      this.removeOldest();
      this.expired = increment(this.expired);
    }
  }

  private removeOldest(): RetainedEvent {
    const event = this.ring[this.head]!;
    this.ring[this.head] = undefined;
    this.head = (this.head + 1) % this.maxEvents;
    this.size -= 1;
    this.bytes -= event.bytes;
    return event;
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(now: number): void {
    this.disarm();
    const oldest = this.ring[this.head];
    if (oldest === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const current = this.tick();
        if (current !== undefined) this.arm(current);
      },
      Math.max(1, oldest.at + this.minutes * 60_000 - now),
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
