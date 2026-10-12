/** Direct-child cleanup must observe exit, bound failures and share concurrent calls. */
import { afterEach, expect, it, vi } from "vitest";
import type { AgentProcessHandle, ProcessExit } from "@orca/agents";
import { processCleanup } from "../src/process-cleanup.js";

afterEach(() => vi.useRealTimers());

function fixture(graceMs?: number) {
  vi.useFakeTimers();
  let exit!: (value: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    exit = resolve;
  });
  const kill = vi.fn();
  const cleanup = processCleanup({ exited, kill } as unknown as AgentProcessHandle, graceMs);
  return { exit: () => exit({ code: 0, signal: null }), kill, cleanup };
}

it("does not signal an already exited child", async () => {
  const f = fixture();
  f.exit();
  await f.cleanup();
  expect(f.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("shares concurrent and repeated cleanup and clears the grace timer on cooperative exit", async () => {
  const f = fixture();
  f.kill.mockImplementation(() => f.exit());
  const first = f.cleanup();
  expect(f.cleanup()).toBe(first);
  await first;
  expect(f.cleanup()).toBe(first);
  expect(f.kill.mock.calls).toEqual([["SIGTERM"]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("escalates once and waits for the actual exit", async () => {
  const f = fixture();
  const done = vi.fn();
  const pending = f.cleanup().then(done);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(done).not.toHaveBeenCalled();
  f.exit();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["two seconds by default", undefined, 2000],
  ["the grace it is given", 100, 100],
])("waits %s after each signal", async (_, graceMs, expected) => {
  const f = fixture(graceMs);
  let outcome = "pending";
  const rejected = f.cleanup().catch(() => {
    outcome = "incomplete";
  });
  await vi.advanceTimersByTimeAsync(expected - 1);
  expect(f.kill.mock.calls).toEqual([["SIGTERM"]]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  await vi.advanceTimersByTimeAsync(expected - 1);
  expect(outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(outcome).toBe("incomplete");
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("bounds an unobserved exit (signals throw: %s)", async (throws) => {
  const f = fixture();
  if (throws)
    f.kill.mockImplementation(() => {
      throw new Error("signal refused");
    });
  const pending = f.cleanup();
  const rejected = expect(pending).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    details: {
      cleanupIncomplete: true,
      signalErrors: throws
        ? [
            { signal: "SIGTERM", error: { message: "signal refused" } },
            { signal: "SIGKILL", error: { message: "signal refused" } },
          ]
        : [],
    },
  });
  await vi.advanceTimersByTimeAsync(4000);
  await rejected;
  expect(f.cleanup()).toBe(pending);
  expect(f.kill).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
