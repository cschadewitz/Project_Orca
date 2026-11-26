/**
 * ORCA's `codex app-server` client (#1156) against a scripted peer: the handshake, requests and
 * answers, asks from Codex answered, overload retried with backoff and jitter, timeouts, an
 * unknown Codex version or a missing method refused, and every malformed message closing the
 * connection rather than being guessed at. Plus the stdio line framing.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { OrcaError } from "@orca/core";
import {
  CODEX_APP_SERVER_PINNED,
  CODEX_OVERLOADED,
  CodexAppServerClient,
  CodexRpcError,
  codexVersionFromUserAgent,
  initializeCodexAppServer,
  JSONRPC_METHOD_NOT_FOUND,
  stdioLineTransport,
  type CodexAppServerClientOptions,
  type CodexLineTransport,
} from "../src/index.js";

/** A transport whose other end the test plays. */
function peer() {
  const sent: Record<string, unknown>[] = [];
  let lineListener: (line: string) => void = () => {};
  let closeListener: (error?: Error) => void = () => {};
  let closed = false;
  const waiters: (() => void)[] = [];
  const transport: CodexLineTransport = {
    send(line) {
      sent.push(JSON.parse(line) as Record<string, unknown>);
      for (const w of waiters.splice(0)) w();
    },
    onLine: (l) => void (lineListener = l),
    onClose: (l) => void (closeListener = l),
    close: () => {
      closed = true;
    },
  };
  return {
    transport,
    sent,
    get closed() {
      return closed;
    },
    /** Deliver a raw line from Codex. */
    line: (line: string) => lineListener(line),
    say: (message: unknown) => lineListener(JSON.stringify(message)),
    hangUp: (error?: Error) => closeListener(error),
    /** Wait until ORCA has sent `n` messages in all. */
    async until(n: number) {
      while (sent.length < n) await new Promise<void>((r) => waiters.push(r));
      return sent[n - 1]!;
    },
  };
}

const client = (p: ReturnType<typeof peer>, options: CodexAppServerClientOptions = {}) =>
  new CodexAppServerClient(p.transport, { sleep: async () => {}, ...options });

const INIT_ANSWER = {
  userAgent: "orca/0.171.0 (Ubuntu 24.4.0; x86_64) linux (orca; 0.9.0)",
  codexHome: "/home/u/.codex",
  platformFamily: "unix",
  platformOs: "linux",
};

describe("the handshake", () => {
  it("sends initialize with ORCA's clientInfo and no experimental API, then initialized", async () => {
    const p = peer();
    const c = client(p);
    const done = initializeCodexAppServer(c, { agentId: "codex", orcaVersion: "0.9.0" });
    const init = await p.until(1);
    expect(init).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "orca", title: "ORCA", version: "0.9.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
    p.say({ id: 1, result: INIT_ANSWER });
    await expect(done).resolves.toEqual({
      version: "0.171.0",
      codexHome: "/home/u/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    });
    expect(p.sent[1]).toEqual({ method: "initialized" });
    expect(p.closed).toBe(false);
  });

  it("asks for the experimental API only when told to, and passes the notifications ORCA opts out of", async () => {
    const p = peer();
    const done = initializeCodexAppServer(client(p), {
      agentId: "codex",
      orcaVersion: "0.9.0",
      experimentalApi: true,
      optOutNotificationMethods: ["thread/started"],
    });
    expect((await p.until(1))["params"]).toMatchObject({
      capabilities: { experimentalApi: true, optOutNotificationMethods: ["thread/started"] },
    });
    p.say({ id: 1, result: INIT_ANSWER });
    await done;
  });

  it("refuses a Codex that is not a pinned version, before initialized", async () => {
    for (const userAgent of ["orca/0.170.0 (x)", "orca/0.171.1", "other/0.171.0", "orca/latest", ""]) {
      const p = peer();
      const done = initializeCodexAppServer(client(p), { agentId: "codex", orcaVersion: "0.9.0" });
      await p.until(1);
      p.say({ id: 1, result: { ...INIT_ANSWER, userAgent } });
      const error = (await done.catch((e: unknown) => e)) as OrcaError;
      expect(error.code, userAgent).toBe("NOT_SUPPORTED");
      expect(error.message).toMatch(/ORCA runs this driver only with Codex 0\.171\.0\. Install a supported Codex\./);
      expect(p.sent).toHaveLength(1);
      expect(p.closed).toBe(true);
    }
  });

  it("refuses a pinned Codex whose protocol lacks a method the session needs", async () => {
    const p = peer();
    const done = initializeCodexAppServer(client(p), {
      agentId: "codex",
      orcaVersion: "0.9.0",
      requiredMethods: ["thread/start", "thread/revert", "thread/rollback", "environment/add"],
    });
    await p.until(1);
    p.say({ id: 1, result: INIT_ANSWER });
    await expect(done).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message:
        "agent codex: Codex 0.171.0's app-server protocol has no thread/rollback, environment/add, which this session needs.",
      details: { agentId: "codex", version: "0.171.0", missing: ["thread/rollback", "environment/add"] },
    });
    expect(p.sent).toHaveLength(1);
    expect(p.closed).toBe(true);
  });

  it("refuses an initialize answer that is not the generated shape", async () => {
    for (const result of [null, {}, { ...INIT_ANSWER, codexHome: 1 }, { userAgent: INIT_ANSWER.userAgent }]) {
      const p = peer();
      const done = initializeCodexAppServer(client(p), { agentId: "codex", orcaVersion: "0.9.0" });
      await p.until(1);
      p.say({ id: 1, result });
      await expect(done).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
      expect(p.closed).toBe(true);
    }
  });

  it("reads the version only from ORCA's own prefix", () => {
    expect(codexVersionFromUserAgent("orca/0.171.0 (Ubuntu)")).toBe("0.171.0");
    expect(codexVersionFromUserAgent("orca/0.171.0")).toBe("0.171.0");
    expect(codexVersionFromUserAgent("orca/0.171.0-alpha.1 (x)")).toBeUndefined();
    expect(codexVersionFromUserAgent("orcax/0.171.0")).toBeUndefined();
    expect(Object.keys(CODEX_APP_SERVER_PINNED)).toEqual(["0.171.0"]);
  });
});

