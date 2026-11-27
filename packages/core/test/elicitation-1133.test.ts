/**
 * An agent question's form and the check of its answer (#1133, #1169): what ORCA keeps of an
 * agent's `requestedSchema`, what it declines, and which answers it accepts.
 */
import { describe, expect, it } from "vitest";
import {
  ELICITATION_DECLINE,
  elicitationForm,
  elicitationOf,
  encodeElicitationAnswer,
  parseElicitationAnswer,
  type ElicitationForm,
} from "@orca/core";

const form = (schema: unknown): ElicitationForm => {
  const out = elicitationForm("Question?", schema);
  if ("refused" in out) throw new Error(out.refused);
  return out.form;
};

const every = form({
  type: "object",
  properties: {
    pick: { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "b" }] },
    named: { type: "string", enum: ["x", "y"], enumNames: ["Ex", "Why"] },
    many: { type: "array", items: { anyOf: [{ const: "p" }, { const: "q" }, { const: "r" }] }, maxItems: 2 },
    words: { type: "string", maxLength: 5, format: "email" },
    count: { type: "integer", minimum: 1, maximum: 3 },
    ratio: { type: "number" },
    ok: { type: "boolean", default: true },
  },
  required: ["pick", "many"],
});

describe("elicitationForm", () => {
  it("keeps every field kind, in order, with its bounds", () => {
    expect(every.fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["pick", "choice", true],
      ["named", "choice", false],
      ["many", "multi", true],
      ["words", "text", false],
      ["count", "number", false],
      ["ratio", "number", false],
      ["ok", "boolean", false],
    ]);
    expect(every.fields[1]).toMatchObject({
      options: [
        { value: "x", label: "Ex" },
        { value: "y", label: "Why" },
      ],
    });
    expect(every.fields[3]).toMatchObject({ maxLength: 5, format: "email" });
    expect(every.fields[4]).toMatchObject({ integer: true, minimum: 1, maximum: 3 });
    expect(every.fields[6]).toMatchObject({ default: true });
  });

  it.each([
    ["no schema", undefined, "no schema"],
    ["no fields", { type: "object", properties: {} }, "no fields"],
    ["a secret (Codex)", { properties: { k: { type: "string", _meta: { codex: { isSecret: true } } } } }, "secret"],
    ["a secret (writeOnly)", { properties: { k: { type: "string", writeOnly: true } } }, "secret"],
    ["an object field", { properties: { k: { type: "object" } } }, "cannot show"],
    ["a list without options", { properties: { k: { type: "array", items: { type: "string" } } } }, "without options"],
    ["unreadable options", { properties: { k: { type: "string", oneOf: [{ const: 1 }] } } }, "cannot read"],
    ["a non-object schema", { type: "string" }, "not an object"],
  ])("declines %s", (_, schema, reason) => {
    const out = elicitationForm("Q", schema);
    expect("refused" in out && out.refused).toContain(reason);
  });

  it.each([
    ["a pattern on text", { k: { type: "string", pattern: "^a+$" } }, "'pattern'"],
    ["an exclusive bound on a number", { k: { type: "number", exclusiveMinimum: 0 } }, "'exclusiveMinimum'"],
    ["a multipleOf", { k: { type: "integer", multipleOf: 2 } }, "'multipleOf'"],
    ["a text format ORCA does not check", { k: { type: "string", format: "ipv4" } }, "format"],
    ["a bound ORCA cannot read", { k: { type: "string", maxLength: -1 } }, "'maxLength'"],
    ["a constraint on a choice", { k: { type: "string", enum: ["a"], pattern: "a" } }, "'pattern'"],
    ["a constraint on list items", { k: { type: "array", items: { enum: ["a"], maxLength: 1 } } }, "items"],
    ["a list of non-text values", { k: { type: "array", items: { type: "number", enum: ["a"] } } }, "not text"],
    ["a keyword on an option", { k: { type: "string", oneOf: [{ const: "a", pattern: "a" }] } }, "cannot read"],
    ["a constraint on a yes/no", { k: { type: "boolean", const: true } }, "'const'"],
  ])("declines %s rather than dropping it", (_, properties, reason) => {
    const out = elicitationForm("Q", { type: "object", properties });
    expect("refused" in out && out.refused).toContain(reason);
  });

  it.each([
    ["oneOf and enum", { type: "string", oneOf: [{ const: "a" }], enum: ["b"] }],
    ["oneOf and anyOf", { type: "string", oneOf: [{ const: "a" }], anyOf: [{ const: "b" }] }],
    ["anyOf and enum on list items", { type: "array", items: { anyOf: [{ const: "a" }], enum: ["b"] } }],
    ["enumNames without enum", { type: "string", oneOf: [{ const: "a" }], enumNames: ["A"] }],
    ["a oneOf that is not a list", { type: "string", oneOf: { const: "a" } }],
  ])("declines an ambiguous choice: %s", (_, field) => {
    expect(elicitationForm("Q", { properties: { k: field } })).toHaveProperty("refused");
  });

  it.each([
    ["a repeated oneOf value", { type: "string", oneOf: [{ const: "a" }, { const: "a", title: "A again" }] }],
    ["a repeated enum value", { type: "string", enum: ["a", "a"] }],
    ["a repeated list item", { type: "array", items: { anyOf: [{ const: "a" }, { const: "a" }] } }],
  ])("declines %s: no answer satisfies exactly one branch", (_, field) => {
    expect(elicitationForm("Q", { properties: { k: field } })).toHaveProperty("refused");
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "declines a field named %s: field names are data, not object bookkeeping",
    (key) => {
      // JSON.parse makes `__proto__` an own key, as it arrives from an agent.
      const schema = JSON.parse(`{"properties":{"${key}":{"type":"string"}}}`) as unknown;
      const out = elicitationForm("Q", schema);
      expect("refused" in out && out.refused).toContain("reserves");
      expect(
        elicitationOf({ elicitation: { message: "Q", fields: [{ key, kind: "text", required: false }] } }),
      ).toBeUndefined();
    },
  );

  it("reads only an answer's own fields, into a map without a prototype", () => {
    const f = form({ properties: { k: { type: "string" } }, required: ["k"] });
    // An inherited value is not an answer.
    expect(() => parseElicitationAnswer(f, JSON.stringify({ action: "accept", content: {} }))).toThrow(/required/);
    const parsed = parseElicitationAnswer(f, JSON.stringify({ action: "accept", content: { k: "v" } }));
    expect(parsed.action === "accept" && Object.getPrototypeOf(parsed.content)).toBeNull();
  });

  it.each([
    ["an explicit null", null],
    ["a name the form lacks", ["k", "missing"]],
    ["a name that is not text", ["k", 1]],
    ["a repeated name", ["k", "k"]],
    ["a list that is not a list", "k"],
  ])("declines a required list with %s", (_, required) => {
    const out = elicitationForm("Q", { properties: { k: { type: "string" } }, required });
    expect("refused" in out && out.refused).toContain("required");
  });

  it("declines a form that allows fields it does not name, or sets a keyword of its own", () => {
    expect(elicitationForm("Q", { properties: { k: { type: "string" } }, additionalProperties: true })).toHaveProperty(
      "refused",
    );
    expect(elicitationForm("Q", { properties: { k: { type: "string" } }, minProperties: 1 })).toHaveProperty("refused");
    expect(
      elicitationForm("Q", { $schema: "x", properties: { k: { type: "string" } }, additionalProperties: false }),
    ).toHaveProperty("form");
  });

  it("declines a form beyond its limits", () => {
    const properties = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, { type: "string" }]));
    expect(elicitationForm("Q", { properties })).toHaveProperty("refused");
  });

  it("is read back from an input's context, and only a well-formed one", () => {
    expect(elicitationOf({ elicitation: every })).toEqual(every);
    expect(elicitationOf({ elicitation: { message: "x", fields: [] } })).toBeUndefined();
    expect(elicitationOf({ toolCall: {} })).toBeUndefined();
    expect(elicitationOf(undefined)).toBeUndefined();
  });
});

