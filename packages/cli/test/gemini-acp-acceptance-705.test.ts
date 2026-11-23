/**
 * ORCA driving the real Gemini CLI over ACP (#705, tiers A and B), with a scripted local
 * stand-in for the Gemini API (`GOOGLE_GEMINI_BASE_URL`), so no account, key or model spend
 * is involved. `gemini-acp-acceptance.yml` installs the pinned CLI and runs this with
 * `ORCA_GEMINI_CLI` set to its entry point; without it there is nothing to run.
 *
 * The stand-in is told what to call by the prompt (`SCRIPT:` and a base64 list of tool calls)
 * and plays step k once k tool results have come back. Each effect is a file a shell call
 * writes in the workspace, read independently of anything Gemini or ORCA reports.
 *
 * ORCA installs no hook in Gemini. What is observed is the part ORCA can and cannot see:
 * - **Connectivity (tier A)**: the qualified version opens an ORCA session with Gemini's own
 *   home, streams the turn, is cancelled while it waits on ORCA, and closes.
 * - **Approvals (tier B)**: a shell call asks ORCA; an ORCA allow runs it once, answered with
 *   Gemini's one-time option, so the next call asks again; a deny, a person's refusal and a
 *   cancelled ask do not run it. An edit to an existing file goes through ORCA's own file
 *   boundary (`fs/*`); creating a new file there fails today (a known gap, pinned).
 * - **Outside ORCA (pinned, so a change is noticed)**: read-only tools never ask; "Allow for
 *   this session" covers every later call with the same command prefix; an "always allow"
 *   policy saved in the user's Gemini home, or `--yolo` in a trusted workspace, runs calls
 *   ORCA never hears about (an untrusted workspace keeps Gemini in its default mode).
 *   These are what `geminiCliFindings` reports.
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
  GEMINI_CLI_AGENT_NAME,
  LocalHost,
  geminiCliFindings,
  geminiCliLaunch,
  geminiCliSupport,
  openAcpSession,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";

const GEMINI = process.env["ORCA_GEMINI_CLI"];
type PermissionRequest = Parameters<NonNullable<OpenSessionOptions["askPermission"]>>[0];

/* ------------------------------ the model stand-in ------------------------------ */

type Step = { tool: string; args?: Record<string, unknown> };

/**
 * A Gemini API endpoint that plays the `SCRIPT:` in the prompt. `hold` makes it answer the
 * next model call only when released, so a turn can be cancelled while it is in flight.
 */
