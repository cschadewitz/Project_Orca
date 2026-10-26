/** Controlled emitted-code probe. Run after tsc -b; stdout is evidence, never an accepted-build token. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { FakeClock } from "../../core/dist/index.js";
import { InMemoryExecutionStore, InMemoryLeaseStore, lapsed } from "../../store/dist/index.js";
import {
  createStrictPermissionSource,
  createStrictPolicyPort,
  strictPermissionRuleRevision,
  strictRuleProjectionDigest,
} from "../../agents/dist/index.js";
import { createOwnedFileReadServiceForTest } from "../dist/owned-file-read-service.js";

const complete = (value) => ({ state: "complete", value });
const clock = new FakeClock(Date.now());
const abort = new AbortController();
const leases = new InMemoryLeaseStore(clock);
const lease = await leases.acquire({
  resource: "run:controlled-built-probe",
  holder: "controlled-owner",
  ttlMs: 60_000,
});
const records = new InMemoryExecutionStore();
await records.putInputs({
  runId: "controlled-run",
  workflowId: "controlled-workflow",
  workflowVersion: "1",
  vars: {},
  sensitiveNames: [],
  secrets: [],
});
const baseSnapshot = {
  invocation: {
    instanceId: "controlled-synthetic-boot",
    sessionId: "controlled-session",
    turnId: "controlled-turn",
    invocationId: "setup",
    runId: "controlled-run",
    rootRunId: "controlled-run",
    stepRunId: "controlled-step",
    attemptId: "controlled-attempt",
    agentId: "controlled-agent",
    hostId: "controlled-local-linux-host",
    runnerId: "controlled-runner",
    principalRef: "controlled-original-principal",
  },
  authority: {
    capturedGeneration: "controlled-original-ceiling",
    currentPolicyRevision: "empty",
    authorityRevision: "controlled-authority",
    revocationEpoch: "0",
    leaseEpoch: lease.guardedId ?? lease.acquiredAt,
  },
  coverage: {},
  cwd: "controlled",
  workspaceRef: "controlled",
  relevantStateRefs: [],
  expiresAt: new Date(clock.now() + 60_000).toISOString(),
};
let revoked = false;
const ownerFor = (snapshot) => ({
  signal: abort.signal,
  clock,
  snapshot: () => snapshot,
  withOwnership: (work) => leases.withOwnership(lease, work),
  authorize: async () => {
    if (revoked) throw new Error("controlled revoked");
  },
  assertCurrent: (action) => {
    assert.equal(revoked, false);
    assert.equal(lapsed(lease, clock.now()), false);
    assert.deepEqual(action.invocation, snapshot.invocation);
    assert.deepEqual(action.authority, snapshot.authority);
  },
});
let osReads = 0;
const observedByteCounts = [];
const outputs = [];
const originalRead = fs.readSync;
// Independent call-through observation at the actual OS-read API, separate from fence receipts/callbacks.
fs.readSync = function (...args) {
  osReads++;
  const count = Reflect.apply(originalRead, this, args);
  observedByteCounts.push(count);
  return count;
};
let effects = 0;
let captures = 0;
let authorizations = 0;
const evidence = {
  recordCapture: async (action, bytes) => {
    captures++;
    await records.putPayload(action.original.privateRef, {
      type: "agent.update",
      runId: action.invocation.runId,
      payload: {
        stepRunId: action.invocation.stepRunId,
        sessionId: action.invocation.sessionId,
        update: { kind: "controlled-capture", text: JSON.stringify({ action, bytes }) },
      },
    });
  },
  recordAuthorization: async (action, verdict, ref) => {
    authorizations++;
    await records.putPayload(ref, {
      type: "agent.update",
      runId: action.invocation.runId,
      payload: {
        stepRunId: action.invocation.stepRunId,
        sessionId: action.invocation.sessionId,
        update: { kind: "controlled-authorization", text: JSON.stringify({ action, verdict }) },
      },
    });
  },
  read: async () => ({}),
};
let service;
try {
  service = createOwnedFileReadServiceForTest({
    enabled: true,
    owner: ownerFor(baseSnapshot),
    maximumInvocations: 8,
    content: "controlled private bytes",
    observed: async () => {
      effects++;
    },
    respond: async (bytes) => {
      outputs.push(Buffer.from(bytes).toString());
    },
  });
  const parameters = { resourceRef: service.resourceRef, offset: 0, length: 10 };
  let policyRevision = "empty";
  let rules = [];
  let sequence = 0;
  let lastSnapshot;
  const invocation = () => {
    const snapshot = {
      ...baseSnapshot,
      invocation: { ...baseSnapshot.invocation, invocationId: `read-${++sequence}` },
      authority: { ...baseSnapshot.authority, currentPolicyRevision: policyRevision },
    };
    lastSnapshot = snapshot;
    const source = createStrictPermissionSource({
      capturedCeiling: complete(true),
      readBoundary: async () => ({
        authority: { ...snapshot.authority, currentPolicyRevision: policyRevision },
        currentAuthority: complete(!revoked),
        protectedAccess: complete(true),
        coverageAndState: complete(true),
        mandatoryHuman: complete(false),
        profile: complete({
          profileRef: "orca-owned-file-read-v1",
          minimumCoverage: "policy-per-ask",
          facts: {
            rawDuplicateKeyValidation: "complete-or-absent",
            effectiveCwd: "complete",
            workspaceRef: "complete",
            resources: "complete",
            executableAndInterpreter: "complete-or-absent",
            stdin: "complete-or-absent",
            environmentAndCredentialRefs: "complete",
            relevantStateRefs: "complete",
          },
        }),
      }),
      readRules: async () => ({
        state: "qualified",
        rules,
        provenance: {
          sourceRefs: ["controlled:synthetic-protected-approval"],
          scopeEvidenceRef: "controlled:scope",
          approvalRecordRef: "controlled:approval",
          policyRevision,
          authorityRevision: snapshot.authority.authorityRevision,
          projectionDigest: strictRuleProjectionDigest(rules),
        },
      }),
    });
    const policy = createStrictPolicyPort({
      source,
      now: () => clock.now(),
      authorizeProjection: async () => {
        throw new Error("no judge delegated in built probe");
      },
      recordReview: async () => {
        throw new Error("no judge delegated in built probe");
      },
    });
    return service.capture(ownerFor(snapshot), parameters, policy, evidence);
  };
  const denied = invocation();
  const missing = await denied.evaluate(abort.signal);
  assert.equal(missing.phase, "final");
  assert.equal(missing.verdict.outcome, "require-human");
  assert.equal(osReads, 0);
  const a = denied.action;
  const oldAction = structuredClone(a);
  const draft = {
    ruleId: "controlled:exact-rule",
    status: "approved",
    decision: "allow",
    notBefore: new Date(clock.now() - 1).toISOString(),
    expiresAt: a.expiresAt,
    match: {
      principalRef: a.invocation.principalRef,
      agentId: a.invocation.agentId,
      hostId: a.invocation.hostId,
      runnerId: a.invocation.runnerId,
      operation: a.operation,
      profileRef: a.profileRef,
      coverageId: a.coverage.coverageId,
      effectiveCwd: a.effectiveCwd.value,
      workspaceRef: a.workspaceRef.value,
      resources: a.resources.value,
      environmentAndCredentialRefs: [],
    },
  };
  rules = [{ ...draft, ruleRevision: strictPermissionRuleRevision(draft) }];
  policyRevision = strictRuleProjectionDigest(rules);
  const perform = async (current) => {
    const evaluated = await current.evaluate(abort.signal);
    assert.equal(evaluated.phase, "final");
    assert.equal(evaluated.verdict.outcome, "allow");
    const permit = await current.authorize(current.action, evaluated.verdict, abort.signal);
    const receipts = await Promise.all(Array.from({ length: 8 }, () => current.dispatch(permit, abort.signal)));
    assert.ok(receipts.every((r) => r.state === "completed"));
    await current.dispatch(permit, abort.signal);
    return receipts[0];
  };
  lastSnapshot.authority.currentPolicyRevision = policyRevision;
  const first = service.refreshPolicyRevision(denied);
  assert.deepEqual(denied.action, oldAction);
  assert.deepEqual(first.action.invocation, denied.action.invocation);
  assert.equal(first.action.expiresAt, denied.action.expiresAt);
  await perform(first);
  const second = invocation();
  assert.deepEqual(first.action.resources, second.action.resources);
  assert.deepEqual(first.action.coverage, second.action.coverage);
  await perform(second);
  assert.equal(osReads, 2);
  assert.deepEqual(observedByteCounts, [10, 10]);
  assert.deepEqual(outputs, ["controlled", "controlled"]);
  assert.equal(effects, 2);
  assert.equal(authorizations, 2);
  const third = invocation();
  revoked = true;
  await assert.rejects(third.evaluate(abort.signal));
  assert.equal(osReads, 2);
  service.close();
  assert.throws(invocation);
  assert.equal(service.coverage.level, "policy-per-ask");
  assert.deepEqual(service.coverage.evidence.installedRefs, []);
  // Code-manifest reads are independent of the resource-read observations above.
  fs.readSync = originalRead;
  // Bind evidence to every emitted JS byte in the four packages used by this process.
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const build = [];
  const walk = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".js"))
        build.push({
          path: relative(repository, path),
          sha256: createHash("sha256").update(fs.readFileSync(path)).digest("hex"),
        });
    }
  };
  for (const pkg of ["core", "store", "agents", "engine"]) walk(join(repository, "packages", pkg, "dist"));
  const buildDigest = createHash("sha256").update(JSON.stringify(build)).digest("hex");
  process.stdout.write(
    `${JSON.stringify(
      {
        qualification: "unqualified",
        activation: "off",
        gate: "No independently accepted installed build/host/tool/profile qualification; source or local build conformance is not production acceptance",
        runtime: { node: process.version, platform: process.platform, arch: process.arch, hostId: a.invocation.hostId },
        profileRef: a.profileRef,
        coverage: service.coverage,
        buildDigest,
        build,
        observations: {
          osReads,
          observedByteCounts,
          effects,
          captures,
          authorizations,
          missingRuleReads: 0,
          revocationAdditionalReads: 0,
          repeatedDispatchAdditionalReads: 0,
          distinctInvocations: 2,
          policyRefresh: true,
          originalEvidenceUnchanged: true,
          closeRefused: true,
        },
        assumptions: [
          "synthetic authenticated boot/principal/authority",
          "synthetic protected approval qualification",
          "controlled local emitted build; no accepted production build",
          "trusted same-UID process and Linux filesystem",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  fs.readSync = originalRead;
  service?.close();
  abort.abort();
}
