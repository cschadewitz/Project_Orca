"""Real child / synthetic producer controls, never a traced original attempt.

Instrumentation starts after the child's initial checks. It calls the same child
currentness closure repeatedly, including through phase boundaries, and separately
calls the retained-proof association and managed build-port callables. Neither of
those repeats the whole physical check; each observes its own facts freshly.
"""
import json
import unittest

import test_bootstrap_receipt_child as receipt_controls


STUB = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = fs.readFileSync;
let fdinfoCalls = 0;
export function assertControlledLifetimeFdinfo(fd) {
  fdinfoCalls++;
  assert.match(read(`/proc/self/fdinfo/${fd}`, 'utf8'), /FLOCK\s+ADVISORY\s+WRITE /);
}
export async function runControlledOwnedReadTest(base, lane, options) {
  const plan = JSON.parse(read(`${base}/controlled-plan.json`, 'utf8'));
  const files = Object.keys(plan.inventory);
  const command = Number(process.argv[5]), ack = Number(process.argv[6]);
  const lstat = fs.lstatSync, fstat = fs.fstatSync;
  const proof = plan.bootstrap.proofPath;
  let proofReads = 0;
  fs.readFileSync = function(path, ...args) {
    if (path === proof) proofReads++;
    return read.call(this, path, ...args);
  };
  let paths = [], descriptors = [], injected = null;
  fs.lstatSync = function(path, config) {
    paths.push([path, config?.bigint === true]);
    const info = lstat.call(this, path, config);
    return injected?.path === path ? injected.transform(info) : info;
  };
  fs.fstatSync = function(fd, config) {
    descriptors.push([fd, config?.bigint === true]);
    const info = fstat.call(this, fd, config);
    return injected?.fd === fd ? injected.transform(info) : info;
  };
  let checks = 0, inventoryCalls = 0, fifoCalls = 0, associations = 0, builds = 0;
  function verifyObservations(count) {
    assert.equal(fdinfoCalls, count);
    // Also retain every noninventory path/lifetime observation per invocation.
    const expectedPaths = [plan.lifetime.path, ...Object.keys(plan.roots),
      ...Object.keys(plan.originalFiles), ...files];
    assert.deepEqual(paths.map(([path]) => path).sort(),
      Array.from({length: count}, () => expectedPaths).flat().sort());
    assert.deepEqual(descriptors.map(([fd]) => fd).sort(),
      Array.from({length: count}, () => [Number(process.argv[4]), command, ack]).flat().sort());
    for (const file of files) {
      assert.deepEqual(paths.filter(([path]) => path === file),
        Array.from({length: count}, () => [file, true]), 'one fresh bigint inventory stat per check');
      inventoryCalls += count;
    }
    for (const fd of [command, ack]) {
      assert.deepEqual(descriptors.filter(([number]) => number === fd),
        Array.from({length: count}, () => [fd, true]), 'one fresh bigint FIFO stat per check');
      fifoCalls += count;
    }
    checks += count;
  }
  function observedCheck(work) {
    paths = []; descriptors = []; fdinfoCalls = 0;
    work();
    verifyObservations(1);
  }
  // Retained proof only: one fresh no-follow identity and one fresh byte hash.
  function observedAssociation(work) {
    paths = []; descriptors = []; fdinfoCalls = 0; proofReads = 0;
    assert.equal(work(), undefined);
    assert.equal(fdinfoCalls, 0);
    assert.deepEqual(paths, [[proof, false]]);
    assert.deepEqual(descriptors, []);
    assert.equal(proofReads, 1);
    associations++;
  }
  // Build port: one fresh bigint stamp per installed image file, then the proof.
  function observedBuild(work) {
    paths = []; descriptors = []; fdinfoCalls = 0; proofReads = 0;
    assert.equal(work(), undefined);
    assert.equal(fdinfoCalls, 0);
    assert.deepEqual(paths, [...files.map((file) => [file, true]), [proof, false]]);
    assert.deepEqual(descriptors, []);
    assert.equal(proofReads, 1);
    inventoryCalls += files.length;
    associations++;
    builds++;
  }
  for (let i = 0; i < 4; i++) {
    observedCheck(options.assertCurrent);
    observedAssociation(options.bootstrap.assertCurrent);
    observedBuild(options.assertBuildCurrent);
  }
  const scenario = process.env.RECEIPT_CHILD_TAMPER;
  if (scenario) {
    const [kind, target, field] = scenario.split(':');
    const path = files[Number(target)];
    if (kind === 'descriptor') {
      const fd = target === 'command' ? command : ack;
      fs.closeSync(fd);
      const replacement = field === 'type'
        ? fs.openSync(files[0], 'r')
        : fs.openSync(`/proc/self/fd/${target === 'command' ? ack : command}`,
            target === 'command' ? 'r' : 'w');
      assert.equal(replacement, fd, 'reuse the original descriptor number');
    } else if (kind === 'proof') {
      if (target === 'bytes') {
        const original = read(proof), before = lstat(proof);
        fs.chmodSync(proof, 0o600);
        fs.writeFileSync(proof, Buffer.alloc(original.length, 120));
        fs.chmodSync(proof, before.mode & 0o777);
        fs.utimesSync(proof, before.atime, before.mtime);
      } else if (target === 'replacement') {
        fs.writeFileSync(proof + '.new', read(proof));
        fs.renameSync(proof + '.new', proof);
      } else throw new Error('unknown proof mutation');
    } else if (kind === 'file') {
      if (field === 'bytes') {
        const original = read(path), before = lstat(path);
        fs.writeFileSync(path, Buffer.alloc(original.length, 120));
        fs.utimesSync(path, before.atime, before.mtime);
      } else if (field === 'replacement') {
        fs.writeFileSync(path + '.new', read(path));
        fs.renameSync(path + '.new', path);
      } else if (field === 'directory' || field === 'symlink') {
        fs.renameSync(path, path + '.original');
        if (field === 'directory') fs.mkdirSync(path);
        else fs.symlinkSync(path + '.original', path);
      } else if (field === 'nlink') fs.linkSync(path, path + '.alias');
      else if (field === 'mode') fs.chmodSync(path, lstat(path).mode ^ 0o100);
      else throw new Error('unknown file mutation');
    } else {
      const transform = info => {
        // Preserve real Stats methods and exact other fields to isolate each predicate.
        const changed = Object.create(info);
        if (kind === 'type') changed[target === 'file' ? 'isFile' : 'isFIFO'] = () => false;
        else changed[field] = info[field] + (typeof info[field] === 'bigint' ? 1n : 1);
        return changed;
      };
      injected = target === 'file' || kind === 'stamp'
        ? {path: files[kind === 'stamp' ? Number(target) : 0], transform}
        : {fd: target === 'command' ? command : ack, transform};
    }
    // The mutation follows four successful calls of each closure. Any cached
    // observation/success would incorrectly let the probed invocation return.
    const probe = process.env.RECEIPT_CHILD_PROBE || 'current';
    process.stderr.write('PROBING AFTER MUTATION\n');
    ({current: options.assertCurrent, build: options.assertBuildCurrent,
      association: options.bootstrap.assertCurrent})[probe]();
    throw new Error('MUTATION WAS ACCEPTED');
  }
  for (const name of ['save', 'human-read', 'rule-read']) {
    paths = []; descriptors = []; fdinfoCalls = 0;
    await options.phase(name, async () => {});
    verifyObservations(2); // before and after the phase work's await
  }
  assert.equal(checks, 10);
  return {syntheticChildOnly: true, checks, inventoryCalls, fifoCalls, associations, builds};
}
'''


class ChildStatObservationControls(unittest.TestCase):
    def child(self, scenario=None, probe=None):
        return receipt_controls.BootstrapReceiptChildControls().child(
            b'synthetic immutable association', tamper=scenario, stub=STUB, probe=probe)

    def test_one_fresh_bigint_observation_per_object_per_check(self):
        result = self.child()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        # Ten complete physical checks (4 direct, 6 at phase boundaries) observe the image
        # 30 times; four build-port calls observe it 12 more. Association calls never
        # repeat the physical check (the reviewed child's 4 extra checks are gone).
        self.assertEqual(json.loads(result.stdout), {
            'kind': 'controlled-producer-correlations-v1', 'syntheticChildOnly': True,
            'checks': 10, 'inventoryCalls': 42, 'fifoCalls': 20, 'associations': 8, 'builds': 4})

    def assert_refused(self, scenario, probe=None):
        result = self.child(scenario, probe)
        self.assertNotEqual(result.returncode, 0)
        # Refusal must come from the probed call after the mutation, not earlier setup.
        marker = b'PROBING AFTER MUTATION\n'
        self.assertIn(marker, result.stderr, result.stderr.decode())
        self.assertIn(b'AssertionError', result.stderr.split(marker, 1)[1], result.stderr.decode())
        self.assertNotIn(b'MUTATION WAS ACCEPTED', result.stderr)
        self.assertEqual(result.stdout, b'')

    def test_image_mutation_between_check_invocations(self):
        for probe in ('current', 'build'):
            for index in range(3):
                for mutation in ('bytes', 'replacement', 'directory', 'symlink', 'nlink', 'mode'):
                    with self.subTest(probe=probe, index=index, mutation=mutation):
                        self.assert_refused(f'file:{index}:{mutation}', probe)

    def test_every_exact_stamp_field_is_rechecked(self):
        for probe in ('current', 'build'):
            for index in range(3):
                for field in ('dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'):
                    with self.subTest(probe=probe, index=index, field=field):
                        self.assert_refused(f'stamp:{index}:{field}', probe)

    def test_retained_proof_tamper_refuses_each_callable_independently(self):
        # Association and build calls do not depend on a preceding physical check.
        for probe in ('association', 'build', 'current'):
            for mutation in ('bytes', 'replacement'):
                with self.subTest(probe=probe, mutation=mutation):
                    self.assert_refused(f'proof:{mutation}:unused', probe)

    def test_file_and_fifo_type_predicates_are_preserved(self):
        for target in ('file', 'command', 'ack'):
            with self.subTest(target=target):
                self.assert_refused(f'type:{target}:unused')

    def test_real_fifo_replacement_between_check_invocations(self):
        for target in ('command', 'ack'):
            for mutation in ('type', 'identity'):
                with self.subTest(target=target, mutation=mutation):
                    self.assert_refused(f'descriptor:{target}:{mutation}')

    def test_each_fifo_identity_field_is_rechecked(self):
        for target in ('command', 'ack'):
            for field in ('dev', 'ino', 'mode', 'uid', 'gid'):
                with self.subTest(target=target, field=field):
                    self.assert_refused(f'identity:{target}:{field}')


if __name__ == '__main__':
    unittest.main()