describe("requests and answers", () => {
  it("resolves a result and rejects an error answer with its code", async () => {
    const p = peer();
    const c = client(p);
    const ok = c.request("account/read", {});
    const bad = c.request("thread/start", { cwd: "/" });
    await p.until(2);
    p.say({ id: 2, error: { code: -32600, message: "Invalid request", data: { x: 1 } } });
    p.say({ id: 1, result: { account: null, requiresOpenaiAuth: true } });
    await expect(ok).resolves.toEqual({ account: null, requiresOpenaiAuth: true });
    const error = (await bad.catch((e: unknown) => e)) as CodexRpcError;
    expect(error).toBeInstanceOf(CodexRpcError);
    expect([error.code, error.message, error.data]).toEqual([-32600, "Invalid request", { x: 1 }]);
  });

  it("retries an overloaded request with doubling backoff and jitter, within its bound", async () => {
    const p = peer();
    const waits: number[] = [];
    const c = client(p, {
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
      baseBackoffMs: 100,
      maxBackoffMs: 300,
      overloadRetries: 3,
    });
    const r = c.request("account/read", {});
    for (let i = 1; i <= 3; i++) {
      const sent = await p.until(i);
      p.say({ id: sent["id"], error: { code: CODEX_OVERLOADED, message: "Server overloaded; retry later." } });
    }
    const last = await p.until(4);
    expect(last).toMatchObject({ id: 4, method: "account/read" });
    p.say({ id: 4, result: "done" });
    await expect(r).resolves.toBe("done");
    // ceiling 100, 200, 300 (capped), scaled by 0.5 + 0.5/2 = 0.75
    expect(waits).toEqual([75, 150, 225]);
  });

  it("gives up after the last retry with the overload error", async () => {
    const p = peer();
    const c = client(p, { overloadRetries: 1 });
    const r = c.request("account/read", {});
    for (let i = 1; i <= 2; i++) {
      const sent = await p.until(i);
      p.say({ id: sent["id"], error: { code: CODEX_OVERLOADED, message: "busy" } });
    }
    await expect(r).rejects.toMatchObject({ code: CODEX_OVERLOADED });
    expect(p.sent).toHaveLength(2);
  });

  it("does not retry any other error", async () => {
    const p = peer();
    const c = client(p);
    const r = c.request("account/read", {});
    await p.until(1);
    p.say({ id: 1, error: { code: -32603, message: "internal" } });
    await expect(r).rejects.toMatchObject({ code: -32603 });
    expect(p.sent).toHaveLength(1);
  });

  it("times out with the outcome unknown, does not resend, and treats a late answer as a protocol error", async () => {
    vi.useFakeTimers();
    try {
      const p = peer();
      const c = client(p, { requestTimeoutMs: 1000 });
      const r = c.request("turn/start", {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      const error = (await r) as OrcaError;
      expect(error.code).toBe("AGENT_TRANSPORT");
      expect(error.message).toBe(
        "codex app-server did not answer turn/start within 1000 ms; whether it acted on it is unknown",
      );
      expect(p.sent).toHaveLength(1);
      // A late answer is to a request no longer pending: a protocol error, so the connection closes.
      p.say({ id: 1, result: {} });
      expect(c.closed?.code).toBe("AGENT_PROTOCOL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails every pending request when the connection ends, and refuses new ones", async () => {
    const p = peer();
    const onClose = vi.fn();
    const c = client(p, { onClose });
    const a = c.request("account/read", {});
    const b = c.request("model/list", {});
    await p.until(2);
    p.hangUp(new Error("EPIPE"));
    for (const r of [a, b])
      await expect(r).rejects.toMatchObject({
        code: "AGENT_TRANSPORT",
        message: "codex app-server connection closed: EPIPE",
      });
    await expect(c.request("account/read", {})).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("asks and notifications from Codex", () => {
  async function ready(options: CodexAppServerClientOptions = {}) {
    const p = peer();
    const c = client(p, options);
    const done = initializeCodexAppServer(c, { agentId: "codex", orcaVersion: "0.9.0" });
    await p.until(1);
    p.say({ id: 1, result: INIT_ANSWER });
    await done;
    return { p, c };
  }

  it("answers an ask the pinned protocol lists with the handler's result", async () => {
    const onServerRequest = vi.fn(async () => ({ decision: "decline" }));
    const { p } = await ready({ onServerRequest });
    p.say({ id: "s-1", method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    expect(await p.until(3)).toEqual({ id: "s-1", result: { decision: "decline" } });
    expect(onServerRequest).toHaveBeenCalledWith("item/commandExecution/requestApproval", { command: "ls" });
  });

  it("answers a handler's CodexRpcError as an error, and any other throw as an internal error", async () => {
    const onServerRequest = vi.fn(async (method: string) => {
      if (method === "item/tool/requestUserInput") throw new CodexRpcError(-32000, "nobody to ask", { why: 1 });
      throw new Error("secret detail");
    });
    const { p } = await ready({ onServerRequest });
    p.say({ id: 7, method: "item/tool/requestUserInput", params: {} });
    expect(await p.until(3)).toEqual({ id: 7, error: { code: -32000, message: "nobody to ask", data: { why: 1 } } });
    p.say({ id: 8, method: "item/fileChange/requestApproval", params: {} });
    expect(await p.until(4)).toEqual({
      id: 8,
      error: { code: -32603, message: "ORCA could not answer item/fileChange/requestApproval" },
    });
  });

  it("answers an ask the pinned protocol does not list, or with no handler, as not handled", async () => {
    const onServerRequest = vi.fn(async () => ({}));
    const { p } = await ready({ onServerRequest });
    p.say({ id: 9, method: "made/up", params: {} });
    expect(await p.until(3)).toEqual({
      id: 9,
      error: { code: JSONRPC_METHOD_NOT_FOUND, message: "ORCA does not handle made/up" },
    });
    expect(onServerRequest).not.toHaveBeenCalled();
    const bare = await ready();
    bare.p.say({ id: 10, method: "item/tool/call", params: {} });
    expect(await bare.p.until(3)).toMatchObject({ id: 10, error: { code: JSONRPC_METHOD_NOT_FOUND } });
  });

  it("answers every ask before the handshake as not handled", async () => {
    const onServerRequest = vi.fn(async () => ({}));
    const p = peer();
    client(p, { onServerRequest });
    p.say({ id: 1, method: "item/commandExecution/requestApproval", params: {} });
    expect(await p.until(1)).toMatchObject({ id: 1, error: { code: JSONRPC_METHOD_NOT_FOUND } });
    expect(onServerRequest).not.toHaveBeenCalled();
  });

  it("delivers notifications, extra fields and all", async () => {
    const onNotification = vi.fn();
    const p = peer();
    client(p, { onNotification });
    p.say({ method: "configWarning", params: { summary: "s" }, emittedAtMs: 1 });
    p.say({ method: "turn/completed" });
    expect(onNotification.mock.calls).toEqual([
      ["configWarning", { summary: "s" }],
      ["turn/completed", undefined],
    ]);
  });

  it("closes the connection as a protocol error when the notification handler throws", async () => {
    const onClose = vi.fn();
    const p = peer();
    const c = client(p, {
      onNotification: () => {
        throw new Error("cannot read it");
      },
      onClose,
    });
    const pending = c.request("thread/start", {});
    p.say({ method: "item/started", params: {} });
    await expect(pending).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    expect(c.closed?.message).toBe(
      "codex app-server sent a item/started notification ORCA could not read (cannot read it); ORCA closed the connection",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(p.closed).toBe(true);
  });
});

describe("a malformed message closes the connection", () => {
  const cases: [string, string][] = [
    ["not JSON", "{not json"],
    ["an array", "[1]"],
    ["a number", "3"],
    ["a non-string method", JSON.stringify({ method: 3 })],
    ["a fractional request id", JSON.stringify({ id: 1.5, method: "x" })],
    ["neither method nor id", JSON.stringify({ result: 1 })],
    ["a string id answer", JSON.stringify({ id: "1", result: 1 })],
    ["an answer to nothing pending", JSON.stringify({ id: 99, result: 1 })],
    ["both result and error", JSON.stringify({ id: 1, result: 1, error: { code: 1, message: "m" } })],
    ["neither result nor error", JSON.stringify({ id: 1 })],
  ];
  for (const [name, line] of cases)
    it(name, async () => {
      const p = peer();
      const c = client(p);
      const pending = c.request("account/read", {});
      await p.until(1);
      p.line(line);
      await expect(pending).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
      expect(c.closed?.message).toMatch(/ORCA closed the connection$/);
      expect(p.closed).toBe(true);
    });

  it("a malformed error answer fails only that request", async () => {
    const p = peer();
    const c = client(p);
    const r = c.request("account/read", {});
    await p.until(1);
    p.say({ id: 1, error: "nope" });
    await expect(r).rejects.toMatchObject({ code: -32603 });
    expect(c.closed).toBeUndefined();
  });
});

describe("stdio line framing", () => {
  function io(maxLineBytes?: number) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const t = stdioLineTransport({ stdin, stdout }, maxLineBytes === undefined ? {} : { maxLineBytes });
    const lines: string[] = [];
    const closes: (Error | undefined)[] = [];
    t.onLine((l) => lines.push(l));
    t.onClose((e) => closes.push(e));
    return { stdin, stdout, t, lines, closes };
  }

  it("splits lines across and within chunks, drops CR and blank lines, and writes one line per message", async () => {
    const s = io();
    s.stdout.write('{"a":');
    s.stdout.write('1}\r\n\n{"b":"é');
    s.stdout.write(Buffer.from([0xc3]));
    s.stdout.write(Buffer.concat([Buffer.from([0xa9]), Buffer.from('"}\n')]));
    expect(s.lines).toEqual(['{"a":1}', '{"b":"éé"}']);
    s.t.send('{"id":1}');
    expect(String(s.stdin.read())).toBe('{"id":1}\n');
  });

  it("closes with an error on a line longer than the limit", () => {
    const s = io(8);
    s.stdout.write("12345");
    s.stdout.write("6789");
    expect(s.closes).toHaveLength(1);
    expect(s.closes[0]?.message).toBe("codex app-server sent a line longer than 8 bytes");
    s.stdout.write("\n");
    expect(s.lines).toEqual([]);
    expect(() => s.t.send("x")).toThrow(/closed/);
  });

  it("holds a completed line to the limit, delivering nothing from it, however the bytes are split", () => {
    const line = "x".repeat(9);
    const splits = [[line + "\n"], [line.slice(0, 4), line.slice(4) + "\n"], ["xxxxxxxx", "x\n"], ["xxxxxxxxx", "\n"]];
    for (const chunks of splits) {
      const s = io(8);
      s.stdout.write('{"a":1}\n');
      for (const c of chunks) s.stdout.write(c);
      expect(s.lines, JSON.stringify(chunks)).toEqual(['{"a":1}']);
      expect(s.closes).toHaveLength(1);
      expect(s.closes[0]?.message).toBe("codex app-server sent a line longer than 8 bytes");
    }
  });

  it("accepts a line of exactly the limit, whole or split, and counts a CR toward it", () => {
    for (const chunks of [["12345678\n"], ["1234", "5678\n"], ["12345678", "\n"]]) {
      const s = io(8);
      for (const c of chunks) s.stdout.write(c);
      expect(s.lines, JSON.stringify(chunks)).toEqual(["12345678"]);
      expect(s.closes).toEqual([]);
    }
    const crlf = io(8);
    crlf.stdout.write("1234567\r\n");
    expect(crlf.lines).toEqual(["1234567"]);
    const over = io(8);
    over.stdout.write("12345678\r\n");
    expect(over.lines).toEqual([]);
    expect(over.closes).toHaveLength(1);
  });

  it("refuses the rest of a chunk once a line in it is over the limit", () => {
    const s = io(8);
    s.stdout.write('123456789\n{"b":2}\n');
    expect(s.lines).toEqual([]);
    expect(s.closes).toHaveLength(1);
  });

  it("closes once when the output ends", async () => {
    const s = io();
    s.stdout.end();
    await new Promise((r) => setImmediate(r));
    s.t.close();
    expect(s.closes).toEqual([undefined]);
  });
});
