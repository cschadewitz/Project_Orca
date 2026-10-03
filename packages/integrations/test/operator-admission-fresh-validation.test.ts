/** Prospective refusal must not consume retry intent: real compiled daemons and production claims. */
import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OPERATOR_MAX_RESULT_BYTES, RunsEventsResultSchema } from "@orca/protocol";
import { ProductionFixture, accepted, rpcResult, transports, until } from "./mcp-operator-production-fixture.js";

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

      // Both concurrent fresh callers use the target whose pinned generation is current.
      const params = { target: first.target, command, retry };
      const replies = await Promise.all([f.mutation(first, method, params), f.mutation(first, method, params)]);
      expect(new Set(replies.map((reply) => reply.operationId)).size).toBe(1);
      const receipt = accepted(await f.mutation(first, method, params));
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
