/**
 * Isolation on the Claude Agent SDK route (#1126), through the session factory a daemon uses:
 * secret references are planned, checked and read as on the ACP route and reach Claude only in
 * the variables the agent's env names; every variable a secret is read from, and every inherited
 * Claude override, is kept from Claude; the values are reported for redaction and taken out of
 * what the session throws. `claude` is the SDK stand-in behind a launch-check shim.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, OrcaError } from "@orca/core";
import { LocalHost, type AgentSession, type SessionUpdateEvent } from "@orca/agents";
import { makeSessionFactory } from "../src/bootstrap.js";

const STAND_IN = fileURLToPath(new URL("../../agents/test/fixtures/claude-sdk-stand-in.mjs", import.meta.url));
const VALUE = "sk-orca-1126-secret-value";
const SOURCE = "ORCA_1126_KEY_SOURCE";

let dir: string;
let claude: string;
let keyFile: string;
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-isolation-")));
  claude = join(dir, "claude");
  keyFile = join(dir, "key");
  await writeFile(keyFile, `${VALUE}\n`);
  await writeFile(
    claude,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}'; exit 0; fi
exec "${process.execPath}" "${STAND_IN}" "$@"
`,
  );
  await chmod(claude, 0o755);
  process.env[SOURCE] = "inherited-source-value";
  process.env["CLAUDE_ENV_FILE"] = join(dir, "env.sh");
});
afterEach(async () => {
  delete process.env[SOURCE];
  delete process.env["CLAUDE_ENV_FILE"];
  await rm(dir, { recursive: true, force: true });
});

const factory = () =>
  makeSessionFactory({ configDir: join(dir, "orca"), storeDir: ".orca" }, () =>
    Promise.reject(new Error("ACP opened")),
  );
const agent = () =>
  AgentSpecSchema.parse({
    id: "claude",
    driver: "claude-agent-sdk",
    command: claude,
    env: { ANTHROPIC_API_KEY: { secret: "claude-key" } },
  });
const secrets = () => ({
  "claude-key": { host: "local", provider: "file" as const, path: keyFile },
  // Not used by this agent, but read from the daemon's environment: withheld all the same.
  other: { host: "local", provider: "env" as const, name: SOURCE },
});

async function childEnv(session: AgentSession): Promise<Record<string, string>> {
  const texts: string[] = [];
  const off = session.onUpdate((e: SessionUpdateEvent) => {
    if (e.summary.kind === "agent_message_chunk") texts.push(e.summary.text ?? "");
  });
  await session.prompt("env");
  off();
  return JSON.parse(texts.join("")) as Record<string, string>;
}

describe.runIf(process.platform !== "win32")("Claude Agent SDK isolation (#1126)", () => {
  it("delivers a secret only into the variable the agent names, withholds its sources and Claude overrides", async () => {
    const reported: string[][] = [];
    const uses: unknown[] = [];
    const session = await factory()({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(),
      cwd: dir,
      secrets: secrets(),
      authorizeSecretUse: (u) => {
        uses.push(...u);
        return Promise.resolve();
      },
      onSecretValues: (v) => reported.push([...v]),
    });
    try {
      const env = await childEnv(session);
      expect(env["ANTHROPIC_API_KEY"]).toBe(VALUE);
      expect(env[SOURCE]).toBeUndefined();
      expect(env["CLAUDE_ENV_FILE"]).toBeUndefined();
      expect(reported).toEqual([[VALUE]]);
      expect(uses).toEqual([expect.objectContaining({ secret: "claude-key", provider: "file", agentId: "claude" })]);
    } finally {
      await session.close();
    }
  });

  it("neither checks nor reads a reference only an MCP server uses: this route starts none (#1308 review)", async () => {
    const asked: unknown[] = [];
    const reported: unknown[] = [];
    const session = await factory()({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "claude",
        driver: "claude-agent-sdk",
        command: claude,
        mcpServers: [{ name: "tool", command: "/bin/true", env: { TOOL_KEY: { secret: "claude-key" } } }],
      }),
      cwd: dir,
      // The source is gone: a read would fail the open.
      secrets: { ...secrets(), "claude-key": { host: "local", provider: "file", path: join(dir, "missing") } },
      authorizeSecretUse: (u) => {
        asked.push(...u);
        return Promise.resolve();
      },
      onSecretValues: (v) => reported.push(...v),
    });
    try {
      const env = await childEnv(session);
      expect(asked).toEqual([]);
      expect(reported).toEqual([]);
      expect(env["TOOL_KEY"]).toBeUndefined();
      // The catalog's withholding still holds.
      expect(env[SOURCE]).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("refuses a secret reference without a server-verified use check, before Claude starts", async () => {
    const marker = join(dir, "started");
    await writeFile(claude, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    const error = await factory()({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(),
      cwd: dir,
      secrets: secrets(),
    }).then(
      () => undefined,
      (e: unknown) => e as OrcaError,
    );
    expect(error).toBeInstanceOf(OrcaError);
    expect(error!.message).toMatch(/server-verified authority/);
    await expect(import("node:fs/promises").then((fs) => fs.access(marker))).rejects.toThrow();
  });

  it("takes the delivered value out of what the session throws", async () => {
    const session = await factory()({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(),
      cwd: dir,
      secrets: secrets(),
      authorizeSecretUse: () => Promise.resolve(),
    });
    try {
      // A refused option names the value it was asked for, here the secret.
      const refused = await session.setConfigOption("model", VALUE).then(
        () => undefined,
        (e: unknown) => e as OrcaError,
      );
      expect(refused).toBeInstanceOf(OrcaError);
      expect(JSON.stringify({ m: refused!.message, d: refused!.details })).not.toContain(VALUE);
    } finally {
      await session.close();
    }
  });
});
