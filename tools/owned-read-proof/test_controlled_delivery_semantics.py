"""Reauthenticated synthetic delivery correlations; no observed connected acceptance."""
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
import unittest
from urllib.parse import quote

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from controlled_delivery_semantics import authenticate_connected_delivery
from controlled_semantics import decode, digest, encoded, parse
from test_controlled_semantics import synthetic_bootstrap
from test_controlled_connected import raw
from test_controlled_timestamps import START, NS


def uid(n):
    return '12345678-1234-4123-8123-' + f'{n:012x}'


def at(raw_line):
    value = datetime.fromtimestamp(START // NS, timezone.utc) + timedelta(seconds=1, milliseconds=raw_line * 10)
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def authority(value, field, replacement):
    value['action']['authority'][field] = replacement
    if 'verdict' in value:
        value['verdict']['authority'] = deepcopy(value['action']['authority'])


class Fixture:
    """Physical observations here are declared synthetic, never an observed run."""
    def __init__(self):
        r, old, _, self.key = synthetic_bootstrap()
        self.replay, self.payloads, self.objects = r, {}, {}
        r.original['lane'] = 'connected'
        r.designation = SimpleNamespace(evidence_ref='trusted-supervisor:synthetic-original', check=lambda: None)
        r.entry_times = {i: START + NS + i * NS // 100 for i in range(221)}
        r.marks = [(10, 'read' if i % 2 == 0 else 'write', [], '0', line, line)
                   for i, line in enumerate([5, 80, 90, 150, 160, 200])]
        resource = r.resources[0]
        resource.creation_entry = 10
        resource.creation_record = (*resource.creation_record[:4], 10, 10)
        resource.effect_entries = [135, 185]
        resource.read_phases = ['human-read', 'rule-read']
        resource.reads = [resource.data[2:6]] * 2
        a = deepcopy(old['controlled-capture-v1'][1]['action'])
        a['coverage']['level'] = 'verified-per-execution'
        a['coverage']['evidence']['installedRefs'] = [r.designation.evidence_ref]
        a['coverage']['evidence']['independentlyObservedEffects'] = True
        baseline = deepcopy(old['controlled-baseline-v1'][1])
        baseline['originalAction'], baseline['rules'] = a, []
        baseline['installedEvidenceRef'] = r.designation.evidence_ref
        self.baseline, self.actions = baseline, [a]
        sidecar = r.original['base'] + '/workspace/orca.permissions.json'
        initial = r.paths[sidecar]
        initial.physical, initial.names = (0, 1, 500), set()
        initial.publication_path, initial.publication_method = sidecar, 'rename'
        initial.writer_close_completion, initial.publication_entry, initial.publication_completion = 6, 7, 8
        rule = deepcopy(old['controlled-baseline-v1'][1]['rules'][0])
        rule['ruleId'], rule['notBefore'] = uid(10), at(40)
        rule['ruleRevision'] = digest({k: v for k, v in rule.items() if k != 'ruleRevision'})
        actor = baseline['operator']['actor']
        record = {'rule': rule, 'actor': actor, 'approvalRecordRef': encoded(['controlled', uid(11)]),
                  'scopeEvidenceRef': uid(12), 'authorityRevision': a['authority']['authorityRevision']}
        saved = SimpleNamespace(data=encoded({'version': 2, 'agents': {}, 'scopedRules': {'version': 1, 'records': [record]}}).encode(),
            physical=(0, 1, 501), names={sidecar}, publication_path=sidecar, publication_method='rename',
            writer_close_completion=53, publication_entry=54, publication_completion=55)
        r.paths[sidecar], r.objects = saved, [initial, saved]
        self.sidecar_path, self.saved, self.rule = sidecar, saved, rule
        import hashlib
        revision = hashlib.sha256(saved.data).hexdigest()
        for index in (2, 3):
            action = deepcopy(a)
            action['actionId'] = uid(index)
            action['bindingRef'] = 'synthetic-read:' + uid(index) + ':action'
            for key in ('original', 'dispatch'):
                action[key]['privateRef'] = action[key]['bindingRef'] = 'synthetic-read:' + uid(index) + ':parameters'
            action['authority']['currentPolicyRevision'] = revision
            if index == 3:
                action['invocation'].update(turnId='controlled-rule-turn', invocationId='controlled-rule-invocation')
            self.actions.append(action)
        self.semantic('controlled-baseline-v1', uid(20), baseline, 20, 25)
        for i, action in enumerate(self.actions):
            ref = 'capture:' + action['bindingRef']
            self.semantic('controlled-capture-v1', ref,
                {'action': action, 'bytes': old['controlled-capture-v1'][1]['bytes']}, [30, 115, 165][i], [35, 120, 170][i])
        credentials = parse(r.paths[r.original['base'] + '/credentials.json'].data)['credentials']
        reviewer = {k: v for k, v in credentials[1].items() if k != 'secretSha256'}
        for i in (0, 1):
            action = self.actions[i]
            self.semantic('controlled-persistence-review-v1', uid(30+i),
                {'version': 1, 'action': action, 'binding': baseline['binding'], 'actor': actor,
                 'reviewer': {'actor': {'principalId': reviewer['principal'], 'credentialId': reviewer['id']}, 'credential': reviewer},
                 'lease': baseline['lease'], 'revision': action['authority']['currentPolicyRevision'],
                 'expiresAt': action['expiresAt'], 'plannedInterval': {'offset': 2, 'length': 4},
                 'executionReview': {'result': 'unavailable', 'sourceRefs': []}}, [40, 60][i], [45, 65][i])
        r.journal_records = [raw(i) for i in range(4)]
        r.journal_entries, r.journal_closes = [13, 17, 50, 101], [14, 18, 51, 102]
        for i, row in enumerate(r.journal_records):
            row['at'], row['executionPayloadRef'] = at(r.journal_entries[i]), uid(40+i)
            if i == 2:
                row['payload']['scopedApprovalRef'] = uid(11)
            if i == 3:
                row['payload']['actor'] = deepcopy(actor)
            payload = deepcopy(row['payload'])
            if i == 2:
                # This stage authenticates opaque Save entry bytes/projection only;
                # full approval/persistence semantics are explicitly still pending.
                payload['entry'] = {'choice': 'save', 'requiredReview': 'unavailable'}
            self.put(row['executionPayloadRef'], row['type'], payload, [11, 15, 46, 95][i], [12, 16, 47, 99][i])
        self.semantic('controlled-final-delivery-ack-v1', uid(50),
            {'requestId': r.journal_records[0]['payload']['requestId'], 'actor': actor}, 105, 110)
        for i, action in enumerate(self.actions[1:]):
            ref = 'synthetic-read:' + action['actionId'] + ':evidence'
            by = ({'kind': 'human', 'acceptedAnswerRef': encoded(['controlled', r.journal_records[3]['id']])}
                  if i == 0 else {'kind': 'rule', 'ruleId': rule['ruleId'], 'ruleRevision': rule['ruleRevision']})
            verdict = {'version': 1, 'actionBindingRef': action['bindingRef'], 'authority': action['authority'],
                       'coverageId': action['coverage']['coverageId'], 'outcome': 'allow', 'authorizedBy': by}
            self.semantic('controlled-authorization-v1', ref, {'action': action, 'verdict': verdict, 'protectedEvidenceRef': ref},
                          [125, 175][i], [130, 180][i])
            self.semantic('controlled-producer-observation-v1', uid(60+i),
                          {'actionId': action['actionId'], 'authorizationRef': ref}, [140, 190][i], [145, 195][i])

    def put(self, ref, kind, payload, entry, durable):
        self.payloads[ref] = {'runId': 'controlled', 'type': kind, 'sensitivityRefs': [], 'payload': payload}
        self.objects[ref] = SimpleNamespace(creation_entry=entry, durable_publication_completion=durable,
            physical=(0, 1, 1000+entry), published=True, directory_synced=True)

    def semantic(self, kind, ref, value, entry, durable):
        self.put(ref, 'agent.update', {'stepRunId': 'controlled-step', 'sessionId': 'controlled-session',
                 'update': {'kind': kind, 'text': encoded({'kind': kind, 'value': value})}}, entry, durable)

    def values(self, kind):
        return [(ref, parse(payload['payload']['update']['text'])['value']) for ref, payload in self.payloads.items()
                if payload['type'] == 'agent.update' and payload['payload']['update']['kind'] == kind]

    def change(self, kind, index, mutate):
        ref, value = self.values(kind)[index]
        mutate(value)
        self.payloads[ref]['payload']['update']['text'] = encoded({'kind': kind, 'value': value})

    def encrypt(self):
        directory = self.replay.original['base'] + '/workspace/.orca/private-execution/'
        for i, (ref, payload) in enumerate(self.payloads.items()):
            name = quote(ref, safe='') + '.payload.json'
            plaintext = encoded(payload).encode()
            nonce = i.to_bytes(12, 'big')
            aad = ('orca:protected-execution:v1:private-execution:' + name).encode()
            ciphertext = AESGCM(self.key).encrypt(nonce, plaintext, aad)
            envelope = {'version': 1, 'algorithm': 'aes-256-gcm', 'nonce': base64.b64encode(nonce).decode(),
                        'ciphertext': base64.b64encode(ciphertext[:-16]).decode(), 'tag': base64.b64encode(ciphertext[-16:]).decode()}
            obj = self.objects[ref]
            obj.data = encoded(envelope).encode()
            # Every semantic negative is valid AEAD, including correct filename AAD.
            if decode(name, obj.data, self.key) != payload:
                raise AssertionError('synthetic crypto roundtrip failed')
            self.replay.paths[directory + name] = obj
        return self.replay


class DeliveryCorrelationControls(unittest.TestCase):
    def result(self, fixture):
        return authenticate_connected_delivery(fixture.encrypt())

    def test_synthetic_positive_is_explicitly_not_save_or_live_delivery_authority(self):
        result = self.result(Fixture())
        self.assertEqual(result['authority'], 'none')
        self.assertEqual(result['protectedRecords'], 15)
        self.assertEqual(result['saveAuthority'], 'unvalidated-persistence-approval-and-review')
        self.assertEqual(result['liveDeliveryAuthority'], 'unmeasured-exact-source-memory')

    def test_lost_final_ack_refuses_despite_original_durable_answer(self):
        f = Fixture()
        ref, _ = f.values('controlled-final-delivery-ack-v1')[0]
        f.payloads.pop(ref)
        with self.assertRaisesRegex(RuntimeError, 'record inventory'):
            self.result(f)

    def test_pending_late_or_cross_phase_final_ack_refuses(self):
        for entry, durable in [(105, 125), (151, 155), (105, None)]:
            f = Fixture()
            ref, _ = f.values('controlled-final-delivery-ack-v1')[0]
            f.objects[ref].creation_entry, f.objects[ref].durable_publication_completion = entry, durable
            with self.subTest(entry=entry, durable=durable), self.assertRaises(RuntimeError):
                self.result(f)

    def test_reauthenticated_wrong_ack_request_or_actor_refuses(self):
        for field, value in [('requestId', 'another'), ('actor', {'principalId': 'reviewer', 'credentialId': 'reviewer1234'})]:
            f = Fixture()
            f.change('controlled-final-delivery-ack-v1', 0, lambda v: v.__setitem__(field, value))
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'acknowledgement target/actor'):
                self.result(f)

    def test_reauthenticated_wrong_human_answer_reference_and_rule_attribution_refuse(self):
        for index, kind in [(0, {'kind': 'human', 'acceptedAnswerRef': encoded(['controlled', 'another-event'])}),
                            (1, {'kind': 'human', 'acceptedAnswerRef': encoded(['controlled', 'another-event'])}),
                            (1, {'kind': 'rule', 'ruleId': uid(10), 'ruleRevision': 'f'*64})]:
            f = Fixture()
            f.change('controlled-authorization-v1', index, lambda v: v['verdict'].__setitem__('authorizedBy', kind))
            with self.subTest(index=index), self.assertRaisesRegex(RuntimeError, 'human/fresh rule authorization'):
                self.result(f)

    def test_revoked_actor_and_reviewer_current_bytes_refuse(self):
        for index in (0, 1):
            f = Fixture()
            path = f.replay.original['base'] + '/credentials.json'
            value = parse(f.replay.paths[path].data)
            value['credentials'][index]['revokedAt'] = at(110)
            f.replay.paths[path].data = encoded(value).encode()
            with self.subTest(index=index), self.assertRaisesRegex(RuntimeError, 'wrong designated test credentials'):
                self.result(f)

    def test_stale_coherent_capture_and_authorization_policy_revision_refuse(self):
        f = Fixture()
        for kind, index in [('controlled-capture-v1', 1), ('controlled-authorization-v1', 0)]:
            f.change(kind, index, lambda v: authority(v, 'currentPolicyRevision', 'f'*64))
        with self.assertRaisesRegex(RuntimeError, 'stale connected current sidecar revision'):
            self.result(f)

    def test_changed_lease_or_revocation_epoch_even_when_authentication_agrees_refuses(self):
        for field in ('leaseEpoch', 'revocationEpoch', 'authorityRevision'):
            f = Fixture()
            for kind, index in [('controlled-capture-v1', 1), ('controlled-authorization-v1', 0)]:
                f.change(kind, index, lambda v: authority(v, field, 'e'*64))
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'authority epoch differs'):
                self.result(f)

    def test_fresh_rule_requires_distinct_turn_invocation_action_and_original_interval(self):
        for change in (lambda v: v['action']['invocation'].update(turnId='controlled-human-turn'),
                       lambda v: v['action']['invocation'].update(invocationId='controlled-human-invocation'),
                       lambda v: v['action'].update(actionId=uid(2)),
                       lambda v: v.update(bytes=encoded(parse(v['bytes'])[:-1] + [5]))):
            f = Fixture()
            f.change('controlled-capture-v1', 2, change)
            with self.assertRaises(RuntimeError):
                self.result(f)

    def test_duplicate_dispatch_extra_effect_and_missing_read_refuse(self):
        for count in (1, 3):
            f = Fixture()
            f.replay.resources[0].effect_entries = [135, 185, 186][:count]
            with self.subTest(count=count), self.assertRaisesRegex(RuntimeError, 'actual connected effects'):
                self.result(f)

    def test_extra_authorization_or_observation_refuses(self):
        for kind in ('controlled-authorization-v1', 'controlled-producer-observation-v1'):
            f = Fixture()
            ref, _ = f.values(kind)[0]
            f.payloads[uid(99)] = deepcopy(f.payloads[ref])
            f.objects[uid(99)] = deepcopy(f.objects[ref])
            with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError, 'record inventory'):
                self.result(f)

    def test_wrong_phase_and_authorization_effect_order_refuse(self):
        for kind, index, entry, durable in [('controlled-capture-v1', 1, 70, 75),
                                          ('controlled-authorization-v1', 0, 125, 136),
                                          ('controlled-producer-observation-v1', 0, 134, 140)]:
            f = Fixture()
            ref, _ = f.values(kind)[index]
            f.objects[ref].creation_entry, f.objects[ref].durable_publication_completion = entry, durable
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                self.result(f)

    def test_public_private_projection_and_publication_before_append_refuse(self):
        f = Fixture()
        f.payloads[uid(43)]['payload']['answer'] = 'deny'
        with self.assertRaisesRegex(RuntimeError, 'journal projection differs'):
            self.result(f)
        f = Fixture()
        f.objects[uid(43)].durable_publication_completion = 102
        with self.assertRaisesRegex(RuntimeError, 'publication does not precede append'):
            self.result(f)

    def test_ciphertext_filename_aad_or_key_tamper_refuses(self):
        f = Fixture()
        r = f.encrypt()
        path = next(p for p in r.paths if p.endswith('.payload.json'))
        payload = parse(r.paths[path].data)
        payload['tag'] = base64.b64encode(bytes(16)).decode()
        r.paths[path].data = encoded(payload).encode()
        with self.assertRaises(InvalidTag):
            authenticate_connected_delivery(r)

    def test_missing_physical_durable_or_clock_observation_refuses(self):
        for field, value in [('physical', None), ('published', False), ('durable_publication_completion', True)]:
            f = Fixture()
            ref, _ = f.values('controlled-final-delivery-ack-v1')[0]
            setattr(f.objects[ref], field, value)
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'physical durable publication'):
                self.result(f)

    def test_current_saved_rule_revocation_revision_and_marker_locator_refuse(self):
        for change in (lambda v: v['scopedRules']['records'][0]['rule'].update(status='revoked'),
                       lambda v: v['scopedRules']['records'][0]['rule'].update(ruleRevision='f'*64),
                       lambda v: v['scopedRules']['records'][0].update(approvalRecordRef=encoded(['controlled', uid(999)]))):
            f = Fixture()
            value = parse(f.saved.data)
            change(value)
            rule = value['scopedRules']['records'][0]['rule']
            if rule['status'] == 'revoked':
                rule['ruleRevision'] = digest({k: v for k, v in rule.items() if k != 'ruleRevision'})
                f.change('controlled-authorization-v1', 1,
                         lambda v: v['verdict']['authorizedBy'].update(ruleRevision=rule['ruleRevision']))
            f.saved.data = encoded(value).encode()
            # Keep captures/authentication coherent with the actual changed policy
            # revision, so the targeted rule/locator predicate must reject it.
            import hashlib
            revision = hashlib.sha256(f.saved.data).hexdigest()
            for kind, indexes in [('controlled-capture-v1', (1, 2)), ('controlled-authorization-v1', (0, 1))]:
                for index in indexes:
                    f.change(kind, index, lambda v: authority(v, 'currentPolicyRevision', revision))
            with self.assertRaisesRegex(RuntimeError, 'saved rule revoked/invalid revision|original Save marker/scope'):
                self.result(f)

    def test_authenticated_opaque_save_entry_does_not_grant_save_authority(self):
        f = Fixture()
        f.payloads[uid(42)]['payload']['entry'] = {'unvalidated': 'not a valid protected approval'}
        result = self.result(f)
        self.assertEqual(result['saveAuthority'], 'unvalidated-persistence-approval-and-review')
        self.assertEqual(result['authority'], 'none')

    def test_reauthenticated_wrapper_schema_coverage_and_scalar_aliases_refuse(self):
        mutations = [lambda f: f.payloads[uid(50)].update(extra='unapproved'),
                     lambda f: f.payloads[uid(50)]['payload'].update(sessionId='another-session'),
                     lambda f: f.payloads[uid(50)]['payload']['update'].update(kind='producer-passed'),
                     lambda f: f.change('controlled-capture-v1', 1, lambda v: v['action'].update(version=True)),
                     lambda f: f.change('controlled-capture-v1', 1,
                                        lambda v: v['action']['coverage']['evidence'].update(installedRefs=['another-image']))]
        for change in mutations:
            f = Fixture()
            change(f)
            with self.assertRaises(RuntimeError):
                self.result(f)

    def test_original_resource_stamp_and_projected_root_cannot_be_rebound(self):
        f = Fixture()
        f.change('controlled-capture-v1', 1, lambda v: v['action']['effectiveCwd'].update(value='/another-root'))
        with self.assertRaisesRegex(RuntimeError, 'owned resource projection'):
            self.result(f)
        f = Fixture()
        def restamp(value):
            parameters = parse(value['bytes'])
            parameters[2] = parameters[2].rsplit(':', 1)[0] + ':999'
            value['bytes'] = encoded(parameters)
            value['action']['resources']['value'][0]['physicalTargetRef'] = parameters[2]
            value['action']['relevantStateRefs']['value'] = [parameters[2]]
        f.change('controlled-capture-v1', 1, restamp)
        with self.assertRaisesRegex(RuntimeError, 'physical stamp differs'):
            self.result(f)

    def test_missing_effect_clock_is_not_replaced_by_diagnostic_observation(self):
        f = Fixture()
        f.replay.entry_times.pop(135)
        with self.assertRaisesRegex(RuntimeError, 'effect lacks original raw-line clock'):
            self.result(f)


if __name__ == '__main__':
    unittest.main()
