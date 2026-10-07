/** Transport closure cannot stand in for settlement of an already dispatched application write. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { z } from "zod";
import { expect, it } from "vitest";
import { startDaemon } from "@orca/daemon";
import { emptyFixture } from "./fixture.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([
  ["http", false],
  ["socket", false],
  ["http", true],
  ["socket", true],
] as const)("close drains a pending %s handler after caller disconnect (rejects=%s)", async (transport, rejects) => {
  const dir = await mkdtemp(join(tmpdir(), "orca-close-settlement-"));
  const entered = barrier();
  const finish = barrier();
  const settled = barrier();
  let dispatched = false;
  const fixture = emptyFixture();
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.read"],
    source: fixture.orchestrator,
    auth: { mode: "loopback-unauthenticated" },
    methods: {
      hello: {
        params: z.object({}),
        handle: async () => {
          dispatched = true;
          entered.release();
          await finish.promise;
          await writeFile(join(dir, "settled"), "one effect");
          settled.release();
          if (rejects) throw new Error("Original application failure");
          return {};
        },
      },
    },
  });
  let socket: WebSocket | undefined;
  let request: Promise<unknown>;
  let closing: Promise<void> | undefined;
  try {
    const body = JSON.stringify({ kind: "request", id: "pending", method: "hello", params: {} });
    if (transport === "http") {
      const caller = new AbortController();
      request = fetch(`${daemon.url}/rpc`, { method: "POST", body, signal: caller.signal }).catch(() => undefined);
      await entered.promise;
      caller.abort();
    } else {
      socket = new WebSocket(daemon.socketUrl!);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener("error", () => reject(new Error("Socket failed to open")), { once: true });
      });
      request = new Promise<void>((resolve) => socket!.addEventListener("close", () => resolve(), { once: true }));
      socket.send(body);
      await entered.promise;
      socket.close();
    }
    await request;
    let closed = false;
    closing = daemon.close().then(() => {
      closed = true;
    });
    await nextTurn();
    await nextTurn();
    expect(closed).toBe(false);
    finish.release();
    await closing;
    expect(await readFile(join(dir, "settled"), "utf8")).toBe("one effect");
    // Close is idempotent and cannot admit another write.
    await daemon.close();
    await expect(fetch(`${daemon.url}/rpc`, { method: "POST", body })).rejects.toThrow();
  } finally {
    finish.release();
    socket?.close();
    await (closing ?? daemon.close());
    if (dispatched) await settled.promise;
    await rm(dir, { recursive: true, force: true });
  }
});
