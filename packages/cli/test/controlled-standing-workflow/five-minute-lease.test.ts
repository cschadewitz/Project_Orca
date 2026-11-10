/** A five-minute real lease with a distinct post-approval human action.
 * Split out of core.test.ts: it waits in real time, so in its own file it runs beside the rest of the suite instead of in front of it.
 */
import fs from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { runControlledOwnedReadTest } from "../controlled-owned-read/producer-expanded.js";
import { bootstrap, supervisor } from "./fixture.js";

it("uses a five-minute real lease with a distinct post-approval human action and the same standing grant", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  // A short action lifetime: the scenario still waits out a real expiry, just not the default 55 s one.
  Object.assign(c.options, { ownerDurationMs: 300000, waitAfterSaveExpiry: true, actionTtlMs: 8000 });
  const phase = c.options.phase.bind(c.options);
  c.options.phase = async (name, work) => {
    const started = performance.now();
    process.stdout.write(JSON.stringify({ record: "standing-workflow-phase", phase: name, state: "started" }) + "\n");
    try {
      await phase(name, work);
    } finally {
      process.stdout.write(
        JSON.stringify({
          record: "standing-workflow-phase",
          phase: name,
          state: "settled",
          elapsedMs: Math.round(performance.now() - started),
        }) + "\n",
      );
    }
  };
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(c.observed.map((effect) => ({ phase: effect.phase, bytes: effect.bytes }))).toEqual([
    { phase: "human-read", bytes: "spos" },
    { phase: "rule-read", bytes: "spos" },
  ]);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  const records = await Promise.all(
    result.semanticRefs.map(async (ref) => {
      const payload = (await stores.execution.getPayload("controlled", ref, "agent.update")) as {
        update: { text: string };
      };
      return JSON.parse(payload.update.text) as { kind: string; value: Record<string, unknown> };
    }),
  );
  const captures = records
    .filter((record) => record.kind === "controlled-capture-v1")
    .map(
      (record) =>
        record.value.action as {
          actionId: string;
          expiresAt: string;
          invocation: { invocationId: string };
        },
    );
  expect(captures).toHaveLength(3);
  expect(new Set(captures.map((action) => action.actionId)).size).toBe(3);
  expect(captures[1]!.invocation.invocationId).toBe("controlled-fresh-human-invocation");
  expect(captures[2]!.invocation.invocationId).toBe("controlled-rule-invocation");
  const issued = records.find((record) => record.kind === "controlled-fresh-authority-v1")!.value as {
    observedAt: number;
    leaseExpiresAt: number;
    lease: { guardedTtlMs: number };
  };
  expect(issued.lease.guardedTtlMs).toBe(300000);
  expect(issued.observedAt).toBeGreaterThan(Date.parse(captures[0]!.expiresAt));
  expect(Date.parse(captures[1]!.expiresAt)).toBeGreaterThan(issued.observedAt);
  // Factory observation precedes an awaited protected write. It is not the
  // execution-window origin; the fresh capture's precise cap is tested separately.
  expect(Date.parse(captures[1]!.expiresAt)).toBeLessThanOrEqual(issued.leaseExpiresAt);
  expect(records.findIndex((record) => record.kind === "controlled-deferred-intent-v1")).toBeLessThan(
    records.findIndex((record) => record.kind === "controlled-final-delivery-ack-v1"),
  );
  expect(records.findIndex((record) => record.kind === "controlled-final-delivery-ack-v1")).toBeLessThan(
    records.findIndex((record) => record.kind === "controlled-fresh-authority-v1"),
  );
  const questions = await stores.events.readTypes("controlled", ["human.requested"]);
  const answers = await stores.events.readTypes("controlled", ["human.answered"]);
  expect(questions).toHaveLength(2);
  expect(answers).toHaveLength(1);
  if (answers[0]?.type === "human.answered" && questions[1]?.type === "human.requested")
    expect(answers[0].payload.requestId).toBe(questions[1].payload.requestId);
  const sidecar = JSON.parse(fs.readFileSync(join(c.base, "workspace/orca.permissions.json"), "utf8")) as {
    scopedRules: { records: { rule: { version: number; expiresAt: null } }[] };
  };
  expect(sidecar.scopedRules.records).toHaveLength(1);
  expect(sidecar.scopedRules.records[0]!.rule).toMatchObject({ version: 2, expiresAt: null });
}, 90000);
