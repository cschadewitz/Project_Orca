/**
 * The Claude Agent SDK comes without the `claude` it bundles (#1120): ORCA runs only the person's
 * own installed `claude` (#1118), so every per-platform package the SDK would pull in, each of
 * which carries a CLI binary, is removed by an override and never reaches the lockfile.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(join(root, "packages", "agents", "package.json"));

function sdkPackage(): { version: string; optionalDependencies?: Record<string, string> } {
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  return JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as {
    version: string;
    optionalDependencies?: Record<string, string>;
  };
}

describe("Claude Agent SDK dependency (#1120)", () => {
  it("overrides every bundled-CLI package the SDK names away", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const optional = Object.keys(sdkPackage().optionalDependencies ?? {});
    expect(optional.length).toBeGreaterThan(0);
    for (const name of optional) expect(workspace).toContain(`"${name}": "-"`);
  });

  it("keeps no bundled-CLI package in the lockfile", () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    // Package and snapshot keys: `  '@anthropic-ai/claude-agent-sdk-<platform>@<version>':`
    expect(lock).not.toMatch(/^ {2}'@anthropic-ai\/claude-agent-sdk-[^'@]+@/m);
    expect(lock).not.toMatch(/^ {6}'@anthropic-ai\/claude-agent-sdk-[^']+': \d/m);
  });

  it("pins the SDK to one exact version", () => {
    const pkg = JSON.parse(readFileSync(join(root, "packages", "agents", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sdkPackage().version).toBe(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]);
  });
});
