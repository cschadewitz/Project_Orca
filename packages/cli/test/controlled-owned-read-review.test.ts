/** Independent #742 review regressions at 6f208db. The supervisor fixture below mirrors
 * controlled-owned-read.test.ts unchanged (it is not exported). These cases separate
 * approval recording, delivery, authorization/dispatch and read, and check refusal origin.
 * Local interception is test evidence only; it is not installed confinement or acceptance.
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fileStores } from "@orca/store";
import * as agents from "@orca/agents";
import type { ActionEvidenceV1, PolicyEvaluationV1, StrictPermissionRule } from "@orca/core";
import { resolveManagedRootBinding } from "../src/typed-workspace-gate.js";
import { runControlledOwnedReadTest, type ControlledReadTestSupervisor } from "./controlled-owned-read-producer.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const content = "disposable candidate bytes";
async function supervisor(
  lane: "bootstrap" | "connected",
  previous?: { evidenceRef: string; assertCurrent(): undefined },
  fault?: ControlledReadTestSupervisor["fault"],
) {
  const base = await mkdtemp(join(tmpdir(), "orca-controlled-test-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  for (const path of ["workspace", "workspace/.orca", "workspace/.orca/workspace-identity", "control", "releases"])
    await mkdir(join(base, path), { mode: 0o700 });
  const id = join(base, "workspace/.orca/workspace-identity/id");
  await writeFile(id, `${randomUUID()}\n`, { mode: 0o600 });
  const binding = resolveManagedRootBinding(
    [
      { role: "config", path: join(base, "workspace") },
      { role: "sidecar", path: join(base, "workspace/orca.permissions.json") },
      { role: "store", path: join(base, "workspace/.orca") },
    ],
    join(base, "control"),
    join(base, "releases"),
  );
  await writeFile(join(base, "control/never-typed"), `${digest(await readFile(id))}\n${binding.rootBindingRef}\n`, {
    mode: 0o600,
  });
  // A real supervisor-owned flock, not a boolean lifetime substitute.
  const lock = join(base, "lifetime.lock");
  const holder = spawn(
    "python3",
    [
      "-c",
      "import os,fcntl,sys\nf=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)\nfcntl.flock(f,fcntl.LOCK_EX)\nprint(f,flush=True)\nsys.stdin.read()",
      lock,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  cleanup.push(async () => {
    holder.stdin.end();
    if (holder.exitCode === null) await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  });
  const fd = await new Promise<number>((resolve, reject) => {
    holder.stdout.once("data", (b: Buffer) => resolve(Number(b.toString().trim())));
    holder.once("error", reject);
  });
  const identity = (path: string) => {
    const info = fs.lstatSync(path, { bigint: true });
    return [info.dev, info.ino, info.mode, info.uid, info.gid].join(":");
  };
  const originals = new Map(
    [
      base,
      ...[
        "workspace",
        "workspace/.orca",
        "workspace/.orca/workspace-identity",
        "control",
        "releases",
        "lifetime.lock",
        "workspace/.orca/workspace-identity/id",
      ].map((p) => join(base, p)),
    ].map((path) => [path, identity(path)]),
  );
  const identityBytes = fs.readFileSync(id);
  const image = new URL("./controlled-owned-read-producer.ts", import.meta.url);
  const imageBytes = fs.readFileSync(image),
    imageStamp = identity(image.pathname);
  const phases: string[] = [],
    observed: { phase: string; offset: number; length: number; bytes: string }[] = [];
  let phase = "outside";
  const check = (): undefined => {
    assert.equal(holder.exitCode, null);
    assert.match(fs.readFileSync(`/proc/${holder.pid}/fdinfo/${fd}`, "utf8"), /FLOCK\s+ADVISORY\s+WRITE /);
    for (const [path, stamp] of originals) assert.equal(identity(path), stamp);
    assert.equal(digest(fs.readFileSync(id)), digest(identityBytes));
    assert.equal(identity(image.pathname), imageStamp);
    assert.equal(digest(fs.readFileSync(image)), digest(imageBytes));
    return undefined;
  };
  const originalRead = fs.readSync;
  const spy = vi.spyOn(fs, "readSync").mockImplementation(((
    descriptor: number,
    bytes: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const result = originalRead(descriptor, bytes, offset, length, position);
    const info = fs.fstatSync(descriptor);
    if (
      info.isFile() &&
      info.nlink === 0 &&
      info.size === Buffer.byteLength(content) &&
      (info.mode & 0o777) === 0o400
    ) {
      observed.push({
        phase,
        offset: position!,
        length,
        bytes: Buffer.from(bytes.buffer, bytes.byteOffset + offset, result).toString(),
      });
    }
    return result;
  }) as typeof fs.readSync);
  cleanup.push(async () => spy.mockRestore());
  const options: ControlledReadTestSupervisor = {
    content,
    offset: 2,
    length: 4,
    assertCurrent: check,
    ...(previous ? { bootstrap: previous } : {}),
    ...(fault ? { fault } : {}),
    phase: async (name, work) => {
      phases.push(name);
      phase = name;
      try {
        await work();
      } finally {
        phase = "outside";
      }
    },
  };
  return { base, lane, options, phases, observed, check, holder, image, originals, restore: () => spy.mockRestore() };
}
async function bootstrap() {
  const s = await supervisor("bootstrap");
  const result = await runControlledOwnedReadTest(s.base, "bootstrap", s.options);
  expect(s.observed).toEqual([{ phase: "bootstrap", offset: 2, length: 4, bytes: "spos" }]);
  expect(result.authorizationRefs).toHaveLength(1);
  s.restore();
  const ref = result.authorizationRefs[0]!;
  const protectedBytes = fs.readFileSync(
    join(s.base, "workspace/.orca/private-execution", `${encodeURIComponent(ref)}.payload.json`),
  );
  const grant = {
    evidenceRef: `test-supervisor-bootstrap:${digest(protectedBytes)}`,
    assertCurrent: (): undefined => {
      s.check();
      assert.equal(
        digest(
          fs.readFileSync(join(s.base, "workspace/.orca/private-execution", `${encodeURIComponent(ref)}.payload.json`)),
        ),
        digest(protectedBytes),
      );
      assert.deepEqual(s.observed, [{ phase: "bootstrap", offset: 2, length: 4, bytes: "spos" }]);
      return undefined;
    },
  };
  return { ...s, result, grant };
}
const runId = "controlled";
const storeOf = (base: string) => join(base, "workspace/.orca");
/** Decoded kinds of the producer's authenticated semantic records; never a positive flag. */
async function semanticKinds(base: string) {
  const stores = fileStores(storeOf(base));
  const counts: Record<string, number> = {};
  for (const name of fs.readdirSync(join(storeOf(base), "private-execution"))) {
    if (!name.endsWith(".payload.json")) continue;
    const ref = decodeURIComponent(name.slice(0, -".payload.json".length));
    let kind = "other";
    try {
      const payload = (await stores.execution.getPayload(runId, ref, "agent.update")) as { update: { text: string } };
      kind = (JSON.parse(payload.update.text) as { kind: string }).kind;
    } catch {
      // Protected approval payloads and inputs are a different record type.
    }
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}
async function events(base: string, type: "human.answered" | "agent.permission") {
  return fileStores(storeOf(base)).events.readTypes(runId, [type]);
}
const sidecarRules = (base: string) =>
  (
    JSON.parse(fs.readFileSync(join(base, "workspace/orca.permissions.json"), "utf8")) as {
      scopedRules: { records: { rule: { status: string } }[] };
    }
  ).scopedRules.records;
const failure = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("controlled run unexpectedly completed");
    },
    (error: unknown) => error as Error,
  );

