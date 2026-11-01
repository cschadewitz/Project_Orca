"""Current-image refusal plus mandatory, separately inventoried legacy controls.

ORCA_LEGACY_IMAGE_FIXTURE names an isolated SOURCE checkout with its own frozen
dependencies and a byte-exact copy of this current non-live Python harness.
Missing or invalid fixtures fail; historical-positive coverage is never skipped.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import controlled_connected as connected
import controlled_supervisor as supervisor
import controlled_timestamps as timestamps

REPO = supervisor.REPO
MANIFEST = Path('docs/preparation/tool-execution-guards/controlled-currentness-composition-frozen-build.json')


def legacy_fixture(value):
    if not value:
        raise RuntimeError('required ORCA_LEGACY_IMAGE_FIXTURE is missing; historical coverage is blocked')
    root = Path(value).resolve(strict=True)
    if root == REPO.resolve():
        raise RuntimeError('historical fixture must be separate from the current checkout')
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, check=True,
                          capture_output=True, text=True, timeout=5).stdout.strip()
    if head != supervisor.SOURCE:
        raise RuntimeError('historical fixture HEAD differs from fixed SOURCE')
    # These are test-harness inputs, not image inputs or runtime designation.
    paths = [p.relative_to(REPO) for p in sorted((REPO / 'tools/owned-read-proof').glob('*.py'))]
    if {p.name for p in (root / 'tools/owned-read-proof').glob('*.py')} != {p.name for p in paths}:
        raise RuntimeError('historical fixture Python harness inventory differs')
    paths.append(MANIFEST)
    inventory = {}
    for path in paths:
        data = (REPO / path).read_bytes()
        if (root / path).is_symlink() or (root / path).read_bytes() != data:
            raise RuntimeError('historical fixture harness differs: ' + str(path))
        inventory[str(path)] = hashlib.sha256(data).hexdigest()
    retained = json.loads((REPO / MANIFEST).read_bytes())
    protected = {p for p in retained['sources'] if not p.startswith('node_modules/')}
    protected.update(('tools/owned-read-proof/controlled-child.mjs',
                      'tools/owned-read-proof/build-controlled.mjs', 'pnpm-lock.yaml', 'package.json', 'tsconfig.json'))
    if protected & set(inventory):
        raise RuntimeError('harness would overwrite a historical image/build input')
    for path in sorted(protected):
        original = subprocess.run(['git', 'show', supervisor.SOURCE + ':' + path], cwd=root,
                                  check=True, capture_output=True, timeout=5).stdout
        if (root / path).is_symlink() or (root / path).read_bytes() != original:
            raise RuntimeError('historical input overwritten: ' + path)
    return root, inventory


class CurrentImagePinControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='orca-current-image-refusal-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.image = Path(cls.temp.name) / 'image'
        subprocess.run([shutil.which('node'), str(REPO / 'tools/owned-read-proof/build-controlled.mjs'),
                        str(cls.image)], cwd=REPO, check=True, capture_output=True, timeout=15)
        cls.build = json.loads((cls.image / 'controlled-build.json').read_bytes())

    def test_current_bytes_are_coherent_but_not_the_legacy_source(self):
        self.assertEqual(supervisor.SOURCE, connected.SOURCE)
        self.assertEqual(supervisor.SOURCE, timestamps.SOURCE)
        self.assertEqual(supervisor.SOURCE, '3fce8bcc9afd381cd07c0e06051921307d6322b3')
        for path, expected in self.build['sources'].items():
            self.assertEqual(hashlib.sha256((REPO / path).read_bytes()).hexdigest(), expected)
        for name, field in [('controlled-child.mjs', 'childSha256'),
                            ('controlled-producer.mjs', 'producerSha256')]:
            self.assertEqual(hashlib.sha256((self.image / name).read_bytes()).hexdigest(), self.build[field])
        self.assertNotEqual(self.build['sources'][timestamps.PRODUCER], timestamps.PRODUCER_INPUT_SHA)
        self.assertNotEqual(self.build, json.loads((REPO / MANIFEST).read_bytes()))
        with self.assertRaisesRegex(RuntimeError, 'retained-original check failed'):
            supervisor.assert_image_sources(self.image)
        with self.assertRaisesRegex(RuntimeError, 'missing reviewed expiry-before-service source ordering'):
            timestamps.source_binding({'sourceHead': timestamps.SOURCE, 'controlledBuild': self.build})

    def test_current_image_cannot_construct_a_legacy_designation(self):
        root = Path(self.temp.name)
        bootstrap = root / 'bootstrap'
        bootstrap.mkdir()
        (bootstrap / 'lifetime.lock').touch(mode=0o600)
        proof = root / 'synthetic-evidence'
        proof.write_bytes(b'synthetic closure fixture, never runtime authority')
        with self.assertRaisesRegex(RuntimeError, 'retained-original check failed'):
            connected.ConnectedDesignation(bootstrap_base=bootstrap, evidence_path=proof,
                evidence_ref='synthetic:current-source-refusal', image=self.image,
                assert_bootstrap_closed=lambda: None)


class HistoricalImagePinControls(unittest.TestCase):
    def test_missing_historical_fixture_is_a_failure_not_a_skip(self):
        with self.assertRaisesRegex(RuntimeError, 'historical coverage is blocked'):
            legacy_fixture(None)

    def test_current_checkout_cannot_be_used_as_historical_fixture(self):
        with self.assertRaisesRegex(RuntimeError, 'separate from the current checkout'):
            legacy_fixture(str(REPO))

    def test_real_historical_source_and_physical_controls(self):
        root, inventory = legacy_fixture(os.environ.get('ORCA_LEGACY_IMAGE_FIXTURE'))
        print('Historical harness (separate from image inputs): ' + json.dumps(inventory, sort_keys=True), flush=True)
        result = subprocess.run([sys.executable, *(['-O'] * sys.flags.optimize), '-B', '-m', 'unittest',
                                 'legacy_image_pin_controls', '-v'],
                                cwd=root / 'tools/owned-read-proof', capture_output=True,
                                text=True, timeout=60)
        print(result.stdout + result.stderr, flush=True)
        self.assertEqual(result.returncode, 0, 'mandatory historical source/physical controls failed')


if __name__ == '__main__':
    unittest.main()