describe("parseElicitationAnswer", () => {
  const accept = (content: Record<string, unknown>) => JSON.stringify({ action: "accept", content });

  it("accepts an answer that fits, leaving empty text out", () => {
    expect(
      parseElicitationAnswer(every, accept({ pick: "a", many: ["p", "r"], words: "", count: 2, ok: false })),
    ).toEqual({ action: "accept", content: { pick: "a", many: ["p", "r"], count: 2, ok: false } });
  });

  it("accepts a decline, and round-trips its own encoding", () => {
    expect(parseElicitationAnswer(every, ELICITATION_DECLINE)).toEqual({ action: "decline" });
    const answer = { action: "accept" as const, content: { pick: "b", many: ["q"] } };
    expect(parseElicitationAnswer(every, encodeElicitationAnswer(answer))).toEqual(answer);
  });

  it.each([
    ["email", "a@b.example", "not an email"],
    ["uri", "https://example.invalid/x", "example.invalid"],
    ["date", "2026-02-28", "2026-02-30"],
    ["date-time", "2026-11-27T18:00:00Z", "2026-11-27 18:00"],
  ] as const)("checks a %s field's format", (format, good, bad) => {
    const f = form({ properties: { v: { type: "string", format } } });
    expect(parseElicitationAnswer(f, accept({ v: good }))).toEqual({ action: "accept", content: { v: good } });
    expect(() => parseElicitationAnswer(f, accept({ v: bad }))).toThrow(/not a valid/);
  });

  it.each([
    ["not JSON", "Postgres"],
    ["an unknown action", JSON.stringify({ action: "cancel" })],
    ["a decline with content", JSON.stringify({ action: "decline", content: {} })],
    ["extra keys", JSON.stringify({ action: "accept", content: { pick: "a", many: ["p"] }, x: 1 })],
    ["a field the form lacks", accept({ pick: "a", many: ["p"], other: "x" })],
    ["a missing required field", accept({ many: ["p"] })],
    ["a value outside the options", accept({ pick: "c", many: ["p"] })],
    ["a repeated pick", accept({ pick: "a", many: ["p", "p"] })],
    ["too many picks", accept({ pick: "a", many: ["p", "q", "r"] })],
    ["an empty required list", accept({ pick: "a", many: [] })],
    ["text over its bound", accept({ pick: "a", many: ["p"], words: "toolong" })],
    ["a fractional integer", accept({ pick: "a", many: ["p"], count: 1.5 })],
    ["a number out of range", accept({ pick: "a", many: ["p"], count: 9 })],
    ["a string for a yes/no", accept({ pick: "a", many: ["p"], ok: "yes" })],
  ])("refuses %s", (_, answer) => {
    expect(() => parseElicitationAnswer(every, answer)).toThrow(/does not fit the question/);
  });
});
