"""Composed reauthenticated synthetic controls, never a fresh kernel observation."""
import base64
from copy import deepcopy
import stat
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from controlled_aggregate import compose_connected, effect_inventory
from controlled_replay import Object
from controlled_semantics import encoded, parse
from controlled_save_semantics import pretty
from controlled_supervisor import ObservedRun, assert_observer, observer_original
from controlled_observation import observe_new
from test_controlled_save_semantics import SaveFixture, authority, uid, when


class AggregateFixture(SaveFixture):
    def encrypt(self):
        r = super().encrypt()
        base = r.original['base']
        store = base + '/workspace/.orca'
        directory = store + '/private-execution/'
        r.original['directories'][base] = [1, 600, stat.S_IFDIR | 0o700, 0, 0]
        for original in r.original['immutable'].values():
            original.setdefault('family', 'original-file')
        # Populate the finite final namespace omitted by the correlation-only
        # fixture. These declared identities remain synthetic, not kernel proof.
        for i, path in enumerate([store + '/private-execution', store + '/leases', store + '/runs']):
            if path not in r.paths:
                r.paths[path] = Object('state-directory', stat.S_IFDIR | 0o700, {path}, physical=(0, 1, 900+i))
            r.objects.append(r.paths[path])
        for ref, obj in self.objects.items():
            names = {p for p, value in r.paths.items() if value is obj}
            if not names:
                continue
            obj.family, obj.mode, obj.names = 'protected-temp', stat.S_IFREG | 0o600, names
            obj.writer_closed = obj.synced = True
            obj.temporary_cleanup_completion = obj.durable_publication_completion
            r.objects.append(obj)
        key = Object('protected-temp', stat.S_IFREG | 0o600, {directory + '.execution-key'}, self.key,
                     physical=(0, 1, 990), writer_closed=True, synced=True, directory_synced=True,
                     published=True, creation_entry=75, durable_publication_completion=76,
                     temporary_cleanup_completion=76)
        r.paths[directory + '.execution-key'] = key
        self.inputs = {'runId': 'controlled', 'workflowId': 'controlled-test', 'workflowVersion': '1',
                       'vars': {}, 'sensitiveNames': [], 'secrets': []}
        inputs = Object('protected-temp', stat.S_IFREG | 0o600, {directory + 'controlled.inputs.json'},
                        physical=(0, 1, 991), writer_closed=True, synced=True, directory_synced=True,
                        published=True, creation_entry=77, durable_publication_completion=78,
                        temporary_cleanup_completion=78)
        self.input_obj = inputs
        self.reencrypt_inputs()
        r.paths[directory + 'controlled.inputs.json'] = inputs
        r.objects.extend([key, inputs])
        for name in ('intent', 'enrolled'):
            path = base + '/control/' + name + '.json'
            obj = r.paths[path]
            obj.family, obj.names = 'control-record', {path}
            r.objects.append(obj)
        resource = r.resources[0]
        resource.family, resource.names = 'resource', set()
        r.objects.extend([resource, Object('resource-directory', stat.S_IFDIR | 0o700, set())])
        journal = store + '/runs/controlled.jsonl'
        r.paths[journal] = Object('connected-journal', stat.S_IFREG | 0o644, {journal},
                                 b''.join((encoded(row)+'\n').encode() for row in r.journal_records),
                                 physical=(0, 1, 992))
        for obj in r.objects:
            if not hasattr(obj, 'publication_path'):
                obj.publication_path = None
        return r

    def reencrypt_inputs(self):
        nonce = b'\xff' * 12
        raw = AESGCM(self.key).encrypt(nonce, encoded(self.inputs).encode(),
            b'orca:protected-execution:v1:private-execution:controlled.inputs.json')
        self.input_obj.data = encoded({'version': 1, 'algorithm': 'aes-256-gcm',
            'nonce': base64.b64encode(nonce).decode(), 'ciphertext': base64.b64encode(raw[:-16]).decode(),
            'tag': base64.b64encode(raw[-16:]).decode()}).encode()


