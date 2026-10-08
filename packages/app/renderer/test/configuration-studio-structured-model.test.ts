/** #333 invariants independent of UI and YAML persistence: ordered edits and rich branch semantics. */
import { describe, expect, it } from "vitest";
import {
  atPath,
  initialValue,
  pathLabel,
  projectEdits,
  recordKeyError,
  switchVariant,
} from "../src/config/structured-form/collection-model.js";
import type { FieldShape, FieldMetadata } from "../src/config/structured-form/contracts.js";

const metadata: FieldMetadata = {
  acceptsAbsent: true,
  acceptsNull: false,
  visibility: "non-secret",
  default: { state: "none" },
};
const scalar: FieldShape = { ...metadata, kind: "scalar", field: { path: "value", type: "string", required: false } };
const variant: Extract<FieldShape, { kind: "union" }> = {
  ...metadata,
  kind: "union",
  discriminator: "type",
  branches: {
    local: { ...metadata, kind: "object", fields: { type: scalar, shared: scalar, command: scalar } },
    remote: { ...metadata, kind: "object", fields: { type: scalar, shared: scalar, endpoint: scalar } },
  },
};

describe("ordered display projection, never a serialization contract", () => {
  it("preserves extension values and uses pre-operation array indices", () => {
    const base = { hosts: [{ id: "a", extension: { keep: true } }, { id: "b" }], other: false };
    expect(
      projectEdits(base, [
        { kind: "move", path: ["hosts"], from: 0, to: 1 },
        { kind: "insert", path: ["hosts"], index: 1, value: { id: "c" } },
        { kind: "set", path: ["hosts", 2, "id"], value: "a-edited" },
        { kind: "remove", path: ["hosts", 0] },
      ]),
    ).toEqual({ hosts: [{ id: "c" }, { id: "a-edited", extension: { keep: true } }], other: false });
    expect(base.hosts[0]?.id).toBe("a");
  });
  it("keeps absent, null, false, zero and empty string distinct", () => {
    const projected = projectEdits({ data: { remove: 1 } }, [
      { kind: "remove", path: ["data", "remove"] },
      { kind: "set", path: ["data", "null"], value: null },
      { kind: "set", path: ["data", "false"], value: false },
      { kind: "set", path: ["data", "zero"], value: 0 },
      { kind: "set", path: ["data", "empty"], value: "" },
    ]);
    expect(projected).toEqual({ data: { null: null, false: false, zero: 0, empty: "" } });
    expect(atPath(projected, ["data", "remove"])).toBeUndefined();
    expect(() => projectEdits({}, [{ kind: "set", path: ["undefined"], value: undefined }])).toThrow("explicit JSON");
  });
  it.each(["__proto__", "constructor", "prototype", "a.b", "a[0]", "", "with space"])(
    "refuses unsafe or ambiguous record key %s",
    (key) => {
      expect(recordKeyError(key, {})).toBeTruthy();
    },
  );
  it("refuses duplicates and prototype mutation while preserving original unsafe extension keys", () => {
    expect(recordKeyError("existing", { existing: false })).toBe("This key already exists.");
    expect(recordKeyError("safe-key_1", {})).toBeUndefined();
    expect(() => projectEdits({}, [{ kind: "set", path: ["__proto__", "polluted"], value: true }])).toThrow(
      "Unsupported edit path",
    );
    expect(
      projectEdits(JSON.parse('{"extension":{"__proto__":"kept"}}') as unknown, [
        { kind: "set", path: ["version"], value: 1 },
      ]),
    ).toEqual({ extension: JSON.parse('{"__proto__":"kept"}') as unknown, version: 1 });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
  it("refuses invalid indices and missing parents instead of manufacturing containers", () => {
    expect(() => projectEdits({ list: [] }, [{ kind: "move", path: ["list"], from: 0, to: 1 }])).toThrow();
    expect(() => projectEdits({ list: [] }, [{ kind: "insert", path: ["list"], index: 2, value: {} }])).toThrow();
    expect(() => projectEdits({}, [{ kind: "set", path: ["missing", "field"], value: "" }])).toThrow();
    expect(pathLabel(["hosts", 1, "id"])).toBe("hosts[1].id");
    expect(pathLabel(["record", "a.b"])).toBe('record["a.b"]');
  });
});

describe("authoritative creation and unions", () => {
  it("creates an empty object without materializing unused child defaults", () => {
    const shape: FieldShape = {
      ...metadata,
      kind: "object",
      fields: { unused: { ...scalar, default: { state: "available", value: "automatic" } } },
    };
    expect(initialValue(shape)).toEqual({ available: true, value: {} });
    expect(
      initialValue({ ...scalar, visibility: "withheld", default: { state: "available", value: "never echo" } }),
    ).toEqual({ available: false });
    expect(initialValue({ ...scalar, acceptsNull: "metadata-unavailable" })).toEqual({ available: false });
  });
  it("switches branch with ordered leaf removals and preserves common and unknown values", () => {
    const value = { type: "local", command: "old", shared: false, futureExtension: { value: 42 } };
    const edits = switchVariant(variant, value, ["host"], "remote");
    expect(edits).toEqual([
      { kind: "remove", path: ["host", "command"] },
      { kind: "set", path: ["host", "type"], value: "remote" },
    ]);
    expect(projectEdits({ host: value }, edits!)).toEqual({
      host: { type: "remote", shared: false, futureExtension: { value: 42 } },
    });
    expect(switchVariant(variant, { type: "plugin", unknown: true }, ["host"], "remote")).toBeUndefined();
    expect(switchVariant(variant, value, ["host"], "constructor")).toBeUndefined();
  });
  it("requires explicit variant selection on an absent union", () => {
    expect(initialValue(variant)).toEqual({ available: false });
    expect(switchVariant(variant, undefined, ["host"], "local")).toEqual([
      { kind: "set", path: ["host"], value: {} },
      { kind: "set", path: ["host", "type"], value: "local" },
    ]);
  });
});
