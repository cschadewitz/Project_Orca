/**
 * `config.get`'s effective policy lists each agent's plain-language rules apart from its typed
 * ones (protocol 2.12, #701), named as the judged lane names them: `config:N` and `sidecar:N`,
 * by index as written with typed rules counted. An expired saved rule is left out.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "@orca/core";
import { ConfigGetResultSchema } from "@orca/protocol";
import { ConfigModel } from "@orca/daemon";

const CONFIG = `version: 1
agents:
  - id: claude
    command: claude-code
    permissions:
      default: ask
      rules:
        - match: { kind: edit }
          decision: deny
        - match: { kind: search, scope: workspace }
          judge: { criterion: "Searching the repository for code and docs." }
`;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("the effective policy's plain-language rules", () => {
  it("lists configured and saved judged rules apart from the typed ones, without an expired one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-effective-judged-"));
    dirs.push(dir);
    const configFile = join(dir, "orca.config.yaml");
    await writeFile(configFile, CONFIG, "utf8");
    await writeFile(
      join(dir, "orca.permissions.json"),
      JSON.stringify({
        version: 4,
        agents: {
          claude: {
            rules: [
              { match: { kind: "read", path: "README.md" }, decision: "allow", addedAt: "2026-11-01T00:00:00.000Z" },
              {
                match: { kind: "read", pathPrefix: "docs" },
                judge: { criterion: "Reading the docs." },
                addedAt: "2026-11-20T00:00:00.000Z",
                expiresAt: "2026-12-20T00:00:00.000Z",
              },
              {
                match: { kind: "read", pathPrefix: "old" },
                judge: { criterion: "Reading old notes." },
                expiresAt: "2026-11-01T00:00:00.000Z",
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const clock = new FakeClock(Date.UTC(2026, 10, 23, 12, 0, 0));
    const model = new ConfigModel({ configDir: dir, configFile, clock });
    const result = ConfigGetResultSchema.parse(await model.get());
    const policy = result.effective.agents["claude"]!;
    // The typed rules alone are in the first-match order.
    expect(policy.rules.map((rule) => rule.source)).toEqual(expect.arrayContaining(["config", "permissions"]));
    expect(policy.rules.every((rule) => "decision" in rule)).toBe(true);
    expect(policy.judged).toEqual([
      {
        ruleId: "config:1",
        source: "config",
        match: { kind: "search", scope: "workspace" },
        criterion: "Searching the repository for code and docs.",
      },
      {
        ruleId: "sidecar:1",
        source: "permissions",
        match: { kind: "read", pathPrefix: "docs" },
        criterion: "Reading the docs.",
        addedAt: "2026-11-20T00:00:00.000Z",
        expiresAt: "2026-12-20T00:00:00.000Z",
      },
    ]);
  });
});
