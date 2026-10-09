/** CLI launch types and preflight identities survive every supported direct root launch boundary. */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommandContext } from "../src/commands/index.js";
import { parseVars, workflowGuards } from "../src/commands/launch-options.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function ctx(cwd: string, positionals: string[], flags: CommandContext["flags"] = {}): CommandContext {
  return { cwd, positionals, flags: { quiet: true, ...flags }, out() {}, err() {} };
}

describe("launch flags", () => {
  it("preserves the historical --var JSON fallback, including explicit JSON strings", () => {
    expect(
      parseVars(["count=3", "enabled=true", 'text="3"', "word=plain", 'object={"x":1}', "nil=null", "empty="]),
    ).toEqual({ count: 3, enabled: true, text: "3", word: "plain", object: { x: 1 }, nil: null, empty: "" });
  });

  it("strict JSON flags retain types and explicitly override legacy flags", () => {
    expect(parseVars(["count=old"], ["count=2", "list=[1,false]", 'name="12"'])).toEqual({
      count: 2,
      list: [1, false],
      name: "12",
    });
    expect(() => parseVars([], ["password=do-not-print"])).toThrow("--var-json requires a valid JSON value");
    expect(() => parseVars([], ["password=do-not-print"])).not.toThrow("do-not-print");
    expect(() => parseVars(["=x"])).toThrow("non-empty key=value");
    expect(() => parseVars(["missing"])).toThrow("key=value");
  });

  it("treats prototype-like names as ordinary own values", () => {
    const vars = parseVars(['__proto__={"polluted":true}', "constructor=plain"]);
    expect(Object.getPrototypeOf(vars)).toBe(Object.prototype);
    expect(Object.hasOwn(vars, "__proto__")).toBe(true);
    expect(vars.constructor).toBe("plain");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("retains both guards and rejects empty ones", () => {
    expect(workflowGuards(ctx("", [], { "workflow-version": "1", "expected-workflow-revision": "digest" }))).toEqual({
      workflowVersion: "1",
      expectedWorkflowRevision: "digest",
    });
    expect(() => workflowGuards(ctx("", [], { "workflow-version": "" }))).toThrow("must not be empty");
    expect(() => workflowGuards(ctx("", [], { "expected-workflow-revision": "" }))).toThrow("must not be empty");
  });
});
