/** Offline final-parameter capture tests; no real filesystem or provider coverage claim. */
import { describe, expect, it } from "vitest";
import { SyntheticReadBoundary } from "../src/synthetic-read-boundary.js";
import type { AgentHost } from "../src/host.js";

function fixture() {
  const observed: string[] = [];
  const fs: AgentHost["fs"] = {
    readFile: (path) => {
      observed.push(path);
      return Promise.resolve("first\nsecond\nthird\nfourth");
    },
    writeFile: () => Promise.reject(new Error("read-only fixture")),
    exists: () => Promise.resolve(false),
    existsMany: (paths) => Promise.resolve(paths.map(() => false)),
    mkdirp: () => Promise.reject(new Error("read-only fixture")),
  };
  return { boundary: new SyntheticReadBoundary({ fs }), observed, fs };
}

describe("inactive synthetic AgentHost read capture", () => {
  it("retains original path and slicing parameters before an await", async () => {
    const { boundary, observed } = fixture();
    const parameters = { path: "/synthetic/../exact.txt ", line: 2, limit: 2 };
    const captured = boundary.capture(parameters);
    parameters.path = "/substituted";
    parameters.line = 1;
    parameters.limit = 99;
    expect(await boundary.read(captured)).toBe("second\nthird");
    expect(observed).toEqual(["/synthetic/../exact.txt "]);
    expect(Object.isFrozen(boundary.inspect(captured))).toBe(true);
    expect(() => Object.assign(boundary.inspect(captured), { path: "/changed" })).toThrow();
  });

  it("retains the original host read capability", async () => {
    const { boundary, observed, fs } = fixture();
    const captured = boundary.capture({ path: "/fixture" });
    fs.readFile = () => Promise.reject(new Error("substituted host"));
    expect(await boundary.read(captured)).toBe("first\nsecond\nthird\nfourth");
    expect(observed).toEqual(["/fixture"]);
  });

  it.each([
    [{ path: "/fixture", limit: 1 }, "first\nsecond\nthird\nfourth"],
    [{ path: "/fixture", line: null, limit: null }, "first\nsecond\nthird\nfourth"],
    [{ path: "/fixture", line: 0, limit: 1 }, "first"],
    [{ path: "/fixture", line: 3, limit: null }, "third\nfourth"],
    [{ path: "/fixture", line: 2, limit: 0 }, ""],
  ])("preserves the existing callback's read/slice semantics: %j", async (parameters, expected) => {
    const { boundary, observed } = fixture();
    const captured = boundary.capture(parameters);
    expect(boundary.inspect(captured)).toEqual(parameters);
    expect(await boundary.read(captured)).toBe(expected);
    expect(observed).toEqual(["/fixture"]);
  });

  it("refuses serialized and foreign captures without touching the host", async () => {
    const { boundary, observed } = fixture();
    const foreign = fixture().boundary.capture({ path: "/fixture" });
    await expect(boundary.read(foreign)).rejects.toThrow("Unknown synthetic read capture");
    await expect(boundary.read(structuredClone(boundary.capture({ path: "/fixture" })))).rejects.toThrow();
    expect(observed).toEqual([]);
  });

  it("binds omitted, null, explicit undefined, zero and negative zero distinctly", () => {
    const { boundary } = fixture();
    // Explicit undefined is outside ACP JSON, but cannot alias an omitted JS field at this internal seam.
    const parameters = [
      { path: "/fixture" },
      { path: "/fixture", line: null },
      { path: "/fixture", line: undefined } as unknown as Parameters<typeof boundary.capture>[0],
      { path: "/fixture", line: 0 },
      { path: "/fixture", line: -0 },
    ];
    expect(new Set(parameters.map((value) => boundary.encode(boundary.capture(value)))).size).toBe(5);
  });

  it("refuses unsupported fields, oversized paths and noninteger parameters before fenced use", () => {
    const { boundary, observed } = fixture();
    for (const value of [
      { path: "/fixture", extra: "unbound" },
      { path: "x".repeat(4097) },
      { path: "/fixture", line: NaN },
      { path: "/fixture", line: Infinity },
      { path: "/fixture", limit: 1.5 },
      { path: "/fixture", limit: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() => boundary.encode(boundary.capture(value))).toThrow();
    expect(observed).toEqual([]);
  });
});
