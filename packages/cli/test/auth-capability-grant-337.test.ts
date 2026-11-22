/** `orca auth issue --mcp-server` writes a credential's catalog MCP server grant (#337). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpServerDefinitionDigest, secretHostBinding } from "@orca/agents";
import { HostSpecSchema } from "@orca/core";
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
      "",
    ].join("\n"),
    "utf8",
  );
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
    expect(stored("all").capabilities).toBe("*");
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
});
