"""Synthetic, reauthenticated v2 histories. Never an observed/accepting run."""
from copy import deepcopy
import hashlib
import subprocess
import unittest
from unittest.mock import patch

from controlled_aggregate import compose_connected
from controlled_delivery_semantics import authenticate_connected_delivery
from controlled_semantics import digest, parse
from controlled_save_semantics import pretty
from controlled_supervisor import REPO, observe
from controlled_timestamps import iso_ns, PRODUCER
from controlled_v2_model import SOURCE, PRODUCER_INPUT_SHA, CHILD_SHA, MS
from test_controlled_aggregate import AggregateFixture
from test_controlled_delivery_semantics import authority, uid
from test_controlled_save_semantics import when


class V2Fixture(AggregateFixture):
    def __init__(self):
        super().__init__()
        r = self.replay
        # Distinct current-model fixture; never relabel the legacy positive.
        r.original['sourceHead'] = SOURCE
        r.original['controlledBuild']['sources'][PRODUCER] = PRODUCER_INPUT_SHA
        saved = parse(self.saved.data)
        old_rule = saved['scopedRules']['records'][0]['rule']
        rule = {'version': 2, **old_rule, 'expiresAt': None}
        rule['ruleRevision'] = digest({k: v for k, v in rule.items() if k != 'ruleRevision'})
        saved['scopedRules']['records'][0]['rule'] = rule
        self.saved.data = pretty(saved)
        revision = hashlib.sha256(self.saved.data).hexdigest()
        for i in (1, 2):
            self.change('controlled-capture-v1', i, lambda v: authority(v, 'currentPolicyRevision', revision))
        for i in (0, 1):
            self.change('controlled-authorization-v1', i, lambda v: authority(v, 'currentPolicyRevision', revision))
        self.change('controlled-authorization-v1', 1,
                    lambda v: v['verdict']['authorizedBy'].update(ruleRevision=rule['ruleRevision']))
        fresh_expiry = when(r.marks[4][4] + 55001)
        self.change('controlled-capture-v1', 2, lambda v: v['action'].update(expiresAt=fresh_expiry))
        self.change('controlled-authorization-v1', 1, lambda v: v['action'].update(expiresAt=fresh_expiry))
        actions = [v['action'] for _, v in self.values('controlled-capture-v1')]
        self.change('controlled-persistence-review-v1', 1,
                    lambda v: v.update(action=actions[1], revision=revision))
        self.approval['command']['rule'] = rule
        self.approval.update(version=2, grantMode='until-revoked',
            reviewUntil=iso_ns(actions[0]['expiresAt']) // MS,
            standingReview={'version': 2, 'result': 'passed', 'sourceRefs': [uid(95)]})
        self.approval['scope']['lifetime'] = 'Until revoked'
        self.approval['projection']['expiresAt']['value'] = None
        prior_ref, prior = self.values('controlled-persistence-review-v1')[0]
        standing = {'version': 2, 'grantMode': 'until-revoked', 'reviewedAt': iso_ns(when(451)) // MS,
            'action': actions[0], 'command': deepcopy(self.approval['command']),
            'binding': deepcopy(self.baseline['binding']), 'actor': deepcopy(self.baseline['operator']['actor']),
            'reviewer': deepcopy(prior['reviewer']), 'lease': deepcopy(self.baseline['lease']),
            'persistenceReview': {'ref': prior_ref, 'value': deepcopy(prior)}}
        self.semantic('controlled-standing-review-v2', uid(95), standing, 452, 454)
        self.rule, self.actions = rule, actions


def compose(fixture):
    return compose_connected(fixture.encrypt(), standing_v2=True)


