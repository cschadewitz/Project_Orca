/** ESLint's thread count stays within the memory the lint process may use. */
import { expect, it } from "vitest";
import { chooseConcurrency, memoryLimit, RESERVE_BYTES, THREAD_BYTES } from "../lint.js";

const GIB = 1024 ** 3;

it("stays single-threaded unless threads are requested", () => {
  for (const requested of [undefined, "", "  ", "off"])
    expect(chooseConcurrency(requested, { cores: 32, memory: 64 * GIB })).toEqual({
      concurrency: "off",
      note: undefined,
    });
});

it("honours a request the memory holds", () => {
  expect(chooseConcurrency("4", { cores: 32, memory: 64 * GIB })).toEqual({ concurrency: "4", note: undefined });
  // "auto" is half the cores, as ESLint's own default for it.
  expect(chooseConcurrency("auto", { cores: 16, memory: 64 * GIB }).concurrency).toBe("8");
});

it("caps threads at what the memory fits, and says so", () => {
  // A 12 GiB limit holds three 3 GiB threads after the reserve; auto on 22 cores asks for 11.
  const { concurrency, note } = chooseConcurrency("auto", { cores: 22, memory: 12 * GIB });
  expect(concurrency).toBe("3");
  expect(note).toBe("lint: ESLINT_CONCURRENCY=auto asks for 11 threads, but 12.0 GiB of memory fits 3; using 3");
  expect(Math.floor((12 * GIB - RESERVE_BYTES) / THREAD_BYTES)).toBe(3);
  // Room for one thread only means ESLint's single-threaded default.
  expect(chooseConcurrency("8", { cores: 32, memory: 4 * GIB }).concurrency).toBe("off");
});

it("passes anything else to ESLint unchanged, which rejects it", () => {
  for (const requested of ["abc", "0", "-2", "1.5"])
    expect(chooseConcurrency(requested, { cores: 8, memory: 64 * GIB })).toEqual({ concurrency: requested });
});

it("reads the cgroup limit, lower of it and the machine's, and ignores an unlimited cgroup", () => {
  const files = (map) => (path) => {
    if (path in map) return map[path];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  expect(memoryLimit(files({ "/sys/fs/cgroup/memory.max": `${12 * GIB}\n` }), 64 * GIB)).toBe(12 * GIB);
  expect(memoryLimit(files({ "/sys/fs/cgroup/memory.max": "max\n" }), 64 * GIB)).toBe(64 * GIB);
  expect(memoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" }), 64 * GIB)).toBe(
    64 * GIB,
  );
  expect(memoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${8 * GIB}` }), 64 * GIB)).toBe(8 * GIB);
  expect(memoryLimit(files({}), 16 * GIB)).toBe(16 * GIB);
});
