/** Marker bytes are structural diagnostics, never enrollment/owner authority. */
import { describe, expect, it } from "vitest";
import {
  createInactiveTypedSidecarStore,
  parseTypedCompatibilityMarkerBytes,
  type TypedCompatibilityMarker,
} from "@orca/agents";
const marker: TypedCompatibilityMarker = {
  version: 1,
  workspaceRef: "synthetic:workspace",
  rootBindingRef: "synthetic:original-role-binding",
  sidecarRef: "synthetic:sidecar",
  format: "orca-permissions-v2",
  minimumWriterContract: "orca-typed-sidecar-v1",
  enrollmentRef: "synthetic:enrollment",
  state: "enrolled",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
describe("canonical typed compatibility marker byte parser", () => {
  it.each(["enrollment-pending", "enrolled"] as const)(
    "returns exact %s structure without minting an owner",
    (state) => {
      const expected = { ...marker, state };
      const parsed = parseTypedCompatibilityMarkerBytes(new Uint8Array(encode(expected)));
      expect(parsed).toEqual(expected);
      expect(() => createInactiveTypedSidecarStore(parsed as never)).toThrow(/trusted owner/);
    },
  );
  it.each(Object.keys(marker))("refuses missing required %s without defaults", (key) => {
    const raw: Record<string, unknown> = { ...marker };
    delete raw[key];
    expect(() => parseTypedCompatibilityMarkerBytes(encode(raw))).toThrow();
  });
  it.each([
    { ...marker, version: 2 },
    { ...marker, version: "1" },
    { ...marker, state: "pending" },
    { ...marker, state: "future" },
    { ...marker, format: "orca-permissions-v3" },
    { ...marker, minimumWriterContract: "orca-typed-sidecar-v2" },
    { ...marker, future: true },
    { ...marker, workspaceRef: "" },
    { ...marker, rootBindingRef: " " },
    { ...marker, sidecarRef: null },
    { ...marker, enrollmentRef: 1 },
    null,
    [],
    {},
    true,
  ])("refuses unknown, incomplete or unsupported material %j", (raw) => {
    expect(() => parseTypedCompatibilityMarkerBytes(encode(raw))).toThrow();
  });
  it.each([
    "",
    "{",
    "null",
    JSON.stringify(marker).replace('"version":1', '"version":2,"version":1'),
    JSON.stringify(marker).replace('"version":1', '"version":1,"\\u0076ersion":1'),
  ])("refuses corrupt, absent or duplicate-key bytes %s", (text) => {
    expect(() => parseTypedCompatibilityMarkerBytes(Buffer.from(text))).toThrow();
  });
  it("refuses invalid UTF-8 and non-byte input rather than normalizing it", () => {
    const bytes = Buffer.concat([Buffer.from('{"workspaceRef":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(() => parseTypedCompatibilityMarkerBytes(bytes)).toThrow(/UTF-8/);
    expect(() => parseTypedCompatibilityMarkerBytes(marker as never)).toThrow(/must be bytes/);
  });
});
