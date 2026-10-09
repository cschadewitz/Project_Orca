/** Focused unit contracts separated from the mixed suite. */
import { describe, expect, it } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import { buildConfigOptions } from "@orca/integrations";

describe("buildConfigOptions", () => {
  it("groups an agent role's choices by host when the candidates span more than one host", () => {
    const spec = (id: string, hostId: string) =>
      AgentSpecSchema.parse({ id, hostId, roles: ["builder"], command: "x" });
    const options = buildConfigOptions(
      {
        workflows: [],
        agents: [spec("a", "local"), spec("b", "box")],
        templatePacks: [],
        booleans: false,
        useClientCwd: true,
      },
      { roles: {} },
    );
    const role = options.find((o) => o.id === "orca/agent.builder");
    expect(role?.type === "select" && role.options.map((o) => ("group" in o ? o.group : o.value))).toEqual([
      "orca:default",
      "local",
      "box",
    ]);
  });

  it("advertises declared models before discovery, grouped by agent when more than one agent offers any", () => {
    const spec = (id: string, models?: { id: string; name: string }[]) =>
      AgentSpecSchema.parse({ id, hostId: "local", command: "x", ...(models ? { models } : {}) });
    const model = (agents: ReturnType<typeof spec>[]) => {
      const o = buildConfigOptions(
        { workflows: [], agents, templatePacks: [], booleans: false, useClientCwd: true },
        { roles: {} },
      ).find((x) => x.id === "orca/model");
      return o?.type === "select" ? o.options : [];
    };
    expect(model([spec("a", [{ id: "m1", name: "M1" }]), spec("b")])).toEqual([
      { value: "orca:default", name: "Agent default" },
      { value: "a/m1", name: "M1" },
    ]);
    expect(
      model([spec("a", [{ id: "m1", name: "M1" }]), spec("b", [{ id: "m2", name: "M2" }])]).map((g) =>
        "group" in g ? g.group : g.value,
      ),
    ).toEqual(["orca:default", "a", "b"]);
  });
});
