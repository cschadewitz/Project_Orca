/** Focused unit contracts separated from the mixed suite. */
import { describe, expect, it } from "vitest";
import { SOCKET_PATH } from "@orca/protocol";
import { DaemonClient, DaemonClientError, DEFAULT_DAEMON_URL } from "../src/client/daemon-client.js";

describe("DaemonClient", () => {
  it("defaults to the local daemon URL", () => {
    expect(new DaemonClient().url).toBe(DEFAULT_DAEMON_URL);
  });

  it("rejects a body that is not a response envelope", async () => {
    const fake: typeof fetch = async () => new Response(JSON.stringify({ nope: 1 }));
    const err = await new DaemonClient("http://x", fake).hello("t").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonClientError);
    expect((err as DaemonClientError).error.code).toBe("PROTOCOL_MESSAGE");
  });

  it("puts the socket beside the read endpoint, on the same host and port", () => {
    expect(new DaemonClient("http://10.0.0.2:6722").socketUrl).toBe(`ws://10.0.0.2:6722${SOCKET_PATH}`);
    expect(new DaemonClient("https://orca.example/").socketUrl).toBe(`wss://orca.example${SOCKET_PATH}`);
  });
});
