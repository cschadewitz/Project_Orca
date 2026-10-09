/** Portable seam/arithmetic checks. These cannot establish macOS suspend conformance. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createNativeDiagnosticsClock, loadNativeDiagnosticsClock } from "../src/main/diagnostics/native-clock.js";

const bootId = "12345678-1234-1234-1234-123456789abc";
const value = (elapsedMs = 1000) => ({ bootId, elapsedMs });
const backend = (read: () => unknown) => ({ abi: 1, platform: "darwin", suspendInclusive: true, read });

describe("private native clock boundary", () => {
  it("copies continuity authority and admits repeated/equal readings plus a suspend-sized increment", () => {
    const native = value();
    const clock = createNativeDiagnosticsClock(
      backend(() => native),
      "darwin",
    );
    const first = clock.read()!;
    first.elapsedMs = 9000;
    first.bootId = "mutated";
    expect(clock.read()).toEqual(value());
    native.elapsedMs += 86_399_999;
    expect(clock.read()).toEqual(value(86_400_999));
  });

  it.each([
    undefined,
    null,
    {},
    { ...value(), bootId: "process-or-wall-derived" },
    { ...value(), bootId: "a".repeat(100_000) },
    { ...value(), elapsedMs: NaN },
    { ...value(), elapsedMs: Infinity },
    { ...value(), elapsedMs: -1 },
    { ...value(), elapsedMs: 0.1 },
    { ...value(), elapsedMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...value(), elapsedMs: "1000" },
    { ...value(), bootId: "22345678-1234-1234-1234-123456789abc" },
    value(999),
  ])("latches uncertain, invalid, changed-boot or rollback observations (%#)", (invalid) => {
    const read = vi
      .fn<() => unknown>()
      .mockReturnValueOnce(value())
      .mockReturnValueOnce(invalid)
      .mockReturnValue(value(2000));
    const clock = createNativeDiagnosticsClock(backend(read), "darwin");
    expect(clock.read()).toEqual(value());
    expect(clock.read()).toBeUndefined();
    expect(clock.read()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not invoke accessors or coerce native fields, and latches native exceptions", () => {
    const getter = vi.fn(() => bootId);
    const clock = createNativeDiagnosticsClock(
      backend(() => Object.defineProperty({ elapsedMs: 1000 }, "bootId", { get: getter })),
      "darwin",
    );
    expect(clock.read()).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    const read = vi.fn(() => {
      throw new Error("native unavailable");
    });
    const throwing = createNativeDiagnosticsClock(backend(read), "darwin");
    expect(throwing.read()).toBeUndefined();
    expect(throwing.read()).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["win32", "linux", "unknown"])("never reads a backend on unsupported platform %s", (platform) => {
    const read = vi.fn(() => value());
    expect(createNativeDiagnosticsClock(backend(read), platform).read()).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { abi: 2 }, { platform: "unsupported" }, { suspendInclusive: false }, { read: undefined }])(
    "refuses absent or mismatched capabilities (%#)",
    (override) => {
      const read = vi.fn(() => value());
      const candidate =
        override === undefined
          ? undefined
          : { ...backend(read), ...override, ...(Object.keys(override).length === 0 ? { abi: undefined } : {}) };
      expect(createNativeDiagnosticsClock(candidate, "darwin").read()).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "darwin" && process.platform !== "win32")(
    "fixed shipping loader stays unavailable here",
    () => {
      expect(loadNativeDiagnosticsClock().read()).toBeUndefined();
    },
  );

  it("admits only matching Windows capabilities and latches a rollback", () => {
    const read = vi
      .fn<() => unknown>()
      .mockReturnValueOnce(value())
      .mockReturnValueOnce(value(999))
      .mockReturnValue(value(2000));
    const clock = createNativeDiagnosticsClock({ ...backend(read), platform: "win32" }, "win32");
    expect(clock.read()).toEqual(value());
    expect(clock.read()).toBeUndefined();
    expect(clock.read()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

it.runIf(process.platform === "linux" || process.platform === "darwin")(
  "compiles and checks the actual C conversion at overflow/rounding boundaries",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orca-clock-math-"));
    try {
      const source = fileURLToPath(new URL("./recovery-preparation/clock-math-fixture.c", import.meta.url));
      const executable = join(directory, "clock-math");
      const run = promisify(execFile);
      await run("/usr/bin/cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", executable], {
        timeout: 10_000,
        maxBuffer: 4096,
      });
      const result = await run(executable, [], { timeout: 5000, maxBuffer: 64 });
      expect(result.stdout).toBe("clock arithmetic passed\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
