"""Current-main build refusal and v2 incompatibility controls, never observation.

The imported observer still models the pinned pre-standing-grant source. These
tests must not turn a current image or a v2-shaped synthetic record into proof.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from controlled_delivery_semantics import authenticate_connected_delivery, records
from controlled_save_semantics import APPROVAL_FIELDS
from controlled_semantics import closed_fields, digest, encoded, parse
from controlled_supervisor import REPO, SOURCE, assert_image_sources, observe
from controlled_timestamps import PRODUCER, PRODUCER_INPUT_SHA
from test_controlled_delivery_semantics import Fixture, uid


class CurrentMainPreparationControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='orca-current-preparation-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name)
        cls.image = cls.root / 'image'
        subprocess.run([shutil.which('node'), str(REPO / 'tools/owned-read-proof/build-controlled.mjs'),
                        str(cls.image)], cwd=REPO, check=True, capture_output=True, timeout=15)

    def test_current_image_is_not_the_legacy_observer_source(self):
        build = json.loads((self.image / 'controlled-build.json').read_bytes())
        self.assertNotEqual(build['sources'][PRODUCER], PRODUCER_INPUT_SHA)
        self.assertEqual(build['sources'][PRODUCER], hashlib.sha256((REPO / PRODUCER).read_bytes()).hexdigest())
        self.assertEqual(SOURCE, '3fce8bcc9afd381cd07c0e06051921307d6322b3')
        with self.assertRaisesRegex(RuntimeError, 'retained-original check failed'):
            assert_image_sources(self.image)

    def test_current_image_refuses_before_tracer_probe_or_owned_process_creation(self):
        # observe's real image check runs; no trace/probe/producer may be started.
        with patch('controlled_supervisor.probe_clock', side_effect=AssertionError('unexpected probe')) as probe, \
             patch('controlled_supervisor.run_traced', side_effect=AssertionError('unexpected trace')) as trace:
            with self.assertRaisesRegex(RuntimeError, 'retained-original check failed'):
                observe(self.root, self.image)
        probe.assert_not_called()
        trace.assert_not_called()
        self.assertFalse((self.root / 'bootstrap').exists())

    def test_standing_review_record_is_not_implicitly_admitted(self):
        fixture = Fixture()
        fixture.semantic('controlled-standing-review-v2', uid(90),
                         {'version': 2, 'grantMode': 'until-revoked'}, 46, 47)
        with self.assertRaisesRegex(RuntimeError, 'unknown/mismatched connected semantic kind'):
            records(fixture.encrypt())

    def test_standing_approval_fields_are_not_implicitly_admitted(self):
        approval = dict.fromkeys(APPROVAL_FIELDS.split())
        approval.update(version=2, grantMode='until-revoked', reviewUntil=None,
                        standingReview={'version': 2, 'result': 'passed', 'sourceRefs': [uid(90)]})
        with self.assertRaises(RuntimeError):
            closed_fields(approval, APPROVAL_FIELDS, 'controlled Save approval')

    def test_standing_rule_shape_is_not_implicitly_admitted(self):
        fixture = Fixture()
        saved = parse(fixture.saved.data)
        rule = saved['scopedRules']['records'][0]['rule']
        rule.update(version=2, expiresAt=None)
        rule['ruleRevision'] = digest({k: v for k, v in rule.items() if k != 'ruleRevision'})
        fixture.saved.data = encoded(saved).encode()
        revision = hashlib.sha256(fixture.saved.data).hexdigest()
        for index in (1, 2):
            fixture.change('controlled-capture-v1', index,
                           lambda value: value['action']['authority'].update(currentPolicyRevision=revision))
        with self.assertRaisesRegex(RuntimeError, 'saved rule'):
            authenticate_connected_delivery(fixture.encrypt())


if __name__ == '__main__':
    unittest.main()