it("Save records approval only: no answer, authorization, dispatch or read, and keeps unavailable judge provenance", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  const original = c.options.phase.bind(c.options);
  let atSave: Record<string, unknown> | undefined;
  c.options.phase = (name, work) =>
    original(name, async () => {
      await work();
      if (name !== "save") return;
      const stores = fileStores(storeOf(c.base));
      const approvals = await events(c.base, "agent.permission");
      const approval = (await stores.execution.getPayload(
        runId,
        approvals[0]!.executionPayloadRef!,
        "agent.permission",
      )) as {
        entry: {
          requiredReview: string;
          reviewSourceRefs: string[];
          actor: { principalId: string };
          persistenceReview: { result: string; sourceRefs: string[] };
        };
      };
      const attestation = (await stores.execution.getPayload(
        runId,
        approval.entry.persistenceReview.sourceRefs[0]!,
        "agent.update",
      )) as { update: { text: string } };
      atSave = {
        approvals: approvals.length,
        answers: (await events(c.base, "human.answered")).length,
        kinds: await semanticKinds(c.base),
        reads: [...c.observed],
        rules: sidecarRules(c.base).map((r) => r.rule.status),
        approval: approval.entry,
        attestation: JSON.parse(attestation.update.text),
      };
    });
  await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(atSave).toBeDefined();
  expect(atSave!.approvals).toBe(1);
  expect(atSave!.answers).toBe(0);
  expect(atSave!.reads).toEqual([]);
  expect(atSave!.rules).toEqual(["approved"]);
  const kinds = atSave!.kinds as Record<string, number>;
  for (const absent of [
    "controlled-authorization-v1",
    "controlled-producer-observation-v1",
    "controlled-final-delivery-ack-v1",
  ])
    expect(kinds[absent]).toBeUndefined();
  const approval = atSave!.approval as {
    requiredReview: string;
    reviewSourceRefs: string[];
    actor: { principalId: string };
    persistenceReview: { result: string };
  };
  // Persistence review is additional; it never rewrites the execution judge outcome.
  expect(approval.requiredReview).toBe("unavailable");
  expect(approval.reviewSourceRefs).toEqual([]);
  expect(approval.persistenceReview.result).toBe("passed");
  const attestation = atSave!.attestation as {
    kind: string;
    value: { executionReview: unknown; reviewer: { actor: { principalId: string } } };
  };
  expect(attestation.kind).toBe("controlled-persistence-review-v1");
  expect(attestation.value.executionReview).toEqual({ result: "unavailable", sourceRefs: [] });
  expect(attestation.value.reviewer.actor.principalId).not.toBe(approval.actor.principalId);
  // Only the later separately delivered answer and the fresh rule invocation authorize reads.
  expect((await semanticKinds(c.base))["controlled-authorization-v1"]).toBe(2);
  expect(c.observed.map((read) => read.phase)).toEqual(["human-read", "rule-read"]);
}, 60000);

