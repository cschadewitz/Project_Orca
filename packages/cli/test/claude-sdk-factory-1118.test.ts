/**
 * The session factory's route for `driver: claude-agent-sdk` (#1118, #1120): the launch checks
 * run, then a Claude Agent SDK session opens, and the ACP opener is never called.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import { LocalHost, type AgentHost, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import { makeSessionFactory } from "../src/bootstrap.js";

const STAND_IN = fileURLToPath(new URL("../../agents/test/fixtures/claude-sdk-stand-in.mjs", import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-factory-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function factoryWithSpy() {
  const open = vi.fn<(o: OpenSessionOptions) => Promise<AgentSession>>(() => Promise.reject(new Error("ACP opened")));
  return { open, factory: makeSessionFactory({ configDir: dir, storeDir: ".orca" }, open) };
}

describe.runIf(process.platform !== "win32")("session factory, driver: claude-agent-sdk (#1118)", () => {
  it("checks the person's claude and opens a Claude Agent SDK session, without opening ACP", async () => {
    const claude = join(dir, "claude");
    await writeFile(
      claude,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'; exit 0; fi
exec "${process.execPath}" "${STAND_IN}" "$@"
`,
    );
    await chmod(claude, 0o755);
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", driver: "claude-agent-sdk", command: claude });
    const session = await factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: dir });
    try {
      expect(session.agentId).toBe("claude");
      expect((await session.prompt("hello")).stopReason).toBe("end_turn");
    } finally {
      await session.close();
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses the session when claude is not signed in, before starting it", async () => {
    const claude = join(dir, "claude");
    await writeFile(
      claude,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
echo '{"loggedIn":false}'; exit 1
`,
    );
    await chmod(claude, 0o755);
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", driver: "claude-agent-sdk", command: claude });
    await expect(factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: dir })).rejects.toThrow(
      /claude auth login/,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses an agent on another host before running anything there", async () => {
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", driver: "claude-agent-sdk", hostId: "box" });
    const host = { id: "box", spec: { id: "box", type: "ssh" } } as unknown as AgentHost;
    await expect(factory({ host, agent, cwd: dir })).rejects.toThrow(/only on ORCA's own machine for now \(#1130\)/);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens an agent without the driver exactly as before", async () => {
    const { open, factory } = factoryWithSpy();
    const agent = AgentSpecSchema.parse({ id: "claude", command: "claude-agent-acp" });
    await expect(factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: dir })).rejects.toThrow(
      "ACP opened",
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});
