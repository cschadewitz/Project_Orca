/** Revision bridge calls exercise the real client, with only HTTP responses supplied by a fixture. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  RequestMessageSchema,
  type InputsReviseParams,
  type InputsReplaceRevisionParams,
  type PendingRevisionView,
  type RevisionResult,
} from "@orca/protocol";
import { DaemonClient, DaemonClientError } from "../src/client/daemon-client.js";

const target = {
  runId: "run-1",
  stepRunId: "step-1",
  requestId: "request-1",
  destinationId: "destination-1",
  expectedRevision: "revision-0",
};
const pendingTarget = {
  runId: target.runId,
  revisionId: "revision-1",
  destinationId: target.destinationId,
  attemptId: "attempt-1",
};
const revise: InputsReviseParams = {
  command: {
    target,
    payload: { kind: "text", text: "Use the revised requirements." },
    actionId: "action-1",
    supersedesRevisionId: "revision-0",
  },
  retry: { idempotencyKey: "revise-key" },
};
const replace: InputsReplaceRevisionParams = {
  command: {
    target: pendingTarget,
    expectedRevision: "revision-1",
    payload: { kind: "values", values: { scope: "smaller", approved: true, nested: { count: 2 } } },
  },
  retry: { idempotencyKey: "replace-key" },
};
const receipt: RevisionResult = {
  state: "resolved",
  operationId: "operation-1",
  replayed: true,
  result: {
    revisionId: "revision-1",
    target,
    state: "pending",
    attemptId: "attempt-1",
    currentRevisionId: "revision-1",
    expectedRevision: "revision-0",
  },
};
const pending: PendingRevisionView = {
  target: pendingTarget,
  expectedRevision: "revision-1",
  state: "pending",
  payload: revise.command.payload,
  replacementAllowed: true,
};
const writes = [
  { method: "inputs.revise", params: revise, invoke: (client: DaemonClient) => client.inputsRevise(revise) },
  {
    method: "inputs.replaceRevision",
    params: replace,
    invoke: (client: DaemonClient) => client.inputsReplaceRevision(replace),
  },
];
const methods = [
  ...writes.map((method) => ({ ...method, result: receipt })),
  {
    method: "inputs.revisionPending",
    params: { target: pendingTarget },
    invoke: (client: DaemonClient) => client.inputsRevisionPending({ target: pendingTarget }),
    result: pending,
  },
];

function transport(result: unknown, ok = true) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const request = RequestMessageSchema.parse(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ kind: "response", id: request.id, ok, ...(ok ? { result } : { error: result }) }),
      { headers: { "content-type": "application/json" } },
    );
  });
}

describe("operator revision bridge client", () => {
  it.each(methods)(
    "sends $method params intact and preserves its typed result",
    async ({ method, params, invoke, result }) => {
      const fetchImpl = transport(result);
      const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl);
      expect(await invoke(client)).toEqual(result);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("http://127.0.0.1:6722/rpc");
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ kind: "request", id: 1, method, params });
    },
  );

  it.each(writes)("preserves an in-progress $method operation without inventing a receipt", async ({ invoke }) => {
    const result: RevisionResult = {
      state: "in-progress",
      operationId: "operation-pending",
      recovery: "inspect-or-retry",
    };
    expect(await invoke(new DaemonClient("http://127.0.0.1:6722", transport(result)))).toEqual(result);
  });

  it("preserves an unavailable pending revision without requiring a payload", async () => {
    const result: PendingRevisionView = {
      target: pendingTarget,
      expectedRevision: "revision-2",
      state: "delivered",
      replacementAllowed: false,
      unavailableReason: "delivered",
    };
    const client = new DaemonClient("http://127.0.0.1:6722", transport(result));
    expect(await client.inputsRevisionPending({ target: pendingTarget })).toEqual(result);
  });

  it.each(methods)("retains $method refusal codes and details", async ({ invoke }) => {
    const error = {
      code: "REVISION_STALE",
      message: "The revision target has changed",
      details: { expectedRevision: "revision-1", actualRevision: "revision-2" },
    };
    const fetchImpl = transport(error, false);
    const client = new DaemonClient("http://127.0.0.1:6722", fetchImpl);
    const failure: unknown = await invoke(client).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(DaemonClientError);
    expect(failure).toMatchObject({ error });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(methods)("validates $method results rather than accepting a malformed receipt", async ({ invoke }) => {
    const client = new DaemonClient("http://127.0.0.1:6722", transport({ state: "resolved" }));
    await expect(invoke(client)).rejects.toBeInstanceOf(z.ZodError);
  });

  it.each(methods)("requires credentials before sending $method to a remote daemon", async ({ invoke }) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new DaemonClient("https://orca.example", fetchImpl, { requireAuthentication: true });
    await expect(invoke(client)).rejects.toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
