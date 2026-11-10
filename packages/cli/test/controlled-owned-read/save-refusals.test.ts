/** Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 */
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores } from "@orca/store";
import * as daemonTransport from "../../../daemon/src/server.js";
import { runControlledOwnedReadTest } from "./producer.js";
import { bootstrap, supervisor } from "./fixture.js";

it.each(["missing", "refusing", "hanging"] as const)(
  "%s standing reviewer disables Save while ordinary answers remain available",
  async (fault) => {
    const b = await bootstrap();
    for (const choice of (fault === "hanging" ? ["allow-once", "deny"] : ["save", "allow-once", "deny"]) as readonly (
      "save" | "allow-once" | "deny"
    )[]) {
      const c = await supervisor("connected", b.grant);
      Object.assign(c.options, { standingReviewerFault: fault });
      const dispatch = daemonTransport.dispatch;
      let selected: Awaited<ReturnType<typeof dispatch>> | undefined;
      const spy = vi.spyOn(daemonTransport, "dispatch").mockImplementation(async (text, ...rest) => {
        const request = JSON.parse(text) as { method: string; params: { choice?: string } };
        if (request.method === "scopedPermissions.choose") {
          request.params.choice = choice;
          selected = await dispatch(JSON.stringify(request), ...rest);
          return selected;
        }
        return dispatch(text, ...rest);
      });
      try {
        // This producer expects Save and intentionally stops after this substituted
        // answer. The actual authenticated bridge/owner records its real outcome.
        const error = await runControlledOwnedReadTest(c.base, "connected", c.options).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(Error);
        expect(selected, `${choice}: ${String(error)}`).toBeDefined();
        if (choice === "save") {
          if (selected?.ok) expect(selected.result).not.toMatchObject({ outcome: "saved" });
        } else {
          expect(selected?.ok).toBe(true);
          if (selected?.ok) expect(selected.result).toMatchObject({ outcome: "answered" });
        }
        const stores = fileStores(join(c.base, "workspace/.orca"));
        const answers = await stores.events.readTypes("controlled", ["human.answered"]);
        expect(answers.filter((event) => event.type === "human.answered").map((event) => event.payload.answer)).toEqual(
          choice === "save" ? [] : [choice === "deny" ? "deny" : "once"],
        );
        expect(await stores.events.readTypes("controlled", ["agent.permission"])).toEqual([]);
        expect(c.observed).toEqual([]);
      } finally {
        spy.mockRestore();
        c.restore();
      }
    }
  },
);

it("the saved standing grant qualifies a fresh action after the original action expires", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  Object.assign(c.options, { ownerDurationMs: 300000 });
  const originalPhase = c.options.phase.bind(c.options);
  let expiredActionAt = 0;
  let advanced: ReturnType<typeof vi.spyOn> | undefined;
  c.options.phase = (name, work) =>
    originalPhase(name, async () => {
      if (name === "rule-read") {
        const stores = fileStores(join(c.base, "workspace/.orca"));
        const approved = (await stores.events.readTypes("controlled", ["agent.permission"]))[0]!;
        const payload = (await stores.execution.getPayload(
          "controlled",
          approved.executionPayloadRef!,
          "agent.permission",
        )) as {
          entry: {
            version: number;
            command: { rule: { version: number; expiresAt: null } };
            action: { expiresAt: string };
          };
        };
        expect(payload.entry.version).toBe(2);
        expect(payload.entry.command.rule).toMatchObject({ version: 2, expiresAt: null });
        expiredActionAt = Date.parse(payload.entry.action.expiresAt);
        const lease = await stores.leases.get("run:controlled");
        expect(lease!.guardedTtlMs).toBe(300000);
        expect(expiredActionAt + 1).toBeLessThan(Date.parse(lease!.renewedAt) + lease!.guardedTtlMs!);
        // Simulated clock transition, not a real elapsed-time/effect-proof claim.
        const realNow = Date.now.bind(Date);
        const advance = expiredActionAt + 1 - realNow();
        advanced = vi.spyOn(Date, "now").mockImplementation(() => realNow() + advance);
      }
      await work();
    });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    const payload = (await stores.execution.getPayload("controlled", result.authorizationRefs[1]!, "agent.update")) as {
      update: { text: string };
    };
    const execution = JSON.parse(payload.update.text).value as {
      action: { expiresAt: string };
      verdict: { authorizedBy: { kind: string } };
    };
    expect(execution.verdict.authorizedBy.kind).toBe("rule");
    expect(Date.parse(execution.action.expiresAt)).toBeGreaterThan(expiredActionAt + 1);
    expect(c.observed.map((effect) => effect.phase)).toEqual(["human-read", "rule-read"]);
  } finally {
    advanced?.mockRestore();
  }
});

it("connects actual Save, separately settled original Allow once and fresh rule execution", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(c.observed).toEqual([
    { phase: "human-read", offset: 2, length: 4, bytes: "spos" },
    { phase: "rule-read", offset: 2, length: 4, bytes: "spos" },
  ]);
  expect(result.initialRevision).not.toBe(result.finalRevision);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  const records = await Promise.all(
    result.authorizationRefs.map((ref) => stores.execution.getPayload("controlled", ref, "agent.update")),
  );
  const values = records.map(
    (payload) =>
      JSON.parse((payload as { update: { text: string } }).update.text).value as {
        action: { invocation: { invocationId: string } };
        verdict: { authorizedBy: { kind: string; acceptedAnswerRef?: string } };
      },
  );
  expect(values.map((v) => v.verdict.authorizedBy.kind)).toEqual(["human", "rule"]);
  expect(values[0]!.action.invocation.invocationId).not.toBe(values[1]!.action.invocation.invocationId);
  const answers = await stores.events.readTypes("controlled", ["human.answered"]);
  expect(answers).toHaveLength(1);
  expect(values[0]!.verdict.authorizedBy.acceptedAnswerRef).toBe(JSON.stringify(["controlled", answers[0]!.id]));
  const approvals = await stores.events.readTypes("controlled", ["agent.permission"]);
  expect(approvals).toHaveLength(1);
  const approval = (await stores.execution.getPayload(
    "controlled",
    approvals[0]!.executionPayloadRef!,
    "agent.permission",
  )) as { entry: { requiredReview: string; persistenceReview: { result: string } } };
  expect(approval.entry.requiredReview).toBe("unavailable");
  expect(approval.entry.persistenceReview.result).toBe("passed");
  // Budget the complete three-phase fixture separately from its unchanged
  // individual action and lease fences; do not remove a running fixture at 30s.
}, 60000);
it.each(["review-proof", "reviewer-revoked", "stale-revision", "lost-ack", "cancel", "wrong-interval"] as const)(
  "refuses %s without an extra read",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant, fault);
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed.filter((r) => r.phase === "save")).toEqual([]);
    expect(c.observed.length).toBe(fault === "wrong-interval" ? 1 : 0);
  },
  30000,
);
it("refuses unknown bootstrap evidence before creating connected state", async () => {
  const c = await supervisor("connected");
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(c.phases).toEqual([]);
  expect(c.observed).toEqual([]);
});
