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
  return { boundary: new SyntheticReadBoundary({ fs }), observed };
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
});
