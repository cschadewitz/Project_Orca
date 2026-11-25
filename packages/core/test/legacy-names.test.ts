import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptEnvPrefix,
  adoptLegacyEnv,
  ENV_PREFIX,
  LEGACY_ENV_PREFIX,
  legacyFallbackPath,
  resetLegacyNameWarnings,
} from "@orca/core";

beforeEach(() => resetLegacyNameWarnings());

describe("adopting environment variables from before the rename", () => {
  it("moves an old name to its unset new name and warns once per name", () => {
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = { OLD_A: "1", OLD_B: "2", NEW_B: "kept", OTHER: "x" };
    expect(adoptEnvPrefix(env, "OLD_", "NEW_", (m) => warnings.push(m))).toEqual(["NEW_A"]);
    expect(env).toEqual({ NEW_A: "1", OLD_B: "2", NEW_B: "kept", OTHER: "x" });
    expect(warnings).toEqual(["warning: OLD_A is deprecated, set NEW_A instead (read until 0.10)"]);
    env.OLD_A = "again";
    adoptEnvPrefix(env, "OLD_", "NEW_", (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });

  it("adopts the product's own legacy prefix, and does nothing while the names are the same", () => {
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = { [`${LEGACY_ENV_PREFIX}DAEMON_TOKEN`]: "t" };
    const adopted = adoptLegacyEnv(env, (m) => warnings.push(m));
    expect(env[`${ENV_PREFIX}DAEMON_TOKEN`]).toBe("t");
    if (ENV_PREFIX === LEGACY_ENV_PREFIX) expect(adopted).toEqual([]);
    else {
      expect(adopted).toEqual([`${ENV_PREFIX}DAEMON_TOKEN`]);
      expect(env[`${LEGACY_ENV_PREFIX}DAEMON_TOKEN`]).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });
});

describe("reading a file under its old name", () => {
  it("prefers the new name, falls back to the old one with a warning, and otherwise names the new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-names-"));
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(legacyFallbackPath(dir, "new.yaml", "old.yaml", warn)).toBe(join(dir, "new.yaml"));
    writeFileSync(join(dir, "old.yaml"), "a: 1\n");
    expect(legacyFallbackPath(dir, "new.yaml", "old.yaml", warn)).toBe(join(dir, "old.yaml"));
    expect(legacyFallbackPath(dir, "new.yaml", "old.yaml", warn)).toBe(join(dir, "old.yaml"));
    expect(warnings).toHaveLength(1);
    writeFileSync(join(dir, "new.yaml"), "a: 2\n");
    expect(legacyFallbackPath(dir, "new.yaml", "old.yaml", warn)).toBe(join(dir, "new.yaml"));
  });
});
