/** `orca auth issue --mcp-server` writes a credential's catalog MCP server grant (#337). */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpServerDefinitionDigest, secretHostBinding } from "@orca/agents";
import { HostSpecSchema } from "@orca/core";
import { skillDigest } from "@orca/engine";
import { openAuthDirectory } from "@orca/daemon";
import { authCommand } from "../src/commands/auth.js";
import type { CommandContext } from "../src/commands/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-auth-capability-"));
  await writeFile(
    join(dir, "orca.config.yaml"),
    [
      "version: 1",
      "workflows: []",
      "templates: []",
      "hosts:",
      "  - { id: local, type: local }",
      "  - { id: build-box, type: ssh, host: build.example }",
      "secrets:",
      "  github-token: { host: local, provider: env, name: GITHUB_TOKEN }",
      "capabilities:",
      "  mcpServers:",
      "    github: { command: /opt/mcp/gh-mcp, args: [--stdio], env: { GITHUB_TOKEN: { secret: github-token } } }",
      "    bare: { command: gh-mcp }",
      "  skills:",
      "    review: { path: review }",
      "    pinned: { path: review, digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "review"));
  await writeFile(join(dir, "review", "SKILL.md"), "review carefully", "utf8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function issue(principal: string, flags: CommandContext["flags"]): Promise<number> {
  return authCommand({
    cwd: dir,
    flags: { json: true, ...flags },
    positionals: ["issue", principal],
    out: () => {},
    err: () => {},
  });
}

const stored = (principal: string) =>
  openAuthDirectory(join(dir, "auth"))
    .credentials.list()
    .find((c) => c.principal === principal)!;

describe("auth issue --mcp-server", () => {
  it("grants each id@host, pinned to its definition and the host's endpoint, and adds capabilities.use", async () => {
    expect(await issue("ci-bot", { "mcp-server": ["github@build-box", "github@local", "github@local"] })).toBe(0);
    const c = stored("ci-bot");
    const definition = mcpServerDefinitionDigest({
      command: "/opt/mcp/gh-mcp",
      args: ["--stdio"],
      env: { GITHUB_TOKEN: { secret: "github-token" } },
    });
    expect(c.capabilities).toEqual([
      {
        kind: "mcpServer",
        id: "github",
        host: "build-box",
        binding: secretHostBinding(HostSpecSchema.parse({ id: "build-box", type: "ssh", host: "build.example" })),
        definition,
      },
      {
        kind: "mcpServer",
        id: "github",
        host: "local",
        binding: secretHostBinding({ id: "local", type: "local" }),
        definition,
      },
    ]);
    expect(c.permissions).toContain("capabilities.use");
    expect(c.permissions).not.toContain("secrets.use");
  });

  it("grants every server with '*', and none without the flag", async () => {
    expect(await issue("all", { "mcp-server": ["*"] })).toBe(0);
    // An explicit entry for servers only: it grants no skill.
    expect(stored("all").capabilities).toEqual([{ kind: "mcpServer", any: true }]);
    expect(await issue("none", {})).toBe(0);
    expect(stored("none").capabilities).toBeUndefined();
    expect(stored("none").permissions).not.toContain("capabilities.use");
  });

  it("refuses a grant without a host, for a server not in the catalog or an unconfigured host, or '*' mixed with ids", async () => {
    await expect(issue("a", { "mcp-server": ["github"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(issue("a", { "mcp-server": ["absent@local"] })).rejects.toMatchObject({
      message: "--mcp-server names 'absent', which is not a catalog MCP server",
    });
    await expect(issue("a", { "mcp-server": ["github@nowhere"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(issue("c", { "mcp-server": ["*", "github@local"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // A command found by PATH cannot be pinned by a grant for one server.
    await expect(issue("d", { "mcp-server": ["bare@local"] })).rejects.toMatchObject({
      message: expect.stringMatching(/'bare' runs 'gh-mcp', which is not an absolute path/),
    });
  });

  it("grants a skill by its content digest, and refuses one the catalog's pin no longer matches", async () => {
    expect(await issue("reviewer", { skill: ["review"], "mcp-server": ["github@local"] })).toBe(0);
    const digest = skillDigest({ path: "review" }, dir);
    if (!("digest" in digest)) throw new Error(digest.error);
    expect(stored("reviewer").capabilities).toContainEqual({ kind: "skill", id: "review", digest: digest.digest });
    expect(stored("reviewer").permissions).toContain("capabilities.use");
    await expect(issue("e", { skill: ["pinned"] })).rejects.toMatchObject({
      message: expect.stringMatching(/no longer matches the digest the catalog pins/),
    });
    await expect(issue("f", { skill: ["absent"] })).rejects.toMatchObject({
      message: "--skill names 'absent', which is not a catalog skill",
    });
    await expect(issue("g", { skill: ["*", "review"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // Each kind's '*' is its own explicit entry; neither grants the other kind.
    expect(await issue("h", { skill: ["*"] })).toBe(0);
    expect(stored("h").capabilities).toEqual([{ kind: "skill", any: true }]);
    expect(await issue("i", { skill: ["*"], "mcp-server": ["github@local"] })).toBe(0);
    expect(stored("i").capabilities).toEqual([
      expect.objectContaining({ kind: "mcpServer", id: "github" }),
      { kind: "skill", any: true },
    ]);
    expect(await issue("j", { skill: ["*"], "mcp-server": ["*"] })).toBe(0);
    expect(stored("j").capabilities).toEqual([
      { kind: "mcpServer", any: true },
      { kind: "skill", any: true },
    ]);
  });
});
