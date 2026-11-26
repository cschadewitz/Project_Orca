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
  protocol: { major: 2, minor: 14 },
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

describe("a first-run workspace the app set up before the rename", () => {
  it("is recognised under its old names and read under them; a new one under the current names", async () => {
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { firstRunLayout, holdsFirstRunOwnership } = await import("../src/first-run-fence.js");
    const legacy = mkdtempSync(join(tmpdir(), "first-run-legacy-"));
    mkdirSync(join(legacy, ".orca-first-run-ownership")); // rename-keep: the old journal is the fixture
    expect(holdsFirstRunOwnership(legacy)).toBe(true);
    expect(firstRunLayout(legacy)).toEqual({
      journal: join(legacy, ".orca-first-run-ownership"), // rename-keep: the old journal is the fixture
      anchor: join(legacy, ".orca-first-run-ownership.json"), // rename-keep: the old anchor is the fixture
      store: join(legacy, ".orca"), // rename-keep: the old store is the fixture
      config: join(legacy, "orca.config.yaml"), // rename-keep: the old config is the fixture
    });
    const current = mkdtempSync(join(tmpdir(), "first-run-current-"));
    expect(holdsFirstRunOwnership(current)).toBe(false);
    mkdirSync(join(current, ".orca-first-run-ownership"));
    expect(holdsFirstRunOwnership(current)).toBe(true);
    expect(firstRunLayout(current).store).toBe(join(current, ".orca"));
    expect(firstRunLayout(current).config).toBe(join(current, "orca.config.yaml"));
  });
});

describe("a first-run workspace set up before the rename and never started", () => {
  it("has no ownership yet, so its config alone decides which names it opens under", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { firstRunLayout } = await import("../src/first-run-fence.js");
    const unstarted = mkdtempSync(join(tmpdir(), "first-run-unstarted-"));
    writeFileSync(join(unstarted, "orca.config.yaml"), "version: 1\n"); // rename-keep: the old config is the fixture
    expect(firstRunLayout(unstarted)).toEqual({
      journal: join(unstarted, ".orca-first-run-ownership"), // rename-keep: the old journal is expected
      anchor: join(unstarted, ".orca-first-run-ownership.json"), // rename-keep: the old anchor is expected
      store: join(unstarted, ".orca"), // rename-keep: the old store is expected
      config: join(unstarted, "orca.config.yaml"), // rename-keep: the old config is expected
    });
    // Once the current config is there too, or only it, the current names win.
    writeFileSync(join(unstarted, "orca.config.yaml"), "version: 1\n");
    expect(firstRunLayout(unstarted).config).toBe(join(unstarted, "orca.config.yaml"));
    expect(firstRunLayout(unstarted).store).toBe(join(unstarted, ".orca"));
    const fresh = mkdtempSync(join(tmpdir(), "first-run-fresh-"));
    expect(firstRunLayout(fresh).config).toBe(join(fresh, "orca.config.yaml"));
  });
});
