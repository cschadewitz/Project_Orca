"""Adversarial v2 composition controls; synthetic histories are not qualification.

No observer, tracer, designation constructor or production input is used. These
tests extend legacy cross-layer negatives to the distinct v2 composition path.
They do not establish the caller's full-kernel-replay prerequisite.
"""
import stat
import unittest

from controlled_aggregate import compose_connected, effect_inventory
from controlled_replay import Object
from controlled_semantics import encoded
from test_controlled_v2_semantics import V2Fixture, authority, compose, uid


class CurrentQualificationBoundaries(unittest.TestCase):
    def test_coherently_stale_human_and_fresh_policy_revision_refuse(self):
        for capture, authorization in ((1, 0), (2, 1)):
            f = V2Fixture()
            for kind, index in (('controlled-capture-v1', capture),
                                ('controlled-authorization-v1', authorization)):
                f.change(kind, index, lambda v: authority(v, 'currentPolicyRevision', 'f' * 64))
            with self.subTest(capture=capture), self.assertRaisesRegex(RuntimeError, 'stale connected current sidecar revision'):
                compose(f)

    def test_reauthenticated_final_ack_actor_and_target_refuse(self):
        for field, value in (('requestId', 'another-request'),
                             ('actor', {'principalId': 'reviewer', 'credentialId': 'reviewer1234'})):
            f = V2Fixture()
            f.change('controlled-final-delivery-ack-v1', 0, lambda v: v.update({field: value}))
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'acknowledgement target/actor'):
                compose(f)

    def test_pending_or_unobserved_final_ack_refuses(self):
        for field, value in (('physical', None), ('published', False), ('durable_publication_completion', None)):
            f = V2Fixture()
            ref, _ = f.values('controlled-final-delivery-ack-v1')[0]
            setattr(f.objects[ref], field, value)
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'physical durable publication'):
                compose(f)

    def test_human_and_rule_authorization_cannot_substitute_for_each_other(self):
        cases = ((0, {'kind': 'rule', 'ruleId': uid(10), 'ruleRevision': 'f' * 64}),
                 (1, {'kind': 'human', 'acceptedAnswerRef': encoded(['controlled', 'another-event'])}),
                 (1, {'kind': 'rule', 'ruleId': uid(10), 'ruleRevision': 'f' * 64}))
        for index, replacement in cases:
            f = V2Fixture()
            f.change('controlled-authorization-v1', index,
                     lambda v: v['verdict'].update(authorizedBy=replacement))
            with self.subTest(index=index, replacement=replacement), self.assertRaisesRegex(RuntimeError, 'human/fresh rule authorization'):
                compose(f)

    def test_surviving_journal_must_equal_authenticated_append_history(self):
        r = V2Fixture().encrypt()
        path = r.original['base'] + '/workspace/.orca/runs/controlled.jsonl'
        r.paths[path].data += b'{}\n'
        with self.assertRaisesRegex(RuntimeError, 'journal bytes differ from append history'):
            compose_connected(r, standing_v2=True)

    def test_v2_effect_inventory_rejects_extra_mutation_residual_name_and_pending_publication(self):
        for mutation in ('extra-mutation', 'residual-resource', 'pending-publication', 'extra-name'):
            r = V2Fixture().encrypt()
            if mutation == 'extra-mutation':
                r.objects.append(Object('credentials-temp', stat.S_IFREG | 0o600, set()))
            elif mutation == 'residual-resource':
                r.resources[0].names = {r.original['base'] + '/still-open-resource'}
            elif mutation == 'pending-publication':
                next(o for o in r.objects if o.family == 'protected-temp').temporary_cleanup_completion = None
            else:
                r.paths[r.original['base'] + '/extra'] = Object('control-record', stat.S_IFREG | 0o600, set())
            with self.subTest(mutation=mutation), self.assertRaisesRegex(RuntimeError, 'aggregate'):
                effect_inventory(r, standing_v2=True)

    def test_validly_reencrypted_execution_inputs_cannot_add_authority(self):
        for field, value in (('vars', {'permission': 'allow'}), ('secrets', ['synthetic-secret-ref'])):
            f = V2Fixture()
            r = f.encrypt()
            f.inputs[field] = value
            f.reencrypt_inputs()
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'unexpected original execution inputs'):
                compose_connected(r, standing_v2=True)


if __name__ == '__main__':
    unittest.main()
