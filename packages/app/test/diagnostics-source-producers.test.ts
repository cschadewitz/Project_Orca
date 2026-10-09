/** Real source-owner facts, primitive-only output and no additional authorized operation. */
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import { DaemonClient } from "../src/client/daemon-client.js";
import { ConnectionMachine } from "../src/main/connection-state.js";
import {
  ownedDiagnosticObserver,
  observeOwnedDiagnostic,
  type OwnedDiagnosticObservation,
} from "../src/main/diagnostics/source-producers.js";
import { DIAGNOSTIC_CODES } from "../src/main/diagnostics/profile.js";

const hello: HelloResult = { protocol: PROTOCOL_VERSION, orcaVersion: "synthetic", capabilities: [] };
const reply = (result: unknown) => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result }));
const fault = (code: string, details?: unknown) =>
  new Response(
    JSON.stringify({
      kind: "response",
      id: 1,
      ok: false,
      error: { code, message: "synthetic-source-content", ...(details ? { details } : {}) },
    }),
  );

it("serialization failure has no dispatch or uncertain-admission authority", async () => {
  const observer = vi.fn();
  const transport = vi.fn();
  const params: Record<string, unknown> = {};
  params.circular = params;
  const client = new DaemonClient("http://127.0.0.1:1", transport, { onDiagnostic: observer });
  await expect(client.call("runs.admit", params, z.unknown())).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
});

it("admits only closed primitive owner facts, with no accessor/coercion or exception authority", () => {
  const record = vi.fn(() => true);
  const observer = ownedDiagnosticObserver({ record });
  for (const [phase, codes] of Object.entries(DIAGNOSTIC_CODES))
    for (const code of codes)
      if (phase !== "unknown" && code !== "unknown") observer(...([phase, code] as OwnedDiagnosticObservation));
  expect(record).toHaveBeenCalledTimes(18);
  const previous = record.mock.calls.length;
  const hostile = new Proxy(new Error("synthetic-source-exception"), {
    get() {
      throw new Error("must-not-read");
    },
  });
  observer("run", hostile as never);
  observer("run", "synthetic-source-content" as never);
  observer("run", "unknown" as never);
  expect(record).toHaveBeenCalledTimes(previous);
  expect(() =>
    observeOwnedDiagnostic(
      () => {
        throw hostile;
      },
      "lifecycle",
      "app_started",
    ),
  ).not.toThrow();
});
it("connection owner distinguishes unavailable/lost, ignores stale handshakes and isolates optional observation", async () => {
  const observer = vi.fn();
  let answer: (value: HelloResult) => void = () => undefined;
  const machine = new ConnectionMachine({
    hello: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    onChange: () => undefined,
    onDiagnostic: observer,
    quietMs: 0,
  });
  try {
    machine.linkChanged("reconnecting");
    machine.daemonExited();
    expect(observer.mock.calls).toEqual([["connection", "connection_unavailable"]]);
    machine.reset(false);
    machine.linkChanged("live");
    machine.modeChanged(true);
    machine.linkChanged("reconnecting");
    answer({ ...hello, protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 } });
    await Promise.resolve();
    expect(observer.mock.calls.at(-1)).toEqual(["connection", "connection_lost"]);
    expect(observer).not.toHaveBeenCalledWith("connection", "protocol_mismatch");
    machine.acceptHello({ ...hello, protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 } });
    expect(observer.mock.calls.at(-1)).toEqual(["connection", "protocol_mismatch"]);
    machine.authenticationFailed("AUTH_FORBIDDEN");
    expect(observer.mock.calls.at(-1)).toEqual(["connection", "authorization_denied"]);
  } finally {
    machine.close();
  }
  const isolated = new ConnectionMachine({
    hello: async () => hello,
    onChange: () => undefined,
    onDiagnostic: () => {
      throw new Error("synthetic");
    },
  });
  try {
    expect(() => isolated.daemonExited()).not.toThrow();
  } finally {
    isolated.close();
  }
});
it("admission owner records response loss and safe recoverable state without retry or content", async () => {
  const observer = vi.fn();
  const lost = new Proxy(
    {},
    {
      get() {
        throw new Error("no-error-inspection");
      },
    },
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(lost)
    .mockResolvedValueOnce(reply({ state: "recoverable-failure" }));
  const client = new DaemonClient("http://127.0.0.1:1", fetch, { onDiagnostic: observer });
  const schema = z.object({ state: z.literal("recoverable-failure") });
  await expect(client.call("runs.admit", { synthetic: true }, schema)).rejects.toBe(lost);
  expect(await client.call("runs.admit", { synthetic: true }, schema)).toEqual({ state: "recoverable-failure" });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(observer.mock.calls).toEqual([
    ["admission", "admission_uncertain"],
    ["admission", "admission_recoverable_failure"],
  ]);
});
it("pre-dispatch auth refusal is not uncertain admission, and stale hello publishes no diagnostic", async () => {
  const observer = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = new DaemonClient("https://synthetic.invalid", fetch, {
    requireAuthentication: true,
    onDiagnostic: observer,
  });
  await expect(client.call("runs.admit", {}, z.unknown())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(observer.mock.calls).toEqual([["connection", "authentication_required"]]);
  observer.mockClear();
  const stale = new DaemonClient("http://127.0.0.1:1", async () => fault("AUTH_INVALID"), { onDiagnostic: observer });
  await expect(stale.hello("synthetic", false)).rejects.toThrow();
  expect(observer).not.toHaveBeenCalled();
});
it("protected-state owner projection is required; generic RUN_STATE is insufficient", async () => {
  const observer = vi.fn();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(fault("RUN_STATE"))
    .mockResolvedValueOnce(fault("RUN_STATE", { diagnostics: { protectedState: "unavailable" } }));
  const client = new DaemonClient("http://127.0.0.1:1", fetch, { onDiagnostic: observer });
  await expect(client.runsResume({ runId: "synthetic" })).rejects.toThrow();
  expect(observer.mock.calls).toEqual([["resume", "resume_failed"]]);
  await expect(client.runsResume({ runId: "synthetic" })).rejects.toThrow();
  expect(observer.mock.calls.slice(1)).toEqual([
    ["protected_state", "protected_state_unavailable"],
    ["resume", "resume_failed"],
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each(["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN"])(
  "records only the recognized %s connection verdict",
  async (code) => {
    const observer = vi.fn();
    const client = new DaemonClient("http://127.0.0.1:1", async () => fault(code), { onDiagnostic: observer });
    await expect(client.call("runs.get", { runId: "synthetic" }, z.unknown(), false)).rejects.toThrow();
    expect(observer).toHaveBeenCalledWith(
      "connection",
      code === "AUTH_REQUIRED"
        ? "authentication_required"
        : code === "AUTH_INVALID"
          ? "authentication_invalid"
          : "authorization_denied",
    );
    expect(observer).toHaveBeenCalledTimes(1);
  },
);
