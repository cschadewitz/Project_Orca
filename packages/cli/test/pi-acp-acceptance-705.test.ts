/**
 * ORCA driving the real pi through the `pi-acp` adapter (#705, tier A), with a scripted
 * local stand-in for the model (an OpenAI-compatible chat completions endpoint, set up as a
 * custom provider in pi's own agent directory), so no account, key or model spend is involved.
 * `pi-acp-acceptance.yml` installs the pinned adapter and pi and runs this with
 * `ORCA_PI_ACP` (the adapter's entry point), `ORCA_PI` (the pi executable) and `ORCA_PI_VERSION`
 * set; without them
 * there is nothing to run.
 *
 * The stand-in plays the `SCRIPT:` in the prompt (a base64 list of tool calls), step k after k
 * tool results. Each effect is a file a call writes, read independently of anything pi or ORCA
 * reports.
 *
 * What is observed (pi is connectivity tested; none of its tool calls is an ORCA approval, so
 * an OS sandbox is required to run it):
 * - **Connectivity (tier A)**: the qualified adapter opens an ORCA session with its own agent
 *   directory, streams the turn, is cancelled during a running command, and closes.
 * - **Observed outside ORCA**: pi runs shell commands and file writes without asking ORCA,
 *   even under a policy that denies everything, and writes ORCA's own files; nothing reaches
 *   ORCA's `fs/*` boundary. This is what `piFindings` reports for every pi agent.
 * - **Extension dialogs**: a pi extension's `ctx.ui.confirm` reaches ORCA as a permission
 *   request on a synthetic `pi-ui-*` call of kind `other`; ORCA's answer is passed to the
 *   extension, which decides. This is not an ORCA tool approval.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import {
  LocalHost,
  PI_ACP_AGENT_NAME,
  PI_ACP_SUPPORT,
  openAcpSession,
  piAcpLaunch,
  piAcpSupport,
  piFindings,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";

const ADAPTER = process.env["ORCA_PI_ACP"];
const PI = process.env["ORCA_PI"];
/** The version of the pi at `ORCA_PI`, as the workflow installed it. */
const PI_VERSION = process.env["ORCA_PI_VERSION"];
type PermissionRequest = Parameters<NonNullable<OpenSessionOptions["askPermission"]>>[0];

/* ------------------------------ the model stand-in ------------------------------ */

type Step = { tool: string; args?: Record<string, unknown> };

/** A chat completions endpoint that plays the `SCRIPT:` in the latest prompt. */
function modelStandIn(): Promise<{ server: Server; url: string }> {
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const request = (body ? JSON.parse(body) : {}) as {
        model?: string;
        messages?: { role: string; content?: unknown }[];
      };
      const messages = request.messages ?? [];
      const scripts = [...JSON.stringify(messages).matchAll(/SCRIPT: ([A-Za-z0-9+/=]+)/g)];
      const script = scripts.length
        ? (JSON.parse(Buffer.from(scripts[scripts.length - 1]![1]!, "base64").toString("utf8")) as Step[])
        : [];
      const lastPrompt = messages.findLastIndex(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("SCRIPT: "),
      );
      const results = messages.slice(Math.max(0, lastPrompt)).filter((m) => m.role === "tool").length;
      const step = script[results];
      const id = ++n;
      const send = (o: Record<string, unknown>) =>
        res.write(
          `data: ${JSON.stringify({ id: `c${id}`, object: "chat.completion.chunk", created: 0, model: request.model, ...o })}\n\n`,
        );
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (step) {
        const call = {
          index: 0,
          id: `call_${id}`,
          type: "function",
          function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
        };
        send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ choices: [{ index: 0, delta: { role: "assistant", content: "done" } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }),
    ),
  );
}

const script = (...steps: Step[]) => `SCRIPT: ${Buffer.from(JSON.stringify(steps)).toString("base64")}`;
const bash = (command: string): Step => ({ tool: "bash", args: { command } });

/** A pi extension that asks before every `bash` call and blocks the call unless confirmed. */
const CONFIRMING_EXTENSION = `export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const ok = await ctx.ui.confirm("Run this command?", String(event.input.command));
    if (!ok) return { block: true, reason: "refused" };
  });
}
`;

/* ---------------------------------- the setup ---------------------------------- */

