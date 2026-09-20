import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TEXT_LIMIT_BYTES,
  ArtifactsGetParamsSchema,
  HelloParamsSchema,
  HelloResultSchema,
  PROTOCOL_VERSION,
  READ_METHODS,
  RunsEventsParamsSchema,
  formatProtocolVersion,
  isCompatible,
  isTextMediaType,
  parseMessage,
  protocolError,
} from "@orca/protocol";

describe("protocol version", () => {
  it("formats as major.minor", () => {
    expect(formatProtocolVersion({ major: 1, minor: 4 })).toBe("1.4");
  });

  it("is compatible on the same major when the daemon is at least the client's minor", () => {
    expect(isCompatible({ major: 1, minor: 0 }, { major: 1, minor: 2 })).toBe(true);
    expect(isCompatible({ major: 1, minor: 2 }, { major: 1, minor: 0 })).toBe(false);
    expect(isCompatible({ major: 1, minor: 0 }, { major: 2, minor: 0 })).toBe(false);
    expect(isCompatible(PROTOCOL_VERSION, PROTOCOL_VERSION)).toBe(true);
  });
});

describe("envelope", () => {
  it("parses requests, both response shapes and notifications", () => {
    expect(parseMessage(JSON.stringify({ kind: "request", id: 1, method: "hello", params: {} }))).toMatchObject({
      kind: "request",
      method: "hello",
    });
    expect(parseMessage(JSON.stringify({ kind: "response", id: 1, ok: true, result: null }))).toMatchObject({
      ok: true,
    });
    expect(
      parseMessage(
        JSON.stringify({ kind: "response", id: "a", ok: false, error: protocolError("RUN_NOT_FOUND", "no") }),
      ),
    ).toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } });
    expect(
      parseMessage(JSON.stringify({ kind: "notification", method: "run.event", params: { seq: 1 } })),
    ).toMatchObject({
      kind: "notification",
    });
  });

  it("rejects non-JSON, non-messages and a response carrying neither result nor error", () => {
    expect(parseMessage("{")).toBeUndefined();
    expect(parseMessage(JSON.stringify({ hello: true }))).toBeUndefined();
    expect(parseMessage(JSON.stringify({ kind: "response", id: 1, ok: true }))).toBeUndefined();
  });

  it("carries details only when given", () => {
    expect(protocolError("PROTOCOL_VERSION", "m")).toEqual({ code: "PROTOCOL_VERSION", message: "m" });
    expect(protocolError("PROTOCOL_VERSION", "m", { got: "2.0" })).toEqual({
      code: "PROTOCOL_VERSION",
      message: "m",
      details: { got: "2.0" },
    });
  });
});

describe("hello", () => {
  it("validates params and result", () => {
    expect(HelloParamsSchema.safeParse({ client: "orca-app/0.1.0", protocol: PROTOCOL_VERSION }).success).toBe(true);
    expect(HelloParamsSchema.safeParse({ client: "", protocol: PROTOCOL_VERSION }).success).toBe(false);
    expect(
      HelloResultSchema.safeParse({ protocol: PROTOCOL_VERSION, orcaVersion: "0.1.0", capabilities: ["runs.read"] })
        .success,
    ).toBe(true);
    expect(
      HelloResultSchema.safeParse({ protocol: PROTOCOL_VERSION, orcaVersion: "0.1.0", capabilities: ["nope"] }).success,
    ).toBe(false);
  });

  it("lists the artifact reads among the read methods", () => {
    expect(READ_METHODS).toContain("artifacts.list");
    expect(READ_METHODS).toContain("artifacts.get");
  });
});

describe("runs.events params", () => {
  it("takes a step run beside the type filter, and still refuses two anchors", () => {
    const p = RunsEventsParamsSchema.parse({ runId: "r", stepRunId: "s-1", types: ["agent.update"] });
    expect(p).toMatchObject({ stepRunId: "s-1", types: ["agent.update"], limit: 200 });
    expect(RunsEventsParamsSchema.safeParse({ runId: "r", stepRunId: "", limit: 10 }).success).toBe(false);
    expect(RunsEventsParamsSchema.safeParse({ runId: "r", stepRunId: "s-1", after: 1, before: 5 }).success).toBe(false);
  });
});

describe("artifacts", () => {
  it("knows which media types are text a client can render", () => {
    for (const t of ["text/markdown", "text/plain; charset=utf-8", "application/json", "application/vnd.orca+yaml"])
      expect(isTextMediaType(t)).toBe(true);
    for (const t of ["image/png", "application/pdf", "application/octet-stream"])
      expect(isTextMediaType(t)).toBe(false);
  });

  it("is addressed by id, or by run and name, and never by both or neither", () => {
    expect(ArtifactsGetParamsSchema.parse({ artifactId: "a" })).toMatchObject({
      artifactId: "a",
      maxBytes: ARTIFACT_TEXT_LIMIT_BYTES,
    });
    expect(ArtifactsGetParamsSchema.safeParse({ runId: "r", name: "spec", version: 3 }).success).toBe(true);
    expect(ArtifactsGetParamsSchema.safeParse({}).success).toBe(false);
    expect(ArtifactsGetParamsSchema.safeParse({ runId: "r" }).success).toBe(false);
    expect(ArtifactsGetParamsSchema.safeParse({ artifactId: "a", runId: "r", name: "spec" }).success).toBe(false);
  });
});
