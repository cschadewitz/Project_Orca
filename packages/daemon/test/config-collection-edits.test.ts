import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigSetParamsSchema } from "@orca/protocol";
import { lowerConfigEdits } from "../src/config-collection-edits.js";

const source = `# header unchanged
hosts:
  - id: a # end a
    type: local
    extension: 'untouched a'
  # before b
  - id: b # end b
    type: local
  # before c
  - id: c
    type: local

# unrelated
roles: { builder: a }
`;
describe("comment-preserving ordered collection lowering", () => {
  it("moves original element bytes and their comments without replacing the parent array", () => {
    const moved = lowerConfigEdits(source, [{ kind: "move", path: ["hosts"], from: 1, to: 0 }]);
    const a = "  - id: a # end a\n    type: local\n    extension: 'untouched a'\n";
    const b = "  # before b\n  - id: b # end b\n    type: local\n";
    expect(moved).toBe(source.replace(a + b, b + a));
    expect((parse(moved) as { hosts: { id: string }[] }).hosts.map((h) => h.id)).toEqual(["b", "a", "c"]);
  });

  it("inserts at a pre-operation index and preserves subsequent operation identity", () => {
    const text = lowerConfigEdits(source, [
      { kind: "insert", path: ["hosts"], index: 1, value: { id: "new", type: "local" } },
      { kind: "remove", path: ["hosts", 2] },
    ]);
    expect((parse(text) as { hosts: { id: string }[] }).hosts.map((h) => h.id)).toEqual(["a", "new", "c"]);
    expect(text).toContain("extension: 'untouched a'");
    expect(text).not.toContain("before b");
    expect(text).toContain("# before c");
    expect(text.slice(text.indexOf("\n# unrelated"))).toBe(source.slice(source.indexOf("\n# unrelated")));
  });

  it("preserves scalar comments and literal dotted/bracketed/numeric mapping keys", () => {
    const text = 'roles:\n  "a.b": old # keep\n  "a[0]": other\n  "0": numeric\n';
    expect(lowerConfigEdits(text, [{ kind: "set", path: ["roles", "a.b"], value: "new" }])).toBe(
      text.replace("old", '"new"'),
    );
    const edited = lowerConfigEdits(text, [{ kind: "set", path: ["roles", "0"], value: "changed" }]);
    expect((parse(edited) as { roles: Record<string, string> }).roles["0"]).toBe("changed");
    expect(edited).toContain('"a[0]": other');
  });

  it("creates an empty config using only explicit edits without schema defaults", () => {
    const text = lowerConfigEdits("", [
      { kind: "insert", path: ["hosts"], index: 0, value: { id: "local", type: "local" } },
      { kind: "insert", path: ["agents"], index: 0, value: { id: "builder", command: "example" } },
      { kind: "set", path: ["roles"], value: { builder: "builder" } },
    ]);
    expect(parse(text)).toEqual({
      hosts: [{ id: "local", type: "local" }],
      agents: [{ id: "builder", command: "example" }],
      roles: { builder: "builder" },
    });
    expect(text).not.toContain("storeDir");
  });

  it("keeps null false zero and empty string as explicit values", () => {
    for (const value of [null, false, 0, ""]) {
      const text = lowerConfigEdits("value: original # comment\n", [{ kind: "set", path: ["value"], value }]);
      expect((parse(text) as { value: unknown }).value).toBe(value);
      expect(text).toContain("# comment");
    }
  });

  it("grows empty lists and flow record entries without a one-row dead end", () => {
    const text = lowerConfigEdits("hosts: [] # collection\nroles: {}\n", [
      { kind: "insert", path: ["hosts"], index: 0, value: { id: "a", type: "local" } },
      { kind: "insert", path: ["hosts"], index: 1, value: { id: "b", type: "local" } },
      { kind: "set", path: ["roles", "a.b"], value: "a" },
      { kind: "set", path: ["roles", "0"], value: "b" },
    ]);
    expect(parse(text)).toEqual({
      hosts: [
        { id: "a", type: "local" },
        { id: "b", type: "local" },
      ],
      roles: { "a.b": "a", "0": "b" },
    });
    expect(text).toContain("# collection");
  });

  it("refuses ambiguous/unsafe/unsupported edits without a lossy fallback", () => {
    expect(() => lowerConfigEdits(source, [{ kind: "move", path: ["hosts"], from: 99, to: 0 }])).toThrow();
    expect(() =>
      lowerConfigEdits("roles: {x: a}\n", [{ kind: "set", path: ["roles", "__proto__"], value: "x" }]),
    ).toThrow();
    expect(() =>
      lowerConfigEdits("x: &a {value: 1}\ny: *a\n", [{ kind: "set", path: ["y", "value"], value: 2 }]),
    ).toThrow();
    expect(() => lowerConfigEdits("hosts: [a, b]\n", [{ kind: "move", path: ["hosts"], from: 0, to: 1 }])).toThrow();
    expect(() => lowerConfigEdits("x: 1\nx: 2\n", [{ kind: "set", path: ["x"], value: 3 }])).toThrow();
  });

  it("allows only one representation and refuses deletion encoded as an undefined set", () => {
    expect(
      ConfigSetParamsSchema.safeParse({
        document: "config",
        expectedRevision: "",
        edits: [{ kind: "set", path: ["x"] }],
      }).success,
    ).toBe(false);
    expect(
      ConfigSetParamsSchema.safeParse({ document: "config", expectedRevision: "", text: "", edits: [] }).success,
    ).toBe(false);
    expect(ConfigSetParamsSchema.safeParse({ document: "permissions", expectedRevision: "", edits: [] }).success).toBe(
      false,
    );
  });
});
