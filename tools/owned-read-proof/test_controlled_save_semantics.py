"""Synthetic physical histories and reauthenticated Save negatives; no live acceptance."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import stat
import json
import subprocess
import unittest

from controlled_replay import Object
from controlled_save_semantics import SCOPE, authenticate_connected_save, pretty
from controlled_semantics import digest, encoded, parse
from test_controlled_delivery_semantics import Fixture, authority, uid
from test_controlled_connected import replay
from test_controlled_timestamps import START, NS


def when(index):
    return (datetime.fromtimestamp(START // NS, timezone.utc) + timedelta(seconds=1, milliseconds=index)
            ).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class SaveFixture(Fixture):
    def __init__(self):
        super().__init__()
        r = self.replay
        r.umask = 0o022
        for obj in list(self.objects.values()) + r.objects:
            for field in ('creation_entry', 'durable_publication_completion', 'writer_close_completion',
                          'publication_entry', 'publication_completion'):
                value = getattr(obj, field, None)
                if type(value) is int:
                    setattr(obj, field, value * 10)
        r.entry_times = {i: START + NS + i * NS // 1000 for i in range(2211)}
        r.marks = [(*row[:4], row[4] * 10, row[5] * 10) for row in r.marks]
        r.journal_entries = [v * 10 for v in r.journal_entries]
        r.journal_closes = [v * 10 for v in r.journal_closes]
        resource = r.resources[0]
        resource.creation_entry *= 10
        resource.creation_record = (*resource.creation_record[:4], resource.creation_record[4]*10, resource.creation_record[5]*10)
        resource.effect_entries = [v * 10 for v in resource.effect_entries]
        base = r.original['base']
        w, leases = base + '/workspace', base + '/workspace/.orca/leases'
        for path, inode in [(base, 600), (leases, 601)]:
            r.paths[path] = Object('original-directory' if path == base else 'state-directory',
                                  stat.S_IFDIR | 0o700, {path}, physical=(0, 1, inode))
        self.path = w + '/orca.permissions.json'
        initial = pretty({'version': 2, 'agents': {}, 'scopedRules': {'version': 1, 'records': []}})
        saved = parse(self.saved.data)
        original_rule = saved['scopedRules']['records'][0]['rule']
        rule = {k: original_rule[k] for k in ('ruleId', 'ruleRevision', 'status', 'notBefore', 'expiresAt', 'match', 'decision')}
        saved['scopedRules']['records'][0]['rule'] = rule
        rule['notBefore'] = when(450)
        rule['ruleRevision'] = digest({k: v for k, v in rule.items() if k != 'ruleRevision'})
        current = pretty(saved)
        revisions = [hashlib.sha256(data).hexdigest() for data in (initial, current)]
        self.change('controlled-baseline-v1', 0, lambda v: (v.update(initialRevision=revisions[0]),
            v['originalAction']['authority'].update(currentPolicyRevision=revisions[0])))
        for i in range(3):
            self.change('controlled-capture-v1', i,
                        lambda v: authority(v, 'currentPolicyRevision', revisions[0 if i == 0 else 1]))
        for i in range(2):
            self.change('controlled-authorization-v1', i, lambda v: authority(v, 'currentPolicyRevision', revisions[1]))
        self.change('controlled-authorization-v1', 1,
                    lambda v: v['verdict']['authorizedBy'].update(ruleRevision=rule['ruleRevision']))
        actions = [v['action'] for _, v in self.values('controlled-capture-v1')]
        baseline = self.values('controlled-baseline-v1')[0][1]
        self.baseline, self.actions, self.rule = baseline, actions, rule
        for i in range(2):
            self.change('controlled-persistence-review-v1', i,
                        lambda v: v.update(action=actions[i], revision=revisions[i]))
        self.initial = self.writer('sidecar-temp', self.path + '.10.tmp', self.path, initial,
            (64, 64, 65, 66, 66, 70, 72, 70, 72), 500, set())
        self.saved = self.writer('sidecar-temp', self.path + '.10.tmp', self.path, current,
            (520, 520, 525, 530, 530, 540, 550, 540, 550), 501, {self.path})
        r.paths[self.path] = self.saved
        r.objects = [self.initial, self.saved]
        self.lock_objects = []
        for i, times in enumerate([(60, 61, 62, 63, 73, 74), (512, 513, 514, 515, 560, 570)]):
            dc, tc, tw, te, tr, dr = times
            lock = self.path + '.lock'
            directory = Object('lock-directory', stat.S_IFDIR | 0o755, set(), physical=(0, 1, 700+i),
                creation_path=lock, creation_entry=dc, creation_completion=dc, removal_entry=dr, removal_completion=dr)
            token = Object('lock-token', stat.S_IFREG | 0o644, set(),
                data=encoded({'version': 1, 'pid': 10, 'nonce': uid(90+i)}).encode(), physical=(0, 1, 710+i),
                writes=1, writer_closed=True, creation_path=lock + '/owner.10.' + uid(80+i) + '.json',
                creation_entry=tc, creation_completion=tc, last_write_completion=tw,
                writer_close_entry=te, writer_close_completion=te, removal_entry=tr, removal_completion=tr)
            r.objects.extend([directory, token])
            self.lock_objects.append((directory, token))
        credentials_path = base + '/credentials.json'
        credentials = parse(r.paths[credentials_path].data)
        first = {'version': 1, 'credentials': [credentials['credentials'][0]]}
        self.credential_objects = [
            self.writer('credentials-temp', credentials_path+'.10.00000001.tmp', credentials_path, pretty(first),
                        (85, 85, 86, 87, 87, 88, 88, 88, 88), 720, set()),
            self.writer('credentials-temp', credentials_path+'.10.00000002.tmp', credentials_path, pretty(credentials),
                        (91, 91, 92, 93, 93, 94, 94, 94, 94), 721, {credentials_path})]
        r.paths[credentials_path] = self.credential_objects[1]
        lease_path = base + '/workspace/.orca/leases/run%3Acontrolled.json'
        lease_data = r.paths[lease_path].data
        self.lease_object = self.writer('lease-temp', lease_path+'.10.abc.tmp', lease_path, lease_data,
                        (80, 80, 81, 82, 82, 83, 83, 84, 84), 722, {lease_path}, method='link', mode=0o644)
        r.paths[lease_path] = self.lease_object
        r.objects.extend(self.credential_objects + [self.lease_object])
        operator = credentials['credentials'][0]
        actor = baseline['operator']['actor']
        facts = {**actor, 'permissions': sorted(operator['permissions']), 'scope': operator['scope'],
                 'expiresAt': operator.get('expiresAt'), 'createdAt': operator['createdAt']}
        a = actions[0]
        self.approval = {'version': 1, 'choice': 'save', 'requiredReview': 'unavailable',
            'persistenceReview': {'result': 'passed', 'sourceRefs': [uid(30)]}, 'acceptedAt': when(455),
            'credential': facts, 'lease': baseline['lease'], 'binding': baseline['binding'], 'actor': actor,
            'target': {k: a['invocation'][k] for k in ('instanceId', 'sessionId', 'turnId', 'invocationId', 'runId', 'stepRunId')},
            'command': {'rule': rule, 'expectedRevision': revisions[0], 'approvalRecordRef': encoded(['controlled', uid(11)])},
            'action': a, 'resourceWorkspaceRef': a['workspaceRef']['value'], 'scopeEvidenceRef': uid(12),
            'authorityRevision': a['authority']['authorityRevision'], 'scope': deepcopy(SCOPE),
            'projection': {'coverage': a['coverage'], 'currentAuthority': {'state': 'unknown', 'reason': 'no-execution-decision'},
                           'expiresAt': {'state': 'complete', 'value': a['expiresAt']},
                           'revocation': {'state': 'complete', 'value': 'active'}}, 'references': [], 'reviewSourceRefs': []}
        self.approval['target']['requestId'] = r.journal_records[0]['payload']['requestId']
        self.payloads[uid(42)]['payload']['entry'] = self.approval

    def writer(self, family, temporary, final, data, times, inode, names, method='rename', mode=0o600):
        a, b, c, d, e, f, g, h, i = times
        return Object(family, stat.S_IFREG | mode, names, data, (0, 1, inode), writes=1, writer_closed=True,
            published=True, creation_entry=a, creation_completion=b, creation_path=temporary,
            last_write_completion=c, writer_close_entry=d, writer_close_completion=e,
            publication_entry=f, publication_completion=g, publication_method=method,
            publication_parent=self.replay.paths[final.rsplit('/', 1)[0]], publication_path=final,
            publication_temporary_path=temporary, temporary_cleanup_entry=h, temporary_cleanup_completion=i)


class SaveAuthorityControls(unittest.TestCase):
    def result(self, fixture):
        return authenticate_connected_save(fixture.encrypt())

    def test_synthetic_source_shaped_save_is_not_execution_or_release_authority(self):
        result = self.result(SaveFixture())
        self.assertEqual(result['authority'], 'none')
        self.assertEqual(result['executionReview'], 'unavailable')
        self.assertEqual(result['persistenceReview'], 'distinct-source-designated-reviewer')
        self.assertEqual(result['sidecarPublications'], 2)
        self.assertEqual(result['saveResourceReads'], result['saveAnswers'], 0)

    def test_source_order_approval_completion_precedes_second_sidecar_lock(self):
        f = SaveFixture()
        approval = f.objects[uid(42)]
        lock = f.lock_objects[1][0]
        self.assertLess(approval.durable_publication_completion, f.replay.journal_entries[2])
        self.assertLess(f.replay.journal_entries[2], f.replay.journal_closes[2])
        self.assertLess(f.replay.journal_closes[2], lock.creation_entry)
        self.assertLess(lock.creation_entry, f.saved.creation_entry)
        self.assertEqual(self.result(f)['authority'], 'none')

    def test_reversed_or_incomplete_public_approval_order_cannot_start_sidecar_lock(self):
        for indices in [(451, 452, 453, 454), (507, 508, 509, 511)]:
            f = SaveFixture()
            directory, token = f.lock_objects[1]
            dc, tc, tw, te = indices
            directory.creation_entry = directory.creation_completion = dc
            token.creation_entry = token.creation_completion = tc
            token.last_write_completion = tw
            token.writer_close_entry = token.writer_close_completion = te
            # Keep the full strict cycle and journal-close-before-policy-write
            # relationships valid; only bridge approval/lock ordering is wrong.
            self.assertLess(te, f.saved.creation_entry)
            self.assertLess(f.replay.journal_closes[2], f.saved.creation_entry)
            with self.subTest(indices=indices), self.assertRaisesRegex(RuntimeError, 'Save attestation/approval/journal/policy/refresh'):
                self.result(f)

    def test_preceding_correlation_only_fixture_is_not_valid_save_authority(self):
        with self.assertRaises(RuntimeError):
            self.result(Fixture())

    def test_reauthenticated_wrong_save_attestation_action_scope_revision_or_reviewer_refuses(self):
        changes = [lambda v: v['plannedInterval'].update(length=5),
                   lambda v: v.update(revision='f'*64), lambda v: v['binding'].update(rootBindingRef='f'*64),
                   lambda v: v['reviewer']['actor'].update(principalId='controlled-test-operator'),
                   lambda v: v['reviewer']['credential'].update(permissions=['inputs.answer']),
                   lambda v: v['action']['resources']['value'][0].update(physicalTargetRef='another-resource'),
                   lambda v: v['executionReview'].update(result='passed', sourceRefs=[uid(99)])]
        for i in (0, 1):
            for change in changes:
                f = SaveFixture()
                f.change('controlled-persistence-review-v1', i, change)
                with self.subTest(index=i), self.assertRaisesRegex(RuntimeError, 'persistence attestation'):
                    self.result(f)

    def test_reauthenticated_save_cannot_promote_persistence_into_execution_judgment(self):
        for change in (lambda p: p.update(requiredReview='passed'),
                       lambda p: p.update(reviewSourceRefs=[uid(30)]),
                       lambda p: p['projection'].update(verdict={'outcome': 'allow'}),
                       lambda p: p['persistenceReview'].update(result='failed'),
                       lambda p: p['persistenceReview'].update(sourceRefs=[uid(31)])):
            f = SaveFixture()
            change(f.approval)
            with self.assertRaisesRegex(RuntimeError, 'Save approval'):
                self.result(f)


    def test_reauthenticated_wrong_explicit_choice_scope_projection_revision_or_target_refuses(self):
        changes = [lambda p: p.update(choice='allow-once'), lambda p: p['scope'].update(resources='Any file'),
                   lambda p: p['projection']['currentAuthority'].update(state='complete', value=True),
                   lambda p: p['command'].update(expectedRevision='e'*64),
                   lambda p: p['target'].update(invocationId='controlled-rule-invocation'),
                   lambda p: p.update(scopeEvidenceRef=uid(99)),
                   lambda p: p['credential'].update(permissions=['permissions.grant']),
                   lambda p: p['lease'].update(holder=uid(99)), lambda p: p.update(authorityRevision='a'*64)]
        for change in changes:
            f = SaveFixture()
            change(f.approval)
            with self.assertRaisesRegex(RuntimeError, 'Save approval'):
                self.result(f)

    def test_revoked_actor_reviewer_or_replaced_guarded_lease_refuses(self):
        for index in (0, 1):
            f = SaveFixture()
            file = parse(f.credential_objects[1].data)
            file['credentials'][index]['revokedAt'] = when(440)
            f.credential_objects[1].data = pretty(file)
            with self.subTest(index=index), self.assertRaisesRegex(RuntimeError, 'designated test credentials'):
                self.result(f)
        f = SaveFixture()
        lease = parse(f.lease_object.data)
        lease['guardedId'] = uid(99)
        f.lease_object.data = pretty(lease)
        with self.assertRaises(RuntimeError):
            self.result(f)

    def test_sidecar_mutation_must_be_in_save_and_after_authenticated_approval(self):
        for field, value in [('creation_entry', 495), ('publication_entry', 1505),
                             ('last_write_completion', 540), ('writer_close_completion', 545)]:
            f = SaveFixture()
            setattr(f.saved, field, value)
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.result(f)

    def test_strict_lock_cannot_publish_before_token_close_or_remove_before_publication(self):
        for role, field, value in [('token', 'writer_close_completion', 525), ('token', 'removal_entry', 545),
                                   ('directory', 'removal_entry', 555), ('directory', 'creation_entry', 455)]:
            f = SaveFixture()
            directory, token = f.lock_objects[1]
            setattr(token if role == 'token' else directory, field, value)
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.result(f)

    def test_strict_token_schema_role_and_missing_raw_removal_refuse(self):
        for value in ({'version': True, 'pid': 10, 'nonce': uid(99)},
                      {'version': 1, 'pid': 11, 'nonce': uid(99)}, {'pid': 10, 'at': when(450), 'host': 'other'}):
            f = SaveFixture()
            f.lock_objects[1][1].data = encoded(value).encode()
            with self.assertRaises(RuntimeError):
                self.result(f)
        f = SaveFixture()
        f.lock_objects[1][1].data = b'\n' + f.lock_objects[1][1].data
        with self.assertRaisesRegex(RuntimeError, 'token schema/bytes'):
            self.result(f)
        f = SaveFixture()
        f.lock_objects[1][1].removal_completion = None
        with self.assertRaisesRegex(RuntimeError, 'raw causal observations'):
            self.result(f)

    def test_extra_or_rolled_back_credential_lease_sidecar_history_refuses(self):
        for family in ('credentials-temp', 'lease-temp', 'sidecar-temp'):
            f = SaveFixture()
            f.replay.objects.append(deepcopy(next(o for o in f.replay.objects if o.family == family)))
            with self.subTest(family=family), self.assertRaises(RuntimeError):
                self.result(f)

    def test_physical_alias_mode_owner_and_current_snapshot_substitution_refuse(self):
        for change in (lambda f: setattr(f.credential_objects[0], 'physical', f.saved.physical),
                       lambda f: setattr(f.saved, 'mode', stat.S_IFREG | 0o666),
                       lambda f: setattr(f.saved, 'uid', f.saved.uid + 1),
                       lambda f: setattr(f.lock_objects[1][0], 'physical', None),
                       lambda f: setattr(f.saved, 'writes', True),
                       lambda f: setattr(f.saved, 'writer_closed', 1)):
            f = SaveFixture()
            change(f)
            with self.assertRaises(RuntimeError):
                self.result(f)


    def test_authenticated_opaque_approval_entry_is_still_refused_with_complete_mutable_history(self):
        f = SaveFixture()
        f.payloads[uid(42)]['payload']['entry'] = {'choice': 'save', 'requiredReview': 'unavailable'}
        with self.assertRaisesRegex(RuntimeError, 'controlled Save approval'):
            self.result(f)

    def test_coherent_stale_attestation_and_approval_revision_cannot_replace_original_policy(self):
        f = SaveFixture()
        stale = f.actions[1]['authority']['currentPolicyRevision']
        f.change('controlled-persistence-review-v1', 0, lambda v: v.update(revision=stale))
        f.approval['command']['expectedRevision'] = stale
        with self.assertRaisesRegex(RuntimeError, 'persistence attestation'):
            self.result(f)

    def test_coherent_operator_attestation_cannot_replace_distinct_designated_reviewer(self):
        f = SaveFixture()
        public = deepcopy(f.baseline['operator'])
        for i in (0, 1):
            f.change('controlled-persistence-review-v1', i, lambda v: v.update(reviewer=public))
        with self.assertRaisesRegex(RuntimeError, 'persistence attestation'):
            self.result(f)

    def update_current_revision(self, f):
        revision = hashlib.sha256(f.saved.data).hexdigest()
        for kind, indexes in [('controlled-capture-v1', (1, 2)), ('controlled-authorization-v1', (0, 1))]:
            for index in indexes:
                f.change(kind, index, lambda v: authority(v, 'currentPolicyRevision', revision))
        f.change('controlled-persistence-review-v1', 1,
                 lambda v: (v.update(revision=revision), authority(v, 'currentPolicyRevision', revision)))

    def test_coherent_widened_saved_rule_approval_and_current_revisions_refuse(self):
        f = SaveFixture()
        rule = f.approval['command']['rule']
        rule['match']['effectiveCwd'] = '/another-root'
        rule['ruleRevision'] = digest({k: v for k, v in rule.items() if k != 'ruleRevision'})
        document = parse(f.saved.data)
        document['scopedRules']['records'][0]['rule'] = deepcopy(rule)
        f.saved.data = pretty(document)
        f.change('controlled-authorization-v1', 1,
                 lambda v: v['verdict']['authorizedBy'].update(ruleRevision=rule['ruleRevision']))
        self.update_current_revision(f)
        with self.assertRaisesRegex(RuntimeError, 'saved rule scope differs'):
            self.result(f)

    def test_coherent_equivalent_parsed_final_snapshot_does_not_replace_exact_source_bytes(self):
        f = SaveFixture()
        f.saved.data = (encoded(parse(f.saved.data)) + '\n').encode()
        self.update_current_revision(f)
        with self.assertRaisesRegex(RuntimeError, 'actual sidecar bytes'):
            self.result(f)

    def test_acceptance_currency_and_closed_scalar_schema_refuse(self):
        for value in (when(300), when(600)):
            f = SaveFixture()
            f.approval['acceptedAt'] = value
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'Save acceptance outside'):
                self.result(f)
        for change in (lambda p: p.update(version=True), lambda p: p.update(version=1.0),
                       lambda p: p.update(permitIssued=True), lambda p: p.update(acceptedAt=True)):
            f = SaveFixture()
            change(f.approval)
            with self.assertRaises(RuntimeError):
                self.result(f)

    def test_wrong_phase_credential_publication_cannot_be_hidden_by_current_authority_snapshot(self):
        f = SaveFixture()
        obj = f.credential_objects[1]
        for field in ('creation_entry', 'creation_completion', 'last_write_completion', 'writer_close_entry',
                      'writer_close_completion', 'publication_entry', 'publication_completion',
                      'temporary_cleanup_entry', 'temporary_cleanup_completion'):
            setattr(obj, field, getattr(obj, field) + 900)
        with self.assertRaisesRegex(RuntimeError, 'mutable publication outside Save phase'):
            self.result(f)

    def test_coherent_extra_credential_metadata_does_not_widen_source_issuance_shape(self):
        f = SaveFixture()
        for obj in f.credential_objects:
            value = parse(obj.data)
            value['credentials'][0]['label'] = 'not-issued-by-this-source'
            obj.data = pretty(value)
        f.change('controlled-baseline-v1', 0,
                 lambda v: v['operator']['credential'].update(label='not-issued-by-this-source'))
        with self.assertRaisesRegex(RuntimeError, 'source-issued credential'):
            self.result(f)

    def test_coherent_reordered_rule_hash_does_not_replace_source_construction_order(self):
        f = SaveFixture()
        rule = f.approval['command']['rule']
        replacement = {'decision': rule['decision'], **{k: v for k, v in rule.items() if k != 'decision'}}
        replacement['ruleRevision'] = digest({k: v for k, v in replacement.items() if k != 'ruleRevision'})
        f.approval['command']['rule'] = replacement
        document = parse(f.saved.data)
        document['scopedRules']['records'][0]['rule'] = deepcopy(replacement)
        f.saved.data = pretty(document)
        f.change('controlled-authorization-v1', 1,
                 lambda v: v['verdict']['authorizedBy'].update(ruleRevision=replacement['ruleRevision']))
        self.update_current_revision(f)
        with self.assertRaisesRegex(RuntimeError, 'source construction-order digest'):
            self.result(f)

    def test_source_finite_pretty_bytes_and_rule_digest_match_node_json_stringify(self):
        f = SaveFixture()
        source = (
            "const fs = require('node:fs'), crypto = require('node:crypto');"
            "const doc = JSON.parse(fs.readFileSync(0, 'utf8'));"
            "const {ruleRevision, ...rule} = doc.scopedRules.records[0].rule;"
            "process.stdout.write(JSON.stringify({pretty: JSON.stringify(doc, null, 2) + '\\n',"
            "revision: crypto.createHash('sha256').update(JSON.stringify(rule)).digest('hex')}));")
        result = subprocess.run(['node', '-e', source], input=f.saved.data, capture_output=True, check=True, timeout=5)
        value = parse(result.stdout)
        self.assertEqual(value['pretty'].encode(), f.saved.data)
        self.assertEqual(value['revision'], f.approval['command']['rule']['ruleRevision'])


class MutableObservationProviderControls(unittest.TestCase):
    def test_creation_and_removal_indices_come_from_actual_base_namespace_events(self):
        r = replay()
        parent = '/base/workspace'
        r.paths[parent] = Object('original-directory', stat.S_IFDIR | 0o700, {parent})
        lock = parent + '/orca.permissions.json.lock'
        token = lock + '/owner.10.' + uid(70) + '.json'
        r.event((11, 'mkdir', [json.dumps(lock), '0777'], '0', 1, 2))
        directory = r.paths[lock]
        r.event((11, 'openat', ['AT_FDCWD', json.dumps(token),
                 'O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC', '0666'], '20', 3, 3))
        obj = r.paths[token]
        data = encoded({'version': 1, 'pid': 10, 'nonce': uid(71)})
        r.event((11, 'write', ['20', json.dumps(data), str(len(data))], str(len(data)), 4, 4))
        r.event((11, 'close', ['20'], '0', 5, 8))
        r.event((11, 'unlink', [json.dumps(token)], '0', 9, 10))
        r.event((11, 'rmdir', [json.dumps(lock)], '0', 11, 12))
        self.assertEqual((directory.creation_path, directory.creation_entry, directory.creation_completion), (lock, 1, 2))
        self.assertEqual((obj.creation_path, obj.creation_entry, obj.creation_completion), (token, 3, 3))
        self.assertEqual(obj.writer_close_completion, 8)
        self.assertEqual((obj.removal_entry, obj.removal_completion), (9, 10))
        self.assertEqual((directory.removal_entry, directory.removal_completion), (11, 12))


if __name__ == '__main__':
    unittest.main()
