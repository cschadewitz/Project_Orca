/**
 * The protocol compatibility window (#880), on the daemon's side of `hello`.
 *
 * Every daemon case runs through the real `hello` handler and the real envelope dispatcher.
 * The N-1 client fixtures are the exact `hello` params today's clients send; the window
 * under test stands the daemon one major ahead of them (`MethodContext.protocolWindow`), so
 * the same fixtures will be the N-1 clients of the first major that opens a window.
 */
import { describe, expect, it } from "vitest";
import {
  HelloResultSchema,
  PREVIOUS_PROTOCOL,
  PROTOCOL_VERSION,
  PROTOCOL_WINDOW,
  daemonRelation,
  describeProtocolRefusal,
  helloOffer,
  negotiateProtocol,
  windowOf,
  type HelloParams,
  type ProtocolVersion,
  type ProtocolWindow,
} from "@orca/protocol";
import { dispatch, methodsFor, type MethodContext } from "@orca/daemon";

const v = (major: number, minor: number): ProtocolVersion => ({ major, minor });
const N = v(PROTOCOL_VERSION.major + 1, 0);
const NEXT_WINDOW = windowOf(N, PROTOCOL_VERSION);

/** What a client of this build sends, and what one a major older and newer would send. */
const N1_CLIENT: HelloParams = { client: "orca-app/n-1", protocol: PROTOCOL_VERSION };
const N_CLIENT: HelloParams = { client: "orca-app/n", protocol: N, fallback: PROTOCOL_VERSION };
const N2_CLIENT: HelloParams = { client: "orca-app/n-2", protocol: v(PROTOCOL_VERSION.major - 1, 10) };

const handshake = (params: HelloParams, window?: ProtocolWindow) => {
  const ctx: MethodContext = {
    orcaVersion: "protocol-window-test",
    capabilities: ["runs.read"],
    ...(window ? { protocolWindow: window } : {}),
  };
  return dispatch(JSON.stringify({ kind: "request", id: "window", method: "hello", params }), methodsFor(ctx), ctx);
};

const accepted = async (params: HelloParams, window?: ProtocolWindow) => {
  const response = await handshake(params, window);
  if (!response.ok) throw new Error(response.error.message);
  return HelloResultSchema.parse(response.result);
};

describe("the window this build ships", () => {
  it("is one major wide when it is open at all", () => {
    expect(PROTOCOL_WINDOW.current).toEqual(PROTOCOL_VERSION);
    if (PREVIOUS_PROTOCOL) expect(PREVIOUS_PROTOCOL.major).toBe(PROTOCOL_VERSION.major - 1);
    expect(PROTOCOL_WINDOW.previous).toEqual(PREVIOUS_PROTOCOL);
  });

  it("refuses a window that skips a major or points forward", () => {
    expect(() => windowOf(v(3, 0), v(1, 10))).toThrow(/spans one major/);
    expect(() => windowOf(v(3, 0), v(3, 0))).toThrow(/spans one major/);
    expect(windowOf(v(3, 0))).toEqual({ current: v(3, 0) });
  });

  it("offers a fallback in hello only while a window is open", () => {
    expect(helloOffer(windowOf(v(3, 1)))).toEqual({ protocol: v(3, 1) });
    expect(helloOffer(windowOf(v(3, 1), v(2, 4)))).toEqual({ protocol: v(3, 1), fallback: v(2, 4) });
  });
});

describe("negotiation", () => {
  const window = windowOf(v(3, 2), v(2, 4));

  it("prefers the current major whenever both sides have it", () => {
    expect(negotiateProtocol([v(3, 1), v(2, 4)], window)).toEqual({ protocol: v(3, 2), relation: "current" });
  });

  it("falls back to the previous major, by the same minor rule as before", () => {
    expect(negotiateProtocol([v(2, 3)], window)).toEqual({ protocol: v(2, 4), relation: "previous" });
    expect(negotiateProtocol([v(4, 0), v(3, 0)], window)).toEqual({ protocol: v(3, 2), relation: "current" });
    // A client newer in minor than the daemon is still refused within a major.
    expect(negotiateProtocol([v(2, 5)], window)).toBeUndefined();
  });

  it("refuses N-2 and says what the daemon accepts", () => {
    expect(negotiateProtocol([v(1, 10)], window)).toBeUndefined();
    expect(describeProtocolRefusal([v(1, 10)], window)).toBe(
      "client speaks protocol 1.10, daemon speaks 3.2 and accepts 2.x clients up to 2.4",
    );
    expect(describeProtocolRefusal([v(4, 0), v(3, 9)], windowOf(v(3, 2)))).toBe(
      "client speaks protocol 4.0 or 3.9, daemon speaks 3.2",
    );
  });

  it("tells a client which of its two protocols a daemon answered in", () => {
    expect(daemonRelation(v(3, 2), window)).toBe("current");
    expect(daemonRelation(v(2, 4), window)).toBe("previous");
    expect(daemonRelation(v(2, 3), window)).toBeUndefined();
    expect(daemonRelation(v(1, 10), window)).toBeUndefined();
  });
});

describe("daemon N against client fixtures, through the real hello dispatcher", () => {
  it("answers an N client in N", async () => {
    expect((await accepted(N_CLIENT, NEXT_WINDOW)).protocol).toEqual(N);
  });

  it("accepts an N-1 client and answers in N-1", async () => {
    const result = await accepted(N1_CLIENT, NEXT_WINDOW);
    expect(result.protocol).toEqual(PROTOCOL_VERSION);
    expect(result.capabilities).toEqual(["runs.read"]);
  });

  it("refuses an N-2 client with a protocol message", async () => {
    expect(await handshake(N2_CLIENT, NEXT_WINDOW)).toMatchObject({
      ok: false,
      error: {
        code: "NOT_SUPPORTED",
        message: `client speaks protocol ${PROTOCOL_VERSION.major - 1}.10, daemon speaks ${N.major}.0 and accepts ${PROTOCOL_VERSION.major}.x clients up to ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`,
        details: { client: N2_CLIENT.protocol, daemon: N, previous: PROTOCOL_VERSION },
      },
    });
  });
});

describe("this build's daemon as the N-1 daemon an N app falls back to", () => {
  it("answers an N client's fallback in its own protocol", async () => {
    expect((await accepted(N_CLIENT)).protocol).toEqual(PROTOCOL_VERSION);
  });

  it("still refuses an N client that offers no fallback", async () => {
    const response = await handshake({ client: "orca-app/n", protocol: N });
    expect(response).toMatchObject({ ok: false, error: { code: "NOT_SUPPORTED" } });
  });
});
