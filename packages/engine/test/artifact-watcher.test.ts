/**
 * The `artifact-present` watcher must not queue work faster than the host can answer
 * it: on an SSH host every presence check is a fresh `ssh` process, and a fixed
 * interval that ignores the previous check stacks them up without bound (issue #18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostFileSystem } from "@orca/agents";
import { watchForArtifacts } from "@orca/engine";

/** A file system whose `existsMany` takes `latencyMs` and reports overlapping calls. */
function slowFs(
  latencyMs: number,
  answer: (call: number) => boolean[] | Error,
): HostFileSystem & { calls: number; maxConcurrent: number; batches: number[] } {
  const fs = {
    calls: 0,
    maxConcurrent: 0,
    batches: [] as number[],
    inFlight: 0,
    readFile: () => Promise.reject(new Error("unused")),
    writeFile: () => Promise.reject(new Error("unused")),
    exists: () => Promise.reject(new Error("unused")),
    mkdirp: () => Promise.reject(new Error("unused")),
    existsMany: async (paths: string[]) => {
      fs.inFlight++;
      fs.maxConcurrent = Math.max(fs.maxConcurrent, fs.inFlight);
      fs.batches.push(paths.length);
      const call = ++fs.calls;
      await new Promise((r) => setTimeout(r, latencyMs));
      fs.inFlight--;
      const a = answer(call);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return fs;
}

describe("watchForArtifacts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("never overlaps checks when the host answers slower than the poll interval", async () => {
    // 2 s per check against a 1.5 s base interval: the old setInterval would have a
    // second check in flight before the first returned.
    const fs = slowFs(2000, () => [false, false]);
    const stop = watchForArtifacts(fs, ["/w/a.md", "/w/b.md"], () => expect.unreachable("nothing exists yet"));
    await vi.advanceTimersByTimeAsync(8000);
    stop();

    expect(fs.maxConcurrent).toBe(1);
    expect(fs.calls).toBe(2);
    // Eight seconds of controlled time at >= 2 s latency + >= 1.5 s wait per round.
    expect(fs.calls).toBeLessThanOrEqual(3);
    expect(fs.calls).toBeGreaterThan(0);
    // One round trip for the whole set, not one per path.
    expect(fs.batches.every((n) => n === 2)).toBe(true);
  });

  it("fires once when every path exists and stops polling afterwards", async () => {
    const fs = slowFs(0, (call) => (call >= 2 ? [true, true] : [true, false]));
    let fired = 0;
    const stop = watchForArtifacts(fs, ["/w/a.md", "/w/b.md"], () => fired++);
    await vi.advanceTimersByTimeAsync(5000);
    stop();

    expect(fired).toBe(1);
    expect(fs.calls).toBe(2);
  });

  it("keeps watching through host errors instead of giving up", async () => {
    const fs = slowFs(0, (call) => (call === 1 ? new Error("ssh: connection closed") : [true]));
    let fired = 0;
    const stop = watchForArtifacts(fs, ["/w/a.md"], () => fired++);
    await vi.advanceTimersByTimeAsync(6000);
    stop();

    expect(fs.calls).toBe(2); // first failed, backed off, second succeeded
    expect(fired).toBe(1);
  });

  it("stops scheduling after the caller cancels", async () => {
    const fs = slowFs(0, () => [false]);
    const stop = watchForArtifacts(fs, ["/w/a.md"], () => expect.unreachable("never present"));
    stop();
    await vi.advanceTimersByTimeAsync(4000);

    expect(fs.calls).toBe(0);
  });

  it("does not publish or reschedule a check that finishes after cancellation", async () => {
    const fs = slowFs(2000, () => [true]);
    const present = vi.fn();
    const stop = watchForArtifacts(fs, ["/w/a.md"], present);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fs.calls).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(8000);
    expect(present).not.toHaveBeenCalled();
    expect(fs.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
