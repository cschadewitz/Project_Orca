/** Reference catalogs and conservative three-way reconciliation preserve array identity and source authority. */
import { describe, expect, it } from "vitest";
import { configurationReferenceChoices } from "../src/config/reference-choices.js";
import { reconcileConfigurationEdits } from "../src/config/reconciliation.js";
import type { TemplateCatalog } from "@orca/protocol";
describe("configuration reference selectors", () => {
  const value = { hosts: [{ id: "local" }], agents: [{ id: "worker", models: [{ id: "model-a", name: "Model a" }] }] };
  it("uses local draft IDs and configured models without probing agents", () => {
    expect(configurationReferenceChoices(value, undefined, ["agents", 0, "hostId"])).toEqual(["local"]);
    expect(configurationReferenceChoices(value, undefined, ["roles", "builder"])).toEqual(["worker"]);
    expect(configurationReferenceChoices(value, undefined, ["agents", 0, "defaultModel"])).toEqual(["model-a"]);
    expect(configurationReferenceChoices(value, undefined, ["program", "workflow"])).toBeUndefined();
    expect(
      configurationReferenceChoices(value, { workflows: [{ id: "review", version: "1" }] } as TemplateCatalog, [
        "program",
        "workflow",
      ]),
    ).toEqual(["review"]);
  });
  it("does not reinterpret arbitrary extension or secret fields as references", () => {
    expect(configurationReferenceChoices(value, undefined, ["agents", 0, "env", "hostId"])).toBeUndefined();
    expect(configurationReferenceChoices(value, undefined, ["extensions", "roles"])).toBeUndefined();
  });
});
describe("capability selections (#335)", () => {
  const value = {
    capabilities: { mcpServers: { github: {}, db: {} }, skills: { review: {} } },
    agents: [{ id: "worker", mcpServers: [{ name: "notes", command: "notes-mcp" }] }],
  };
  it("offers catalog ids, and an agent's own inline servers at the agent's scope", () => {
    for (const verb of ["replace", "enable", "disable", "available"])
      expect(
        configurationReferenceChoices(value, undefined, ["capabilities", "workspace", "mcpServers", verb, 0]),
      ).toEqual(["db", "github"]);
    expect(
      configurationReferenceChoices(value, undefined, ["capabilities", "workspace", "skills", "enable", 0]),
    ).toEqual(["review"]);
    expect(
      configurationReferenceChoices(value, undefined, ["agents", 0, "capabilities", "mcpServers", "disable", 0]),
    ).toEqual(["db", "github", "notes"]);
    expect(
      configurationReferenceChoices(value, undefined, ["agents", 0, "capabilities", "skills", "available", 0]),
    ).toEqual(["review"]);
    // An empty catalog offers nothing rather than free text.
    expect(configurationReferenceChoices({}, undefined, ["capabilities", "workspace", "skills", "enable", 0])).toEqual(
      [],
    );
  });
});
describe("three-way configuration reconciliation", () => {
  it("retains independent scalar edits and detects overlapping values", () => {
    const edits = [{ kind: "set" as const, path: ["roles", "builder"], value: "next" }];
    expect(
      reconcileConfigurationEdits({ roles: { builder: "old" } }, { roles: { builder: "old" }, program: {} }, edits)
        .conflicts,
    ).toEqual([]);
    expect(
      reconcileConfigurationEdits({ roles: { builder: "old" } }, { roles: { builder: "other" } }, edits).conflicts,
    ).toEqual([["roles", "builder"]]);
  });
  it("refuses numeric descendants on reordered arrays even when the leaf value matches", () => {
    const before = {
      agents: [
        { id: "a", command: "same" },
        { id: "b", command: "same" },
      ],
    };
    const current = { agents: [...before.agents].reverse() };
    expect(
      reconcileConfigurationEdits(before, current, [{ kind: "set", path: ["agents", 0, "command"], value: "next" }])
        .conflicts,
    ).toEqual([["agents"]]);
  });
  it("refuses retained move/insert/remove indices on changed collections", () => {
    for (const edit of [
      { kind: "move" as const, path: ["ids"], from: 0, to: 1 },
      { kind: "insert" as const, path: ["ids"], index: 0, value: "c" },
      { kind: "remove" as const, path: ["ids", 0] },
    ])
      expect(
        reconcileConfigurationEdits({ ids: ["a", "b"] }, { ids: ["b", "a"] }, [edit]).conflicts.length,
      ).toBeGreaterThan(0);
  });
});
