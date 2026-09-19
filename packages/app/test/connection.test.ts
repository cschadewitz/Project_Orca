import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { connectionState, handshakeDetail, type Handshake } from "../renderer/src/connection.js";

const ok = (protocol = PROTOCOL_VERSION): Handshake => ({
  phase: "done",
  result: { ok: true, result: { protocol, orcaVersion: "0.2.0", capabilities: ["runs.read"] } },
});

describe("connectionState", () => {
  it("is reconnecting until the handshake answers", () => {
    expect(connectionState({ phase: "connecting" })).toBe("reconnecting");
    expect(handshakeDetail({ phase: "connecting" })).toContain(`${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`);
  });

  it("is live for a compatible daemon", () => {
    expect(connectionState(ok())).toBe("live");
  });

  it("is mismatch for a reachable daemon on another major", () => {
    expect(connectionState(ok({ major: PROTOCOL_VERSION.major + 1, minor: PROTOCOL_VERSION.minor }))).toBe("mismatch");
  });

  it("stays live against a daemon newer in the minor, which is the compatible direction", () => {
    expect(connectionState(ok({ major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor + 1 }))).toBe("live");
  });

  it("is disconnected when the bridge returns an error, and shows its code", () => {
    const failed: Handshake = {
      phase: "done",
      result: { ok: false, error: { code: "AGENT_TRANSPORT", message: "connect ECONNREFUSED" } },
    };
    expect(connectionState(failed)).toBe("disconnected");
    expect(handshakeDetail(failed)).toBe("AGENT_TRANSPORT: connect ECONNREFUSED");
  });

  it("renders the handshake result as formatted JSON", () => {
    expect(handshakeDetail(ok())).toContain(`"orcaVersion": "0.2.0"`);
  });
});
