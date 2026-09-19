import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HelloResultSchema, PROTOCOL_VERSION } from "@orca/protocol";
import { dispatch, methods, startDaemon, type DaemonHandle } from "@orca/daemon";

const ctx = { orcaVersion: "0.1.0-test", capabilities: ["runs.read" as const] };

async function rpc(d: DaemonHandle, body: unknown) {
  const res = await fetch(`${d.url}/rpc`, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as { ok: boolean; id: unknown; result?: unknown; error?: { code: string } };
}

describe("startDaemon", () => {
  let d: DaemonHandle;
  beforeAll(async () => {
    d = await startDaemon({ ...ctx, storeDir: "/tmp/store" });
  });
  afterAll(async () => {
    await d.close();
  });

  it("answers /health", async () => {
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("completes the handshake over /rpc", async () => {
    const r = await rpc(d, {
      kind: "request",
      id: "h1",
      method: "hello",
      params: { client: "test/1", protocol: PROTOCOL_VERSION },
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("h1");
    const result = HelloResultSchema.parse(r.result);
    expect(result).toEqual({
      protocol: PROTOCOL_VERSION,
      orcaVersion: "0.1.0-test",
      storeDir: "/tmp/store",
      capabilities: ["runs.read"],
    });
  });

  it("refuses a client on another major", async () => {
    const r = await rpc(d, {
      kind: "request",
      id: 2,
      method: "hello",
      params: { client: "test/1", protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 } },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("NOT_SUPPORTED");
  });

  it("404s anything else as a response envelope", async () => {
    const res = await fetch(`${d.url}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "PROTOCOL_METHOD" } });
  });
});

describe("dispatch", () => {
  it("maps each failure to a protocol error code", async () => {
    expect(await dispatch("nope", methods, ctx)).toMatchObject({ ok: false, error: { code: "PROTOCOL_MESSAGE" } });
    expect(await dispatch(JSON.stringify({ kind: "notification", method: "x" }), methods, ctx)).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MESSAGE" },
    });
    expect(await dispatch(JSON.stringify({ kind: "request", id: 1, method: "runs.list" }), methods, ctx)).toMatchObject(
      {
        id: 1,
        ok: false,
        error: { code: "PROTOCOL_METHOD" },
      },
    );
    expect(
      await dispatch(JSON.stringify({ kind: "request", id: 1, method: "hello", params: { client: "" } }), methods, ctx),
    ).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MESSAGE" },
    });
  });

  it("omits storeDir when the daemon has none", async () => {
    const r = await dispatch(
      JSON.stringify({ kind: "request", id: 1, method: "hello", params: { client: "c", protocol: PROTOCOL_VERSION } }),
      methods,
      ctx,
    );
    expect(r).toMatchObject({ ok: true, result: { capabilities: ["runs.read"] } });
    expect((r as { result: object }).result).not.toHaveProperty("storeDir");
  });
});
