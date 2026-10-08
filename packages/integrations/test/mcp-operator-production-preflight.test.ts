/** Compiled MCP preflight/guard refusals must not publish run, Request, admission or retry intent. */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { OperatorMutationContracts, OperatorPreflightResultSchema } from "@orca/protocol";
import { FileAdmissionStore } from "../../engine/src/program/submission-store.js";
import { ProductionFixture, accepted, refused, tool, transports } from "./mcp-operator-production-fixture.js";

let f: ProductionFixture;
beforeEach(async () => {
  f = await ProductionFixture.create();
  // Change only disposable fixture assets while its compiled daemon is stopped.
  await f.stop();
  const definition = JSON.parse(await readFile(join(f.dir, "workflows/gate.yaml"), "utf8")) as object;
  await writeFile(
    join(f.dir, "workflows/typed.yaml"),
    JSON.stringify({
      ...definition,
      id: "typed",
      name: "Typed acceptance gate",
      inputSchema: {
        unknown: "reject",
        fields: {
          count: { type: "integer", required: true },
          // Request submission injects its own Request object; direct launches omit it.
          request: { type: "object" },
        },
      },
    }),
  );
  await f.boot();
});
afterEach(async () => {
  await f?.close();
});

async function noAdmission() {
  const dir = join(f.dir, "state");
  const stores = fileStores(dir);
  expect(await stores.events.listRuns()).toEqual([]);
  expect(await stores.requests.list()).toEqual([]);
  expect(await new FileAdmissionStore(dir).records.list()).toEqual([]);
  const retryFiles = await readdir(join(dir, "admission-retries")).catch((error: unknown): string[] => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  // Normal daemon startup scans recovery and writes an empty pagination cursor.
  // That cursor is not a claim; every catalog/pointer/ordinal entry must remain absent.
  expect(retryFiles.filter((name) => name !== "cursor.json")).toEqual([]);
  if (retryFiles.includes("cursor.json"))
    expect(JSON.parse(await readFile(join(dir, "admission-retries/cursor.json"), "utf8"))).toBe(0);
}

describe.each(transports)("compiled production preflight via %s", (transport) => {
  it("P01 refuses invalid inputs and stale guards before durable intent, then accepts each corrected same key once", async (ctx) => {
    const peer = await f.connect(transport);
    await f.requireProduction(ctx, peer);
    const validCommands = [];
    for (const purpose of ["workflow", "request"] as const) {
      const preflight = async (vars: Record<string, unknown>) =>
        OperatorPreflightResultSchema.parse(
          await tool(peer.client, "preflight_launch", {
            target: peer.target,
            workflowId: "typed",
            purpose,
            vars,
          }),
        );
      const invalid = await preflight({ count: "invalid" });
      expect(invalid.validation).toMatchObject({ ok: false, errors: [{ path: "vars.count" }] });
      await noAdmission();
      const valid = await preflight({ count: 2 });
      expect(valid.validation).toMatchObject({ ok: true, errors: [] });
      expect(valid.expectedWorkflowRevision).toBe(invalid.expectedWorkflowRevision);
      expect(valid.expectedConfigGeneration).toBe(invalid.expectedConfigGeneration);
      await noAdmission();
      const params = {
        target: peer.target,
        command: {
          workflowId: valid.workflowId,
          workflowVersion: valid.workflowVersion,
          expectedWorkflowRevision: valid.expectedWorkflowRevision,
          expectedConfigGeneration: valid.expectedConfigGeneration,
          vars: { count: 2 },
          ...(purpose === "request" ? { title: "Guard acceptance", body: "SYNTHETIC REQUEST" } : {}),
        },
        retry: { idempotencyKey: `fresh-${purpose}` },
      };
      const name = purpose === "request" ? "submit_request" : "start_workflow";
      for (const { patch, code } of [
        { patch: { vars: { count: "invalid" } }, code: "WORKFLOW_INPUT_INVALID" },
        { patch: { expectedConfigGeneration: "stale-generation" }, code: "CONFIG_STALE" },
        { patch: { expectedWorkflowRevision: "stale-revision" }, code: "WORKFLOW_INVALID" },
      ]) {
        await refused(peer, name, { ...params, command: { ...params.command, ...patch } }, code);
        await noAdmission();
      }
      validCommands.push({ name, params, purpose });
    }
    // Correcting an unclaimed intent preserves the key; accepting it permits only exact replay.
    for (const { name, params, purpose } of validCommands) {
      const contract =
        OperatorMutationContracts[purpose === "request" ? "operator.submitRequest" : "operator.admitRun"];
      const first = accepted(contract.result.parse(await tool(peer.client, name, params)));
      expect(first.replayed).toBe(false);
      expect(Boolean("requestId" in first.result)).toBe(purpose === "request");
      expect(accepted(contract.result.parse(await tool(peer.client, name, params)))).toEqual({
        ...first,
        replayed: true,
      });
      await f.pending(peer, first.result.runId);
      expect((await f.events(first.result.runId)).filter((event) => event.type === "run.created")).toHaveLength(1);
    }
    const stores = fileStores(join(f.dir, "state"));
    expect(await stores.events.listRuns()).toHaveLength(2);
    expect(await stores.requests.list()).toHaveLength(1);
    expect(await new FileAdmissionStore(join(f.dir, "state")).records.list()).toHaveLength(1);
  });
});
