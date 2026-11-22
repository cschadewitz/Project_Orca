/** A silent but open ACP transport must time out at either handshake boundary. */
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSpecSchema, type Logger, silentLogger } from "@orca/core";
import { LocalHost, openAcpSession, startupTermination, stdioAcpStream, type AgentProcessHandle } from "@orca/agents";

afterEach(() => vi.useRealTimers());

it.each(
  ["initialize", "session/new"].flatMap((silent) =>
    ["exited", "cooperative", "stuck", "signal-error"].map((mode) => ({ silent, mode })),
  ),
)("rejects a silent $silent with $mode cleanup", async ({ silent, mode }) => {
  vi.useFakeTimers();
  const input = new PassThrough();
  const output = new PassThrough();
  let reached!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    reached = resolve;
  });
  output.on("data", (bytes: Buffer) => {
    const message = JSON.parse(bytes.toString()) as { id: number; method: string };
    if (message.method === silent) reached();
    else if (message.method === "initialize")
      input.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }) +
          "\n",
      );
  });
  let exit!: () => void;
  const exited =
    mode === "exited"
      ? Promise.resolve({ code: 0, signal: null })
      : new Promise<{ code: number; signal: null }>((resolve) => {
          exit = () => resolve({ code: 0, signal: null });
        });
  const kill = vi.fn(() => {
    if (mode === "signal-error") throw new Error("signal refused");
    if (mode === "cooperative") exit();
  });
  const warn = vi.fn();
  const logger: Logger = { ...silentLogger, warn, child: () => logger };
  const host = new LocalHost({ id: "local", type: "local" });
  vi.spyOn(host, "spawnAgent").mockResolvedValue({
    stream: stdioAcpStream(input, output),
    pid: undefined,
    exited,
    stderrTail: () => "silent transport",
    kill,
  });
  const pending = openAcpSession({
    host,
    logger,
    agent: AgentSpecSchema.parse({ id: "silent", command: "unused" }),
    cwd: process.cwd(),
    handshakeTimeoutMs: 20,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: `${silent} timed out after 20ms`,
  });
  await requestSeen;
  await vi.advanceTimersByTimeAsync(4020);
  await rejected;
  expect(kill).toHaveBeenCalledTimes(mode === "exited" ? 0 : mode === "cooperative" ? 1 : 2);
  if (mode === "stuck" || mode === "signal-error") {
    await expect(pending).rejects.toMatchObject({
      cause: { code: "AGENT_TRANSPORT", message: `${silent} timed out after 20ms` },
      details: { cleanup: { details: { cleanupIncomplete: true } } },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  } else expect(warn).not.toHaveBeenCalled();
  input.destroy();
  output.destroy();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits the exit grace it was opened with after each signal", async () => {
  vi.useFakeTimers();
  const input = new PassThrough();
  const output = new PassThrough();
  let reached!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    reached = resolve;
  });
  output.on("data", () => reached());
  const kill = vi.fn();
  const host = new LocalHost({ id: "local", type: "local" });
  vi.spyOn(host, "spawnAgent").mockResolvedValue({
    stream: stdioAcpStream(input, output),
    pid: undefined,
    exited: new Promise(() => undefined),
    stderrTail: () => "",
    kill,
  });
  const pending = openAcpSession({
    host,
    agent: AgentSpecSchema.parse({ id: "silent", command: "unused" }),
    cwd: process.cwd(),
    handshakeTimeoutMs: 20,
    exitGraceMs: 50,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: "initialize timed out after 20ms",
    details: { cleanup: { details: { cleanupIncomplete: true } } },
  });
  await requestSeen;
  await vi.advanceTimersByTimeAsync(20 + 49);
  expect(kill.mock.calls).toEqual([["SIGTERM"]]);
  await vi.advanceTimersByTimeAsync(1);
  expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  input.destroy();
  output.destroy();
  expect(vi.getTimerCount()).toBe(0);
});

/** What a real child writes to stderr once its SIGTERM handler is in place. */
const ARMED = "sigterm-ignored";

