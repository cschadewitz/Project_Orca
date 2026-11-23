/** #335: the capability set each agent gets, previewed from a candidate before it is saved. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigGetResultSchema, ConfigSetResultSchema } from "@orca/protocol";
import { effectiveCapabilities } from "../src/config-capabilities.js";
import { ConfigModel } from "../src/config-model.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const base = [
  "capabilities:",
  "  mcpServers:",
  "    github: { command: /usr/bin/github-mcp, args: [SYNTHETIC_ARG], env: { TOKEN: SYNTHETIC_LITERAL } }",
  "  skills:",
  "    review: { path: /srv/skills/SYNTHETIC_SKILL_PATH }",
  "  workspace:",
  "    mcpServers:",
  "      enable:",
  "        - github",
  "agents:",
  "  - id: builder",
  "    command: example",
  "    mcpServers: [{ name: notes, command: /usr/bin/notes-mcp }]",
  "    capabilities: { skills: { enable: [review] } }",
  "",
].join("\n");

describe("effective capability sets (#335)", () => {
  it("reports identities and sources per agent, never a definition", () => {
    const result = effectiveCapabilities({
      capabilities: {
        mcpServers: { github: { command: "/usr/bin/github-mcp", env: { TOKEN: "SYNTHETIC_LITERAL" } } },
        workspace: { mcpServers: { enable: ["github"] } },
      },
      agents: [{ id: "builder", command: "example", mcpServers: [{ name: "notes", command: "notes-mcp" }] }],
    });
    expect(result).toEqual({
      agents: {
        builder: {
          mcpServers: [
            { id: "github", source: "config.capabilities.workspace", catalog: true },
            { id: "notes", source: "agents.builder.mcpServers", catalog: false },
          ],
          skills: [],
          errors: [],
          warnings: [],
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_LITERAL|github-mcp|notes-mcp/);
  });

  it("reports warnings, and leaves a candidate the schema refuses to its validation errors", () => {
    const result = effectiveCapabilities({
      capabilities: { skills: { review: { path: "/srv/skills/review.md" } } },
      agents: [{ id: "builder", command: "example", capabilities: { skills: { disable: ["review"] } } }],
    });
    expect(result?.agents.builder?.warnings).toEqual([
      { path: "agents.builder.capabilities.skills.disable", message: expect.stringContaining("'review'") },
    ]);
    expect(
      effectiveCapabilities({
        agents: [{ id: "builder", command: "example", capabilities: { skills: { enable: ["missing"] } } }],
      }),
    ).toBeUndefined();
  });

  it("has nothing to report for a value that is not a configuration", () => {
    expect(effectiveCapabilities({ agents: "nope" })).toBeUndefined();
    expect(effectiveCapabilities(null)).toEqual({ agents: {} });
  });

  it("previews a candidate's sets under validateOnly without writing, and reports the saved ones on get", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-capabilities-335-"));
    dirs.push(dir);
    const file = join(dir, "orca.config.yaml");
    await writeFile(file, base, "utf8");
    const model = new ConfigModel({ configDir: dir, configFile: file });
    const got = ConfigGetResultSchema.parse(await model.get());
    expect(got.capabilities?.agents.builder).toMatchObject({
      mcpServers: [
        { id: "github", catalog: true },
        { id: "notes", catalog: false },
      ],
      skills: [{ id: "review", source: "agents.builder.capabilities" }],
    });
    const preview = ConfigSetResultSchema.parse(
      await model.set({
        document: "config",
        expectedRevision: got.config.revision,
        validateOnly: true,
        text: base.replace("      enable:\n        - github\n", "      disable:\n        - github\n"),
      }),
    );
    expect(preview.capabilities?.agents.builder?.mcpServers).toEqual([
      { id: "notes", source: "agents.builder.mcpServers", catalog: false },
    ]);
    expect(JSON.stringify(preview.capabilities)).not.toMatch(/SYNTHETIC_/);
    expect(await readFile(file, "utf8")).toBe(base);
    // Only the config document has capability sets.
    const sidecar = await model.set({
      document: "permissions",
      expectedRevision: got.permissions.revision,
      validateOnly: true,
      text: "{}",
    });
    expect(sidecar).not.toHaveProperty("capabilities");
  });
});
