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
    expect(root.visibility).toBe("non-secret");
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
    expect(shape.visibility).toBe("withheld");
    expect(JSON.stringify(shape)).not.toContain("secret");
    expect(describeFormNode(z.string(), "agents[].command").visibility).toBe("non-secret");
    expect(describeFormNode(z.string().describe("private"), "futureField")).toMatchObject({
      visibility: "metadata-unavailable",
      field: { type: "string" },
    });
    expect(describeFormNode(z.enum(["private"]), "hosts[].sshArgs[]")).not.toHaveProperty("field.enum");
  });

  it("reports ordinary unions/transforms/catch and records with other key constraints unsupported", () => {
    for (const schema of [
      z.union([z.string(), z.number()]),
      z.string().transform((v) => v),
      z.string().catch("fallback"),
      z.record(z.enum(["x"]), z.string()),
      z.record(z.string().min(2), z.string()),
      z.record(z.string().regex(/^a/).regex(/b$/), z.string()),
      z.record(z.string().regex(/^allowed$/i), z.string()),
    ])
      expect(describeFormNode(schema)).toMatchObject({ kind: "unsupported", visibility: "metadata-unavailable" });
    expect(describeFormNode(z.string().catch("fallback")).acceptsAbsent).toBe("metadata-unavailable");
  });

  it("describes a record whose keys match one plain pattern, such as a catalog id (#335)", () => {
    expect(describeFormNode(z.record(z.string().regex(/^allowed$/), z.string()))).toMatchObject({
      kind: "record",
      keyPattern: "^allowed$",
    });
    const root = describeConfigFormSchema().root;
    if (root.kind !== "object") throw new Error("root");
    const capabilities = root.fields.capabilities!;
    if (capabilities.kind !== "object") throw new Error("capabilities");
    for (const kind of ["skills", "mcpServers"] as const)
      expect(capabilities.fields[kind]).toMatchObject({
        kind: "record",
        visibility: "non-secret",
        keyPattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
      });
    // An MCP server's id and command are shown; its arguments are withheld. Its environment
    // names variables, and each value stays opaque: a literal is never described as shown.
    const server = (capabilities.fields.mcpServers as { value: { fields: Record<string, { visibility: string }> } })
      .value.fields;
    expect(server.command!.visibility).toBe("non-secret");
    expect(server.args!.visibility).toBe("withheld");
    expect(server.env).toMatchObject({
      kind: "record",
      visibility: "non-secret",
      valueKind: "env",
      value: { kind: "unsupported", visibility: "metadata-unavailable" },
    });
    // Agent environments keep their withheld classification.
    const agent = (root.fields.agents as { item: { fields: Record<string, { visibility: string }> } }).item.fields;
    expect(agent.env!.visibility).toBe("withheld");
    // Only the audited environment value schema carries the hint.
    expect(
      describeFormNode(z.record(z.string(), z.union([z.string(), z.object({ secret: z.string() })]))),
    ).not.toHaveProperty("valueKind");
    expect(ConfigFormSchemaSchema.parse(describeConfigFormSchema())).toBeTruthy();
  });

  it("fails closed for prefault/coercion rather than guessing input acceptance", () => {
    const prefault = z.string().min(2).prefault("");
    expect(prefault.safeParse(undefined).success).toBe(false);
    const coerced = z.coerce.string();
    expect(coerced.safeParse(undefined).success).toBe(true);
    expect(coerced.safeParse(null).success).toBe(true);
    for (const schema of [prefault, coerced, z.coerce.number(), z.record(z.coerce.string(), z.string())]) {
      expect(describeFormNode(schema)).toMatchObject({
        kind: "unsupported",
        visibility: "metadata-unavailable",
        acceptsAbsent: "metadata-unavailable",
        acceptsNull: "metadata-unavailable",
      });
    }
    let calls = 0;
    describeFormNode(
      z.string().prefault(() => {
        calls += 1;
        return "factory";
      }),
    );
    expect(calls).toBe(0);
  });
});
