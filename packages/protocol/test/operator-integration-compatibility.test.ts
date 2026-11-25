/** Protocol/store boundaries are explicit even when all optional providers are absent. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { HelloResultSchema, PROTOCOL_VERSION, isCompatible } from "@orca/protocol";
import { dispatch, methodsFor, type MethodContext } from "@orca/daemon";
import { ConnectionMachine } from "../../app/src/main/connection-state.js";

const previousProtocol = { major: 1, minor: 10 };
const context: MethodContext = { orcaVersion: "operator-integration-test", capabilities: [] };
const handshake = (protocol: typeof PROTOCOL_VERSION) =>
  dispatch(
    JSON.stringify({ kind: "request", id: "compatibility", method: "hello", params: { client: "test", protocol } }),
    methodsFor(context),
    context,
  );

describe("operator integration compatibility boundary", () => {
  it("keeps release protocol and store epoch aligned without requiring optional providers", async () => {
    const release: { protocol: typeof PROTOCOL_VERSION; storeEpoch: string; capabilities: string[] } = JSON.parse(
      await readFile(new URL("../../../release-compatibility.json", import.meta.url), "utf8"),
    );
    expect(PROTOCOL_VERSION).toEqual({ major: 2, minor: 13 });
    expect(release.protocol).toEqual(PROTOCOL_VERSION);
    expect(release.storeEpoch).toBe("operator-journals-v4");
    expect(release.capabilities).toEqual([
      "runs.read",
      "runs.control",
      "runs.subscribe",
      "plan.read",
      "plan.write",
      "workflows.validateInputs",
      "inputs.live",
    ]);
    const response = await handshake(PROTOCOL_VERSION);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const result = HelloResultSchema.parse(response.result);
    expect(result.protocol).toEqual(release.protocol);
    expect(result.capabilities).toEqual([]);
    expect(result.methods).toEqual(["hello"]);
  });

  it("rejects a protocol 1.10 client through the daemon's real hello dispatcher", async () => {
    expect(await handshake(previousProtocol)).toMatchObject({
      kind: "response",
      id: "compatibility",
      ok: false,
      error: {
        code: "NOT_SUPPORTED",
        message: "client speaks protocol 1.10, daemon speaks 2.12",
        details: { client: previousProtocol, daemon: PROTOCOL_VERSION },
      },
    });
    expect(isCompatible(previousProtocol, PROTOCOL_VERSION)).toBe(false);
  });

  it("marks a protocol 1.10 daemon incompatible in the real app connection machine", () => {
    const oldHello = HelloResultSchema.parse({
      protocol: previousProtocol,
      orcaVersion: "old-test",
      capabilities: ["runs.read"],
      methods: ["hello", "runs.list"],
    });
    const machine = new ConnectionMachine({ hello: async () => oldHello, onChange: () => {}, quietMs: 0 });
    machine.acceptHello(oldHello);
    expect(machine.current).toMatchObject({ state: "mismatch", versions: { app: "2.12", daemon: "1.10" } });
    expect(isCompatible(PROTOCOL_VERSION, previousProtocol)).toBe(false);
  });
});
