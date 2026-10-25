/** #594 offline bridge obligations: synthetic data/counters only, no provider or command runner. */
import { expect, it, vi } from "vitest";
import {
  CONTRACT,
  ROW_BYTES,
  RESULT_BYTES,
  captureOffline,
  fitsReview,
  type Capture,
  type Json,
  type Owner,
  type Review,
} from "./fixtures/command-evidence-v1.js";

const frame = (row: Review): Json => ({ jsonrpc: "2.0", id: "fixture", result: { rows: [row as unknown as Json] } });
const keys = ["runId", "stepRunId", "requestId", "instanceId", "sessionId", "turnId", "invocationId"] as const;
function fixture(change: (capture: Capture) => void = () => {}) {
  const abort = new AbortController();
  let time = 100;
  const capture: Capture = {
    contract: CONTRACT,
    source: { bridge: "synthetic-bridge-v1", native: "synthetic-native-v1", semantics: "offline-reference" },
    target: {
      runId: "run",
      stepRunId: "step",
      requestId: "request",
      instanceId: "boot",
      sessionId: "session",
      turnId: "turn",
      invocationId: "invocation",
    },
    native: {
      connection: {},
      callback: {},
      requestId: 594,
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: "native-thread",
        turnId: "native-turn",
        itemId: "native-item",
        approvalId: null,
        environmentId: "synthetic-environment",
        startedAtMs: 99,
        command: "/bin/bash -lc 'printf orca-594'",
        cwd: "/synthetic/594",
        networkApprovalContext: null,
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "decline", "cancel"],
        reason: "PRIVATE_REASON_SENTINEL",
        commandActions: [{ type: "unknown", command: "PRIVATE_ACTION_SENTINEL" }],
      },
    },
    acp: {
      requestId: "acp-594",
      sessionId: "native-thread",
      toolCallId: "native-item",
      offered: [
        {
          optionId: "opaque-1",
          name: "Translated choice",
          kind: "allow_once",
          nativeDecision: "accept",
          scope: "command",
        },
        {
          optionId: "opaque-2",
          name: "Yes (misleading label)",
          kind: "reject_once",
          nativeDecision: "decline",
          scope: "none",
        },
        { optionId: "opaque-3", name: "Cancel", kind: "reject_once", nativeDecision: "cancel", scope: "none" },
      ],
    },
    scopeEvidence: "complete",
    representation: "native-shell-quoted",
    lease: {},
    expiresAt: 200,
  };
  change(capture);
  const order: string[] = [];
  const owner: Owner = {
    signal: abort.signal,
    now: () => time,
    current: () => capture,
    withOwnership: vi.fn(async (operation) => operation()),
    authorize: vi.fn(async () => {}),
    record: vi.fn(async () => {
      order.push("record");
    }),
    deliver: vi.fn(async () => {
      order.push("deliver");
    }),
  };
  const pending = captureOffline(capture, owner);
  return {
    capture,
    pending,
    owner,
    abort,
    order,
    setTime: (value: number) => {
      time = value;
    },
  };
}
async function review(f: ReturnType<typeof fixture>) {
  const row = await f.pending.review(frame);
  expect(row.state).toBe("complete");
  if (row.state !== "complete") throw new Error("fixture needs a complete review");
  return row;
}
const answer = (r: Review, optionId = "opaque-1") => ({ reviewId: r.reviewId, target: r.target, optionId });

it("preserves original wrappers, original native representation and exact mapping without parsing or execution", async () => {
  const commands = [
    "printf orca-594",
    "/bin/bash -c 'printf orca-594'",
    "/bin/bash -lc 'printf orca-594'",
    "/bin/zsh -c 'printf orca-594'",
    "printf first\nprintf second",
    "'printf orca-594'",
  ];
  const rows = await Promise.all(
    commands.map((command) =>
      review(
        fixture((c) => {
          c.native.params.command = command;
        }),
      ),
    ),
  );
  expect(rows.map((row) => row.native.command.text)).toEqual(commands);
  expect(new Set(rows.map((row) => row.native.command.text)).size).toBe(commands.length);
  const row = rows[0]!;
  expect(row.native.approvalId).toBeNull();
  expect(row.native.requestId).toBe(594);
  expect(row.acp.offered).toEqual(row.options);
  expect(JSON.stringify(row)).not.toMatch(
    /PRIVATE_REASON_SENTINEL|PRIVATE_ACTION_SENTINEL|callback|connection|lease|digest/,
  );
});