it("lost final ack keeps the durable answer separate from authorization, dispatch and read", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant, "lost-ack");
  const error = await failure(runControlledOwnedReadTest(c.base, "connected", c.options));
  // The bridge reports uncertainty rather than a settled answer.
  expect(error.message).toContain('"outcome":"uncertain"');
  expect(c.phases).toEqual(["save", "human-read"]);
  expect(await events(c.base, "human.answered")).toHaveLength(1);
  const kinds = await semanticKinds(c.base);
  expect(kinds["controlled-authorization-v1"]).toBeUndefined();
  expect(kinds["controlled-producer-observation-v1"]).toBeUndefined();
  expect(kinds["controlled-final-delivery-ack-v1"]).toBeUndefined();
  expect(c.observed).toEqual([]);
}, 60000);

it.each(["review-proof", "reviewer-revoked"] as const)(
  "%s refuses at protected review before any Save record or rule exists",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant, fault);
    const error = await failure(runControlledOwnedReadTest(c.base, "connected", c.options));
    expect(error.message).toContain("CONFIG_STALE");
    expect(c.phases).toEqual(["save"]);
    expect(await events(c.base, "agent.permission")).toHaveLength(0);
    expect(await events(c.base, "human.answered")).toHaveLength(0);
    expect(sidecarRules(c.base)).toEqual([]);
    expect((await semanticKinds(c.base))["controlled-authorization-v1"]).toBeUndefined();
    expect(c.observed).toEqual([]);
  },
  60000,
);

it("a tampered protected Save approval refuses the fresh rule read but not the delivered answer", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  const original = c.options.phase.bind(c.options);
  c.options.phase = async (name, work) => {
    if (name === "rule-read") {
      const approvals = await events(c.base, "agent.permission");
      const path = join(
        storeOf(c.base),
        "private-execution",
        `${encodeURIComponent(approvals[0]!.executionPayloadRef!)}.payload.json`,
      );
      const bytes = await readFile(path);
      bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
      await writeFile(path, bytes);
    }
    return original(name, work);
  };
  const error = await failure(runControlledOwnedReadTest(c.base, "connected", c.options));
  // Refused at the fresh invocation's policy verdict (qualification cannot read the record).
  expect(error.message).toContain('result.verdict.outcome === "allow"');
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(c.observed.map((read) => read.phase)).toEqual(["human-read"]);
  expect(await events(c.base, "human.answered")).toHaveLength(1);
  expect((await semanticKinds(c.base))["controlled-authorization-v1"]).toBe(1);
}, 60000);

