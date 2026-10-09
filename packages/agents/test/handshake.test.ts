/** Focused boundary coverage separated from the mixed suite. */
import { afterEach, expect, it, vi } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import { LocalHost, openAcpSession, type AgentProcessHandle } from "@orca/agents";

afterEach(() => vi.useRealTimers());

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
      return child;
    });
    const script = `
    process.on("SIGTERM", () => {});
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
