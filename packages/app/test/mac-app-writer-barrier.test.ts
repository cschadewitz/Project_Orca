import { expect, it, vi } from "vitest";
import { MacAppWriterBarrier } from "../src/main/mac-app-writer-barrier.js";

it("seals new writes immediately and waits for dispatched work and background settlement before releasing", async () => {
  const barrier = new MacAppWriterBarrier();
  let finish!: () => void;
  const dispatched = barrier.run(() => new Promise<void>((resolve) => (finish = resolve)));
  await Promise.resolve();
  const background = vi.fn(async () => {}),
    release = vi.fn(async () => {});
  const paused = barrier.pause(background, release);
  expect(barrier.admitting).toBe(false);
  await expect(barrier.run(() => undefined)).rejects.toThrow();
  expect(release).not.toHaveBeenCalled();
  finish();
  await dispatched;
  expect(await paused).toBe(true);
  expect(background.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
});

it("a failed background drain stays sealed without releasing a kernel writer", async () => {
  const barrier = new MacAppWriterBarrier(),
    release = vi.fn(async () => {});
  expect(
    await barrier.pause(async () => {
      throw new Error("lost settlement");
    }, release),
  ).toBe(false);
  expect(await barrier.pause(async () => {}, release)).toBe(false);
  expect(release).not.toHaveBeenCalled();
  expect(barrier.admitting).toBe(false);
});
