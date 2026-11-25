/** ESLint's thread count stays within the memory the lint process may use. */
import { expect, it } from "vitest";
import { chooseConcurrency, memoryLimit } from "../lint.js";

const GIB = 1024 ** 3;
const memory = (gib, source = "process limit") => ({ bytes: gib * GIB, source });

it("stays single-threaded unless threads are requested, without a note", () => {
  for (const requested of [undefined, "", "  ", "off"])
    expect(chooseConcurrency(requested, { cores: 32, memory: memory(64) })).toEqual({ concurrency: "off" });
});

it("honours a request the memory holds, and says what it chose", () => {
  expect(chooseConcurrency("4", { cores: 32, memory: memory(64, "machine memory") })).toEqual({
    concurrency: "4",
    note: "lint: ESLINT_CONCURRENCY=4 asks for 4 thread(s); 64.0 GiB (machine memory) fits 21; using --concurrency 4",
  });
  // "auto" is half the cores.
  expect(chooseConcurrency("auto", { cores: 16, memory: memory(64) }).concurrency).toBe("8");
});

it("caps threads at what the process limit fits", () => {
  // A 12 GiB limit holds three 3 GiB threads after the 1 GiB reserve; auto on 22 cores asks for 11.
  expect(chooseConcurrency("auto", { cores: 22, memory: memory(12) })).toEqual({
    concurrency: "3",
    note: "lint: ESLINT_CONCURRENCY=auto asks for 11 thread(s); 12.0 GiB (process limit) fits 3; using --concurrency 3",
  });
  // Room for one thread only means ESLint's single-threaded default.
  expect(chooseConcurrency("8", { cores: 32, memory: memory(4) }).concurrency).toBe("off");
});

it("passes anything else to ESLint unchanged, which rejects it", () => {
  for (const requested of ["abc", "0", "-2", "1.5"])
    expect(chooseConcurrency(requested, { cores: 8, memory: memory(64) })).toEqual({ concurrency: requested });
});

it("uses the process's own limit when it is known and below the machine's memory", () => {
  // Known and lower than the host.
  expect(memoryLimit(12 * GIB, 64 * GIB)).toEqual({ bytes: 12 * GIB, source: "process limit" });
  // Unknown (0, or no process.constrainedMemory at all).
  expect(memoryLimit(0, 64 * GIB)).toEqual({ bytes: 64 * GIB, source: "machine memory" });
  expect(memoryLimit(null, 64 * GIB)).toEqual({ bytes: 64 * GIB, source: "machine memory" });
  // Unlimited: reported at or above the machine's memory.
  expect(memoryLimit(2 ** 64, 64 * GIB)).toEqual({ bytes: 64 * GIB, source: "machine memory" });
  expect(memoryLimit(64 * GIB, 64 * GIB)).toEqual({ bytes: 64 * GIB, source: "machine memory" });
  // Defaults read this process.
  expect(memoryLimit().bytes).toBeGreaterThan(0);
});
