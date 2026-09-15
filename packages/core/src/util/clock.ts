/** Injectable clock so the engine and tests are deterministic. */
export interface Clock {
  now(): number;
  isoNow(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

export class FakeClock implements Clock {
  constructor(private t = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.t;
  }
  isoNow(): string {
    return new Date(this.t).toISOString();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
