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
