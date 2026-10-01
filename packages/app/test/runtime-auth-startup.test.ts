/** Spawned-daemon credential discovery is safe metadata, and follows workspace switches. */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { startBundledDaemon, type DaemonChild } from "../src/main/daemon-process.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import type { DaemonClient } from "../src/client/daemon-client.js";
import type { DaemonSubscription } from "../src/client/subscription.js";

afterEach(() => vi.unstubAllGlobals());

describe("spawned daemon credentials", () => {
  it("uses the emitted token file for startup, without inheriting an unrelated remote token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-start-auth-"));
    try {
      const tokenFile = join(dir, "local-client.token");
      writeFileSync(tokenFile, "fixture-spawned-token");
      const child = Object.assign(new EventEmitter(), {
        pid: 42,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          child.emit("exit", 0, null);
          return true;
        },
      });
      const observed: (string | null)[] = [];
      vi.stubGlobal("fetch", async (_url: string, request: RequestInit) => {
        const token = new Headers(request.headers).get("authorization");
        observed.push(token);
        return new Response(
          JSON.stringify(
            token === "Bearer fixture-spawned-token"
              ? {
                  kind: "response",
                  id: 1,
                  ok: true,
                  result: { protocol: PROTOCOL_VERSION, orcaVersion: "test", capabilities: [] },
                }
              : {
                  kind: "response",
                  id: 0,
                  ok: false,
                  error: { code: "AUTH_REQUIRED", message: "Authentication required" },
                },
          ),
        );
      });
      const daemon = await startBundledDaemon({
        entry: "/fixture/daemon.mjs",
        cwd: dir,
        env: { ORCA_DAEMON_TOKEN: "unrelated-remote-token" },
        findPort: async () => 6799,
        sleep: async () => {},
        spawn: () => {
          queueMicrotask(() =>
            child.stdout.emit("data", Buffer.from(`authentication: token; local token file: ${tokenFile}\n`)),
          );
          return child as unknown as DaemonChild;
        },
      });
      expect(daemon.tokenFile).toBe(tokenFile);
      expect(observed).toContain("Bearer fixture-spawned-token");
      expect(observed).not.toContain("Bearer unrelated-remote-token");
      await daemon.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands the spawned file to the new client, without leaking it into the workspace snapshot", async () => {
    const client = vi.fn<WorkspaceDeps["client"]>(() => ({}) as DaemonClient);
    const workspace = new Workspace({
      findEntry: () => "/fixture/daemon.mjs",
      start: async ({ cwd }) => ({
        url: "http://127.0.0.1:6799",
        pid: 42,
        tokenFile: join(cwd, "auth/local-client.token"),
        stop: async () => {},
      }),
      client,
      subscribe: () => ({ close: () => {} }) as DaemonSubscription,
      onSwitch: () => {},
      onSnapshot: () => {},
      onDaemonGone: () => {},
      defaultPath: () => "/fixture/home",
      defaultUrl: "http://127.0.0.1:6722",
    });
    await workspace.open("/fixture/chosen");
    expect(client).toHaveBeenLastCalledWith("http://127.0.0.1:6799", {
      workspace: "/fixture/chosen",
      bundled: true,
      tokenFile: "/fixture/chosen/auth/local-client.token",
    });
    expect(JSON.stringify(workspace.snapshot)).not.toContain("token");
    await workspace.close();
  });
});
