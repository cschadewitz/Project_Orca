"""Disposable test-image source bindings only; no trace or bootstrap authority.

Build one real image, then exercise actual source and physical association checks
on private copies. Historical source/child pairs are never fallback trust pins.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import controlled_connected as connected
import controlled_supervisor as supervisor
import controlled_timestamps as timestamps
from controlled_connected import ConnectedDesignation, snapshot
from controlled_supervisor import REPO, assert_image_sources
from test_controlled_timestamps import (HISTORICAL_CHILD, HISTORICAL_CHILD_SHA, HISTORICAL_SOURCE,
    PREVIOUS_CHILD, PREVIOUS_CHILD_SHA, PREVIOUS_SOURCE, HISTORICAL_PRODUCER_INPUT_SHA)


class ReviewedImagePinControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='orca-reviewed-image-controls-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.master = Path(cls.temp.name) / 'built-image'
        subprocess.run([shutil.which('node'), str(REPO / 'tools/owned-read-proof/build-controlled.mjs'),
                        str(cls.master)], cwd=REPO, check=True, capture_output=True, timeout=15)
        cls.build = json.loads((cls.master / 'controlled-build.json').read_bytes())

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='orca-image-pin-case-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.image = self.root / 'image'
        shutil.copytree(self.master, self.image)
        self.bootstrap = self.root / 'bootstrap'
        self.bootstrap.mkdir()
        (self.bootstrap / 'lifetime.lock').touch(mode=0o600)
        self.proof = self.root / 'synthetic-evidence.json'
        self.proof.write_bytes(b'synthetic closed bootstrap evidence; never process acceptance')

    def designation(self):
        return ConnectedDesignation(bootstrap_base=self.bootstrap, evidence_path=self.proof,
            evidence_ref='synthetic:source-pin-controls', image=self.image,
            assert_bootstrap_closed=lambda: None)

    def inventory(self):
        return {str(p): {'identity': list(s[:5]), 'stamp': list(map(str, s)),
                        'sha256': supervisor.digest(data)}
                for p in sorted(self.image.iterdir()) for s, data in [snapshot(p)]}

    def manifest(self, build):
        path = self.image / 'controlled-build.json'
        path.chmod(0o600)
        path.write_text(json.dumps(build))

    def test_source_pins_and_rebuilt_input_correspondence_are_coherent(self):
        self.assertEqual(supervisor.SOURCE, connected.SOURCE)
        self.assertEqual(supervisor.SOURCE, timestamps.SOURCE)
        self.assertEqual(timestamps.SOURCE, '3fce8bcc9afd381cd07c0e06051921307d6322b3')
        self.assertEqual(self.build['childSha256'], timestamps.CHILD_SHA)
        self.assertEqual(self.build['sources'][timestamps.PRODUCER], timestamps.PRODUCER_INPUT_SHA)
        retained = json.loads((REPO / 'docs/preparation/tool-execution-guards/'
            'controlled-currentness-composition-frozen-build.json').read_bytes())
        self.assertEqual(self.build, retained)
        self.assertEqual(assert_image_sources(self.image), self.build)
        self.assertEqual(supervisor.digest(HISTORICAL_CHILD), HISTORICAL_CHILD_SHA)
        self.assertNotEqual(timestamps.SOURCE, HISTORICAL_SOURCE)

    def test_unreviewed_child_or_producer_input_cannot_select_a_runtime_image(self):
        # Source implementation and observer repinning are separate review steps.
        # A preparation build must refuse while either reviewed input still differs.
        child = self.build['childSha256']
        producer = self.build['sources'][timestamps.PRODUCER]
        self.assertEqual(producer, supervisor.digest((REPO / timestamps.PRODUCER).read_bytes()))
        if child != timestamps.CHILD_SHA or producer != timestamps.PRODUCER_INPUT_SHA:
            with self.assertRaises(RuntimeError):
                assert_image_sources(self.image)
            with self.assertRaises(RuntimeError):
                timestamps.source_binding({'sourceHead': timestamps.SOURCE, 'controlledBuild': self.build})
        else:
            self.assertEqual(assert_image_sources(self.image), self.build)

    def test_new_image_retains_physical_inventory_and_proof_associations(self):
        d = self.designation()
        inventory = self.inventory()
        result = d.association(inventory)
        self.assertEqual(result['proofSha256'], supervisor.digest(self.proof.read_bytes()))
        self.assertEqual(result['installedInventoryDigest'],
                         supervisor.digest(supervisor.encoded(inventory).encode()))
        d.check()
        for field in ('identity', 'stamp', 'sha256'):
            changed = deepcopy(inventory)
            original = changed[next(iter(changed))][field]
            changed[next(iter(changed))][field] = [] if isinstance(original, list) else '0' * 64
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                d.association(changed)

    def test_connected_original_source_build_bytes_and_plan_bindings_refuse_mixtures(self):
        d = self.designation()
        base = self.root / 'connected'
        base.mkdir()
        lifetime = base / 'lifetime.lock'
        lifetime.touch(mode=0o600)
        inventory = self.inventory()
        plan = {'inventory': inventory, 'bootstrap': d.association(inventory)}
        path = base / 'controlled-plan.json'
        path.write_text(supervisor.encoded(plan))
        files = {**d.files, str(self.proof): d.proof, str(path): snapshot(path),
                 str(lifetime): snapshot(lifetime)}
        original = {'base': str(base), 'lane': 'connected', 'sourceHead': timestamps.SOURCE,
                    'controlledBuild': deepcopy(self.build), 'immutable': {}}
        for name, (physical, data) in files.items():
            original['immutable'][name] = {
                'family': 'image' if name in d.files else 'lifetime' if name == str(lifetime) else 'original-file',
                'identity': list(physical[:5]), 'hex': data.hex(), 'sha256': supervisor.digest(data)}
        d.bind(original)
        changes = [lambda o: o.update(sourceHead=HISTORICAL_SOURCE),
                   lambda o: o.update(sourceHead=PREVIOUS_SOURCE),
                   lambda o: o['controlledBuild'].update(childSha256=HISTORICAL_CHILD_SHA),
                   lambda o: o['controlledBuild'].update(childSha256=PREVIOUS_CHILD_SHA),
                   lambda o: o['controlledBuild']['sources'].update({
                       timestamps.PRODUCER: HISTORICAL_PRODUCER_INPUT_SHA}),
                   lambda o: o['controlledBuild'].update(producerSha256='0' * 64),
                   lambda o: o['immutable'][str(self.proof)].update(hex='00'),
                   lambda o: o['immutable'][str(self.image / 'controlled-child.mjs')].update(
                       hex=HISTORICAL_CHILD.hex(), sha256=HISTORICAL_CHILD_SHA),
                   lambda o: o['immutable'][str(self.image / 'controlled-child.mjs')].update(identity=[0]*5),
                   lambda o: o['immutable'][str(path)].update(hex=supervisor.encoded(
                       {**plan, 'bootstrap': {**plan['bootstrap'], 'proofSha256': '0'*64}}).encode().hex())]
        for index, change in enumerate(changes):
            altered = deepcopy(original)
            change(altered)
            with self.subTest(change=index), self.assertRaises(RuntimeError):
                d.bind(altered)

    def test_old_child_or_old_manifest_and_mixed_pairs_refuse(self):
        current_child = (self.master / 'controlled-child.mjs').read_bytes()
        for child in (HISTORICAL_CHILD, PREVIOUS_CHILD, current_child):
            for declared_hash in (HISTORICAL_CHILD_SHA, PREVIOUS_CHILD_SHA, timestamps.CHILD_SHA):
                if child == current_child and declared_hash == timestamps.CHILD_SHA:
                    continue
                (self.image / 'controlled-child.mjs').write_bytes(child)
                build = deepcopy(self.build)
                build['childSha256'] = declared_hash
                self.manifest(build)
                with self.subTest(child_hash=supervisor.digest(child), manifest=declared_hash):
                    with self.assertRaises(RuntimeError):
                        assert_image_sources(self.image)
                    with self.assertRaises(RuntimeError):
                        self.designation()

    def test_bundle_tamper_and_self_consistent_historical_child_refuse(self):
        (self.image / 'controlled-producer.mjs').write_bytes(b'tampered bundle')
        with self.assertRaises(RuntimeError):
            assert_image_sources(self.image)
        # A self-consistent child hash cannot disguise historical child bytes.
        (self.image / 'controlled-child.mjs').write_bytes(HISTORICAL_CHILD)
        build = deepcopy(self.build)
        build.update(producerSha256=supervisor.digest(b'tampered bundle'), childSha256=HISTORICAL_CHILD_SHA)
        self.manifest(build)
        with self.assertRaises(RuntimeError):
            assert_image_sources(self.image)

    def test_retained_image_proof_and_same_bytes_replacement_refuse(self):
        targets = [*sorted(self.image.iterdir()), self.proof]
        for path in targets:
            original = path.read_bytes()
            d = self.designation()
            path.chmod(0o600)
            path.write_bytes(original + b'\n')
            with self.subTest(path=path.name, mutation='bytes'), self.assertRaises(RuntimeError):
                d.check()
            path.write_bytes(original)
            d = self.designation()
            other = self.root / 'replacement'
            other.write_bytes(original)
            os.replace(other, path)
            with self.subTest(path=path.name, mutation='same-bytes-new-inode'), self.assertRaises(RuntimeError):
                d.check()


if __name__ == '__main__':
    unittest.main()
