/** Focused unit contracts separated from the mixed suite. */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { dispatch, methods } from "@orca/daemon";

const ctx = { orcaVersion: "0.1.0-test", capabilities: ["runs.read" as const] };

describe("dispatch", () => {
  it("maps each failure to a protocol error code", async () => {
    expect(await dispatch("nope", methods, ctx)).toMatchObject({ ok: false, error: { code: "PROTOCOL_MESSAGE" } });
    expect(await dispatch(JSON.stringify({ kind: "notification", method: "x" }), methods, ctx)).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MESSAGE" },
    });
    expect(await dispatch(JSON.stringify({ kind: "request", id: 1, method: "runs.nope" }), methods, ctx)).toMatchObject(
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