it("retains offered order and delivers a misleadingly labelled reject as the original native reject", async () => {
  const f = fixture((c) => {
    c.acp.offered.reverse();
  });
  const row = await review(f);
  expect(row.options.map((o) => o.optionId)).toEqual(["opaque-3", "opaque-2", "opaque-1"]);
  expect(await f.pending.answer(answer(row, "opaque-2"))).toEqual({ recorded: true, delivered: true });
  expect(f.owner.deliver).toHaveBeenCalledExactlyOnceWith("decline");
  expect(f.order).toEqual(["record", "deliver"]);
});

it.each([
  [
    "unknown version",
    (c: Capture) => {
      c.contract = "orca.command-evidence/2";
    },
    "unsupported",
  ],
  [
    "legacy source",
    (c: Capture) => {
      c.source = { bridge: "2.2.2", native: "0.160.1", semantics: "unsupported" };
    },
    "unsupported",
  ],
  [
    "missing scope",
    (c: Capture) => {
      c.scopeEvidence = "missing";
    },
    "incomplete",
  ],
  [
    "stripped experimental scope",
    (c: Capture) => {
      c.scopeEvidence = "experimental-stripped";
    },
    "incomplete",
  ],
  [
    "absent extra scope field",
    (c: Capture) => {
      delete c.native.params.additionalPermissions;
    },
    "incomplete",
  ],
  [
    "unknown environment",
    (c: Capture) => {
      c.native.params.environmentId = null;
    },
    "incomplete",
  ],
  [
    "missing callback null semantics",
    (c: Capture) => {
      delete c.native.params.approvalId;
    },
    "incomplete",
  ],
  [
    "missing command",
    (c: Capture) => {
      delete c.native.params.command;
    },
    "incomplete",
  ],
  [
    "missing cwd",
    (c: Capture) => {
      delete c.native.params.cwd;
    },
    "incomplete",
  ],
  [
    "no authoritative offers",
    (c: Capture) => {
      delete c.native.params.availableDecisions;
    },
    "incomplete",
  ],
  [
    "missing native kind",
    (c: Capture) => {
      delete c.native.params.kind;
    },
    "unsupported",
  ],
  [
    "unknown new native field",
    (c: Capture) => {
      c.native.params.futureScope = true;
    },
    "unsupported",
  ],
  [
    "lossy representation",
    (c: Capture) => {
      c.representation = "unknown";
    },
    "unsupported",
  ],
  [
    "network context",
    (c: Capture) => {
      c.native.params.networkApprovalContext = { host: "synthetic.invalid" };
    },
    "unsupported",
  ],
  [
    "additional permissions",
    (c: Capture) => {
      c.native.params.additionalPermissions = { network: true };
    },
    "unsupported",
  ],
  [
    "policy amendment",
    (c: Capture) => {
      c.native.params.proposedExecpolicyAmendment = ["printf"];
    },
    "unsupported",
  ],
  [
    "network policy amendment",
    (c: Capture) => {
      c.native.params.proposedNetworkPolicyAmendments = [];
    },
    "unsupported",
  ],
  [
    "profile request",
    (c: Capture) => {
      c.native.method = "item/permissions/requestApproval";
      c.acp.offered[0]!.scope = "turn";
    },
    "unsupported",
  ],
  [
    "subcommand",
    (c: Capture) => {
      c.native.params.kind = "subcommand";
      c.native.params.approvalId = "distinct";
    },
    "unsupported",
  ],
  [
    "stdin",
    (c: Capture) => {
      c.native.params.kind = "stdin";
    },
    "unsupported",
  ],
  [
    "turn grant labelled allow_once",
    (c: Capture) => {
      c.acp.offered[0]!.scope = "turn";
    },
    "unsupported",
  ],
  [
    "session grant",
    (c: Capture) => {
      c.acp.offered[0]!.scope = "session";
    },
    "unsupported",
  ],
  [
    "policy grant",
    (c: Capture) => {
      c.acp.offered[0]!.scope = "policy";
    },
    "unsupported",
  ],
  [
    "forged reject mapping",
    (c: Capture) => {
      c.acp.offered[0]!.kind = "reject_once";
    },
    "unsupported",
  ],
  [
    "duplicate option id",
    (c: Capture) => {
      c.acp.offered[1]!.optionId = "opaque-1";
    },
    "unsupported",
  ],
  [
    "different ACP thread",
    (c: Capture) => {
      c.acp.sessionId = "other";
    },
    "unsupported",
  ],
] as const)("refuses %s without disclosing private fields or permitting selection", async (_name, change, state) => {
  const f = fixture(change);
  expect(await f.pending.review(frame)).toEqual({ state, options: [] });
  await expect(
    f.pending.answer({ reviewId: "forged", target: f.capture.target, optionId: "opaque-1" }),
  ).rejects.toThrow("EVIDENCE_UNAVAILABLE");
  expect(f.owner.record).not.toHaveBeenCalled();
  expect(f.owner.deliver).not.toHaveBeenCalled();
});

