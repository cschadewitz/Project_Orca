/** Real SDK stderr -> production bundled-daemon onLog/tail, using synthetic-only peers. */
import { spawn, type ChildProcess } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { childBundle } from "@orca/testing/child-bundle";
import { startBundledDaemon, type DaemonExit, type SpawnDaemon } from "../../app/src/main/daemon-process.js";
import { canaries } from "./fixtures/acp-diagnostic-canaries.js";
const hits = (value: string) =>
  Object.fromEntries(Object.entries(canaries).map(([name, text]) => [name, value.includes(text)]));
const absent = Object.fromEntries(Object.keys(canaries).map((name) => [name, false]));

it.each(["client", "facade"])(
  "keeps %s ACP diagnostics out of raw stderr and daemon projections",
  async (role) => {
    const bundle = childBundle("acp-diagnostic-canary", {
      entries: { probe: "packages/integrations/test/fixtures/acp-diagnostic-canary.ts" },
    });
    const source = fileURLToPath(new URL("./fixtures/acp-diagnostic-canary.ts", import.meta.url));
    const args = bundle?.probe
      ? [bundle.probe, role]
      : ["--import", createRequire(import.meta.url).resolve("tsx"), source, role];
    let child: ChildProcess | undefined;
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => (ready = resolve));
    let report!: (value: Record<string, unknown>) => void;
    const reported = new Promise<Record<string, unknown>>((resolve) => (report = resolve));
    let exit!: (value: DaemonExit) => void;
    const exited = new Promise<DaemonExit>((resolve) => (exit = resolve));
    const logs: string[] = [];
    let stderr = "";
    const spawnProbe: SpawnDaemon = (command) => {
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.on("message", (message: unknown) => {
        if (message === "ready") ready();
        else if (message && typeof message === "object" && "result" in message)
          report(message.result as Record<string, unknown>);
        else report(message as Record<string, unknown>);
      });
      child.once("exit", (code) => {
        ready();
        report({ fixtureExitedBeforeReport: code });
      });
      child.stderr!.on("data", (bytes: Buffer) => {
        const text = bytes.toString();
        if (stderr.length + text.length > 64 * 1024) {
          report({ outputLimitExceeded: true });
          child!.kill();
          return;
        }
        stderr += text;
      });
      return child;
    };
    const watchdog = setTimeout(() => child?.kill(), 8000);
    try {
      await startBundledDaemon({
        entry: bundle?.probe ?? source,
        cwd: process.cwd(),
        spawn: spawnProbe,
        findPort: async () => 41739,
        probe: async () => {
          await readiness;
          return true;
        },
        onLog: (line) => logs.push(line),
        onExit: exit,
      });
      child!.send("run");
      const result = await reported;
      await nextTurn();
      await nextTurn();
      child!.send("finish");
      const terminal = await exited;
      expect(result, JSON.stringify(result)).not.toHaveProperty("failed");
      expect(terminal.code).toBe(0);
      expect(result).toMatchObject({
        role,
        runStatus: "completed",
        listenerCalls: 1,
        validationRejected: true,
        malformedRejected: true,
        authoritativeInputsIntact: true,
        publicVarsRedacted: true,
        executionLoggerRedacted: true,
        executionLoggerContainsCanary: false,
        publicStateContainsCanary: false,
        readViewContainsCanary: false,
        liveNotificationsContainCanary: false,
        replayNotificationsContainCanary: false,
        facadeUpdatesContainCanary: false,
      });
      expect(stderr).toContain("ORCA_SYNTH_UNRELATED_DIAGNOSTIC");
      expect(logs.join("\n")).toContain("ORCA_SYNTH_UNRELATED_DIAGNOSTIC");
      expect(terminal.output).toContain("ORCA_SYNTH_UNRELATED_DIAGNOSTIC");
      expect(stderr).toContain("Error handling notification");
      expect(stderr).toContain("Got response to unknown request");
      expect({
        rawStderr: hits(stderr),
        daemonOnLog: hits(logs.join("\n")),
        retainedTail: hits(terminal.output),
      }).toEqual({ rawStderr: absent, daemonOnLog: absent, retainedTail: absent });
    } finally {
      clearTimeout(watchdog);
      child?.kill();
    }
  },
  12_000,
);