/**
 * Resolves once `child` has installed its SIGTERM handler. The real-child tests below take the
 * handshake timeout to be what ends the wait, so the child must already be ignoring SIGTERM
 * when the clock starts: a child that is still starting when SIGTERM arrives dies of it, and
 * the SIGKILL escalation the test is about never happens.
 */
async function untilArmed(child: AgentProcessHandle): Promise<void> {
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  while (!child.stderrTail().includes(ARMED)) {
    if (exited) throw new Error("the child exited before it installed its SIGTERM handler");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// These are disposable direct children; an unrelated fixture proves cleanup is scoped.
it.each(["initialize", "session/new"])(
  "observes the exit of a real SIGTERM-ignoring child silent at %s",
  async (silent) => {
    const host = new LocalHost({ id: "local", type: "local" });
    const sentinel = await host.spawnAgent(
      AgentSpecSchema.parse({
        id: "sentinel",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      }),
      { cwd: process.cwd() },
    );
    let sentinelExited = false;
    void sentinel.exited.then(() => {
      sentinelExited = true;
    });
    let child: AgentProcessHandle | undefined;
    const spawn = host.spawnAgent.bind(host);
    const signals: (NodeJS.Signals | undefined)[] = [];
    vi.spyOn(host, "spawnAgent").mockImplementation(async (...args) => {
      child = await spawn(...args);
      const kill = child.kill.bind(child);
      child.kill = (signal) => {
        signals.push(signal);
        kill(signal);
      };
      await untilArmed(child);
      return child;
    });
    const script = `
    process.on("SIGTERM", () => {});
    process.stderr.write(${JSON.stringify(ARMED)} + "\\n");
    setInterval(() => {}, 1000);
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.method === "initialize" && ${JSON.stringify(silent)} !== "initialize")
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
    });
  `;
    try {
      const started = Date.now();
      await expect(
        openAcpSession({
          host,
          agent: AgentSpecSchema.parse({ id: "silent", command: process.execPath, args: ["-e", script] }),
          cwd: process.cwd(),
          handshakeTimeoutMs: 1000,
          // The child shrugs off SIGTERM, so the default two seconds would be waited out once.
          exitGraceMs: 200,
        }),
      ).rejects.toMatchObject({ code: "AGENT_TRANSPORT", message: `${silent} timed out after 1000ms` });
      expect(Date.now() - started).toBeLessThan(6000);
      expect(await child!.exited).toMatchObject({ signal: process.platform === "win32" ? "SIGTERM" : "SIGKILL" });
      expect(signals).toEqual(process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
      expect(sentinelExited).toBe(false);
    } finally {
      child?.kill("SIGKILL");
      sentinel.kill("SIGKILL");
      await Promise.all([child?.exited, sentinel.exited]);
    }
  },
);

it("carries the process exit on a failed open whose cleanup could not observe it (#873)", async () => {
  vi.useFakeTimers();
  const input = new PassThrough();
  const output = new PassThrough();
  let reached!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    reached = resolve;
  });
  output.on("data", () => reached());
  let exit!: () => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    exit = () => resolve({ code: 0, signal: null });
  });
  const host = new LocalHost({ id: "local", type: "local" });
  vi.spyOn(host, "spawnAgent").mockResolvedValue({
    stream: stdioAcpStream(input, output),
    pid: undefined,
    exited,
    stderrTail: () => "",
    kill: vi.fn(),
  });
  const pending = openAcpSession({
    host,
    agent: AgentSpecSchema.parse({ id: "silent", command: "unused" }),
    cwd: process.cwd(),
    handshakeTimeoutMs: 20,
    exitGraceMs: 10,
  });
  const failure = pending.catch((e: unknown) => e);
  await requestSeen;
  await vi.advanceTimersByTimeAsync(20 + 10 + 10);
  const error = await failure;
  expect(error).toMatchObject({ details: { cleanup: { details: { cleanupIncomplete: true } } } });
  const terminated = startupTermination(error);
  expect(terminated).toBeDefined();
  // Not enumerable: the error's serialized shape is what it was.
  expect(Object.keys(error as object)).not.toContain("terminated");
  let settled = false;
  void terminated!.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  exit();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  input.destroy();
  output.destroy();
});