it.each(keys)("binds every ORCA lifetime field: %s", async (key) => {
  const f = fixture();
  const row = await review(f);
  f.capture.target[key] += "-changed";
  await expect(f.pending.answer(answer(row))).rejects.toThrow();
  expect(f.owner.deliver).not.toHaveBeenCalled();
});

it.each([
  [
    "native request ID",
    (c: Capture) => {
      c.native.requestId = "594";
    },
  ],
  [
    "native method",
    (c: Capture) => {
      c.native.method += "other";
    },
  ],
  [
    "native connection",
    (c: Capture) => {
      c.native.connection = {};
    },
  ],
  [
    "native callback same item",
    (c: Capture) => {
      c.native.callback = {};
    },
  ],
  [
    "lease replacement",
    (c: Capture) => {
      c.lease = {};
    },
  ],
  [
    "native approval ID",
    (c: Capture) => {
      c.native.params.approvalId = "distinct-callback";
    },
  ],
  [
    "native thread",
    (c: Capture) => {
      c.native.params.threadId = "other-thread";
    },
  ],
  [
    "native turn",
    (c: Capture) => {
      c.native.params.turnId = "other-turn";
    },
  ],
  [
    "native item",
    (c: Capture) => {
      c.native.params.itemId = "other-item";
    },
  ],
  [
    "native environment",
    (c: Capture) => {
      c.native.params.environmentId = "other-env";
    },
  ],
  [
    "command wrapper",
    (c: Capture) => {
      c.native.params.command = "/bin/zsh -c 'printf orca-594'";
    },
  ],
  [
    "cwd",
    (c: Capture) => {
      c.native.params.cwd = "/other";
    },
  ],
  [
    "scope",
    (c: Capture) => {
      c.native.params.additionalPermissions = { network: true };
    },
  ],
  [
    "offered mapping",
    (c: Capture) => {
      c.acp.offered[0]!.nativeDecision = "acceptForSession";
    },
  ],
  [
    "offered label",
    (c: Capture) => {
      c.acp.offered[0]!.name = "changed";
    },
  ],
  [
    "ACP pending ID",
    (c: Capture) => {
      c.acp.requestId = "other";
    },
  ],
  [
    "expiry extension",
    (c: Capture) => {
      c.expiresAt++;
    },
  ],
  [
    "native source",
    (c: Capture) => {
      c.source.native = "other-build";
    },
  ],
] as const)("refuses changed %s at answer time", async (_name, change) => {
  const f = fixture();
  const row = await review(f);
  change(f.capture);
  await expect(f.pending.answer(answer(row))).rejects.toThrow();
  expect(f.owner.record).not.toHaveBeenCalled();
  expect(f.owner.deliver).not.toHaveBeenCalled();
});

it.each(["abort", "expired", "owner-death", "restart", "revoked", "lease-loss"])(
  "refuses %s under original ownership",
  async (cause) => {
    const f = fixture();
    const row = await review(f);
    if (cause === "abort" || cause === "owner-death") f.abort.abort();
    if (cause === "expired") f.setTime(200);
    if (cause === "restart") f.capture.target.instanceId = "new-boot";
    if (cause === "revoked") vi.mocked(f.owner.authorize).mockRejectedValue(new Error("revoked"));
    if (cause === "lease-loss") vi.mocked(f.owner.withOwnership).mockRejectedValue(new Error("lease lost"));
    await expect(f.pending.answer(answer(row))).rejects.toThrow();
    expect(f.owner.deliver).not.toHaveBeenCalled();
  },
);