describe.skipIf(ADAPTER === undefined || PI === undefined || PI_VERSION === undefined)(
  "ORCA and the real pi (#705)",
  () => {
    let model: { server: Server; url: string };
    let root: string;
    let workspace: string;
    let agentDir: string;

    beforeAll(async () => {
      model = await modelStandIn();
    });

    afterAll(async () => {
      model.server.close();
      await once(model.server, "close").catch(() => undefined);
    });

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "orca-705-pi-"));
      workspace = join(root, "work");
      agentDir = join(root, "pi-agent");
      await mkdir(workspace);
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            standin: {
              baseUrl: model.url,
              api: "openai-completions",
              apiKey: "orca-705-test",
              models: [{ id: "standin-1" }],
            },
          },
        }),
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "standin", defaultModel: "standin-1" }),
      );
      return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    const agent = (permissions: unknown = { rules: [] }) => {
      const launch = piAcpLaunch({ agentDir, pi: PI! });
      return AgentSpecSchema.parse({
        id: "pi",
        command: process.execPath,
        args: [ADAPTER, ...launch.args],
        env: { ...launch.env, HOME: root, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
        permissions,
      });
    };

    const exists = (path: string) =>
      readFile(path, "utf8").then(
        (t) => t,
        () => undefined,
      );

    let decisions: string[] = [];
    let asks: PermissionRequest[] = [];

    const open = (
      permissions?: unknown,
      answer?: (req: PermissionRequest) => string | undefined,
    ): Promise<AgentSession> => {
      decisions = [];
      asks = [];
      return openAcpSession({
        host: new LocalHost({ id: "local", type: "local" }),
        agent: agent(permissions),
        cwd: workspace,
        askPermission: async (req) => {
          asks.push(req);
          return answer?.(req);
        },
        onPermission: (p) => decisions.push(p.decision),
        logger: silentLogger,
        handshakeTimeoutMs: 60_000,
      });
    };

    /* ------------------------------ tier A: connectivity ------------------------------ */

    it("runs an adapter and pi ORCA has qualified, and the launch profile says pi never asks", async () => {
      const adapter = JSON.parse(await readFile(join(ADAPTER!, "..", "..", "package.json"), "utf8")) as {
        version: string;
      };
      const entry = piAcpSupport({ name: PI_ACP_AGENT_NAME, version: adapter.version });
      expect(entry).toBeDefined();
      // The pi the workflow installed is the one paired with that adapter version.
      expect(PI_ACP_SUPPORT).toContainEqual(expect.objectContaining({ version: adapter.version, pi: PI_VERSION }));
      const a = agent();
      expect(piFindings({ command: "pi-acp", args: a.args, env: a.env }).map((f) => f.id)).toEqual(["pi-never-asks"]);
    });

    it("opens a session, streams the turn and closes", async () => {
      const session = await open();
      const chunks: string[] = [];
      session.onUpdate((e) => {
        if (e.raw.sessionUpdate === "agent_message_chunk" && e.raw.content.type === "text")
          chunks.push(e.raw.content.text);
      });
      try {
        expect((await session.prompt(script())).stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("done");
      } finally {
        await session.close();
      }
    }, 120_000);

    it("cancels a turn while a command runs, and the command is stopped", async () => {
      const session = await open();
      let started!: () => void;
      const running = new Promise<void>((r) => (started = r));
      session.onUpdate((e) => {
        if (e.raw.sessionUpdate === "tool_call_update" && e.raw.status === "in_progress") started();
      });
      try {
        const turn = session.prompt(script(bash(`sleep 3; echo late >> ${join(workspace, "late.txt")}`)));
        await running;
        await session.cancel();
        expect((await turn).stopReason).toBe("cancelled");
        await new Promise((r) => setTimeout(r, 4_000));
        expect(await exists(join(workspace, "late.txt"))).toBeUndefined();
      } finally {
        await session.close();
      }
    }, 120_000);

    /* ------------------------ observed: nothing asks ORCA ------------------------ */

    it("runs a shell command without asking ORCA, under a policy that denies everything", async () => {
      const session = await open({ default: "deny", rules: [] });
      try {
        await session.prompt(script(bash(`echo ran >> ${join(workspace, "ran.txt")}`)));
        expect(await exists(join(workspace, "ran.txt"))).toBe("ran\n");
        expect(decisions).toEqual([]);
        expect(asks).toEqual([]);
      } finally {
        await session.close();
      }
    }, 120_000);

    it("writes files, ORCA's own included, without ORCA's file boundary", async () => {
      await mkdir(join(workspace, ".orca"));
      const orcaFile = join(workspace, ".orca", "permissions.json");
      const session = await open({ default: "deny", rules: [] });
      try {
        await session.prompt(
          script(
            { tool: "write", args: { path: join(workspace, "written.txt"), content: "pi" } },
            { tool: "write", args: { path: orcaFile, content: "{}" } },
          ),
        );
        expect(await exists(join(workspace, "written.txt"))).toBe("pi");
        expect(await exists(orcaFile)).toBe("{}");
        // Not a permission request and not an fs/* call: ORCA decided nothing.
        expect(decisions).toEqual([]);
      } finally {
        await session.close();
      }
    }, 120_000);

    it("brings an extension's own dialog to ORCA as a kind-other request, and the extension decides", async () => {
      await mkdir(join(agentDir, "extensions"));
      await writeFile(join(agentDir, "extensions", "confirm.js"), CONFIRMING_EXTENSION);
      const refused = await open(undefined, (req) => req.options.find((o) => o.kind === "reject_once")?.optionId);
      try {
        await refused.prompt(script(bash(`echo no >> ${join(workspace, "refused.txt")}`)));
        expect(await exists(join(workspace, "refused.txt"))).toBeUndefined();
        expect(asks).toHaveLength(1);
        expect(asks[0]!.toolCall).toMatchObject({ kind: "other", title: "Run this command?" });
        expect(asks[0]!.toolCall.toolCallId).toMatch(/^pi-ui-/);
        expect(asks[0]!.options.map((o) => `${o.optionId}:${o.kind}`)).toEqual(["yes:allow_once", "no:reject_once"]);
      } finally {
        await refused.close();
      }
      // An ORCA rule for kind `other` answers the extension "yes" with nobody asked.
      const allowed = await open({ rules: [{ match: { kind: "other" }, decision: "allow" }] });
      try {
        await allowed.prompt(script(bash(`echo yes >> ${join(workspace, "allowed.txt")}`)));
        expect(await exists(join(workspace, "allowed.txt"))).toBe("yes\n");
        expect(decisions).toEqual(["allow"]);
        expect(asks).toEqual([]);
      } finally {
        await allowed.close();
      }
    }, 180_000);
  },
);
