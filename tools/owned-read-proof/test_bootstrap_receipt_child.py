"""Synthetic repository-child read/hash controls, never a traced original attempt.

Only the producer is a stub. The exact repository child executes with a real
supervisor flock and command/ack pipes. No credentials or service are created.
"""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from controlled_supervisor import REPO, digest, encoded, prepare


STUB = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = fs.readFileSync;
let reads = 0, bytes = 0;
export function assertControlledLifetimeFdinfo(fd) {
  assert.match(read(`/proc/self/fdinfo/${fd}`, 'utf8'), /FLOCK\s+ADVISORY\s+WRITE /);
}
export async function runControlledOwnedReadTest(base, lane, options) {
  const plan = JSON.parse(read(`${base}/controlled-plan.json`, 'utf8'));
  const proof = plan.bootstrap.proofPath;
  // Instrument the child's real synchronous read/hash calls after initial check.
  fs.readFileSync = function(path, ...args) {
    const data = read.call(this, path, ...args);
    if (path === proof) { reads++; bytes += Buffer.byteLength(data); }
    return data;
  };
  for (let i = 0; i < 4; i++) {
    options.assertCurrent();
    options.bootstrap.assertCurrent();
  }
  assert.equal(reads, 12); // check + bootstrap's check + bootstrap's proof hash, each time
  if (process.env.RECEIPT_CHILD_TAMPER === 'bytes') {
    const original = read(proof);
    fs.writeFileSync(proof, Buffer.alloc(original.length, 120));
  } else if (process.env.RECEIPT_CHILD_TAMPER === 'replacement') {
    fs.writeFileSync(proof + '.new', read(proof));
    fs.renameSync(proof + '.new', proof);
  }
  options.assertCurrent();
  options.bootstrap.assertCurrent();
  for (const name of ['save', 'human-read', 'rule-read']) await options.phase(name, async () => {});
  assert.equal(reads, 21);
  return { syntheticChildOnly: true, proofReads: reads, proofReadBytes: bytes };
}
'''


class BootstrapReceiptChildControls(unittest.TestCase):
    def child(self, proof_bytes, tamper=None, association=None, stub=STUB):
        with tempfile.TemporaryDirectory(prefix='orca-receipt-child-control-') as directory:
            root = Path(directory)
            image, base = root / 'image', root / 'connected'
            image.mkdir()
            base.mkdir()
            child = image / 'controlled-child.mjs'
            child.write_bytes((REPO / 'tools/owned-read-proof/controlled-child.mjs').read_bytes())
            (image / 'controlled-producer.mjs').write_text(stub)
            (image / 'controlled-build.json').write_text('{}')
            proof = root / 'association.json'
            proof.write_bytes(proof_bytes)
            lifetime = os.open(base / 'lifetime.lock', os.O_CREAT | os.O_RDWR, 0o600)
            command, send = os.pipe()
            receive, ack = os.pipe()
            try:
                fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
                phases = [{'name': name, 'token': str(i + 1) * 64}
                          for i, name in enumerate(('save', 'human-read', 'rule-read'))]
                plan = prepare(base, image, lifetime, command, ack, phases)
                plan['lane'] = 'connected'
                info = proof.lstat()
                plan['originalFiles'][str(proof)] = {
                    'identity': [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid],
                    'sha256': digest(proof_bytes)}
                plan['bootstrap'] = {'evidenceRef': 'synthetic-original-only', 'proofPath': str(proof),
                                     'proofSha256': digest(proof_bytes),
                                     'installedInventoryDigest': digest(encoded(plan['inventory']).encode())}
                if association:
                    plan['bootstrap'][association] = 'changed'
                (base / 'controlled-plan.json').write_text(encoded(plan))
                commands = ''.join(f"orca-phase:{p['name']}:{p['token']}\n" for p in phases).encode()
                os.write(send, commands)
                result = subprocess.run([shutil.which('node'), str(child), str(base), 'connected',
                    str(lifetime), str(command), str(ack)], pass_fds=(lifetime, command, ack),
                    capture_output=True, timeout=10,
                    env={**os.environ, 'RECEIPT_CHILD_TAMPER': tamper or ''})
                return result
            finally:
                for number in (lifetime, command, send, receive, ack):
                    os.close(number)

    def test_same_fresh_read_hash_calls_use_fewer_designated_bytes(self):
        receipt, full_report = b'{"syntheticAssociation":"digest"}', b'complete synthetic report ' * 2000
        compact = self.child(receipt)
        full = self.child(full_report)
        self.assertEqual(compact.returncode, 0, compact.stderr.decode())
        self.assertEqual(full.returncode, 0, full.stderr.decode())
        compact, full = json.loads(compact.stdout), json.loads(full.stdout)
        self.assertEqual(compact['proofReads'], full['proofReads'])
        self.assertEqual(compact['proofReadBytes'], 21 * len(receipt))
        self.assertEqual(full['proofReadBytes'], 21 * len(full_report))
        self.assertLess(compact['proofReadBytes'], full['proofReadBytes'])

    def test_child_fresh_hash_and_physical_identity_refuse_tamper(self):
        for scenario in ('bytes', 'replacement'):
            with self.subTest(scenario=scenario):
                result = self.child(b'original immutable synthetic association', scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'AssertionError', result.stderr)
                self.assertEqual(result.stdout, b'')

    def test_child_bootstrap_proof_and_inventory_associations_refuse(self):
        for field in ('proofSha256', 'installedInventoryDigest', 'proofPath'):
            with self.subTest(field=field):
                result = self.child(b'original immutable synthetic association', association=field)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'AssertionError', result.stderr)
                self.assertEqual(result.stdout, b'')


if __name__ == '__main__':
    unittest.main()
