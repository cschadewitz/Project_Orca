import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TEXT_LIMIT_BYTES,
  ArtifactsGetParamsSchema,
  CONFIG_CHANGED,
  CONFIG_APPLY_METHOD,
  CONFIG_GET_METHOD,
  CONFIG_SET_METHOD,
  CONTROL_ERROR_CODES,
  CONTROL_METHODS,
  ConfigDocumentViewSchema,
  ConfigGetResultSchema,
  ConfigSetParamsSchema,
  DAEMON_CAPABILITIES,
  HelloParamsSchema,
  HelloResultSchema,
  NOTIFICATION_METHODS,
  PROTOCOL_VERSION,
  READ_METHODS,
  parseNotification,
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

  it("puts config.get with the reads and config.set with the writes, and mints no capability", () => {
    // Reading what a daemon is configured with is not a different class of thing from
    // reading what it has run; writing it is a write, and `--read-only` omits it (#174).
    expect(READ_METHODS).toContain(CONFIG_GET_METHOD);
    expect(CONTROL_METHODS).toContain(CONFIG_SET_METHOD);
    expect(DAEMON_CAPABILITIES).toEqual([
      "operator.discover",
      "operator.page",
      "operator.config",
      "operator.preflight",
      "operator.artifact",
      "inputs.live",
      "inputs.revise",
      "inputs.revisionPending",
      "inputs.replaceRevision",
      "runs.read",
      "runs.subscribe",
      "runs.admit",
      "admissions.get",
      "admissions.reconcile",
      "runs.continue",
      "continuations.get",
      "continuations.reconcile",
      "runs.control",
      "plan.read",
      "plan.write",
      "workflows.validateInputs",
    ]);
  });
});

describe("the configuration methods (#174, #266)", () => {
  const view = {
    document: "config" as const,
    path: "/w/orca.config.yaml",
    exists: true,
    revision: "abc",
    text: "version: 1\n",
    parsed: { version: 1 },
  };

  it("takes exactly one of text and patch", () => {
    const base = { document: "config", expectedRevision: "abc" };
    expect(ConfigSetParamsSchema.safeParse({ ...base, text: "version: 1\n" }).success).toBe(true);
    expect(ConfigSetParamsSchema.safeParse({ ...base, patch: [{ path: "storeDir", value: ".x" }] }).success).toBe(true);
    // Both is ambiguous and neither is a no-op asking to be mistaken for a write.
    expect(ConfigSetParamsSchema.safeParse({ ...base, text: "", patch: [] }).success).toBe(false);
    expect(ConfigSetParamsSchema.safeParse(base).success).toBe(false);
  });

  it("lets a patch entry omit its value, which means delete the key", () => {
    const parsed = ConfigSetParamsSchema.parse({
      document: "config",
      expectedRevision: "abc",
      patch: [{ path: "storeDir" }],
    });
    expect(parsed.patch?.[0]).toMatchObject({ path: "storeDir" });
    expect(parsed.patch?.[0]?.value).toBeUndefined();
  });

  it("carries each document's own path and revision, and an empty revision when absent", () => {
    expect(ConfigDocumentViewSchema.safeParse(view).success).toBe(true);
    expect(
      ConfigDocumentViewSchema.safeParse({
        document: "permissions",
        path: "/w/orca.permissions.json",
        exists: false,
        revision: "",
        text: "",
      }).success,
    ).toBe(true);
    expect(ConfigDocumentViewSchema.safeParse({ ...view, document: "workflows" }).success).toBe(false);
  });

  it("labels every effective rule with the document it came from", () => {
    const result = ConfigGetResultSchema.parse({
      config: view,
      permissions: { ...view, document: "permissions", path: "/w/orca.permissions.json" },
      schema: [{ path: "storeDir", type: "string", required: false, default: ".orca" }],
      effective: {
        agents: {
          claude: {
            default: "ask",
            rules: [
              { match: { kind: "execute" }, decision: "allow", source: "config" },
              { match: { kind: "edit" }, decision: "allow", source: "permissions", addedAt: "2026-09-20T10:00:00Z" },
            ],
          },
        },
      },
      asOf: "2026-09-21T12:00:00Z",
    });
    expect(result.effective.agents["claude"]?.rules.map((r) => r.source)).toEqual(["config", "permissions"]);
  });

  it("is a notification with no runId and no seq, like agent.changed", () => {
    expect(NOTIFICATION_METHODS).toContain(CONFIG_CHANGED);
    const parsed = parseNotification({
      method: CONFIG_CHANGED,
      params: { subscriptionId: "sub-1", document: "permissions", revision: "abc", path: "/w/p.json", at: "now" },
    });
    expect(parsed?.method).toBe(CONFIG_CHANGED);
    expect(parsed?.params).not.toHaveProperty("seq");
    expect(parsed?.params).not.toHaveProperty("runId");
  });

  it("has a stale-revision code a form can branch on", () => {
    expect(CONTROL_ERROR_CODES).toContain("CONFIG_STALE");
    expect(protocolError("CONFIG_STALE", "moved", { document: "config" }).details).toEqual({ document: "config" });
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

it("classifies generation activation and admission recovery with the authenticated control service", () => {
  for (const method of [
    CONFIG_APPLY_METHOD,
    "requests.submit",
    "requests.reconcile",
    "requests.admission",
    "requests.admissions",
  ]) {
    expect(CONTROL_METHODS).toContain(method);
    expect(READ_METHODS).not.toContain(method);
  }
});
