/** Installed, disposable producer only. The parent owns verification and command authority.
 * A connected `save` command is sent only after separate full bootstrap replay succeeds.
 * Plan bytes associate originals; neither they nor a child report grant qualification.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertControlledLifetimeFdinfo, runControlledOwnedReadTest } from "./controlled-producer.mjs";
const [base, lane, lifetimeArg, commandArg, ackArg] = process.argv.slice(2);
assert.ok(base && ["bootstrap", "connected"].includes(lane));
const lifetimeFd = Number(lifetimeArg),
  commandFd = Number(commandArg),
  ackFd = Number(ackArg);
assert.equal(new Set([lifetimeFd, commandFd, ackFd]).size, 3);
assert.ok([lifetimeFd, commandFd, ackFd].every((fd) => Number.isSafeInteger(fd) && fd > 2));
const plan = JSON.parse(fs.readFileSync(join(base, "controlled-plan.json"), "utf8"));
assert.equal(plan.version, 1);
assert.equal(plan.lane, lane);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Plan identities retain their existing JSON-number representation; full stamps
// retain exact bigint decimal strings from the same observation.
const identity = (info) => [info.dev, info.ino, info.mode, info.uid, info.gid].map(Number);
const actualIdentity = (path) => identity(fs.lstatSync(path));
const stamp = (info) =>
  [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].map(String);
// Initial bytes are associated with the retained original before any authority is used.
// Current checks use complete physical stamps (including unresettable ctime), not a cached
// Boolean. Independent replay also rechecks bytes. Cooperative same-UID scope only.
for (const [path, original] of Object.entries(plan.inventory)) {
  assert.deepEqual(stamp(fs.lstatSync(path, { bigint: true })), original.stamp);
  assert.equal(hash(fs.readFileSync(path)), original.sha256);
}
const image = () => {
  for (const [path, original] of Object.entries(plan.inventory)) {
    const info = fs.lstatSync(path, { bigint: true });
    assert.deepEqual(identity(info), original.identity);
    assert.ok(info.isFile());
    assert.deepEqual(stamp(info), original.stamp);
  }
};
const check = () => {
  assert.deepEqual(identity(fs.fstatSync(lifetimeFd)), plan.lifetime.identity);
  assert.deepEqual(actualIdentity(plan.lifetime.path), plan.lifetime.identity);
  assertControlledLifetimeFdinfo(lifetimeFd);
  for (const [path, original] of Object.entries(plan.roots)) assert.deepEqual(actualIdentity(path), original);
  for (const [path, original] of Object.entries(plan.originalFiles)) {
    assert.deepEqual(actualIdentity(path), original.identity);
    assert.equal(hash(fs.readFileSync(path)), original.sha256);
  }
  image();
  for (const [fd, original] of [
    [commandFd, plan.commandIdentity],
    [ackFd, plan.ackIdentity],
  ]) {
    const info = fs.fstatSync(fd, { bigint: true });
    assert.ok(info.isFIFO());
    assert.deepEqual(identity(info), original);
  }
  return undefined;
};
// Fresh retained-proof identity, bytes and inventory association only. The producer
// composes it after `check`; it no longer repeats that whole physical check itself.
const association = () => {
  const original = plan.originalFiles[plan.bootstrap.proofPath];
  assert.ok(original && original.sha256 === plan.bootstrap.proofSha256);
  assert.deepEqual(actualIdentity(plan.bootstrap.proofPath), original.identity);
  assert.equal(hash(fs.readFileSync(plan.bootstrap.proofPath)), original.sha256);
  assert.equal(plan.bootstrap.installedInventoryDigest, hash(JSON.stringify(plan.inventory)));
  return undefined;
};
assert.deepEqual(actualIdentity(plan.enrollmentWitness.path), plan.enrollmentWitness.identity);
assert.equal(hash(fs.readFileSync(plan.enrollmentWitness.path)), plan.enrollmentWitness.sha256);
check();
let next = 0;
const phases = lane === "bootstrap" ? ["bootstrap"] : ["save", "human-read", "rule-read"];
assert.deepEqual(
  plan.phases.map((phase) => phase.name),
  phases,
);
assert.equal(new Set(plan.phases.map((phase) => phase.token)).size, phases.length);
for (const phase of plan.phases) assert.match(phase.token, /^[0-9a-f]{64}$/);
const report = await runControlledOwnedReadTest(base, lane, {
  content: Buffer.from(plan.inputHex, "hex").toString("utf8"),
  offset: plan.offset,
  length: plan.length,
  assertCurrent: check,
  // Managed build port: fresh installed image and, when connected, its retained proof.
  assertBuildCurrent: () => {
    image();
    if (lane === "connected") association();
    return undefined;
  },
  ...(lane === "connected"
    ? {
        bootstrap: {
          evidenceRef: plan.bootstrap.evidenceRef,
          // Designation comes from the parent command pipe after its independent bootstrap
          // check. This association check cannot promote a mutable report into authority.
          assertCurrent: association,
        },
      }
    : {}),
  phase: async (name, work) => {
    const original = plan.phases[next];
    assert.equal(original.name, name);
    const command = Buffer.from(`orca-phase:${name}:${original.token}\n`);
    const buffer = Buffer.alloc(command.length);
    assert.equal(fs.readSync(commandFd, buffer, 0, buffer.length, null), command.length);
    assert.deepEqual(buffer, command);
    check();
    await work();
    check();
    const ack = Buffer.from(`orca-done:${name}:${original.token}\n`);
    assert.equal(fs.writeSync(ackFd, ack), ack.length);
    next++;
  },
});
assert.equal(next, phases.length);
// Correlations only. Parent independently reads protected bytes and traces all effects.
process.stdout.write(JSON.stringify({ kind: "controlled-producer-correlations-v1", ...report }) + "\n");
