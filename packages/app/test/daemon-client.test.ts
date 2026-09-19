import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { startDaemon, type DaemonHandle } from "@orca/daemon";
import { DaemonClient, DaemonClientError, DEFAULT_DAEMON_URL } from "../src/client/daemon-client.js";

describe("DaemonClient", () => {
  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({ orcaVersion: "0.1.0-test", capabilities: ["runs.read"] });
  });
  afterAll(async () => {
    await d.close();
  });

  it("defaults to the local daemon URL", () => {
    expect(new DaemonClient().url).toBe(DEFAULT_DAEMON_URL);
  });

  it("completes the handshake against a real daemon", async () => {
    const hello = await new DaemonClient(d.url).hello("test/1");
    expect(hello.protocol).toEqual(PROTOCOL_VERSION);
    expect(hello.capabilities).toEqual(["runs.read"]);
  });

  it("surfaces a daemon error as DaemonClientError with the protocol code", async () => {
    await expect(new DaemonClient(d.url).call("runs.list", {}, z.unknown())).rejects.toMatchObject({
      name: "DaemonClientError",
      error: { code: "PROTOCOL_METHOD" },
    });
  });

  it("rejects a body that is not a response envelope", async () => {
    const fake: typeof fetch = async () => new Response(JSON.stringify({ nope: 1 }));
    const err = await new DaemonClient("http://x", fake).hello("t").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonClientError);
    expect((err as DaemonClientError).error.code).toBe("PROTOCOL_MESSAGE");
  });
});
