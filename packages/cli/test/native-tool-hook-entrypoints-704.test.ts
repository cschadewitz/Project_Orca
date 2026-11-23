/**
 * `nativeToolHook: on` is unavailable in every build ORCA ships (#704), and every entry point
 * that starts agent work refuses such an agent before anything starts: the session factory
 * the daemon and runs use, `openAcpSession` (which `orca ping` calls directly), and remote
 * delegation. Each case here watches for the work itself: a spawned process writing a
 * marker, a host asked to spawn, a remote looked up.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, type AgentSpec } from "@orca/core";
import { LocalHost, openAcpSession, type AgentHost, type OpenSessionOptions } from "@orca/agents";
import { delegatingSessionFactory } from "@orca/daemon";
import { commands, type CommandContext } from "../src/commands/index.js";
import { makeSessionFactory } from "../src/bootstrap.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-704-entry-"));
  dirs.push(dir);
  return dir;
};

/** A port nothing listens on, so `orca ping` finds no daemon and works in its own process. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

const refusal = {
  code: "NOT_SUPPORTED",
  message: expect.stringMatching(/not available in this build yet[\s\S]*nativeToolHook: on/),
};

/** A host that records whether anything asked it to start an agent. */
function watchedHost(): { host: AgentHost; spawned: ReturnType<typeof vi.fn> } {
  const host: AgentHost = new LocalHost({ id: "local", type: "local" });
  const spawned = vi.fn(async () => {
    throw new Error("an agent was started");
  });
  host.spawnAgent = spawned;
  return { host, spawned };
}

describe("nativeToolHook: on is refused at every entry point in a shipped build (#704)", () => {
  it("orca ping: refused, and the agent's program never runs", async () => {
    const dir = await tempDir();
    const marker = join(dir, "started");
    // The agent's "program" only leaves a marker: if it runs at all, the refusal came too late.
    await writeFile(
      join(dir, "agent.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`,
    );
    await writeFile(
      join(dir, "orca.config.yaml"),
      [
        "version: 1",
        "workflows: []",
        "templates: []",
        "agents:",
        "  - id: claude",
        `    command: ${JSON.stringify(process.execPath)}`,
        `    args: [${JSON.stringify(join(dir, "agent.mjs"))}]`,
        "    nativeToolHook: on",
        "",
      ].join("\n"),
      "utf8",
    );
    const ctx: CommandContext = {
      cwd: dir,
      flags: { quiet: true, port: String(await closedPort()) },
      positionals: ["claude"],
      out: () => {},
      err: () => {},
    };
    await expect(commands.ping!.run(ctx)).rejects.toMatchObject(refusal);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("openAcpSession without the factory's hook: refused before the host starts anything", async () => {
    const { host, spawned } = watchedHost();
    const agent = AgentSpecSchema.parse({ id: "claude", command: "claude-agent-acp", nativeToolHook: "on" });
    await expect(openAcpSession({ host, agent, cwd: tmpdir() })).rejects.toMatchObject(refusal);
    expect(spawned).not.toHaveBeenCalled();
  });

  it("the shipped session factory: refused before the base opener is called", async () => {
    const dir = await tempDir();
    const open = vi.fn(async (_: OpenSessionOptions) => {
      throw new Error("a session was opened");
    });
    // No hook argument: exactly as bootstrap builds it for the daemon, runs and agents.ping.
    const factory = makeSessionFactory({ configDir: dir, storeDir: ".orca" }, open);
    const agent = AgentSpecSchema.parse({ id: "claude", command: "claude-agent-acp", nativeToolHook: "on" });
    await expect(factory({ host: watchedHost().host, agent, cwd: dir })).rejects.toMatchObject(refusal);
    expect(open).not.toHaveBeenCalled();
  });

  it("remote delegation: config refuses it, and a spec built another way is refused before any dispatch", async () => {
    const remote = { id: "box", type: "orca-daemon", profile: "box", workflow: "w", nativeToolHook: "on" };
    expect(AgentSpecSchema.safeParse(remote).success).toBe(false);
    const base = vi.fn();
    const remotes = vi.fn(() => []);
    const factory = delegatingSessionFactory(base, {
      remotes,
      configDir: await tempDir(),
      receiptsDir: await tempDir(),
    });
    // Bypassing the schema, as an internal caller could.
    const agent = { ...AgentSpecSchema.parse({ ...remote, nativeToolHook: "off" }), nativeToolHook: "on" } as AgentSpec;
    await expect(factory({ host: watchedHost().host, agent, cwd: tmpdir() })).rejects.toMatchObject(refusal);
    expect(remotes).not.toHaveBeenCalled();
    expect(base).not.toHaveBeenCalled();
  });
});
