import { describe, expect, it } from "vitest";
import {
  HelloResultSchema,
  LEGACY_VERSION_FIELD,
  legacyVersionField,
  OperatorDiscoverySchema,
  PROTOCOL_VERSION,
  VERSION_FIELD,
} from "@orca/protocol";

const hello = { protocol: PROTOCOL_VERSION, capabilities: ["runs.read"] };
const discovery = {
  target: { workspaceId: "6f1c1f8e-3a52-4b8e-9d1c-0a8e1b2c3d4e", instanceId: "0b7a3e8f-1c2d-4e5f-8a9b-0c1d2e3f4a5b" },
  protocol: { major: 2, minor: 12 },
  principalId: "p",
  authentication: "credential",
  scope: { runs: "all", workflows: "*", permissions: [] },
  operations: [],
  collections: [],
  asOf: "2026-11-25T00:00:00.000Z",
};

describe("the version field renamed on the wire", () => {
  it("reads a daemon from before the rename, which sends only the old name", () => {
    for (const schema of [HelloResultSchema, OperatorDiscoverySchema] as const) {
      const base = schema === HelloResultSchema ? hello : discovery;
      const parsed = schema.parse({ ...base, [LEGACY_VERSION_FIELD]: "0.8.3" }) as Record<string, unknown>;
      expect(parsed[VERSION_FIELD]).toBe("0.8.3");
    }
  });

  it("keeps both names in what a daemon sends, so a client from before the rename finds its own", () => {
    const sent = { ...hello, ...legacyVersionField("0.9.0"), [VERSION_FIELD]: "0.9.0" };
    const parsed = HelloResultSchema.parse(sent) as Record<string, unknown>;
    expect(parsed[VERSION_FIELD]).toBe("0.9.0");
    expect(parsed[LEGACY_VERSION_FIELD]).toBe("0.9.0");
  });

  it("prefers the current name and still requires one of them", () => {
    const sent: Record<string, unknown> = { ...hello, [LEGACY_VERSION_FIELD]: "old" };
    sent[VERSION_FIELD] = "new";
    const parsed = HelloResultSchema.parse(sent);
    expect((parsed as Record<string, unknown>)[VERSION_FIELD]).toBe("new");
    expect(HelloResultSchema.safeParse(hello).success).toBe(false);
  });
});
