import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigFormSchemaSchema } from "@orca/protocol";
import { describeConfigFormSchema, describeFormNode } from "../src/config-form-schema.js";

describe("authoritative rich configuration metadata", () => {
  it("preserves parent-relative branches and record value structure from core", () => {
    const { root } = ConfigFormSchemaSchema.parse(describeConfigFormSchema());
    expect(root.kind).toBe("object");
    if (root.kind !== "object") throw new Error("root");
    expect(root.fields.roles).toMatchObject({ kind: "record", value: { kind: "scalar", field: { type: "string" } } });
    const hosts = root.fields.hosts;
    if (hosts?.kind !== "array" || hosts.item.kind !== "union") throw new Error("hosts");
    expect(hosts.item.discriminator).toBe("type");
    expect(Object.keys(hosts.item.branches)).toEqual(["local", "ssh"]);
    const ssh = hosts.item.branches.ssh;
    if (ssh?.kind !== "object") throw new Error("ssh");
    expect(ssh.fields.host).toMatchObject({ acceptsAbsent: false, acceptsNull: false });
    expect(hosts.item.branches.local).not.toHaveProperty("fields.host");
  });

  it("distinguishes required nullable, optional nonnullable and defaulted values", () => {
    expect(describeFormNode(z.string().nullable())).toMatchObject({
      acceptsAbsent: false,
      acceptsNull: true,
      default: { state: "none" },
    });
    expect(describeFormNode(z.string().optional())).toMatchObject({ acceptsAbsent: true, acceptsNull: false });
    for (const schema of [
      z.boolean().default(false),
      z.number().default(0),
      z.string().default(""),
      z.string().nullable().default(null),
    ])
      expect(describeFormNode(schema)).toMatchObject({ acceptsAbsent: true, default: { state: "withheld" } });
    expect(describeFormNode(z.string().nullable().default(null)).acceptsNull).toBe(true);
  });

  it("puts wrapper semantics on collection/object/union roots without flattening", () => {
    const schemas = [
      z.array(z.string()).optional(),
      z.record(z.string(), z.number()).nullable(),
      z.object({ a: z.string() }).optional(),
      z.discriminatedUnion("kind", [z.object({ kind: z.literal("a"), required: z.string() })]).nullable(),
    ];
    expect(schemas.map((s) => describeFormNode(s).kind)).toEqual(["array", "record", "object", "union"]);
    expect(describeFormNode(schemas[0]!).acceptsAbsent).toBe(true);
    expect(describeFormNode(schemas[1]!).acceptsNull).toBe(true);
  });

  it("does not execute default factories or echo sensitive metadata", () => {
    let calls = 0;
    const schema = z.string().default(() => {
      calls += 1;
      return "secret";
    });
    expect(describeFormNode(schema, "agents[].env.<key>").default).toEqual({ state: "withheld" });
    expect(calls).toBe(0);
    const shape = describeFormNode(z.enum(["secret"]).describe("secret"), "agents[].env.<key>");
    expect(JSON.stringify(shape)).not.toContain("secret");
  });

  it("reports ordinary unions/transforms/catch and constrained records unsupported", () => {
    for (const schema of [
      z.union([z.string(), z.number()]),
      z.string().transform((v) => v),
      z.string().catch("fallback"),
      z.record(z.enum(["x"]), z.string()),
    ])
      expect(describeFormNode(schema).kind).toBe("unsupported");
    expect(describeFormNode(z.string().catch("fallback")).acceptsAbsent).toBe("metadata-unavailable");
  });
});