// Cal reconciliation of the original #744 reproduction. Requires the reviewed #749
// correction: an unrelated fixture exception must fail this ordinary regression.
it("persisted revocation reaches fresh policy refusal with only the prior human authority and read", async () => {
  const automatic: { action: ActionEvidenceV1; result: PolicyEvaluationV1 }[] = [];
  const createPolicy = agents.createStrictPolicyPort;
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
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant, "revoke-rule");
  const completed: string[] = [];
  let approvedPolicyRevision = "";
  let approvedRule: StrictPermissionRule | undefined;
  const original = c.options.phase.bind(c.options);
  c.options.phase = (name, work) =>
    original(name, async () => {
      await work();
      completed.push(name);
      if (name !== "save") return;
      const bytes = await readFile(join(c.base, "workspace/orca.permissions.json"));
      approvedPolicyRevision = digest(bytes);
      const document = JSON.parse(bytes.toString()) as {
        scopedRules: { records: { rule: StrictPermissionRule }[] };
      };
      expect(document.scopedRules.records).toHaveLength(1);
      approvedRule = document.scopedRules.records[0]!.rule;
      expect(approvedRule.status).toBe("approved");
      expect(await events(c.base, "human.answered")).toHaveLength(0);
      expect(c.observed).toEqual([]);
    });
  const error = await failure(runControlledOwnedReadTest(c.base, "connected", c.options));
  const sidecarBytes = await readFile(join(c.base, "workspace/orca.permissions.json"));
  const document = JSON.parse(sidecarBytes.toString()) as {
    scopedRules: { records: { rule: StrictPermissionRule; approvalRecordRef: string }[] };
  };
  expect(document.scopedRules.records).toHaveLength(1);
  const revoked = document.scopedRules.records[0]!;
  expect(revoked.rule.status).toBe("revoked");
  expect(approvedRule).toBeDefined();
  expect(revoked.rule.ruleId).toBe(approvedRule!.ruleId);
  expect(revoked.rule.ruleRevision).not.toBe(approvedRule!.ruleRevision);
  expect(revoked.rule.ruleRevision).toBe(agents.strictPermissionRuleRevision(revoked.rule));
  expect(approvedPolicyRevision).not.toBe("");
  expect(digest(sidecarBytes)).not.toBe(approvedPolicyRevision);
  expect(error).toBeInstanceOf(assert.AssertionError);
  expect(error.message).toContain('result.verdict.outcome === "allow"');
  expect(automatic).toHaveLength(1);
  expect(automatic[0]!.result).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "required-policy-unavailable" },
  });
  expect(automatic[0]!.action.authority.currentPolicyRevision).toBe(digest(sidecarBytes));
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(completed).toEqual(["save", "human-read"]);
  expect(c.observed).toEqual([{ phase: "human-read", offset: 2, length: 4, bytes: "spos" }]);
  expect(await events(c.base, "agent.permission")).toHaveLength(1);
  expect(await events(c.base, "human.answered")).toHaveLength(1);
  const stores = fileStores(storeOf(c.base));
  const [revocationRun, revocationRef] = JSON.parse(revoked.approvalRecordRef) as [string, string];
  expect(revocationRun).toBe(runId);
  const proof = (await stores.execution.getPayload(runId, revocationRef, "agent.update")) as {
    update: { text: string };
  };
  expect(JSON.parse(proof.update.text)).toMatchObject({
    kind: "controlled-rule-revocation-v1",
    value: {
      command: {
        rule: revoked.rule,
        expectedRevision: approvedPolicyRevision,
        approvalRecordRef: revoked.approvalRecordRef,
      },
    },
  });
  const authorizations: string[] = [];
  for (const name of fs.readdirSync(join(storeOf(c.base), "private-execution"))) {
    if (!name.startsWith("synthetic-read%3A") || !name.endsWith("%3Aevidence.payload.json")) continue;
    const ref = decodeURIComponent(name.slice(0, -".payload.json".length));
    const payload = (await stores.execution.getPayload(runId, ref, "agent.update")) as {
      update: { text: string };
    };
    const record = JSON.parse(payload.update.text) as {
      kind: string;
      value: { verdict: { authorizedBy: { kind: string } } };
    };
    expect(record.kind).toBe("controlled-authorization-v1");
    authorizations.push(record.value.verdict.authorizedBy.kind);
  }
  expect(authorizations).toEqual(["human"]);
  const kinds = await semanticKinds(c.base);
  expect(kinds["controlled-authorization-v1"]).toBe(1);
  expect(kinds["controlled-producer-observation-v1"]).toBe(1);
  expect(kinds["controlled-final-delivery-ack-v1"]).toBe(1);
}, 60000);
