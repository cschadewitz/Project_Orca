/**
 * A desktop from this build against a shipped 2.0 daemon (#880 review): the hello it sends
 * must pass v0.7.0's own check, and the answer v0.7.0 actually sends must leave the app live,
 * on its current protocol and writable. The daemon side is the captured v0.7.0 wire in
 * `fixtures/protocol-2.0-hello.json`, replayed byte for byte.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, isCompatible, type ProtocolVersion } from "@orca/protocol";
import type { ConnectionSnapshot } from "../src/bridge.js";
import { DaemonClient } from "../src/client/daemon-client.js";
import { ConnectionMachine } from "../src/main/connection-state.js";
import { toConnection, writability } from "../renderer/src/connection.js";

interface Wire {
  request: { params: { client: string; protocol: ProtocolVersion } };
  response: { ok: true; result: { protocol: ProtocolVersion } };
}
const wire: Wire = JSON.parse(await readFile(new URL("./fixtures/protocol-2.0-hello.json", import.meta.url), "utf8"));
const V070_DAEMON = { major: 2, minor: 0 };

/** The v0.7.0 daemon: its hello check (`isCompatible(client, 2.0)`), then its recorded answer. */
const v070Daemon: typeof fetch = async (_url, init) => {
  const request = JSON.parse(init?.body as string) as {
    id: unknown;
    method: string;
    params: { protocol: ProtocolVersion };
  };
  if (request.method !== "hello") throw new Error(`unexpected ${request.method}`);
  if (!isCompatible(request.params.protocol, V070_DAEMON))
    return new Response(
      JSON.stringify({
        kind: "response",
        id: request.id,
        ok: false,
        error: { code: "NOT_SUPPORTED", message: "client speaks protocol newer than 2.0" },
      }),
    );
  return new Response(JSON.stringify({ ...wire.response, id: request.id }));
};

describe("app on this build against a shipped 2.0 daemon", () => {
  it("the fixture is the 2.0 wire", () => {
    expect(wire.request.params.protocol).toEqual(V070_DAEMON);
    expect(wire.response.result.protocol).toEqual(V070_DAEMON);
    expect(PROTOCOL_VERSION.major).toBe(V070_DAEMON.major);
  });

  it("offers a hello v0.7.0 accepts, and is live and writable on its answer", async () => {
    const hello = await new DaemonClient("http://v070.invalid", v070Daemon).hello("orca-app/connection");
    expect(hello.protocol).toEqual(V070_DAEMON);
    const snapshots: ConnectionSnapshot[] = [];
    const machine = new ConnectionMachine({ hello: async () => hello, onChange: (s) => snapshots.push(s), quietMs: 0 });
    machine.acceptHello(hello);
    machine.linkChanged("live");
    const snapshot = snapshots.at(-1)!;
    expect(snapshot).toMatchObject({ state: "live", versions: { daemon: "2.0" } });
    expect(snapshot).not.toHaveProperty("olderProtocol");
    expect(writability(toConnection(snapshot))).toEqual({ can: true });
    machine.close();
  });
});
