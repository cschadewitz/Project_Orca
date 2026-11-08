/** Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores, FileExecutionStore } from "@orca/store";
import * as agents from "@orca/agents";
import type { ActionEvidenceV1, PolicyEvaluationV1, StrictPermissionRule } from "@orca/core";
import { runControlledOwnedReadTest } from "./controlled-owned-read-producer.js";
import { bootstrap, cleanup, digest, supervisor } from "./controlled-owned-read-fixture.js";

it.each(["policy", "lease"] as const)(
  "refuses actual changed protected %s after Save",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    const original = c.options.phase.bind(c.options);
    c.options.phase = (name, work) =>
      original(name, async () => {
        await work();
        if (name !== "save") return;
        if (fault === "policy") await fs.promises.appendFile(join(c.base, "workspace/orca.permissions.json"), "\n");
        else await fileStores(join(c.base, "workspace/.orca")).leases.forceRelease("run:controlled");
      });
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed).toEqual([]);
  },
  30000,
);

// Regression based on the focused #744 reproduction at 3281740. This is an ordinary
// passing requirement: a fixture/setup exception is not evidence of revocation.
it("genuinely revokes the saved rule before the fresh canonical evaluation refuses it", async () => {
  const automatic: { action: ActionEvidenceV1; result: PolicyEvaluationV1 }[] = [];
  const createPolicy = agents.createStrictPolicyPort;
  // Record the unchanged result of the real strict policy; supply no replacement verdict.
  const evaluationSpy = vi.spyOn(agents, "createStrictPolicyPort").mockImplementation((options) => {
    const policy = createPolicy(options);
    return {
      ...policy,
      evaluate: async (action, signal) => {
        const result = await policy.evaluate(action, signal);
        if (action.invocation.invocationId === "controlled-rule-invocation") automatic.push({ action, result });
        return result;
      },
    };
  });
  cleanup.push(async () => evaluationSpy.mockRestore());
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant, "revoke-rule");
  let approvedRevision = "";
  const completed: string[] = [];
  const phase = c.options.phase.bind(c.options);
  c.options.phase = (name, work) =>
    phase(name, async () => {
      await work();
      completed.push(name);
      if (name === "save") approvedRevision = digest(await readFile(join(c.base, "workspace/orca.permissions.json")));
    });
  const error: unknown = await runControlledOwnedReadTest(c.base, "connected", c.options).then(
    () => {
      throw new Error("Revoked rule unexpectedly allowed a fresh execution");
    },
    (error: unknown) => error,
  );
  // Pin the origin before accepting refusal: the former error was the writer's
  // sidecar-lock exception and left an approved rule without a fresh evaluation.
  const sidecarBytes = await readFile(join(c.base, "workspace/orca.permissions.json"));
  const sidecar = JSON.parse(sidecarBytes.toString("utf8")) as {
    scopedRules: { records: { rule: StrictPermissionRule; approvalRecordRef: string }[] };
  };
  expect(sidecar.scopedRules.records.map((r) => r.rule.status)).toEqual(["revoked"]);
  expect(error).toBeInstanceOf(assert.AssertionError);
  expect((error as Error).message).toContain('result.verdict.outcome === "allow"');
  expect((error as Error).message).not.toContain("typed policy transition pending");
  expect(approvedRevision).not.toBe("");
  expect(digest(sidecarBytes)).not.toBe(approvedRevision);
  expect(automatic).toHaveLength(1);
  expect(automatic[0]!.result).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "required-policy-unavailable" },
  });
  expect(automatic[0]!.action.authority.currentPolicyRevision).toBe(digest(sidecarBytes));
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(completed).toEqual(["save", "human-read"]);
  expect(c.observed).toEqual([{ phase: "human-read", offset: 2, length: 4, bytes: "spos" }]);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  const answers = await stores.events.readTypes("controlled", ["human.answered"]);
  expect(answers).toHaveLength(1);
  const approvals = await stores.events.readTypes("controlled", ["agent.permission"]);
  expect(approvals).toHaveLength(1);
  const saved = (await stores.execution.getPayload(
    "controlled",
    approvals[0]!.executionPayloadRef!,
    "agent.permission",
  )) as {
    entry: { command: { rule: StrictPermissionRule } };
  };
  const revoked = sidecar.scopedRules.records[0]!;
  expect(revoked.rule.ruleId).toBe(saved.entry.command.rule.ruleId);
  expect(revoked.rule.ruleRevision).not.toBe(saved.entry.command.rule.ruleRevision);
  expect(revoked.rule.ruleRevision).toBe(agents.strictPermissionRuleRevision(revoked.rule));
  const [revocationRun, revocationRef] = JSON.parse(revoked.approvalRecordRef) as [string, string];
  expect(revocationRun).toBe("controlled");
  const protectedRevocation = (await stores.execution.getPayload(revocationRun, revocationRef, "agent.update")) as {
    update: { text: string };
  };
  expect(JSON.parse(protectedRevocation.update.text)).toMatchObject({
    kind: "controlled-rule-revocation-v1",
    value: {
      command: { rule: revoked.rule, expectedRevision: approvedRevision, approvalRecordRef: revoked.approvalRecordRef },
    },
  });
  const authorizationKinds: string[] = [];
  for (const name of await fs.promises.readdir(join(c.base, "workspace/.orca/private-execution"))) {
    if (!name.startsWith("synthetic-read%3A") || !name.endsWith("%3Aevidence.payload.json")) continue;
    const ref = decodeURIComponent(name.slice(0, -".payload.json".length));
    const payload = (await stores.execution.getPayload("controlled", ref, "agent.update")) as {
      update: { text: string };
    };
    const record = JSON.parse(payload.update.text) as {
      kind: string;
      value: { verdict: { authorizedBy: { kind: string } } };
    };
    expect(record.kind).toBe("controlled-authorization-v1");
    authorizationKinds.push(record.value.verdict.authorizedBy.kind);
  }
  expect(authorizationKinds).toEqual(["human"]);
}, 60000);

it.each(["credential", "lease"] as const)(
  "revocation still refuses a genuinely lost %s authority",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant, "revoke-rule");
    // Rebound to the actual receiver with call(this, ...) inside the interceptor.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const put = FileExecutionStore.prototype.putPayload;
    let injected = false;
    const proofWrite = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(async function (
      this: FileExecutionStore,
      ref,
      input,
    ) {
      await put.call(this, ref, input);
      if (
        input.type !== "agent.update" ||
        (input.payload.update as { kind?: unknown }).kind !== "controlled-rule-revocation-v1"
      )
        return;
      expect(injected).toBe(false);
      injected = true;
      if (fault === "lease") {
        expect(await fileStores(join(c.base, "workspace/.orca")).leases.forceRelease("run:controlled")).toBeDefined();
      } else {
        const { CredentialStore } = await import("../../daemon/src/auth/credentials.js");
        const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
        const actor = credentials.list().find((record) => record.principal === "controlled-test-operator")!;
        expect(await credentials.revoke(actor.id)).toBe(true);
      }
    });
    cleanup.push(async () => proofWrite.mockRestore());
    const error: unknown = await runControlledOwnedReadTest(c.base, "connected", c.options).then(
      () => {
        throw new Error("Lost authority unexpectedly published revocation");
      },
      (error: unknown) => error,
    );
    expect(injected).toBe(true);
    if (fault === "credential") {
      expect(error).toBeInstanceOf(assert.AssertionError);
      expect((error as Error).stack).toContain("currentCredential");
      const { CredentialStore } = await import("../../daemon/src/auth/credentials.js");
      const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
      const actor = credentials.list().find((record) => record.principal === "controlled-test-operator")!;
      expect(credentials.current(actor.id)).toMatchObject({ ok: false, reason: "revoked" });
    } else {
      expect(error).toMatchObject({ code: "RUN_LEASED" });
      expect(await fileStores(join(c.base, "workspace/.orca")).leases.get("run:controlled")).toBeUndefined();
    }
    const sidecar = JSON.parse(await readFile(join(c.base, "workspace/orca.permissions.json"), "utf8")) as {
      scopedRules: { records: { rule: { status: string } }[] };
    };
    expect(sidecar.scopedRules.records.map((r) => r.rule.status)).toEqual(["approved"]);
    expect(c.observed).toEqual([{ phase: "human-read", offset: 2, length: 4, bytes: "spos" }]);
  },
  60000,
);
