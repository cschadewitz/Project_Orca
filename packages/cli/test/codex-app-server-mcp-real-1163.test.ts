/**
 * The agent's MCP servers on the app-server route (#1163), against the real pinned
 * `codex app-server` and the shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex
 * (skipped otherwise). The server is a small stdio MCP server whose one tool writes a file and
 * is annotated read-only, which Codex's own approval would let through:
 *
 * - each call still reaches ORCA's policy as `<server>: <tool>`, once per call; an allowed
 *   call runs and a declined one does not;
 * - the server's environment reaches it from thread/start, and nothing of it is written to
 *   Codex's home;
 * - an MCP server in Codex's own config refuses the session;
 * - a server that cannot start is reported, not silent.
 */
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger, type OrcaError } from "@orca/core";
import {
  LocalHost,
  openCodexAppServerSession,
  type CodexMcpServerStatus,
  type OpenCodexAppServerSessionOptions,
} from "@orca/agents";
import { modelStandIn, script, type ModelStandIn, type Step } from "./codex-model-stand-in.js";

type AskRequest = Parameters<NonNullable<OpenCodexAppServerSessionOptions["askPermission"]>>[0];

const CODEX = process.env.ORCA_CODEX_BIN;
/** A synthetic value for the server's environment: never a real secret. */
const SENTINEL = "orca-1163-sentinel-value";

/** A stdio MCP server with one tool, `touch`, annotated read-only, that writes its file and the server's env value. */
const SERVER = `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize")
    out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "touch", version: "1" } } });
  else if (m.method === "tools/list")
    out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", description: "write a file", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } }] } });
  else if (m.method === "tools/call") {
    writeFileSync(m.params.arguments.file, process.env.ORCA_1163_SERVER_VALUE ?? "");
    out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
  } else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

describe.skipIf(!CODEX)("the agent's MCP servers against the real pinned Codex", () => {
  let model: ModelStandIn;
  let root: string;
  let workspace: string;
  let codexHome: string;
  let server: string;
  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(() => model?.server.close());
  const configToml = (more: string[] = []) =>
    [
      `model = "gpt-5.5"`,
      `model_provider = "standin"`,
      `[model_providers.standin]`,
      `name = "standin"`,
      `base_url = "${model.url}"`,
      `wire_api = "responses"`,
      `env_key = "ORCA_1163_KEY"`,
      ...more,
    ].join("\n") + "\n";
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1163-")));
    workspace = join(root, "work");
    codexHome = join(root, "codex-home");
    server = join(root, "mcp-touch.mjs");
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(join(codexHome, "config.toml"), configToml());
    await writeFile(server, SERVER);
    model.outputs.length = 0;
    onTestFailed(() => console.error(`tool outputs Codex sent the model:\n${model.outputs.join("\n")}`));
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const touch = (file: string): Step => ({ tool: "touch", namespace: "mcp__t", args: { file } });
  const open = (
    answer: (req: AskRequest) => string | undefined,
    more: Partial<OpenCodexAppServerSessionOptions> = {},
    command = process.execPath,
  ) => {
    const asked: AskRequest[] = [];
    const statuses: CodexMcpServerStatus[] = [];
    const opened = openCodexAppServerSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: CODEX,
        driver: "codex-app-server",
        env: {
          CODEX_HOME: codexHome,
          ORCA_1163_KEY: "sk-orca-1163-test",
          NO_PROXY: "127.0.0.1",
          no_proxy: "127.0.0.1",
        },
        permissions: { default: "ask" },
        mcpServers: [{ name: "t", command, args: [server], env: { ORCA_1163_SERVER_VALUE: SENTINEL } }],
      }),
      cwd: workspace,
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      logger: silentLogger,
      askPermission: async (req) => (asked.push(req), answer(req)),
      onMcpServerStatus: (status) => statuses.push(status),
      ...more,
    });
    return { opened, asked, statuses };
  };
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  /** Every file under `dir`, for a search of what Codex wrote. */
  const files = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { withFileTypes: true, recursive: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));

  it("asks ORCA's policy for each read-only-annotated call; an allowed one runs, a declined one does not", async () => {
    const allowed = join(workspace, "allowed.txt");
    const declined = join(workspace, "declined.txt");
    const s = open((req) => ((req.toolCall.rawInput as { file: string }).file === allowed ? "accept" : "decline"));
    const session = await s.opened;
    try {
      const turn = await session.prompt(script(touch(allowed), touch(allowed), touch(declined)), { timeoutMs: 60_000 });
      expect(turn.stopReason).toBe("end_turn");
    } finally {
      await session.close();
    }
    expect(s.asked.map((r) => r.toolCall.title)).toEqual(["t: touch", "t: touch", "t: touch"]);
    expect(s.asked[0]!.toolCall).toMatchObject({ kind: "other", rawInput: { file: allowed } });
    // the server ran with the env ORCA gave it, and only for the allowed calls
    expect(await readFile(allowed, "utf8")).toBe(SENTINEL);
    expect(await exists(declined)).toBe(false);
    expect(s.statuses).toContainEqual({ server: "t", status: "ready" });
    // Codex kept the server's environment in memory only
    // (Codex's own background work, such as a plugin clone, can remove a temporary file while it
    // is listed: one gone by the time it is read held nothing to check.)
    for (const file of await files(codexHome)) {
      const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return "";
        throw e;
      });
      expect(text, file).not.toContain(SENTINEL);
    }
  });

  it("refuses the session when Codex's own config adds an MCP server", async () => {
    await writeFile(
      join(codexHome, "config.toml"),
      configToml([`[mcp_servers.own]`, `command = "${process.execPath}"`, `args = ["${server}"]`]),
    );
    const error = await open(() => "accept").opened.then(
      () => expect.unreachable("the session opened"),
      (e: unknown) => e as OrcaError,
    );
    expect(error.message).toContain("Codex's config adds the MCP server own");
  });

  it("reports a server that cannot start", async () => {
    const s = open(() => "accept", {}, join(root, "no-such-server"));
    const session = await s.opened;
    try {
      await expect
        .poll(() => s.statuses.find((st) => st.status === "failed"), { timeout: 20_000 })
        .toMatchObject({ server: "t", error: expect.stringMatching(/No such file or directory/) });
    } finally {
      await session.close();
    }
  });
});
