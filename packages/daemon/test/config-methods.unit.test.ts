/** Focused unit contracts separated from the mixed suite. */
import { describe, expect, it } from "vitest";
import { describeConfigSchema, dottedPath, splitPath } from "@orca/daemon";

describe("the schema description", () => {
  const schema = describeConfigSchema();
  const at = (path: string) => schema.find((f) => f.path === path);

  it("writes an array's element type once, not per index", () => {
    expect(at("hosts")?.type).toBe("array");
    expect(at("hosts[]")?.type).toBe("object");
    expect(at("hosts[].id")).toMatchObject({ type: "string", required: true });
    expect(schema.some((f) => f.path.startsWith("hosts[0]"))).toBe(false);
  });

  it("flattens a discriminated union and merges its discriminator into one enum", () => {
    // `hosts[]` is `local | ssh`; a form needs one dropdown and both branches' fields.
    expect(at("hosts[].type")).toMatchObject({ type: "enum" });
    expect(at("hosts[].type")?.enum?.sort()).toEqual(["local", "ssh"]);
    expect(at("hosts[].host")?.type).toBe("string");
    // Present in only one branch, so not required in general.
    expect(at("hosts[].host")?.required).toBe(false);
    expect(at("humanInput.mode")?.enum?.sort()).toEqual(["auto", "cli", "pause"]);
  });

  it("carries the schema's defaults so a form can show what a blank field means", () => {
    expect(at("storeDir")).toMatchObject({ type: "string", required: false, default: ".orca" });
    expect(at("roles")?.type).toBe("record");
    expect(at("plugins")).toMatchObject({ type: "array", default: [] });
  });
});

describe("dotted paths", () => {
  it("spell an array index the way a form reads it — #174's done-when", () => {
    expect(dottedPath(["hosts", 1, "transport"])).toBe("hosts[1].transport");
    expect(dottedPath(["agents", 0, "permissions", "rules", 2, "decision"])).toBe(
      "agents[0].permissions.rules[2].decision",
    );
  });

  it("read both spellings back, because a form may send either", () => {
    expect(splitPath("hosts[1].type")).toEqual(["hosts", 1, "type"]);
    expect(splitPath("hosts.1.type")).toEqual(["hosts", 1, "type"]);
  });
});