class V2Controls(unittest.TestCase):
    def test_synthetic_positive_preserves_no_authority_and_exact_effect_inventory(self):
        result = compose(V2Fixture())
        self.assertEqual(result['semanticModel'], 'standing-v2')
        self.assertEqual(result['authority'], 'none')
        self.assertIsNone(result['acceptingToken'])
        self.assertFalse(result['productionEligible'])
        self.assertEqual(result['effects']['protectedFiles'], 18)
        self.assertEqual(result['delivery']['protectedRecords'], 16)
        self.assertEqual(result['save']['saveResourceReads'], 0)
        self.assertEqual(result['save']['saveAnswers'], 0)
        self.assertEqual(result['save']['executionReview'], 'unavailable')

    def test_v2_source_constants_match_committed_inputs(self):
        for path, expected in [(PRODUCER, PRODUCER_INPUT_SHA),
                               ('tools/owned-read-proof/controlled-child.mjs', CHILD_SHA)]:
            value = subprocess.run(['git', 'show', SOURCE + ':' + path], cwd=REPO,
                                   check=True, capture_output=True, timeout=5).stdout
            self.assertEqual(hashlib.sha256(value).hexdigest(), expected)

    def test_models_refuse_mixed_records_and_nonboolean_selectors(self):
        with self.assertRaises(RuntimeError):
            compose_connected(V2Fixture().encrypt())
        with self.assertRaises(RuntimeError):
            compose_connected(AggregateFixture().encrypt(), standing_v2=True)
        for flag in (1, 'v2', None):
            with self.subTest(flag=flag), self.assertRaises(RuntimeError):
                compose_connected(V2Fixture().encrypt(), standing_v2=flag)

    def test_v2_source_and_image_bindings_are_not_interchangeable(self):
        for field in ('source', 'producer-input', 'child-hash', 'producer-bytes', 'child-bytes'):
            f = V2Fixture()
            original = f.replay.original
            if field == 'source': original['sourceHead'] = '3fce8bcc9afd381cd07c0e06051921307d6322b3'
            elif field == 'producer-input': original['controlledBuild']['sources'][PRODUCER] = '0'*64
            elif field == 'child-hash': original['controlledBuild']['childSha256'] = '0'*64
            else:
                path = '/image/controlled-' + ('producer.mjs' if field == 'producer-bytes' else 'child.mjs')
                original['immutable'][path]['hex'] = '00'
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                compose(f)

    def test_no_model_can_reach_launcher_even_with_approved_image_checker(self):
        with patch('controlled_supervisor.assert_image_sources', return_value={}) as image, \
             patch('controlled_supervisor.probe_clock') as probe, \
             patch('controlled_supervisor.run_traced') as run:
            for lane in ('bootstrap', 'connected'):
                with self.assertRaisesRegex(RuntimeError, 'observer launch disabled'):
                    observe(None, None, lane)
            image.assert_not_called()
            probe.assert_not_called()
            run.assert_not_called()

    def test_every_standing_authority_field_and_prior_proof_is_bound(self):
        mutations = {
            'version': lambda v: v.update(version=True),
            'mode': lambda v: v.update(grantMode='forever'),
            'action': lambda v: v['action']['authority'].update(revocationEpoch='f'*64),
            'command': lambda v: v['command'].update(expectedRevision='f'*64),
            'scope': lambda v: v['command']['rule']['match'].update(operation='fs.write'),
            'binding': lambda v: v['binding'].update(workspaceRef='f'*64),
            'actor': lambda v: v['actor'].update(credentialId='other-actor'),
            'reviewer': lambda v: v['reviewer'].update(actor=deepcopy(v['actor'])),
            'reviewer-credential': lambda v: v['reviewer']['credential'].update(revokedAt=when(450)),
            'lease': lambda v: v['lease'].update(guardedId=uid(99)),
            'prior-ref': lambda v: v['persistenceReview'].update(ref=uid(99)),
            'prior-value': lambda v: v['persistenceReview']['value'].update(revision='f'*64),
            'extra': lambda v: v.update(permit=True),
        }
        for name, mutate in mutations.items():
            f = V2Fixture()
            f.change('controlled-standing-review-v2', 0, mutate)
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                compose(f)

    def test_standing_timestamp_approval_link_and_lifetime_negatives(self):
        for value in (True, 1.5, 0, 9007199254740992, iso_ns(when(449)) // MS, iso_ns(when(453)) // MS):
            f = V2Fixture()
            f.change('controlled-standing-review-v2', 0, lambda v: v.update(reviewedAt=value))
            with self.subTest(reviewedAt=value), self.assertRaises(RuntimeError):
                compose(f)
        for field, value in [('version', 1), ('grantMode', 'finite'), ('reviewUntil', True),
                             ('reviewUntil', iso_ns(when(60000)) // MS),
                             ('standingReview', {'version': 2, 'result': 'passed', 'sourceRefs': [uid(30)]})]:
            f = V2Fixture()
            f.approval[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                compose(f)
        for field, value in [('lifetime', 'Original test lifetime, at most one minute')]:
            f = V2Fixture()
            f.approval['scope'][field] = value
            with self.assertRaises(RuntimeError):
                compose(f)
        f = V2Fixture()
        f.approval['projection']['expiresAt']['value'] = f.actions[0]['expiresAt']
        with self.assertRaises(RuntimeError):
            compose(f)

    def test_standing_missing_duplicate_wrong_phase_or_order_refuses(self):
        for mutation in ('missing', 'duplicate', 'early', 'late', 'human-phase'):
            f = V2Fixture()
            obj = f.objects[uid(95)]
            if mutation == 'missing':
                del f.payloads[uid(95)]
                del f.objects[uid(95)]
            elif mutation == 'duplicate':
                f.semantic('controlled-standing-review-v2', uid(96),
                           f.values('controlled-standing-review-v2')[0][1], 453, 455)
            elif mutation == 'early': obj.creation_entry = 450
            elif mutation == 'late': obj.durable_publication_completion = 460
            else: obj.creation_entry, obj.durable_publication_completion = 1100, 1101
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                compose(f)

    def test_fresh_expiry_cannot_extend_owner_or_replace_current_authority(self):
        for mutation in ('stale-expiry', 'extended-expiry', 'human-expiry', 'authority', 'scope', 'null-expiry'):
            f = V2Fixture()
            if mutation == 'human-expiry':
                pairs = [('controlled-capture-v1', 1), ('controlled-authorization-v1', 0)]
            else:
                pairs = [('controlled-capture-v1', 2), ('controlled-authorization-v1', 1)]
            for kind, index in pairs:
                if mutation == 'authority':
                    f.change(kind, index, lambda v: authority(v, 'revocationEpoch', 'f'*64))
                elif mutation == 'scope':
                    f.change(kind, index, lambda v: v['action'].update(operation='fs.write'))
                else:
                    expiry = {'stale-expiry': f.actions[0]['expiresAt'], 'extended-expiry': when(60000),
                              'human-expiry': f.actions[2]['expiresAt'], 'null-expiry': None}[mutation]
                    f.change(kind, index, lambda v: v['action'].update(expiresAt=expiry))
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                compose(f)

    def test_fresh_action_never_extends_the_original_owner_run_bound(self):
        f = V2Fixture()
        original = f.replay.original
        finish = iso_ns(f.actions[0]['expiresAt'])
        delta = finish - original['finishedWallNs']
        original['finishedWallNs'] = finish
        for key in ('wallNs', 'monotonicBeforeNs', 'monotonicAfterNs'):
            original['clockSamples']['finish'][key] += delta
        self.assertGreater(iso_ns(f.actions[2]['expiresAt']), finish)
        with self.assertRaisesRegex(RuntimeError, 'v2 action expiry'):
            compose(f)

    def test_date_millisecond_floor_is_exact_without_timing_slack(self):
        f = V2Fixture()
        r = f.replay
        prior = f.objects[uid(30)]
        r.entry_times[prior.durable_publication_completion] += MS - 1
        f.change('controlled-standing-review-v2', 0,
                 lambda v: v.update(reviewedAt=r.entry_times[prior.durable_publication_completion] // MS))
        phase = r.marks[4][4]
        r.entry_times[phase] += MS - 1
        lower = when(phase + 55000)
        for kind, index in [('controlled-capture-v1', 2), ('controlled-authorization-v1', 1)]:
            f.change(kind, index, lambda v: v['action'].update(expiresAt=lower))
        self.assertEqual(compose(f)['authority'], 'none')
        # Recreate before the second encrypt: aggregate fixtures represent a
        # single publication graph, never mutable reuse of an accepted replay.
        f = V2Fixture()
        for kind, index in [('controlled-capture-v1', 2), ('controlled-authorization-v1', 1)]:
            f.change(kind, index, lambda v: v['action'].update(expiresAt=when(phase + 54999)))
        with self.assertRaisesRegex(RuntimeError, 'predates source issuance'):
            compose(f)

    def test_fresh_capture_upper_bound_and_review_deadline_are_exact(self):
        for offset in (0, 1):
            f = V2Fixture()
            capture = f.objects[f.values('controlled-capture-v1')[2][0]]
            expiry = when(capture.creation_entry + 55000 + offset)
            for kind, index in [('controlled-capture-v1', 2), ('controlled-authorization-v1', 1)]:
                f.change(kind, index, lambda v: v['action'].update(expiresAt=expiry))
            if offset == 0:
                self.assertEqual(compose(f)['authority'], 'none')
            else:
                with self.assertRaisesRegex(RuntimeError, 'v2 action expiry'):
                    compose(f)
        for offset in (-1, 1):
            f = V2Fixture()
            f.approval['reviewUntil'] += offset
            with self.assertRaisesRegex(RuntimeError, 'reviewUntil'):
                compose(f)

    def test_v2_retains_lost_ack_save_no_read_lease_revocation_and_namespace_checks(self):
        for mutation in ('lost-ack', 'save-read', 'lease', 'operator', 'reviewer', 'extra-effect', 'namespace'):
            f = V2Fixture()
            if mutation == 'lost-ack': del f.payloads[uid(50)]
            elif mutation == 'save-read': f.replay.resources[0].read_phases[0] = 'save'
            elif mutation == 'lease':
                value = parse(f.lease_object.data)
                value['guardedTtlMs'] = 300000
                f.lease_object.data = pretty(value)
            elif mutation in ('operator', 'reviewer'):
                value = parse(f.credential_objects[1].data)
                value['credentials'][mutation == 'reviewer']['revokedAt'] = when(440)
                f.credential_objects[1].data = pretty(value)
            elif mutation == 'extra-effect': f.replay.resources[0].reads.append(b'extra')
            else: f.replay.paths['/synthetic/unexpected'] = f.saved
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                compose(f)


if __name__ == '__main__':
    unittest.main()
