import { expect, it } from "vitest";
import { OrcaConfigSchema } from "@orca/core";
import { configReferenceErrors } from "../src/config-references.js";

it("reports each actual remaining host/agent/model reference without rewriting consumers", () => {
  const config = OrcaConfigSchema.parse({
    hosts: [{ id: "local", type: "local" }],
    agents: [{ id: "builder", command: "example", hostId: "removed", defaultModel: "missing", models: [] }],
    roles: { reviewer: "removed-agent" },
  });
  expect(configReferenceErrors(config).map((e) => e.path)).toEqual([
    "agents[0].hostId",
    "agents[0].defaultModel",
    "roles.reviewer",
  ]);
  expect(config.agents[0]?.hostId).toBe("removed");
});
it("valid explicit host/agent/role bindings retain omitted defaults", () => {
  const raw = {
    hosts: [{ id: "local", type: "local" }],
    agents: [{ id: "builder", command: "example" }],
    roles: { builder: "builder" },
  };
  expect(configReferenceErrors(OrcaConfigSchema.parse(raw))).toEqual([]);
  expect(raw.agents[0]).not.toHaveProperty("models");
});