class ComposedControls(unittest.TestCase):
    def test_closed_synthetic_composition_remains_ineligible(self):
        result = compose_connected(AggregateFixture().encrypt())
        self.assertEqual(result['authority'], 'none')
        self.assertIsNone(result['acceptingToken'])
        self.assertFalse(result['productionEligible'])
        self.assertEqual(result['effects']['protectedFiles'], 17)

    def test_lost_or_pending_final_ack_refuses_with_durable_original_answer(self):
        for pending in (False, True):
            f = AggregateFixture()
            ref, _ = f.values('controlled-final-delivery-ack-v1')[0]
            if pending:
                f.objects[ref].durable_publication_completion = None
            else:
                f.payloads.pop(ref)
            with self.subTest(pending=pending), self.assertRaises(RuntimeError):
                compose_connected(f.encrypt())

    def test_coherently_stale_capture_and_verdict_refuse(self):
        f = AggregateFixture()
        for kind, index in [('controlled-capture-v1', 1), ('controlled-authorization-v1', 0)]:
            f.change(kind, index, lambda v: authority(v, 'currentPolicyRevision', 'f'*64))
        with self.assertRaisesRegex(RuntimeError, 'stale connected current sidecar revision'):
            compose_connected(f.encrypt())

    def test_revoked_original_operator_or_reviewer_refuses(self):
        for index in (0, 1):
            f = AggregateFixture()
            value = parse(f.credential_objects[1].data)
            value['credentials'][index]['revokedAt'] = when(440)
            f.credential_objects[1].data = pretty(value)
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                compose_connected(f.encrypt())

    def test_wrong_phase_policy_mutation_and_duplicate_dispatch_record_refuse(self):
        f = AggregateFixture()
        f.saved.creation_entry = 1505
        with self.assertRaises(RuntimeError):
            compose_connected(f.encrypt())
        f = AggregateFixture()
        ref, _ = f.values('controlled-authorization-v1')[0]
        f.payloads[uid(999)] = deepcopy(f.payloads[ref])
        f.objects[uid(999)] = deepcopy(f.objects[ref])
        f.objects[uid(999)].physical = (0, 1, 9999)
        with self.assertRaisesRegex(RuntimeError, 'record inventory'):
            compose_connected(f.encrypt())

    def test_extra_effect_unexpected_name_and_residual_lock_refuse(self):
        for mutation in ('effect', 'name', 'lock'):
            r = AggregateFixture().encrypt()
            if mutation == 'effect':
                r.objects.append(Object('credentials-temp', stat.S_IFREG | 0o600, set()))
            elif mutation == 'name':
                r.paths[r.original['base']+'/extra'] = Object('control-record', stat.S_IFREG | 0o600, set())
            else:
                r.objects[2].names = {'/synthetic/workspace/orca.permissions.json.lock'}
            with self.subTest(mutation=mutation), self.assertRaisesRegex(RuntimeError, 'aggregate'):
                effect_inventory(r)

    def test_valid_aead_inputs_and_unfinished_private_publication_refuse(self):
        f = AggregateFixture()
        r = f.encrypt()
        f.inputs['vars'] = {'unexpected': True}
        f.reencrypt_inputs()
        with self.assertRaisesRegex(RuntimeError, 'original execution inputs'):
            compose_connected(r)
        r = AggregateFixture().encrypt()
        next(o for o in r.objects if o.family == 'protected-temp').temporary_cleanup_completion = None
        with self.assertRaisesRegex(RuntimeError, 'incomplete protected publication'):
            compose_connected(r)


class OriginalSupervisorControls(unittest.TestCase):
    def test_refused_bootstrap_cannot_release_connected_commands(self):
        run = SimpleNamespace(report={}, assert_bootstrap_closed=lambda: (_ for _ in ()).throw(
            RuntimeError('missing permanently closed original bootstrap')))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'image').mkdir()
            with patch('controlled_observation.committed_observer', return_value={}), \
                 patch('controlled_observation.observe', return_value=run) as observe, \
                 patch('controlled_observation.safe_summary', return_value={'refusal': 'bounded bootstrap refusal'}), \
                 patch('controlled_observation.ConnectedDesignation') as designation:
                result = observe_new(root)
            self.assertEqual(observe.call_count, 1)
            designation.assert_not_called()
            self.assertIn('closed original bootstrap', result['refusal'])
            self.assertFalse(result['productionEligible'])
            self.assertIsNone(result['acceptingToken'])

    def test_report_success_cannot_replace_closed_original_graph(self):
        for closed in (False, True):
            run = ObservedRun({'success': True}, {'lane': 'bootstrap'}, None, Path('/unused'), closed)
            with self.subTest(closed=closed), self.assertRaisesRegex(RuntimeError, 'closed original bootstrap'):
                run.assert_bootstrap_closed()

    def test_open_original_resource_or_unsettled_process_refuses(self):
        for unsettled in (False, True):
            resource = SimpleNamespace(names={'still-named'}, reads=[b'once'])
            replay = SimpleNamespace(threads={1}, settled=set() if unsettled else {1}, resources=[resource], handles={})
            run = ObservedRun({}, {'lane': 'bootstrap'}, replay, Path('/unused'), True)
            with self.subTest(unsettled=unsettled), self.assertRaises(RuntimeError):
                run.assert_bootstrap_closed()

    def test_during_trace_observer_check_never_spawns_another_child(self):
        original = observer_original()
        with patch('controlled_supervisor.subprocess.run', side_effect=AssertionError('unexpected concurrent child')):
            assert_observer(original)
            changed = deepcopy(original)
            changed['files']['controlled_aggregate.py'] = '0'*64
            with self.assertRaisesRegex(RuntimeError, 'observer implementation changed'):
                assert_observer(changed)


if __name__ == '__main__':
    unittest.main()
