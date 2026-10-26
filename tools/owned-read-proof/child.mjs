/** Disposable installed-layout refusal probe. No accepting qualification implementation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createManagedTypedWorkspace,
  resolveManagedRootBinding,
  ACCEPTED_MANAGED_TYPED_BUILDS,
} from "./node_modules/@orca/cli/dist/typed-workspace-gate.js";
import { createOwnedFileReadServiceForTest } from "./node_modules/@orca/engine/dist/owned-file-read-service.js";
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
for (const p of [config, store, join(store, "workspace-identity"), control, releases]) fs.mkdirSync(p, { mode: 0o700 });
const identity = randomUUID() + "\n";
fs.writeFileSync(join(store, "workspace-identity/id"), identity, { mode: 0o600 });
const binding = resolveManagedRootBinding(
  [
    { role: "config", path: config },
    { role: "sidecar", path: join(config, "orca.permissions.json") },
    { role: "store", path: store },
  ],
  control,
  releases,
);
fs.writeFileSync(join(control, "never-typed"), `${hash(identity)}\n${binding.rootBindingRef}\n`, { mode: 0o600 });
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
// Calibrate independent observer with an ordinary file. This is never service execution.
const calibration = join(base, "observer-calibration");
fs.writeFileSync(calibration, "calibrate");
const raw = fs.openSync(calibration, "r");
assert.equal(fs.readSync(raw, Buffer.alloc(4), 0, 4, 0), 4);
fs.closeSync(raw);
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
if (scenario !== "baseline") {
  assert.equal((await owner.currentStore()).available, false);
  await assert.rejects(typed.read());
} else {
  assert.equal((await owner.currentStore()).available, true);
  // No action, rule, approval or qualification is invented to turn this into a positive read.
  const abort = new AbortController();
  const snapshot = { invocation: {}, authority: {}, expiresAt: new Date(Date.now() + 10000).toISOString() };
  const service = createOwnedFileReadServiceForTest({
    enabled: true,
    owner: { signal: abort.signal, snapshot: () => snapshot },
    content: "disposable",
    maximumInvocations: 1,
    observed: async () => assert.fail("unexpected effect"),
    respond: async () => assert.fail("unexpected delivery"),
  });
  assert.equal(service.coverage.level, "policy-per-ask");
  assert.deepEqual(service.coverage.evidence.installedRefs, []);
  assert.equal(service.coverage.evidence.independentlyObservedEffects, false);
  assert.throws(() =>
    service.capture(
      { signal: abort.signal, snapshot: () => snapshot },
      { resourceRef: service.resourceRef, offset: -1, length: 1 },
      {},
      {},
    ),
  );
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
  }) + "\n",
);
