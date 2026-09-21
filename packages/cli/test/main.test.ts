/** `orca --help` is a request, not a mistake: it exits 0. A bare `orca` is a mistake and exits 1. */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError, type Logger } from "@orca/core";
import { ORCA_VERSION } from "../src/commands/index.js";
import { installProcessErrorHandlers, main } from "../src/main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe("orca --help", () => {
  it("prints usage to stdout and exits 0", async () => {
    const { out, err } = capture();
    expect(await main(["--help"])).toBe(0);
    expect(out.join("")).toMatch(/^orca - /);
    expect(err.join("")).toBe("");
  });

  it("exits 0 with a command too", async () => {
    const { out } = capture();
    expect(await main(["runs", "--help"])).toBe(0);
    expect(out.join("")).toMatch(/usage: orca/);
  });

  it("a bare `orca` prints usage to stderr and exits 1", async () => {
    const { out, err } = capture();
    expect(await main([])).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/usage: orca/);
  });

  it("an unknown command exits 1", async () => {
    const { err } = capture();
    expect(await main(["nope"])).toBe(1);
    expect(err.join("")).toMatch(/unknown command 'nope'/);
  });
});

describe("orca --version", () => {
  // The root manifest is the release version and the only source of it: the packages under
  // packages/ stay at 0.1.0 (docs/RELEASING.md), so reading one of those reported a number
  // no release ever carried (#229). `hello.orcaVersion` and the `orca serve` banner are the
  // same constant, so pinning it here pins all three.
  const root = createRequire(import.meta.url)("../../../package.json") as { version: string };

  it("prints the root package.json version and exits 0", async () => {
    const { out, err } = capture();
    expect(await main(["--version"])).toBe(0);
    expect(out.join("")).toBe(`${root.version}\n`);
    expect(err.join("")).toBe("");
  });

  it("is the version the daemon hands out", () => {
    expect(ORCA_VERSION).toBe(root.version);
  });
});

/**
 * #268: without these, Node's default for an unobserved rejection is to end the process -
 * which for `orca serve` lapses every lease it holds over one run's failed append.
 */
describe("the process error handlers", () => {
  function fakeLogger(lines: { msg: string; fields?: Record<string, unknown> }[]): Logger {
    const logger: Logger = {
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg, fields) => void lines.push({ msg, ...(fields ? { fields } : {}) }),
      child: () => logger,
    };
    return logger;
  }

  function install(keepRunning: boolean): {
    lines: { msg: string; fields?: Record<string, unknown> }[];
    exits: number[];
    remove: () => void;
  } {
    // Vitest listens for both of these itself and would fail the file on the emits below, so
    // its listeners stand aside for the length of the assertion and go back afterwards.
    const before = { r: process.listeners("unhandledRejection"), u: process.listeners("uncaughtException") };
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
    const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
    const exits: number[] = [];
    installProcessErrorHandlers({ keepRunning, logger: fakeLogger(lines), exit: (c) => void exits.push(c) });
    return {
      lines,
      exits,
      remove: () => {
        process.removeAllListeners("unhandledRejection");
        process.removeAllListeners("uncaughtException");
        for (const l of before.r) process.on("unhandledRejection", l as never);
        for (const l of before.u) process.on("uncaughtException", l as never);
      },
    };
  }

  it("a plain command logs the described error and exits non-zero", () => {
    const h = install(false);
    try {
      process.emit("unhandledRejection", new OrcaError("STORE_WRITE", "no space left on device"), Promise.resolve());
      expect(h.lines).toHaveLength(1);
      expect(h.lines[0]!.msg).toBe("unhandled rejection");
      expect(h.lines[0]!.fields?.error).toMatchObject({ code: "STORE_WRITE", message: "no space left on device" });
      expect(h.exits).toEqual([1]);
    } finally {
      h.remove();
    }
  });

  it("the daemon logs and keeps serving", () => {
    const h = install(true);
    try {
      process.emit("uncaughtException", new Error("boom"));
      expect(h.lines[0]!.msg).toBe("uncaught exception");
      expect(h.lines[0]!.fields).toMatchObject({ serving: true });
      expect(h.exits).toEqual([]);
    } finally {
      h.remove();
    }
  });
});
