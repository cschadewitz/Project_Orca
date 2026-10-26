/** Disposable installed-layout refusal probe. No accepting qualification implementation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createManagedTypedWorkspace,
  resolveManagedRootBinding,
  ACCEPTED_MANAGED_TYPED_BUILDS,
} from "./node_modules/@orca/cli/dist/typed-workspace-gate.js";
import { createStrictPermissionSource, createStrictPolicyPort } from "./node_modules/@orca/agents/dist/index.js";
import { createOwnedFileReadServiceForTest } from "./node_modules/@orca/engine/dist/owned-file-read-service.js";
let policyObservation;
const [base, descriptor, scenario] = process.argv.slice(2);
const fd = Number(descriptor),
  lock = join(base, "lifetime.lock");
const original = fs.fstatSync(fd);
const inventory = JSON.parse(fs.readFileSync(join(base, "inventory.json")));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function lifetime() {
  const held = fs.fstatSync(fd),
    named = fs.lstatSync(lock);
  assert.equal(held.ino, original.ino);
  assert.equal(held.dev, original.dev);
  assert.equal(named.ino, original.ino);
  assert.equal(named.dev, original.dev);
  assert.match(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), /lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE /);
}
function image() {
  for (const [path, digest] of Object.entries(inventory)) {
    const s = fs.lstatSync(path);
    assert.ok(s.isFile() && !s.isSymbolicLink());
    assert.equal(hash(fs.readFileSync(path)), digest);
  }
}
const config = join(base, "workspace"),
  store = join(config, ".orca"),
  control = join(base, "control"),
  releases = join(base, "releases");
const identity = fs.readFileSync(join(store, "workspace-identity/id"), "utf8");
const plan = JSON.parse(fs.readFileSync(join(base, "plan.json"), "utf8"));
const binding = resolveManagedRootBinding(
  [
    { role: "config", path: config },
    { role: "sidecar", path: join(config, "orca.permissions.json") },
    { role: "store", path: store },
  ],
  control,
  releases,
);
assert.deepEqual(binding, JSON.parse(fs.readFileSync(join(base, "binding.json"), "utf8")));
const owner = createManagedTypedWorkspace({
  binding,
  lifetime: { mode: "enrollment", assertCurrent: lifetime },
  assertBuildCurrent: image,
  qualify: async () => {
    throw Error("No independently accepted qualification");
  },
});
assert.deepEqual(ACCEPTED_MANAGED_TYPED_BUILDS, []);
const typed = await owner.enrollFresh();
assert.equal(owner.inspect().state, "enrolled");
assert.equal((await typed.read()).document.version, 2);
if (scenario === "changed-image")
  fs.appendFileSync(
    Object.keys(inventory).find((p) => p.endsWith("/typed-workspace-gate.js")),
    "\n// mutation\n",
  );
if (scenario === "lifetime-loss") fs.closeSync(fd);
if (scenario === "root-replacement") {
  fs.renameSync(join(store, "workspace-identity/id"), join(store, "workspace-identity/old"));
  fs.writeFileSync(join(store, "workspace-identity/id"), identity, { mode: 0o600 });
}
if (["changed-image", "lifetime-loss", "root-replacement"].includes(scenario)) {
  assert.equal((await owner.currentStore()).available, false);
  await assert.rejects(typed.read());
} else {
  assert.equal((await owner.currentStore()).available, true);
  // Calibrate independent observer with an ordinary file. This is never service execution.
  const calibration = join(base, "input");
  const raw = fs.openSync(calibration, "r");
  assert.equal(
    fs.readSync(raw, Buffer.alloc(plan.length), 0, plan.length, plan.offset + (scenario === "wrong-offset" ? 1 : 0)),
    4,
  );
  fs.closeSync(raw);

  // Test-only cooperative owner: checks physical bindings, never claims authenticated authority.
  const abort = new AbortController();
  const now = Date.now();
  const snapshot = {
    invocation: Object.fromEntries(
      [
        "instanceId",
        "sessionId",
        "turnId",
        "invocationId",
        "runId",
        "rootRunId",
        "stepRunId",
        "attemptId",
        "agentId",
        "hostId",
        "runnerId",
        "principalRef",
      ].map((key) => [key, `test-only-unverified:${key}`]),
    ),
    authority: Object.fromEntries(
      ["capturedGeneration", "currentPolicyRevision", "authorityRevision", "revocationEpoch", "leaseEpoch"].map(
        (key) => [key, `test-only-unverified:${key}`],
      ),
    ),
    coverage: {},
    cwd: base,
    workspaceRef: "test-only-unverified",
    relevantStateRefs: [],
    expiresAt: new Date(now + 10000).toISOString(),
  };
  const check = () => {
    lifetime();
    image();
    for (const [path, expected] of Object.entries(plan.roots)) {
      const stat = fs.lstatSync(path);
      assert.deepEqual([stat.dev, stat.ino, stat.mode, stat.uid, stat.gid], expected);
    }
    assert.equal(
      hash(fs.readFileSync(join(store, "workspace-identity/id"))),
      plan.rootBytes[join(store, "workspace-identity/id")],
    );
  };
  const serviceOwner = {
    signal: abort.signal,
    snapshot: () => snapshot,
    clock: { now: Date.now, isoNow: () => new Date().toISOString() },
    withOwnership: async (work) => {
      check();
      return work();
    },
    authorize: async () => {
      check();
    },
    assertCurrent: check,
  };
  // Controlled fault injection only: retain the real open result to issue a raw
  // forbidden read below. The independent verifier never receives this variable.
  const originalOpen = fs.openSync;
  let faultDescriptor;
  if (scenario === "service-read")
    fs.openSync = function (...args) {
      const result = Reflect.apply(originalOpen, this, args);
      if (typeof args[1] === "number" && args[1] & fs.constants.O_NOFOLLOW) faultDescriptor = result;
      return result;
    };
  const service = createOwnedFileReadServiceForTest({
    enabled: true,
    owner: serviceOwner,
    content: Buffer.from(plan.inputHex, "hex").toString(),
    maximumInvocations: 1,
    observed: async () => assert.fail("unexpected effect"),
    respond: async () => assert.fail("unexpected delivery"),
  });
  fs.openSync = originalOpen;
  assert.equal(service.coverage.level, "policy-per-ask");
  assert.deepEqual(service.coverage.evidence.installedRefs, []);
  assert.equal(service.coverage.evidence.independentlyObservedEffects, false);
  const unknown = () => ({ state: "unknown", reason: "no-independent-authority-or-qualification" });
  let boundaryReads = 0;
  const source = createStrictPermissionSource({
    capturedCeiling: unknown(),
    readBoundary: async () => {
      boundaryReads++;
      return {
        authority: snapshot.authority,
        currentAuthority: unknown(),
        protectedAccess: unknown(),
        coverageAndState: unknown(),
        mandatoryHuman: unknown(),
        profile: unknown(),
      };
    },
    readRules: async () => ({ state: "unavailable", reason: "no-protected-approval-source" }),
  });
  const policy = createStrictPolicyPort({
    source,
    authorizeProjection: async () => assert.fail("no review authority"),
    recordReview: async () => assert.fail("no protected review record"),
  });
  const request = service.capture(
    serviceOwner,
    { resourceRef: service.resourceRef, offset: plan.offset, length: plan.length },
    policy,
    {
      recordCapture: async () => {},
      recordAuthorization: async () => assert.fail("no authorization"),
      read: async () => ({}),
    },
  );
  assert.equal(request.action.operation, "fs.readOwnedBytes");
  const evaluated = await request.evaluate(abort.signal);
  assert.equal(evaluated.phase, "final");
  assert.equal(evaluated.verdict.outcome, "indeterminate");
  assert.equal(boundaryReads, 2);
  await assert.rejects(request.authorize(request.action, evaluated.verdict, abort.signal));
  // Reported policy observations are separate from independently reconstructed kernel effects.
  policyObservation = {
    validAction: true,
    outcome: evaluated.verdict.outcome,
    reason: evaluated.verdict.reason,
    boundaryReads,
    authority: "test-only-unverified",
  };
  if (scenario === "service-read") {
    assert.equal(typeof faultDescriptor, "number");
    fs.readSync(faultDescriptor, Buffer.alloc(plan.length), 0, plan.length, plan.offset);
  }
  if (scenario === "wrong-descriptor") {
    const decoy = join(base, "decoy");
    fs.writeFileSync(decoy, "disposable candidate bytes");
    const other = fs.openSync(decoy, "r");
    fs.readSync(other, Buffer.alloc(plan.length), 0, plan.length, plan.offset);
    fs.closeSync(other);
  }
  if (scenario === "extra-process") assert.equal(spawnSync(process.execPath, ["-e", ""], { env: {} }).status, 0);
  service.close();
  abort.abort();
}
process.stdout.write(
  JSON.stringify({
    scenario,
    qualification: "unqualified",
    activation: "off",
    managedEnrollment: "disposable-only",
    servicePositiveExecution: false,
    policyObservation,
    rawFaultInjection: ["service-read", "wrong-descriptor"].includes(scenario),
  }) + "\n",
);
