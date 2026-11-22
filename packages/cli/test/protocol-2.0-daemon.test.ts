/**
 * The CLI's daemon paths against a shipped 2.0 daemon (#880 review on #899). `orca ping` and
 * `orca agents` shake hands before `agents.ping` / `agents.list`; a 2.1 CLI that offered its
 * own minor was refused by v0.7.0 and silently fell back to a local ping or lost discovered
 * models. The daemon here applies v0.7.0's hello check and answers with the captured v0.7.0
 * hello (`packages/app/test/fixtures/protocol-2.0-hello.json`), with `agents.*` added to its
 * method list as a daemon with an agent registry advertises them.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentsListResultSchema,
  AgentsPingResultSchema,
  CLIENT_PROTOCOL,
  isCompatible,
  type ProtocolVersion,
} from "@orca/protocol";
import { commands, type CommandContext } from "../src/commands/index.js";

interface Wire {
  response: { ok: true; result: { protocol: ProtocolVersion; methods: string[] } };
}
const wire: Wire = JSON.parse(
  await readFile(new URL("../../app/test/fixtures/protocol-2.0-hello.json", import.meta.url), "utf8"),
);
const V070 = { major: 2, minor: 0 };
const asOf = "2026-11-22T00:00:00.000Z";
const agent = {
  id: "coder",
  hostId: "local",
  hostType: "local",
  roles: ["build"],
  state: "ok",
  consecutiveFailures: 0,
  models: ["m-1", "m-2"],
};

let server: Server;
let port: number;
const seen: { method: string; protocol?: ProtocolVersion }[] = [];
const dirs: string[] = [];

beforeEach(async () => {
  vi.stubEnv("ORCA_DAEMON_TOKEN", undefined);
  vi.stubEnv("ORCA_DAEMON_TOKEN_FILE", undefined);
  vi.stubEnv("ORCA_DAEMON_URL", undefined);
  seen.length = 0;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: unknown;
        method: string;
        params: { protocol?: ProtocolVersion };
      };
      seen.push({ method, ...(params.protocol ? { protocol: params.protocol } : {}) });
      const answer = (result: unknown) => ({ kind: "response", id, ok: true, result });
      let reply: unknown;
      if (method === "hello")
        reply = isCompatible(params.protocol!, V070)
          ? answer({
              ...wire.response.result,
              methods: [...wire.response.result.methods, "agents.list", "agents.ping"],
            })
          : {
              kind: "response",
              id,
              ok: false,
              error: { code: "NOT_SUPPORTED", message: "client speaks a newer protocol than 2.0" },
            };
      else if (method === "agents.ping") reply = answer({ agent, ok: true, roundTripMs: 7, asOf });
      else if (method === "agents.list")
        reply = answer({ agents: [agent], claims: [], asOf: "2026-11-22T00:00:00.000Z" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  port = address.port;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function context(positionals: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "orca-cli-v070-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "orca.config.yaml"),
    [
      "version: 1",
      "workflows: []",
      "templates: []",
      "hosts:",
      "  - { id: local, type: local }",
      "agents:",
      "  - { id: coder, hostId: local, roles: [build], command: /bin/false, args: [--acp] }",
      "",
    ].join("\n"),
  );
  const lines: string[] = [];
  const ctx: CommandContext & { lines: string[] } = {
    cwd: dir,
    positionals,
    flags: { port: String(port) },
    lines,
    out: (line: string) => void lines.push(line),
    err: () => {},
  };
  return ctx;
}

describe("CLI against a shipped 2.0 daemon", () => {
  it("answers agents.* with views the protocol schemas accept", () => {
    expect(AgentsPingResultSchema.safeParse({ agent, ok: true, roundTripMs: 7, asOf }).error?.issues).toBeUndefined();
    expect(
      AgentsListResultSchema.safeParse({ agents: [agent], claims: [], asOf: "2026-11-22T00:00:00.000Z" }).success,
    ).toBe(true);
  });

  it("offers the client protocol, which v0.7.0 accepts", () => {
    expect(isCompatible(CLIENT_PROTOCOL, V070)).toBe(true);
  });

  it("orca ping is recorded by the daemon, not run locally", async () => {
    const ctx = await context(["coder"]);
    expect(await commands.ping!.run(ctx)).toBe(0);
    expect(seen).toEqual([{ method: "hello", protocol: CLIENT_PROTOCOL }, { method: "agents.ping" }]);
    expect(ctx.lines.join("\n")).toContain("recorded by the daemon at");
  });

  it("orca agents shows the models the daemon discovered", async () => {
    const ctx = await context([]);
    expect(await commands.agents!.run(ctx)).toBe(0);
    expect(seen.map((s) => s.method)).toEqual(["hello", "agents.list"]);
    expect(ctx.lines.join("\n")).toContain("models discovered: m-1, m-2");
  });
});
