/** Display readers tolerate historical data without invoking arbitrary string coercion. */
import { describe, expect, it } from "vitest";
import { EventPayload, coerceWorkflowString } from "@orca/core";

describe("EventPayload", () => {
  it("preserves primitive text and optional-field spellings", () => {
    const p = new EventPayload({ text: "ok", count: 0, flag: false, nil: null });
    expect([p.text("text"), p.text("count"), p.text("flag"), p.text("nil"), p.text("missing")]).toEqual([
      "ok",
      "0",
      "false",
      "null",
      "undefined",
    ]);
    expect([p.optionalText("count"), p.optionalText("flag"), p.optionalText("nil"), p.optionalText("missing")]).toEqual(
      ["", "", "", ""],
    );
  });

  it("does not invoke an object's coercion hooks or expose its contents", () => {
    const secret = {
      toString() {
        throw new Error("canary");
      },
    };
    const p = new EventPayload({ value: secret, array: [secret] });
    expect(p.text("value")).toBe("[invalid]");
    expect(p.text("value", 8)).toBe("[invalid]");
    expect(p.optionalText("value")).toBe("[invalid]");
    expect(p.text("array")).toBe("[invalid]");
    expect(p.strings("array")).toEqual(["[invalid]"]);
    expect(p.flag("value")).toBe(false);
  });

  it("uses only own fields and leaves structured data intact", () => {
    const value = Object.freeze({ vars: Object.freeze({ token: "[redacted]" }) });
    const p = new EventPayload(value);
    expect(p.text("toString")).toBe("undefined");
    expect(p.record("vars").keys()).toEqual(["token"]);
    expect(p.field("vars")).toBe(value.vars);
    expect(p.strings("vars")).toEqual(["[invalid]"]);
    expect(p.list("vars")).toEqual([]);
  });
});

it("keeps workflow-language coercion explicit and separate from event display", () => {
  expect([undefined, null, false, 0, { a: 1 }, [1, null, "two"]].map(coerceWorkflowString)).toEqual([
    "undefined",
    "null",
    "false",
    "0",
    "[object Object]",
    "1,,two",
  ]);
});