it("claims once before await; duplicate or concurrent answers cannot deliver twice", async () => {
  const f = fixture();
  const row = await review(f);
  const results = await Promise.allSettled([f.pending.answer(answer(row)), f.pending.answer(answer(row))]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  await expect(f.pending.answer(answer(row))).rejects.toThrow();
  expect(f.owner.deliver).toHaveBeenCalledExactlyOnceWith("accept");
});

it.each(["record", "deliver"] as const)("never retries uncertain %s or lost acknowledgement", async (hook) => {
  const f = fixture();
  const row = await review(f);
  vi.mocked(f.owner[hook]).mockRejectedValue(new Error("uncertain"));
  await expect(f.pending.answer(answer(row))).rejects.toThrow("uncertain");
  await expect(f.pending.answer(answer(row))).rejects.toThrow("EVIDENCE_UNAVAILABLE");
  expect(f.owner[hook]).toHaveBeenCalledTimes(1);
  if (hook === "record") expect(f.owner.deliver).not.toHaveBeenCalled();
});

it("rechecks after recording; changed evidence records an answer without delivery", async () => {
  const f = fixture();
  const row = await review(f);
  vi.mocked(f.owner.record).mockImplementation(async () => {
    f.capture.native.params.cwd = "/changed";
  });
  expect(await f.pending.answer(answer(row))).toEqual({ recorded: true, delivered: false });
  expect(f.owner.deliver).not.toHaveBeenCalled();
});

it("rechecks after asynchronous authority verification", async () => {
  const f = fixture();
  const row = await review(f);
  vi.mocked(f.owner.authorize).mockImplementation(async () => {
    f.capture.native.callback = {};
  });
  await expect(f.pending.answer(answer(row))).rejects.toThrow();
  expect(f.owner.record).not.toHaveBeenCalled();
});

it("forged metadata, unknown selection, wrong target and standing requests confer no authority", async () => {
  const f = fixture();
  const row = await review(f);
  for (const request of [
    { ...answer(row), reviewId: "forged" },
    answer(row, "unknown"),
    { ...answer(row), target: { ...row.target, invocationId: "wrong" } },
    { ...answer(row), standing: true },
  ]) {
    await expect(f.pending.answer(request)).rejects.toThrow();
  }
  expect(f.owner.record).not.toHaveBeenCalled();
  expect(f.owner.deliver).not.toHaveBeenCalled();
  // Returned row is a copy, never the bound internal evidence.
  row.native.command.text = "forged";
  row.acp.offered[0]!.nativeDecision = "acceptForSession";
  expect(await f.pending.answer(answer(row))).toEqual({ recorded: true, delivered: true });
  expect(f.owner.deliver).toHaveBeenCalledExactlyOnceWith("accept");
});

it("requires separately authorized private review before answering and never leaks refused evidence", async () => {
  const f = fixture();
  vi.mocked(f.owner.authorize).mockRejectedValue(new Error("forbidden"));
  await expect(f.pending.review(frame)).rejects.toThrow("forbidden");
  await expect(
    f.pending.answer({ reviewId: "guessed", target: f.capture.target, optionId: "opaque-1" }),
  ).rejects.toThrow();
  expect(f.owner.deliver).not.toHaveBeenCalled();
});

it("enforces exact UTF-8 JSON row and fully framed result boundaries", async () => {
  const row = await review(fixture());
  const used = Buffer.byteLength(JSON.stringify(row));
  row.native.command.text += "x".repeat(ROW_BYTES - used);
  expect(Buffer.byteLength(JSON.stringify(row))).toBe(ROW_BYTES);
  expect(fitsReview(row, frame)).toBe(true);
  row.native.command.text += "é";
  expect(fitsReview(row, frame)).toBe(false);
  const small = await review(fixture());
  const framing = Buffer.byteLength(JSON.stringify({ row: small, padding: "" }));
  const pad = "x".repeat(RESULT_BYTES - framing);
  expect(fitsReview(small, (r) => ({ row: r as unknown as Json, padding: pad }))).toBe(true);
  expect(fitsReview(small, (r) => ({ row: r as unknown as Json, padding: pad + "x" }))).toBe(false);
});

it.each(["row", "result"])("oversized %s returns no command or positive option", async (bound) => {
  const f = fixture((c) => {
    if (bound === "row") c.native.params.command = "é".repeat(ROW_BYTES);
  });
  const output = await f.pending.review((r) => ({
    row: r as unknown as Json,
    padding: bound === "result" ? "x".repeat(RESULT_BYTES) : "",
  }));
  expect(output).toEqual({ state: "incomplete", options: [] });
  await expect(
    f.pending.answer({ reviewId: "guessed", target: f.capture.target, optionId: "opaque-1" }),
  ).rejects.toThrow();
  expect(f.owner.deliver).not.toHaveBeenCalled();
});
