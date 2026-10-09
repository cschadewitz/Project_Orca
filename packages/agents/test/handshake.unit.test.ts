/** A silent but open ACP transport must time out at either handshake boundary. */
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSpecSchema, type Logger, silentLogger } from "@orca/core";
import { LocalHost, openAcpSession, stdioAcpStream } from "@orca/agents";

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
