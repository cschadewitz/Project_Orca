/** #335: the workflow editor's capability scope model. */
import { describe, expect, it } from "vitest";
import {
  addToScope,
  catalogChoices,
  clearInherited,
  stopReplacing,
  normalizeScope,
  readScope,
  removeFromScope,
  workflowScopeSupported,
} from "../src/workflow/editor/capability-scope.js";

describe("capability scope model", () => {
  it("reads a well-formed scope, an absent one as empty, and refuses anything else", () => {
    expect(readScope(undefined)).toEqual({});
    expect(readScope({ mcpServers: { enable: ["a"], disable: ["b"] }, skills: { replace: ["c"] } })).toEqual({
      mcpServers: { enable: ["a"], disable: ["b"] },
      skills: { replace: ["c"] },
    });
    for (const odd of [
      "text",
      [],
      { tools: {} },
      { skills: { available: ["x"] } },
      { skills: { enable: "x" } },
      { skills: { enable: ["has space"] } },
      { skills: { enable: [1] } },
    ])
      expect(readScope(odd)).toBeUndefined();
  });
  it("adds valid ids once, removes them, and normalizes an empty scope away", () => {
    let scope = addToScope({}, "skills", "enable", "review");
    expect(addToScope(scope, "skills", "enable", "review")).toBe(scope);
    expect(addToScope(scope, "skills", "enable", "-bad")).toBe(scope);
    scope = addToScope(scope, "mcpServers", "disable", "db");
    expect(normalizeScope(scope)).toEqual({ skills: { enable: ["review"] }, mcpServers: { disable: ["db"] } });
    scope = removeFromScope(removeFromScope(scope, "skills", "enable", "review"), "mcpServers", "disable", "db");
    expect(normalizeScope(scope)).toBeUndefined();
  });
  it("keeps an explicit empty replace distinct from no replace", () => {
    const cleared = readScope({ mcpServers: { replace: [] } })!;
    expect(normalizeScope(cleared)).toEqual({ mcpServers: { replace: [] } });
    // An unrelated edit keeps the clearing.
    expect(normalizeScope(addToScope(cleared, "skills", "disable", "review"))).toEqual({
      mcpServers: { replace: [] },
      skills: { disable: ["review"] },
    });
    // Removing the last replaced id still clears; only stopReplacing inherits again.
    const one = addToScope({}, "skills", "replace", "review");
    expect(normalizeScope(removeFromScope(one, "skills", "replace", "review"))).toEqual({ skills: { replace: [] } });
    expect(normalizeScope(stopReplacing(one, "skills"))).toBeUndefined();
    expect(normalizeScope(clearInherited({}, "mcpServers"))).toEqual({ mcpServers: { replace: [] } });
  });
  it("offers the workflow scope from protocol 2.10, and catalog ids from the config", () => {
    expect(workflowScopeSupported(undefined)).toBe(true);
    expect(workflowScopeSupported("2.10")).toBe(true);
    expect(workflowScopeSupported("3.0")).toBe(true);
    expect(workflowScopeSupported("2.9")).toBe(false);
    expect(workflowScopeSupported("junk")).toBe(false);
    expect(
      catalogChoices({ capabilities: { mcpServers: { github: {}, db: {} }, skills: { review: {}, "bad id": {} } } }),
    ).toEqual({ mcpServers: ["db", "github"], skills: ["review"] });
    expect(catalogChoices({})).toEqual({ mcpServers: [], skills: [] });
    expect(catalogChoices(undefined)).toBeUndefined();
  });
});