function modelStandIn(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const request = (body ? JSON.parse(body) : {}) as {
        contents?: { parts?: { text?: string; functionResponse?: unknown }[] }[];
      };
      if (req.url?.includes(":countTokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ totalTokens: 1 }));
        return;
      }
      const contents = request.contents ?? [];
      const scripts = [...JSON.stringify(contents).matchAll(/SCRIPT: ([A-Za-z0-9+/=]+)/g)];
      const script = scripts.length
        ? (JSON.parse(Buffer.from(scripts[scripts.length - 1]![1]!, "base64").toString("utf8")) as Step[])
        : [];
      // Step k is played after k tool results, counted from the last prompt on.
      const lastPrompt = contents.findLastIndex((c) => (c.parts ?? []).some((p) => p.text?.includes("SCRIPT: ")));
      const results = contents
        .slice(Math.max(0, lastPrompt))
        .flatMap((c) => c.parts ?? [])
        .filter((p) => p.functionResponse !== undefined).length;
      const step = script[results];
      const parts = step ? [{ functionCall: { name: step.tool, args: step.args ?? {} } }] : [{ text: "done" }];
      const chunk = {
        candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
      if (req.url?.includes("streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(chunk)}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(chunk));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

const script = (...steps: Step[]) => `SCRIPT: ${Buffer.from(JSON.stringify(steps)).toString("base64")}`;
const shell = (command: string): Step => ({ tool: "run_shell_command", args: { command } });

/* ---------------------------------- the setup ---------------------------------- */

describe.skipIf(GEMINI === undefined)("ORCA and the real Gemini CLI (#705)", () => {
  let model: { server: Server; url: string };
  let root: string;
  let workspace: string;
  let home: string;

  beforeAll(async () => {
    model = await modelStandIn();
  });

  afterAll(async () => {
    model.server.close();
    await once(model.server, "close").catch(() => undefined);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orca-705-gemini-"));
    workspace = join(root, "work");
    home = join(root, "gemini-home");
    await mkdir(workspace);
    await mkdir(home);
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** The launch profile, run by this Node against the installed CLI, pointed at the stand-in. */
  const agent = (permissions: unknown = { rules: [] }, extraArgs: string[] = []) => {
    const launch = geminiCliLaunch({ home });
    return AgentSpecSchema.parse({
      id: "gemini",
      command: process.execPath,
      args: [GEMINI, ...launch.args, ...extraArgs],
      env: {
        ...launch.env,
        GOOGLE_GEMINI_BASE_URL: model.url,
        GEMINI_API_KEY: "orca-705-test",
        // One model, so Gemini's model router does not call the stand-in first.
        GEMINI_MODEL: "gemini-2.5-pro",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
      permissions,
    });
  };

  const exists = (name: string) =>
    readFile(join(workspace, name), "utf8").then(
      (t) => t,
      () => undefined,
    );

  /** Every decision ORCA made on a permission request, in order. */
  let decisions: string[] = [];
  /** Every ask that reached the person, with the options it carried. */
  let asks: PermissionRequest[] = [];
  let answer: OpenSessionOptions["askPermission"];
  const refuse: NonNullable<OpenSessionOptions["askPermission"]> = async (req) =>
    req.options.find((o) => o.kind === "reject_once")?.optionId;

  const open = (permissions?: unknown, extraArgs?: string[]): Promise<AgentSession> => {
    decisions = [];
    asks = [];
    return openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(permissions, extraArgs),
      cwd: workspace,
      askPermission: async (req, inv) => {
        asks.push(req);
        return (answer ?? refuse)(req, inv);
      },
      onPermission: (p) => decisions.push(p.decision),
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });
  };

  const ALLOW_MARK = { match: { kind: "execute", titlePattern: "^echo orca-705 >> " }, decision: "allow" };

  /* ------------------------------ tier A: connectivity ------------------------------ */

  it("runs a version and platform ORCA has qualified, and its launch profile has no findings", async () => {
    const pkg = JSON.parse(await readFile(join(GEMINI!, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(geminiCliSupport({ name: GEMINI_CLI_AGENT_NAME, version: pkg.version })).toBeDefined();
    const a = agent();
    expect(geminiCliFindings({ command: "gemini", args: a.args, env: a.env })).toEqual([]);
  });

  it("opens a session, streams the turn and closes", async () => {
    const session = await open();
    const chunks: string[] = [];
    session.onUpdate((e) => {
      if (e.raw.sessionUpdate === "agent_message_chunk" && e.raw.content.type === "text")
        chunks.push(e.raw.content.text);
    });
    try {
      const turn = await session.prompt(script());
      expect(turn.stopReason).toBe("end_turn");
      expect(chunks.join("")).toBe("done");
    } finally {
      await session.close();
    }
  }, 120_000);

  it("cancels a turn that is waiting on ORCA, and the call does not run", async () => {
    let asked!: () => void;
    const waiting = new Promise<void>((r) => (asked = r));
    answer = () => {
      asked();
      return new Promise(() => {});
    };
    const session = await open();
    try {
      const turn = session.prompt(script(shell("echo cancelled >> cancelled.txt")));
      await waiting;
      await session.cancel();
      expect((await turn).stopReason).toBe("cancelled");
      expect(await exists("cancelled.txt")).toBeUndefined();
    } finally {
      answer = undefined;
      await session.close();
    }
  }, 120_000);

  /* ------------------------------ tier B: approvals ------------------------------ */

  it("runs a call ORCA allows once, with Gemini's one-time option, and asks again for the next", async () => {
    const session = await open({ rules: [ALLOW_MARK] });
    try {
      await session.prompt(script(shell("echo orca-705 >> allowed.txt"), shell("echo orca-705 >> allowed.txt")));
      expect(await exists("allowed.txt")).toBe("orca-705\norca-705\n");
      // Two asks, both allowed by the rule: the first did not become a Gemini session grant.
      expect(decisions).toEqual(["allow", "allow"]);
      expect(asks).toEqual([]);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("does not run a call a rule denies, or one the person refuses", async () => {
    const session = await open({
      rules: [{ match: { kind: "execute", titlePattern: "^echo denied" }, decision: "deny" }],
    });
    try {
      await session.prompt(script(shell("echo denied >> denied.txt"), shell("echo refused >> refused.txt")));
      expect(await exists("denied.txt")).toBeUndefined();
      expect(await exists("refused.txt")).toBeUndefined();
      expect(decisions).toEqual(["deny", "ask:reject_once"]);
      // What Gemini offers on a shell call: ORCA's engine shows a person only the one-time pair.
      expect(asks.map((a) => a.options.map((o) => `${o.optionId}:${o.kind}`))).toEqual([
        ["proceed_always:allow_always", "proceed_once:allow_once", "cancel:reject_once"],
      ]);
      expect(asks[0]!.toolCall).toMatchObject({ kind: "execute", title: "echo refused >> refused.txt" });
    } finally {
      await session.close();
    }
  }, 120_000);

  it("edits an existing file through ORCA's file boundary, after ORCA allows it", async () => {
    await writeFile(join(workspace, "edited.txt"), "before");
    let wrote = 0;
    const session = await open({ rules: [{ match: { kind: "edit", scope: "workspace" }, decision: "allow" }] });
    session.onUpdate((e) => {
      if (e.raw.sessionUpdate === "tool_call_update" && e.raw.status === "completed") wrote++;
    });
    try {
      await session.prompt(
        script({ tool: "write_file", args: { file_path: join(workspace, "edited.txt"), content: "orca-705" } }),
      );
      expect(await exists("edited.txt")).toBe("orca-705");
      // Gemini reads the file through ORCA, asks, then reads and writes it through ORCA,
      // each file operation decided by ORCA's policy on its own (#703).
      expect(decisions).toEqual(["fs:allow", "allow", "fs:allow", "fs:allow"]);
      expect(wrote).toBe(1);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("cannot create a new file through ORCA's file boundary yet (known gap)", async () => {
    // Gemini reads a file through ORCA to see whether it exists, and takes only a
    // "Resource not found" answer as missing. ORCA answers a missing file with a generic
    // internal error today, so the write fails before Gemini asks. When ORCA answers with
    // ACP's not-found error this test fails, and the coverage page's gap row goes.
    const failures: string[] = [];
    const session = await open({ rules: [{ match: { kind: "edit", scope: "workspace" }, decision: "allow" }] });
    session.onUpdate((e) => {
      if (e.raw.sessionUpdate === "tool_call_update" && e.raw.status === "failed")
        failures.push(JSON.stringify(e.raw.content ?? []));
    });
    try {
      await session.prompt(
        script({ tool: "write_file", args: { file_path: join(workspace, "new.txt"), content: "orca-705" } }),
      );
      expect(await exists("new.txt")).toBeUndefined();
      // The existence checks reached ORCA and were allowed; nothing was asked or written.
      expect(decisions).toEqual(["fs:allow", "fs:allow"]);
      expect(failures).toEqual([expect.stringContaining("Error checking existing file: Internal error")]);
    } finally {
      await session.close();
    }
  }, 120_000);

  /* ------------------------- outside ORCA, pinned so a change shows ------------------------- */

  it("runs read-only tools without asking ORCA", async () => {
    await writeFile(join(workspace, "seen.txt"), "x");
    const session = await open();
    const ran: string[] = [];
    session.onUpdate((e) => {
      if (e.raw.sessionUpdate === "tool_call_update" && e.raw.status === "completed") ran.push(e.raw.toolCallId);
    });
    try {
      await session.prompt(
        script(
          { tool: "list_directory", args: { dir_path: "." } },
          { tool: "glob", args: { pattern: "*.txt" } },
          { tool: "read_file", args: { file_path: join(workspace, "seen.txt") } },
        ),
      );
      expect(ran.map((id) => id.split("__")[0])).toEqual(["list_directory", "glob", "read_file"]);
      expect(decisions).toEqual([]);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("stops asking for the whole command prefix once a person picks Gemini's session option", async () => {
    answer = async (req) => req.options.find((o) => o.optionId === "proceed_always")?.optionId;
    const session = await open();
    try {
      await session.prompt(script(shell("echo first >> first.txt"), shell("echo second >> second.txt")));
      expect(await exists("first.txt")).toBe("first\n");
      expect(await exists("second.txt")).toBe("second\n");
      // Only the first call reached ORCA.
      expect(decisions).toEqual(["ask:allow_always"]);
    } finally {
      answer = undefined;
      await session.close();
    }
  }, 120_000);

  it("runs calls ORCA never hears about under a policy saved in the user's Gemini home", async () => {
    await mkdir(join(home, ".gemini", "policies"), { recursive: true });
    await writeFile(
      join(home, ".gemini", "policies", "auto-saved.toml"),
      [
        "[[rule]]",
        'decision = "allow"',
        "priority = 950",
        'toolName = "run_shell_command"',
        'commandPrefix = [ "echo" ]',
        "allowRedirection = true",
        "",
      ].join("\n"),
    );
    const session = await open();
    try {
      await session.prompt(script(shell("echo saved >> saved.txt")));
      expect(await exists("saved.txt")).toBe("saved\n");
      expect(decisions).toEqual([]);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("keeps asking ORCA in YOLO mode while the workspace is untrusted, and stops once it is trusted", async () => {
    const untrusted = await open(undefined, ["--yolo"]);
    try {
      await untrusted.prompt(script(shell("echo yolo >> untrusted.txt")));
      expect(await exists("untrusted.txt")).toBeUndefined();
      expect(decisions).toEqual(["ask:reject_once"]);
    } finally {
      await untrusted.close();
    }
    const trusted = await open(undefined, ["--yolo", "--skip-trust"]);
    try {
      await trusted.prompt(script(shell("echo yolo >> trusted.txt")));
      expect(await exists("trusted.txt")).toBe("yolo\n");
      expect(decisions).toEqual([]);
    } finally {
      await trusted.close();
    }
    const a = agent(undefined, ["--yolo", "--skip-trust"]);
    expect(geminiCliFindings({ command: "gemini", args: a.args, env: a.env })).toEqual([
      expect.objectContaining({ id: "yolo", effect: "bypass" }),
      expect.objectContaining({ id: "trusted-workspace" }),
    ]);
  }, 120_000);
});
