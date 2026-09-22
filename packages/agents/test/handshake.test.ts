/** A silent but open ACP transport must time out at either handshake boundary. */
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import { LocalHost, openAcpSession, stdioAcpStream } from "@orca/agents";

afterEach(() => vi.useRealTimers());

it.each(["initialize", "session/new"])("rejects and cleans up a silent %s", async (silent) => {
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
  const kill = vi.fn(() => {
    input.end();
    output.end();
  });
  const host = new LocalHost({ id: "local", type: "local" });
  vi.spyOn(host, "spawnAgent").mockResolvedValue({
    stream: stdioAcpStream(input, output),
    pid: undefined,
    exited: Promise.resolve({ code: 0, signal: null }),
    stderrTail: () => "silent transport",
    kill,
  });
  const pending = openAcpSession({
    host,
    agent: AgentSpecSchema.parse({ id: "silent", command: "unused" }),
    cwd: process.cwd(),
    handshakeTimeoutMs: 20,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: `${silent} timed out after 20ms`,
  });
  await requestSeen;
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  expect(kill).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
