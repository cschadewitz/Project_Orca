/** Real scoped IPC/client validation over synthetic fetch replies; no owner, policy store or Electron is activated. */
import { describe, expect, it, vi } from "vitest";
import { SCOPED_PERMISSION_CONTRACTS, type ScopedPermissionMethod } from "@orca/protocol";
import { projectGuardDecision } from "../../protocol/src/guard-decision-projection.js";
import { callScopedPermission } from "../src/client/scoped-permission-client.js";
import { DaemonClient, DaemonClientError } from "../src/client/daemon-client.js";
const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
const handle = "33333333-3333-4333-8333-333333333333";
const input = {
  instanceId: target.instanceId,
  sessionId: "session",
  turnId: "turn",
  invocationId: "invocation",
  runId: "run",
  stepRunId: "step",
  requestId: "request",
};
const review = {
  handle,
  reviewUntil: 123456,
  scope: {
    principal: "Synthetic operator",
    operation: "Read",
    resources: "Disposable fixture",
    environment: "Synthetic",
    lifetime: "Bounded",
    limits: "One file",
    authorizer: "Synthetic owner",
    coverage: "Unknown",
  },
  requiredReview: "unavailable",
  decision: projectGuardDecision(
    {},
    { requiredDisclosure: () => "unavailable", reference: () => undefined },
    Date.now(),
  ),
};
const cases = [
  ["scopedPermissions.review", { target, input }, review],
  ["scopedPermissions.choose", { target, handle, choice: "save" }, { outcome: "saved" }],
  ["scopedPermissions.inspect", { target, handle }, { outcome: "uncertain", retainedRule: true }],
  ["scopedPermissions.cancel", { target, handle }, { outcome: "cancelled" }],
] as const;
const response = (result: unknown) => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result }));
describe("scoped permission IPC client boundary", () => {
  it.each(cases)("validates %s parameters and result using the real daemon client", async (method, params, result) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(result));
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl);
    await expect(callScopedPermission(client, method, params)).resolves.toEqual(result);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:6722/rpc");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(init?.body as string)).toEqual({ kind: "request", id: 1, method, params });
  });
  it("refuses inherited and arbitrary method names before dispatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl);
    for (const method of ["toString", "__proto__", "constructor", "inputs.answer"])
      await expect(callScopedPermission(client, method as ScopedPermissionMethod, { target, handle })).rejects.toThrow(
        "Scoped permission method unavailable.",
      );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ["scopedPermissions.review", { target, input: { ...input, actor: "forged" } }],
    ["scopedPermissions.review", { target: { ...target, instanceId: "not-a-uuid" }, input }],
    ["scopedPermissions.choose", { target, handle, choice: "save", rule: { decision: "allow" }, actor: "forged" }],
    ["scopedPermissions.choose", { target, handle, choice: "save-and-answer" }],
    ["scopedPermissions.inspect", { target, handle: "private-record-reference" }],
    ["scopedPermissions.cancel", { target, handle, expectedRevision: "forged" }],
  ] as const)("rejects invalid %s fields without sending credentials or a request", async (method, params) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const read = vi.fn(() => "synthetic-credential");
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, { auth: { read, refresh: () => false } });
    await expect(callScopedPermission(client, method, params)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(cases)("rejects extra private response fields for %s", async (method, params, result) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...result, ownerReference: "synthetic-private" }));
    await expect(
      callScopedPermission(new DaemonClient("http://127.0.0.1:6722", fetchImpl), method, params),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses a result from the wrong family rather than presenting it as a save", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ outcome: "cancelled" }));
    await expect(
      callScopedPermission(new DaemonClient("http://127.0.0.1:6722", fetchImpl), "scopedPermissions.inspect", {
        target,
        handle,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["AUTH_FORBIDDEN", "CONFIG_STALE", "RUN_STATE"])("propagates %s without fallback or replay", async (code) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ kind: "response", id: 1, ok: false, error: { code, message: "Synthetic refusal" } }),
        ),
      );
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl);
    await expect(
      callScopedPermission(client, "scopedPermissions.choose", { target, handle, choice: "save" }),
    ).rejects.toMatchObject({ name: "DaemonClientError", error: { code } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("leaves a dispatched save unresolved until its acknowledgement, then never retries a lost response", async () => {
    let lose!: (error: Error) => void;
    const pending = new Promise<Response>((_resolve, reject) => {
      lose = reject;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(pending);
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, {
      requireAuthentication: true,
      auth: { read: () => "synthetic-original", refresh: () => false },
    });
    const error = new Error("Synthetic lost acknowledgement");
    const attempt = callScopedPermission(client, "scopedPermissions.choose", { target, handle, choice: "save" });
    const rejected = expect(attempt).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer synthetic-original",
    });
    lose(error);
    await rejected;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not turn missing authentication or malformed transport output into an accepted command", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("lost partial response"));
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl, { requireAuthentication: true });
    await expect(
      callScopedPermission(client, "scopedPermissions.choose", { target, handle, choice: "save" }),
    ).rejects.toBeInstanceOf(DaemonClientError);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      callScopedPermission(new DaemonClient("http://127.0.0.1:6722", fetchImpl), "scopedPermissions.choose", {
        target,
        handle,
        choice: "save",
      }),
    ).rejects.toMatchObject({ error: { code: "PROTOCOL_MESSAGE" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("keeps request IDs and handle/choice identity distinct across explicit operations", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ outcome: "saved" }))
      .mockResolvedValueOnce(response({ outcome: "answered" }));
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl);
    await callScopedPermission(client, "scopedPermissions.choose", { target, handle, choice: "save" });
    await callScopedPermission(client, "scopedPermissions.choose", { target, handle, choice: "allow-once" });
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string))).toEqual([
      { kind: "request", id: 1, method: "scopedPermissions.choose", params: { target, handle, choice: "save" } },
      { kind: "request", id: 2, method: "scopedPermissions.choose", params: { target, handle, choice: "allow-once" } },
    ]);
  });
  it("uses the exact closed result schema at the IPC dispatch boundary", async () => {
    const call = vi.fn().mockResolvedValue({ outcome: "cancelled" });
    await callScopedPermission({ call }, "scopedPermissions.cancel", { target, handle });
    expect(call).toHaveBeenCalledWith(
      "scopedPermissions.cancel",
      { target, handle },
      SCOPED_PERMISSION_CONTRACTS["scopedPermissions.cancel"].result,
    );
  });
});
