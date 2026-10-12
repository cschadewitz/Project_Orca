/** Prospective refusal must not consume retry intent: real compiled daemons and production claims. */
import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OPERATOR_MAX_RESULT_BYTES, OperatorMutationContracts, RunsEventsResultSchema } from "@orca/protocol";
import { withFileLock } from "../../store/src/file-lock.js";
import {
  ProductionFixture,
  accepted,
  rpcResult,
  sharedFixture,
  transports,
  until,
} from "./mcp-operator-production-fixture.js";

const fixtures: ProductionFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});

async function claimCount(f: ProductionFixture): Promise<number> {
  try {
    return (
      JSON.parse(await readFile(join(f.dir, "state/admission-retries/catalog.json"), "utf8")) as { total: number }
    ).total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
async function pointerCount(f: ProductionFixture): Promise<number> {
  try {
    return (await readdir(join(f.dir, "state/admission-retries"))).filter((name) =>
      /^retry_.*\.json$|^entry-\d+\.json$/.test(name),
    ).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

// A refused busy-catalog call publishes nothing, so these tests share one daemon. They still compare
// against the counts they found, in case an earlier test left something behind.
const shared = sharedFixture();

describe.each(transports)("fresh admission validation over %s", (transport) => {
  let f: ProductionFixture;
  shared.use((fixture) => {
    f = fixture;
  });

  for (const method of ["operator.admitRun", "operator.submitRequest"] as const)
    it(`${method} refuses a deliberately busy catalog without publishing a fresh claim`, async () => {
      const first = await f.connect(transport);
      const claims = await claimCount(f);
      const pointers = await pointerCount(f);
      const runs = await f.page(first, "runs");
      const requests = await f.page(first, "requests");
      const guards = await f.guards(first, "gate", method === "operator.submitRequest" ? "request" : "workflow");
      const command =
        method === "operator.submitRequest"
          ? { ...guards, title: "Busy catalog", body: "Synthetic request", vars: {} }
          : { ...guards, vars: {} };
      const retry = { idempotencyKey: "retained-busy-intent" };
      const name = method === "operator.submitRequest" ? "submit_request" : "start_workflow";
      const params = { target: first.target, command, retry };
      // A busy catalog refuses before publishing a fresh claim. Do not turn that
      // availability limit into acceptance or silently resend a mutation.
      await withFileLock(join(f.dir, "state/admission-retries/catalog.lock"), async () => {
        const busy = await first.client.callTool({ name, arguments: params });
        expect(busy.isError).toBe(true);
        expect(busy).not.toHaveProperty("structuredContent");
        const encoded = JSON.stringify(busy);
        expect(
          JSON.parse(
            (busy.content as { type: string; text?: string }[]).find((item) => item.type === "text")?.text ?? "{}",
          ),
        ).toMatchObject({ error: { code: "STORE_LOCK_TIMEOUT" } });
        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
        expect(encoded).not.toContain(retry.idempotencyKey);
        expect(encoded).not.toContain(first.token);
        expect(await claimCount(f)).toBe(claims);
        expect(await pointerCount(f)).toBe(pointers);
      });
      // No subsequent mutation: releasing our lock does not mean another daemon's
      // background recovery has relinquished the shared catalog.
      expect(await claimCount(f)).toBe(claims);
      expect(await pointerCount(f)).toBe(pointers);
      expect(await f.page(first, "runs")).toMatchObject({ items: runs.items, restartRequired: false });
      expect(await f.page(first, "requests")).toMatchObject({ items: requests.items, restartRequired: false });
    });
});

describe.each(transports)("fresh admission validation over %s", (transport) => {
  for (const method of ["operator.admitRun", "operator.submitRequest"] as const)
    it(`${method} refuses a stale target without a claim, then accepts the original key once`, async () => {
      const f = await ProductionFixture.create();
      fixtures.push(f);
      const first = await f.connect(transport);
      const secondDaemon = await f.boot();
      const second = await f.connect(transport, f.token, secondDaemon.endpoint);
      const a = await f.guards(first, "gate", method === "operator.submitRequest" ? "request" : "workflow");
      const b = await f.guards(second, "gate", method === "operator.submitRequest" ? "request" : "workflow");
      expect(first.target.workspaceId).toBe(second.target.workspaceId);
      expect(first.target.instanceId).not.toBe(second.target.instanceId);
      expect(a.expectedWorkflowRevision).toBe(b.expectedWorkflowRevision);
      expect(a.expectedConfigGeneration).not.toBe(b.expectedConfigGeneration);
      const command =
        method === "operator.submitRequest"
          ? { ...a, title: "Fresh validation", body: "Synthetic request", vars: {} }
          : { ...a, vars: {} };
      const retry = { idempotencyKey: "retained-fresh-intent" };
      const name = method === "operator.submitRequest" ? "submit_request" : "start_workflow";
      const refused = await second.client.callTool({ name, arguments: { target: second.target, command, retry } });
      expect(refused.isError).toBe(true);
      const text = JSON.stringify(refused);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
      expect(text).toContain("CONFIG_STALE");
      expect(text).not.toContain(retry.idempotencyKey);
      expect(text).not.toContain(second.token);
      expect(await claimCount(f)).toBe(0);
      expect(await pointerCount(f)).toBe(0);
      expect(await f.page(first, "runs")).toMatchObject({ items: [], restartRequired: false });
      expect(await f.page(first, "requests")).toMatchObject({ items: [], restartRequired: false });

      const params = { target: first.target, command, retry };
      // One fresh submission after the stale refusal; ordinary background contention
      // can still refuse it. This test does not establish system-wide quiescence.
      const receipt = accepted(await f.mutation(first, method, params));
      const outcomes = await Promise.all(
        [first, second].map(async (peer) => {
          const response = await peer.client.callTool({ name, arguments: { ...params, target: peer.target } });
          expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
          if (response.isError) {
            expect(response).not.toHaveProperty("structuredContent");
            const encoded = JSON.stringify(response);
            expect(
              JSON.parse(
                (response.content as { type: string; text?: string }[]).find((item) => item.type === "text")?.text ??
                  "{}",
              ),
            ).toMatchObject({ error: { code: "STORE_LOCK_TIMEOUT" } });
            expect(encoded).not.toContain(retry.idempotencyKey);
            expect(encoded).not.toContain(peer.token);
            return;
          }
          const replay = OperatorMutationContracts[method].result.parse(response.structuredContent);
          expect(response.structuredContent).toEqual(replay);
          expect(replay.operationId).toBe(receipt.operationId);
          if (replay.state === "resolved")
            expect(accepted(replay)).toMatchObject({ replayed: true, result: receipt.result });
          else
            expect(replay).toEqual({
              state: "in-progress",
              operationId: receipt.operationId,
              recovery: "inspect-or-retry",
            });
        }),
      );
      expect(outcomes).toHaveLength(2);
      expect(
        accepted(
          await f.mutation(first, "operator.admission", { target: first.target, operationId: receipt.operationId }),
        ),
      ).toMatchObject({ operationId: receipt.operationId, result: receipt.result });
      expect(await claimCount(f)).toBe(1);
      await until(
        async () =>
          RunsEventsResultSchema.parse(
            rpcResult(
              await f.rpc(
                "runs.events",
                { runId: receipt.result.runId, types: ["run.paused"], limit: 500 },
                first.token,
                first.endpoint,
              ),
            ),
          ),
        (page) => !page.hasMore && page.events.some((event) => event.type === "run.paused"),
        "accepted run pause",
      );

      // Accepted replay on the other daemon must precede fresh-generation validation.
      const replay = accepted(await f.mutation(second, method, { ...params, target: second.target }));
      expect(replay).toEqual({ ...receipt, replayed: true });
      for (const lookup of ["operator.admission", "operator.reconcileAdmission"] as const)
        expect(
          await f.mutation(second, lookup, { target: second.target, operationId: receipt.operationId }),
        ).toMatchObject({ state: "resolved", operationId: receipt.operationId, result: receipt.result });
      const conflict = await second.client.callTool({
        name,
        arguments: { ...params, target: second.target, command: { ...command, vars: { changed: true } } },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.stringify(conflict)).toContain("RETRY_CONFLICT");
      expect(Buffer.byteLength(JSON.stringify(conflict))).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
      const events = await f.events(receipt.result.runId);
      expect(events.filter((event) => event.type === "run.created")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
    });
});
