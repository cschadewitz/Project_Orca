"""Synthetic adversarial connected grammar controls; no observed connected acceptance."""
import copy
import fcntl
from collections import Counter
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from controlled_connected import ConnectedDesignation, ConnectedKernelReplay, HUMAN, SOURCE, snapshot
from controlled_contract import wire
from controlled_replay import Handle, Object, Replay, identity, sha
from controlled_supervisor import (ObservedRun, LIMIT, ORIGINAL_METADATA_LIMIT, REPORT_LIMIT,
    RUNTIME_ASSET_LIMIT, MAX_RUNTIME_ASSETS, bootstrap_asset_pins, digest,
    encoded as supervisor_encoded, evidence_seal, file_digest, file_fingerprint, metadata_bytes,
    originals_packet_limit, packet_matches, prepare_connected)

U = '00000000-0000-4000-8000-000000000001'
START, FINISH = 1793016000000000000, 1793016050000000000


def raw(seq):
    payload = [
        {'stepRunId': 'controlled-step', 'requestId': 'hi_' + '0' * 26, 'kind': 'permission',
         'question': 'Allow this bounded disposable test read?',
         'options': [{'id': 'once', 'label': 'once'}, {'id': 'deny', 'label': 'deny'}],
         'context': {}, 'liveDecision': HUMAN},
        {'stepRunId': 'controlled-step', 'on': 'human-input', 'detail': 'hi_' + '0' * 26},
        {'stepRunId': 'controlled-step', 'sessionId': HUMAN['sessionId'], 'title': 'create a scoped rule',
         'decision': 'scoped-rule-save-accepted', 'scopedApprovalRef': U},
        {'stepRunId': 'controlled-step', 'requestId': 'hi_' + '0' * 26, 'answer': 'once',
         'actor': {'principalId': 'controlled-test-operator', 'credentialId': 'operator1234'}},
    ][seq]
    return {'type': ['human.requested', 'step.waiting', 'agent.permission', 'human.answered'][seq],
            'runId': 'controlled', 'payload': copy.deepcopy(payload),
            'executionPayloadRef': U[:-1] + str(seq + 2), 'id': 'evt_' + '0' * 25 + str(seq),
            'seq': seq, 'at': '2026-10-26T12:00:01.000Z'}


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode() + b'\n'


def replay():
    """Bypass full constructor only in unit controls; never creates a designation."""
    r = object.__new__(ConnectedKernelReplay)
    r.base, r.leader, r.umask = '/base', 10, 0o022
    r.original = {'base': r.base, 'lane': 'connected', 'startedWallNs': START, 'finishedWallNs': FINISH,
                  'queries': {}, 'directories': {}, 'absentProbes': [], 'usedTokens': [],
                  'phases': [{'name': name, 'token': str(i + 1) * 64}
                             for i, name in enumerate(['save', 'human-read', 'rule-read'])]}
    r.paths, r.handles, r.inodes, r.initial = {}, {}, {}, {}
    r.objects, r.resources, r.marks = [], [], []
    r.command, r.ack, r.lifetime = 8, 9, 7
    r.threads, r.settled, r.execs = {10, 11}, set(), 1
    r.counts, r.used_paths, r.total_written = Counter(), set(), 0
    r.journal_records, r.journal_closes, r.journal_tokens = [], [], set()
    r.journal_entries = []
    r.open_intervals, r.descriptor_intervals, r.pending_intervals = [], [], []
    r.entry_times = {}
    return r


def mark(r, count):
    r.marks = [(10, 'read', [], '0', i * 100, i * 100) for i in range(count)]


class DesignationControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='orca-connected-designation-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.bootstrap = root / 'bootstrap'
        self.bootstrap.mkdir()
        (self.bootstrap / 'lifetime.lock').touch(mode=0o600)
        self.proof = root / 'evidence.json'
        self.proof.write_bytes(b'original supervisor retained evidence, not authority')
        self.image = root / 'image'
        self.image.mkdir()
        (self.image / 'controlled-child.mjs').write_bytes(b'child')
        (self.image / 'controlled-producer.mjs').write_bytes(b'producer')
        self.build = {'entry': 'controlled-child.mjs', 'profileRef': 'orca-owned-file-read-v1',
                      'childSha256': sha(b'child'), 'producerSha256': sha(b'producer')}
        (self.image / 'controlled-build.json').write_text(json.dumps(self.build))
        self.assertions = []
        # Synthetic image fixtures cannot establish source correspondence. Production
        # designation always calls the real reviewed-source checker.
        source = patch('controlled_supervisor.assert_image_sources', return_value=self.build)
        source.start()
        self.addCleanup(source.stop)

    def designation(self, closed=None):
        return ConnectedDesignation(bootstrap_base=self.bootstrap, evidence_path=self.proof,
            evidence_ref='trusted-supervisor:synthetic-bootstrap', image=self.image,
            assert_bootstrap_closed=closed or (lambda: self.assertions.append('checked')))

    def original(self, d):
        base = Path(self.temp.name) / 'connected'
        base.mkdir(exist_ok=True)
        (base / 'lifetime.lock').touch(mode=0o600)
        inventory = {p: {'identity': list(s[:5]), 'stamp': list(map(str, s)), 'sha256': sha(data)}
                     for p, (s, data) in d.files.items()}
        plan = {'inventory': inventory, 'bootstrap': d.association(inventory)}
        p = base / 'controlled-plan.json'
        p.write_bytes(encoded(plan))
        immutable = {}
        for name, (stamp, data) in {**d.files, str(self.proof): d.proof, str(p): snapshot(p),
                                   str(base / 'lifetime.lock'): snapshot(base / 'lifetime.lock')}.items():
            immutable[name] = {'identity': list(stamp[:5]), 'hex': data.hex(), 'sha256': sha(data),
                               'family': 'image' if name in d.files else 'lifetime' if name.endswith('lifetime.lock') else 'original-file'}
        return {'base': str(base), 'lane': 'connected', 'sourceHead': SOURCE,
                'controlledBuild': self.build, 'immutable': immutable}

    def test_designation_retains_exact_physical_bytes_and_rechecks_original_closure(self):
        d = self.designation()
        d.bind(self.original(d))
        self.assertGreaterEqual(len(self.assertions), 3)

    def test_report_or_child_boolean_cannot_create_designation(self):
        for value in (None, {}, {'accepted': True}, True):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'explicit connected designation'):
                ConnectedKernelReplay({}, value)

    def test_original_bootstrap_closure_refusal_propagates(self):
        def unavailable():
            raise RuntimeError('original bootstrap still live')
        with self.assertRaisesRegex(RuntimeError, 'still live'):
            self.designation(unavailable)

    def test_closure_boolean_and_source_checker_refusal_cannot_designate(self):
        with self.assertRaisesRegex(RuntimeError, 'success flag'):
            self.designation(lambda: True)
        with patch('controlled_supervisor.assert_image_sources', side_effect=RuntimeError('wrong reviewed source')):
            with self.assertRaisesRegex(RuntimeError, 'wrong reviewed source'):
                self.designation()

    def test_changed_evidence_or_same_bytes_new_inode_refuses(self):
        for replacement in (b'changed', self.proof.read_bytes()):
            d = self.designation()
            other = self.proof.with_suffix('.replacement')
            other.write_bytes(replacement)
            other.replace(self.proof)
            with self.assertRaisesRegex(RuntimeError, 'changed designated bootstrap evidence'):
                d.check()

    def test_changed_image_inventory_and_same_bytes_replacement_refuse(self):
        d = self.designation()
        extra = self.image / 'extra'
        extra.touch()
        with self.assertRaisesRegex(RuntimeError, 'inventory'):
            d.check()
        extra.unlink()
        path = self.image / 'controlled-child.mjs'
        replacement = self.image / 'new'
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)
        with self.assertRaisesRegex(RuntimeError, 'changed designated image'):
            d.check()

    def test_wrong_source_profile_proof_bytes_or_inventory_refuse(self):
        d = self.designation()
        o = self.original(d)
        changes = [lambda x: x.update(sourceHead='0' * 40),
                   lambda x: x['controlledBuild'].update(profileRef='other'),
                   lambda x: x['immutable'][str(self.proof)].update(hex='00'),
                   lambda x: x['immutable'].pop(str(self.image / 'controlled-child.mjs'))]
        for change in changes:
            value = copy.deepcopy(o)
            change(value)
            with self.assertRaises(RuntimeError):
                d.bind(value)

    def test_bootstrap_base_ancestor_and_lifetime_alias_refuse(self):
        d = self.designation()
        o = self.original(d)
        for base in (str(self.bootstrap), str(self.bootstrap / 'child'), str(self.bootstrap.parent)):
            with self.subTest(base=base), self.assertRaisesRegex(RuntimeError, 'reuses bootstrap'):
                d.bind({**o, 'base': base})
        entry = next(v for v in o['immutable'].values() if v['family'] == 'lifetime')
        entry['identity'] = d.bootstrap_lifetime
        with self.assertRaisesRegex(RuntimeError, 'lifetime aliases'):
            d.bind(o)

    def test_child_plan_digest_cannot_rebind_another_image_or_proof(self):
        d = self.designation()
        o = self.original(d)
        path = o['base'] + '/controlled-plan.json'
        plan = json.loads(bytes.fromhex(o['immutable'][path]['hex']))
        for field in ('proofSha256', 'installedInventoryDigest', 'evidenceRef', 'proofPath'):
            changed = copy.deepcopy(plan)
            changed['bootstrap'][field] = 'forged'
            o['immutable'][path]['hex'] = encoded(changed).hex()
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'evidence association'):
                d.bind(o)

    def test_prepare_connected_only_prepares_same_image_and_fresh_roots(self):
        d = self.designation()
        base = Path(self.temp.name) / 'fresh'
        base.mkdir()
        lifetime = os.open(base / 'lifetime.lock', os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
        command, send = os.pipe()
        receive, ack = os.pipe()
        for number in (lifetime, command, send, receive, ack):
            self.addCleanup(os.close, number)
        phases = replay().original['phases']
        with patch('controlled_supervisor.assert_image_sources') as source, patch('controlled_supervisor.os.write') as write:
            plan = prepare_connected(base, self.image, lifetime, command, ack, phases, d)
        source.assert_called_once_with(self.image)
        write.assert_not_called()
        self.assertEqual(plan['lane'], 'connected')
        self.assertEqual(plan['bootstrap'], d.association(plan['inventory']))
        self.assertIn(str(self.proof), plan['originalFiles'])
        with self.assertRaisesRegex(RuntimeError, 'not fresh'):
            prepare_connected(base, self.image, lifetime, command, ack, phases, d)

    def receipt_run(self):
        """Synthetic closed graph only; original authentication is independently mocked."""
        root = Path(self.temp.name)
        trace = self.bootstrap / 'trace'
        trace.write_bytes(b'synthetic trace; no original process launched')
        files = {str(p): snapshot(p) for p in self.image.iterdir()}
        node = root / 'synthetic-node'
        node.write_bytes(b'synthetic runtime asset, never executed')
        for name, data in [('workspace/.orca/workspace-identity/id', b'0' * 36 + b'\n'),
                           ('control/never-typed', b'0' * 64 + b'\n' + b'0' * 64 + b'\n'),
                           ('controlled-plan.json', b'{}')]:
            path = self.bootstrap / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        other = {str(node): (snapshot(node), 'runtime')}
        for name, family in [('workspace/.orca/workspace-identity/id', 'original-file'),
                             ('controlled-plan.json', 'original-file'), ('control/never-typed', 'enrollment-witness'),
                             ('lifetime.lock', 'lifetime')]:
            other[str(self.bootstrap / name)] = (snapshot(self.bootstrap / name), family)
        original = {'lane': 'bootstrap', 'base': str(self.bootstrap), 'node': str(node), 'sourceHead': SOURCE,
                    'controlledBuild': self.build, 'observerImplementation': {'synthetic': True},
                    'immutable': {p: {'family': 'image', 'identity': list(s[:5]),
                                     'hex': data.hex(), 'sha256': sha(data)} for p, (s, data) in files.items()}}
        original['immutable'].update({p: {'family': family, 'identity': list(s[:5]),
                                         'hex': data.hex(), 'sha256': sha(data)}
                                      for p, ((s, data), family) in other.items()})
        report = {'root': str(root), 'sourceHead': SOURCE, 'traceSha256': sha(trace.read_bytes()),
                  'traceBytes': trace.stat().st_size,
                  'kernel': {'traceSha256': sha(trace.read_bytes()), 'traceBytes': trace.stat().st_size},
                  'imageProducerSha256': sha(b'producer'), 'imageChildSha256': sha(b'child'),
                  'imageBuildSha256': sha((self.image / 'controlled-build.json').read_bytes()),
                  'producerStderr': 's' * 4000}
        resource = SimpleNamespace(names=set(), reads=[b'once'])
        replay = SimpleNamespace(original=original, threads={1}, settled={1}, resources=[resource], handles={})
        run = ObservedRun(report, original, replay, root / 'bootstrap-attempt.json', True)
        run.report_path.write_text(supervisor_encoded(report))
        (root / 'bootstrap-originals.json').write_text(supervisor_encoded(original))
        for target in ('controlled_supervisor.authenticate_bootstrap', 'controlled_supervisor.assert_observer'):
            mocked = patch(target)
            mocked.start()
            self.addCleanup(mocked.stop)
        runtime = patch('controlled_supervisor.runtime_paths', return_value={str(node)})
        runtime.start()
        self.addCleanup(runtime.stop)
        return run

    def test_compact_receipt_binds_complete_originals_without_changing_them(self):
        run = self.receipt_run()
        paths = [run.report_path, run.report_path.parent / 'bootstrap-originals.json', self.bootstrap / 'trace']
        before = {p: snapshot(p) for p in paths}
        d = run.designate_bootstrap(self.image)
        value = json.loads(d.proof[1])
        self.assertEqual(value['evidenceRef'], d.evidence_ref)
        self.assertEqual(value['sourceHead'], SOURCE)
        self.assertEqual(value['bootstrapBase'], str(self.bootstrap))
        for field, path in zip(('report', 'originals', 'trace'), paths):
            self.assertEqual(value[field], {'path': str(path), 'sha256': sha(before[path][1])})
        self.assertEqual(value['image'], {p: sha(data) for p, (_, data) in d.files.items()})
        self.assertEqual(value['observerImplementationSha256'], digest(supervisor_encoded(run.original['observerImplementation']).encode()))
        self.assertEqual(Path(d.evidence_path).stat().st_mode & 0o777, 0o400)
        self.assertLessEqual(len(d.proof[1]), 4096)
        self.assertLess(len(d.proof[1]), len(before[run.report_path][1]))
        self.assertEqual({p: snapshot(p) for p in paths}, before)
        d.check()
        # Publishing a receipt a second time refuses exclusive creation.
        with self.assertRaises(FileExistsError):
            run.designate_bootstrap(self.image)

    def test_receipt_closure_rehashes_original_packets_on_every_check(self):
        run = self.receipt_run()
        d = run.designate_bootstrap(self.image)
        from controlled_supervisor import file_digest
        with patch('controlled_supervisor.file_digest', wraps=file_digest) as hashed, \
             patch.object(run, 'assert_bootstrap_closed', wraps=run.assert_bootstrap_closed) as closed:
            d.check()
            d.check()
        self.assertEqual(closed.call_count, 2)
        self.assertEqual(hashed.call_count, 6)

    def test_first_receipt_snapshot_still_has_original_synced_writer_open(self):
        run = self.receipt_run()
        synced, captured = [], []
        sync = os.fsync

        def synced_writer(number):
            sync(number)
            synced.append(number)

        def retained(path):
            value = snapshot(path)
            if Path(path).name == 'bootstrap-association.json' and not captured:
                self.assertEqual(len(synced), 1)
                info = os.fstat(synced[0])
                self.assertEqual(value[0], (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                    info.st_gid, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
                captured.append(value)
            return value

        with patch('controlled_supervisor.os.fsync', side_effect=synced_writer), \
             patch('controlled_connected.snapshot', side_effect=retained):
            d = run.designate_bootstrap(self.image)
        self.assertEqual(captured, [d.proof])
        d.check()

    def test_pre_first_receipt_snapshot_corruption_or_same_bytes_replacement_refuses(self):
        run = self.receipt_run()
        for replacement in (False, True):
            injected = []

            def retained(path):
                p = Path(path)
                if p.name == 'bootstrap-association.json' and not injected:
                    data = p.read_bytes()
                    if replacement:
                        other = p.with_suffix('.new')
                        other.write_bytes(data)
                        other.chmod(0o400)
                        other.replace(p)
                    else:
                        p.chmod(0o600)
                        p.write_bytes(data.replace(SOURCE.encode(), b'0' * 40))
                        p.chmod(0o400)
                    injected.append(True)
                return snapshot(path)

            with self.subTest(replacement=replacement), \
                 patch('controlled_connected.snapshot', side_effect=retained), \
                 self.assertRaisesRegex(RuntimeError, 'initial bootstrap receipt'):
                run.designate_bootstrap(self.image)
            self.assertEqual(injected, [True])
            (run.report_path.parent / 'bootstrap-association.json').unlink()

    def test_pre_first_receipt_snapshot_mode_or_size_change_refuses(self):
        run = self.receipt_run()
        for change_size in (False, True):
            injected = []

            def retained(path):
                p = Path(path)
                if p.name == 'bootstrap-association.json' and not injected:
                    p.chmod(0o600)
                    if change_size:
                        p.write_bytes(b'x' * 4097)
                        p.chmod(0o400)
                    injected.append(True)
                return snapshot(path)

            with self.subTest(change_size=change_size), \
                 patch('controlled_connected.snapshot', side_effect=retained), \
                 self.assertRaisesRegex(RuntimeError, 'initial bootstrap receipt'):
                run.designate_bootstrap(self.image)
            self.assertEqual(injected, [True])
            (run.report_path.parent / 'bootstrap-association.json').unlink()

    def test_receipt_writer_stamp_brackets_first_named_snapshot(self):
        run = self.receipt_run()
        for replacement in (False, True):
            injected = []

            def retained(path):
                value = snapshot(path)
                p = Path(path)
                if p.name == 'bootstrap-association.json' and not injected:
                    if replacement:
                        other = p.with_suffix('.new')
                        other.write_bytes(value[1])
                        other.chmod(0o400)
                        other.replace(p)
                    else:
                        p.chmod(0o600)
                        p.write_bytes(value[1].replace(SOURCE.encode(), b'0' * 40))
                        p.chmod(0o400)
                    injected.append(True)
                return value

            with self.subTest(replacement=replacement), \
                 patch('controlled_connected.snapshot', side_effect=retained), \
                 self.assertRaisesRegex(RuntimeError, 'initial bootstrap receipt'):
                run.designate_bootstrap(self.image)
            self.assertEqual(injected, [True])
            (run.report_path.parent / 'bootstrap-association.json').unlink()

    def test_receipt_tamper_same_bytes_replacement_symlink_and_hardlink_refuse(self):
        run = self.receipt_run()
        d = run.designate_bootstrap(self.image)
        path = Path(d.evidence_path)
        replacement = path.with_suffix('.replacement')
        replacement.write_bytes(d.proof[1])
        replacement.replace(path)
        with self.assertRaisesRegex(RuntimeError, 'receipt changed'):
            d.check()
        # Fresh designation construction must not turn any mutated receipt into authority.
        path.unlink()
        d = run.designate_bootstrap(self.image)
        path.chmod(0o600)
        path.write_bytes(d.proof[1].replace(SOURCE.encode(), b'0' * 40))
        with self.assertRaisesRegex(RuntimeError, 'receipt changed'):
            d.check()
        path.unlink()
        d = run.designate_bootstrap(self.image)
        alias = path.with_suffix('.alias')
        os.link(path, alias)
        with self.assertRaisesRegex(RuntimeError, 'unaliased'):
            d.check()
        alias.unlink()
        path.unlink()
        path.symlink_to(run.report_path)
        with self.assertRaisesRegex(RuntimeError, 'unaliased'):
            d.check()

    def test_receipt_closure_refuses_changed_raw_report_originals_trace_and_image(self):
        run = self.receipt_run()
        for path in (run.report_path, run.report_path.parent / 'bootstrap-originals.json',
                     self.bootstrap / 'trace', self.image / 'controlled-child.mjs'):
            d = run.designate_bootstrap(self.image)
            data = path.read_bytes()
            path.write_bytes(data + b'changed')
            with self.subTest(path=path.name), self.assertRaisesRegex(RuntimeError, 'original (evidence|image) changed'):
                d.check()
            path.write_bytes(data)
            # The original physical stamp is immutable even after bytes are restored.
            with self.assertRaises(RuntimeError):
                d.check()
            Path(d.evidence_path).unlink()

    def test_receipt_closure_refuses_same_bytes_raw_replacement_and_alias(self):
        run = self.receipt_run()
        for path in (run.report_path, run.report_path.parent / 'bootstrap-originals.json', self.bootstrap / 'trace'):
            d = run.designate_bootstrap(self.image)
            replacement = path.with_suffix('.new')
            replacement.write_bytes(path.read_bytes())
            replacement.replace(path)
            with self.subTest(path=path.name), self.assertRaisesRegex(RuntimeError, 'original evidence changed'):
                d.check()
            Path(d.evidence_path).unlink()
            d = run.designate_bootstrap(self.image)
            os.link(path, replacement)
            with self.assertRaisesRegex(RuntimeError, 'unaliased'):
                d.check()
            replacement.unlink()
            Path(d.evidence_path).unlink()

    def test_receipt_refuses_wrong_run_source_image_report_or_replay_digest(self):
        run = self.receipt_run()
        changes = [lambda: run.original.update(base=str(self.bootstrap / 'other')),
                   lambda: run.original.update(sourceHead='0' * 40),
                   lambda: setattr(run.replay, 'original', copy.deepcopy(run.original)),
                   lambda: run.report.update(imageChildSha256='0' * 64),
                   lambda: run.report['kernel'].update(traceSha256='0' * 64),
                   lambda: run.report.update(traceBytes=0),
                   lambda: run.original['immutable'][str(self.image / 'controlled-child.mjs')].update(hex='00')]
        original, report = copy.deepcopy(run.original), copy.deepcopy(run.report)
        for change in changes:
            run.original, run.report = copy.deepcopy(original), copy.deepcopy(report)
            run.replay.original = run.original
            change()
            run.report_path.write_text(supervisor_encoded(run.report))
            (run.report_path.parent / 'bootstrap-originals.json').write_text(supervisor_encoded(run.original))
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                run.designate_bootstrap(self.image)
            self.assertFalse((run.report_path.parent / 'bootstrap-association.json').exists())

    def test_receipt_cannot_outlive_original_closed_graph_or_import_copied_report(self):
        run = self.receipt_run()
        d = run.designate_bootstrap(self.image)
        run.closed = False
        with self.assertRaisesRegex(RuntimeError, 'closed original bootstrap'):
            d.check()
        copied = ObservedRun(copy.deepcopy(run.report), copy.deepcopy(run.original), None, run.report_path, True)
        with self.assertRaisesRegex(RuntimeError, 'closed original bootstrap'):
            copied.designate_bootstrap(self.image)

    def test_receipt_never_swallows_a_closure_success_flag(self):
        run = self.receipt_run()
        with patch.object(run, 'assert_bootstrap_closed', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'returned a flag'):
                run.designate_bootstrap(self.image)
        d = run.designate_bootstrap(self.image)
        with patch.object(run, 'assert_bootstrap_closed', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'returned a flag'):
                d.check()

    def test_receipt_refuses_later_changes_to_original_in_memory_objects(self):
        run = self.receipt_run()
        d = run.designate_bootstrap(self.image)
        run.report['traceSha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'original run changed'):
            d.check()

    def test_valid_originals_packet_just_over_trace_cap_uses_pinned_asset_bound(self):
        run = self.receipt_run()
        node = Path(run.original['node'])
        # One finite runtime asset whose hex alone is two bytes above the TRACE cap.
        size = LIMIT // 2 + 1
        with node.open('wb') as stream:
            stream.truncate(size)
        entry = run.original['immutable'][str(node)]
        entry.update(hex='00' * size, sha256=file_digest(node, maximum=size))
        path = run.report_path.parent / 'bootstrap-originals.json'
        path.write_text(supervisor_encoded(run.original))
        files = {str(p): snapshot(p) for p in self.image.iterdir()}
        pins = bootstrap_asset_pins(run.original, files)
        maximum = originals_packet_limit(run.original, pins)
        self.assertEqual(maximum, 2 * sum(pin['size'] for pin in pins.values()) + ORIGINAL_METADATA_LIMIT)
        self.assertGreater(path.stat().st_size, LIMIT)
        self.assertLessEqual(path.stat().st_size, maximum)
        d = run.designate_bootstrap(self.image)
        self.assertEqual(json.loads(d.proof[1])['originals']['sha256'], file_digest(path, maximum=maximum))
        # The same artifact is still refused when treated as a trace.
        with self.assertRaisesRegex(RuntimeError, 'bounded unaliased'):
            evidence_seal(path)

    def test_oversized_originals_report_and_trace_refuse_before_payload_read(self):
        run = self.receipt_run()
        files = {str(p): snapshot(p) for p in self.image.iterdir()}
        maximum = originals_packet_limit(run.original, bootstrap_asset_pins(run.original, files))
        for path, bound in ((run.report_path.parent / 'bootstrap-originals.json', maximum),
                            (run.report_path, REPORT_LIMIT), (self.bootstrap / 'trace', LIMIT)):
            data = path.read_bytes()
            with path.open('wb') as stream:
                stream.truncate(bound + 1)
            with self.subTest(path=path.name), \
                 patch('controlled_supervisor.file_digest', wraps=file_digest) as hashed, \
                 patch('controlled_supervisor.packet_matches') as compared, \
                 self.assertRaisesRegex(RuntimeError, 'bounded unaliased'):
                run.designate_bootstrap(self.image)
            self.assertNotIn(str(path), [str(call.args[0]) for call in hashed.call_args_list])
            compared.assert_not_called()
            path.write_bytes(data)

    def test_unknown_originals_or_report_fields_and_excess_metadata_refuse(self):
        run = self.receipt_run()
        files = {str(p): snapshot(p) for p in self.image.iterdir()}
        pins = bootstrap_asset_pins(run.original, files)
        for field in ('unexpected', 'authority'):
            changed = copy.deepcopy(run.original)
            changed[field] = 'x'
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'unknown originals packet fields'):
                originals_packet_limit(changed, pins)
        changed = copy.deepcopy(run.original)
        changed['kernelRuntimeQueries'] = {'mountinfo': 'x' * (256 * 1024),
                                         'queries': {str(i): 'y' * 4096 for i in range(200)}}
        with self.assertRaisesRegex(RuntimeError, 'metadata serialization exceeds bound'):
            originals_packet_limit(changed, pins)
        with self.assertRaisesRegex(RuntimeError, 'metadata string exceeds bound'):
            metadata_bytes({'mountinfo': 'x' * (256 * 1024 + 1)}, ORIGINAL_METADATA_LIMIT)
        run.report['unexpected'] = True
        with self.assertRaisesRegex(RuntimeError, 'unknown report packet fields'):
            run.designate_bootstrap(self.image)
        run.report.pop('unexpected')
        run.report['semantic'] = {'captures': ['x' * 4096] * 300}
        with patch('controlled_supervisor.packet_matches') as compared:
            with self.assertRaisesRegex(RuntimeError, 'metadata serialization exceeds bound'):
                run.designate_bootstrap(self.image)
        compared.assert_not_called()

    def test_asset_count_keys_size_digest_and_identity_cannot_enlarge_allowance(self):
        run = self.receipt_run()
        files = {str(p): snapshot(p) for p in self.image.iterdir()}
        pins = bootstrap_asset_pins(run.original, files)
        node = run.original['node']
        changes = [lambda x: x['immutable'].update({'/extra': copy.deepcopy(x['immutable'][node])}),
                   lambda x: x['immutable'].pop(node),
                   lambda x: x['immutable'][node].update(extra=True),
                   lambda x: x['immutable'][node].update(hex=x['immutable'][node]['hex'] + '00'),
                   lambda x: x['immutable'][node].update(hex='00' * pins[node]['size']),
                   lambda x: x['immutable'][node].update(sha256='0' * 64),
                   lambda x: x['immutable'][node].update(family='image'),
                   lambda x: x['immutable'][node].update(identity=[True] * 5)]
        for change in changes:
            changed = copy.deepcopy(run.original)
            change(changed)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                originals_packet_limit(changed, pins)
        with patch('controlled_supervisor.runtime_paths', return_value={str(i) for i in range(MAX_RUNTIME_ASSETS + 1)}):
            with self.assertRaisesRegex(RuntimeError, 'runtime asset count'):
                bootstrap_asset_pins(run.original, files)
        path = Path(node)
        with path.open('wb') as stream:
            stream.truncate(RUNTIME_ASSET_LIMIT + 1)
        with patch('controlled_supervisor.file_fingerprint', wraps=file_fingerprint) as hashed:
            with self.assertRaisesRegex(RuntimeError, 'asset type/size'):
                bootstrap_asset_pins(run.original, files)
        self.assertNotIn(str(path), [str(call.args[0]) for call in hashed.call_args_list])

    def test_fixed_runtime_sysfs_asset_pins_read_bytes_instead_of_advertised_size(self):
        run = self.receipt_run()
        path = '/sys/devices/system/cpu/online'
        files = {str(p): snapshot(p) for p in self.image.iterdir()}
        with patch('controlled_supervisor.runtime_paths', return_value={run.original['node'], path}):
            pins = bootstrap_asset_pins(run.original, files)
        data = Path(path).read_bytes()
        self.assertEqual(pins[path]['size'], len(data))
        self.assertEqual(pins[path]['sha256'], sha(data))

    def test_streaming_digest_and_comparison_stop_at_artifact_cap(self):
        path = Path(self.temp.name) / 'growing-packet'
        path.write_bytes(b'x' * 33)
        with self.assertRaisesRegex(RuntimeError, 'artifact byte bound'):
            file_digest(path, maximum=32)
        with self.assertRaisesRegex(RuntimeError, 'packet grew beyond artifact bound'):
            packet_matches(path, b'x' * 32, 32)


class ConnectedPhaseControls(unittest.TestCase):
    def test_exact_connected_phase_plan_and_unique_unreplayed_tokens(self):
        r = replay()
        r.validate_lane()
        for change in (lambda o: o['phases'].reverse(), lambda o: o['phases'].pop(),
                       lambda o: o['phases'][1].update(token=o['phases'][0]['token']),
                       lambda o: o['usedTokens'].append(o['phases'][0]['token']),
                       lambda o: o['phases'][0].update(accepted=True)):
            r = replay()
            change(r.original)
            with self.assertRaises(RuntimeError):
                r.validate_lane()

    def test_bootstrap_default_still_refuses_connected_and_two_reads(self):
        r = replay()
        with self.assertRaisesRegex(RuntimeError, 'not implemented'):
            Replay.validate_lane(r)
        obj = Object('resource', stat.S_IFREG | 0o400)
        obj.reads = [b'x', b'x']
        with self.assertRaisesRegex(RuntimeError, 'exactly one'):
            Replay.validate_reads(r, obj)

    def test_exact_six_control_boundaries_and_no_extra_ack(self):
        r = replay()
        r.handles[8] = Handle(Object('command', stat.S_IFIFO | 0o600), {'O_RDONLY'})
        r.handles[9] = Handle(Object('ack', stat.S_IFIFO | 0o600), {'O_WRONLY'})
        resource = Object('resource', stat.S_IFREG | 0o400)
        r.resources = [resource]
        for i, phase in enumerate(r.original['phases']):
            command = wire(phase)
            r.event((10, 'read', ['8', json.dumps(command.decode()), str(len(command))], str(len(command)), i*10, i*10))
            r.journal_records = [raw(n) for n in range(3 if i == 0 else 4)]
            resource.reads = [b'spos'] * i
            ack = wire(phase, True)
            r.event((10, 'write', ['9', json.dumps(ack.decode()), str(len(ack))], str(len(ack)), i*10+5, i*10+5))
        self.assertEqual(len(r.marks), 6)
        with self.assertRaisesRegex(RuntimeError, 'outside phase'):
            r.event((10, 'write', ['9', '"extra"', '5'], '5', 40, 40))

    def test_save_outside_duplicate_or_reordered_reads_refuse(self):
        for count in (0, 1, 2, 4, 6):
            r = replay()
            mark(r, count)
            with self.subTest(count=count), self.assertRaises(RuntimeError):
                r.read_phase((10, 'pread64', [], '4', 1000, 1000))
        r = replay()
        mark(r, 3)
        r.resources = [Object('resource', stat.S_IFREG | 0o400)]
        r.journal_records, r.journal_closes = [raw(n) for n in range(4)], [250]
        r.read_phase((10, 'pread64', [], '4', 300, 300))
        with self.assertRaisesRegex(RuntimeError, 'duplicate/reordered'):
            r.read_phase((10, 'pread64', [], '4', 301, 301))
        mark(r, 5)
        r.read_phase((10, 'pread64', [], '4', 500, 500))
        self.assertEqual(r.resources[0].read_phases, ['human-read', 'rule-read'])

    def test_durable_answer_alone_does_not_count_as_live_delivery_or_final_ack(self):
        r = replay()
        mark(r, 3)
        r.resources = [Object('resource', stat.S_IFREG | 0o400)]
        r.journal_records = [raw(n) for n in range(4)]
        with self.assertRaisesRegex(RuntimeError, 'not closed'):
            r.read_phase((10, 'pread64', [], '4', 300, 300))
        self.assertEqual(r.evidence_record(), 'controlled-connected-kernel-grammar-only')
        # Even with a closed append, this layer grants no live-delivery verdict.
        r.journal_closes = [299]
        r.read_phase((10, 'pread64', [], '4', 300, 300))
        self.assertFalse(hasattr(r, 'acceptedAnswerRef'))


class JournalControls(unittest.TestCase):
    def parser(self, seq):
        r = replay()
        r.journal_records = [raw(n) for n in range(seq)]
        return r

    def test_four_exact_public_projections_are_grammar_only(self):
        r = replay()
        for i in range(4):
            r.journal_records.append(r.journal_record(encoded(raw(i))))
        with self.assertRaisesRegex(RuntimeError, 'sequence/type/run'):
            r.journal_record(encoded(raw(3)))

    def test_answer_credential_uses_source_base64url_identity_not_uuid(self):
        r = self.parser(3)
        self.assertEqual(r.journal_record(encoded(raw(3)))['payload']['actor']['credentialId'], 'operator1234')
        value = raw(3)
        value['payload']['actor']['credentialId'] = U
        with self.assertRaisesRegex(RuntimeError, 'operator projection'):
            r.journal_record(encoded(value))

    def test_gaps_type_aliases_reorder_extra_fields_and_references_refuse(self):
        for i in range(4):
            changes = [lambda v: v.update(seq=True), lambda v: v.update(seq=float(i)),
                       lambda v: v.update(seq=i+1), lambda v: v.update(runId='other'),
                       lambda v: v.update(type='human.answered' if i != 3 else 'human.requested'),
                       lambda v: v.update(qualified=True), lambda v: v.update(executionPayloadRef='../alias'),
                       lambda v: v['payload'].update(permit=True), lambda v: v.update(at='2026-10-27T12:00:00.000Z')]
            for change in changes:
                r, value = self.parser(i), raw(i)
                change(value)
                with self.subTest(seq=i, value=value), self.assertRaises(RuntimeError):
                    r.journal_record(encoded(value))

    def test_original_request_target_options_save_and_actor_correlations_refuse(self):
        for seq, field, value in [(0, 'liveDecision', {**HUMAN, 'turnId': 'fresh-rule-turn'}),
                                  (0, 'options', [{'id': 'always', 'label': 'always'}]),
                                  (1, 'detail', 'another-request'), (2, 'decision', 'allow'),
                                  (3, 'requestId', 'another-request'), (3, 'answer', 'always'),
                                  (3, 'actor', {'principalId': 'reviewer', 'credentialId': U})]:
            r, changed = self.parser(seq), raw(seq)
            changed['payload'][field] = value
            with self.subTest(seq=seq, field=field), self.assertRaises(RuntimeError):
                r.journal_record(encoded(changed))

    def test_duplicate_keys_nonfinite_torn_multi_and_reused_ids_refuse(self):
        r = replay()
        line = encoded(raw(0))
        for data in (line[:-1], line + line, line.replace(b'"seq":0', b'"seq":0,"seq":0'),
                     line.replace(b'"seq":0', b'"seq":NaN'), line.replace(b'"seq":0', b'"seq":1e999')):
            with self.subTest(data=data), self.assertRaises((RuntimeError, ValueError)):
                r.journal_record(data)
        r = self.parser(1)
        for field in ('id', 'executionPayloadRef'):
            changed = raw(1)
            changed[field] = raw(0)[field]
            with self.assertRaises(RuntimeError):
                r.journal_record(encoded(changed))

    def writer(self, seq=0):
        r = self.parser(seq)
        mark(r, 1 if seq < 3 else 3)
        parent = r.journal_path.rsplit('/', 1)[0]
        r.paths[parent] = Object('state-directory', stat.S_IFDIR | 0o755, {parent})
        lock = r.journal_path + '.lock'
        r.paths[lock] = Object('lock-directory', stat.S_IFDIR | 0o755, {lock})
        token = lock + '/owner.10.' + U + '.json'
        r.paths[token] = Object('lock-token', stat.S_IFREG | 0o644, {token},
            json.dumps({'pid': 10, 'at': START // 1000000 + 1000, 'host': os.uname().nodename}).encode(),
            writes=1, writer_closed=True, writer_close_entry=8, writer_close_completion=9)
        return r, token

    def opening(self, r, flags='O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC', entered=10):
        r.event((11, 'openat', ['AT_FDCWD', json.dumps(r.journal_path), flags, '0666'], '20', entered, entered))

    def write(self, r, value, entered=11):
        data = encoded(value)
        r.event((11, 'write', ['20', json.dumps(data.decode()), str(len(data))], str(len(data)), entered, entered))

    def test_append_exclusive_lock_bytes_sequence_close_and_descriptor_reuse(self):
        r, token = self.writer()
        self.opening(r)
        self.write(r, raw(0))
        with self.assertRaisesRegex(RuntimeError, 'duplicate/cross-phase'):
            self.write(r, raw(1))
        r.event((11, 'close', ['20'], '0', 12, 12))
        self.assertEqual(r.journal_closes, [12])
        self.assertEqual(r.paths[r.journal_path].data, encoded(raw(0)))
        with self.assertRaisesRegex(RuntimeError, 'reused a prior lock'):
            self.opening(r, entered=13)
        # The next append uses a distinct exclusively-created token acquisition.
        r.paths[token] = copy.copy(r.paths[token])
        self.opening(r, entered=13)
        self.write(r, raw(1), entered=14)
        r.event((11, 'close', ['20'], '0', 15, 15))
        self.assertEqual(r.paths[r.journal_path].data, encoded(raw(0)) + encoded(raw(1)))

    def test_missing_multiple_changed_or_unsettled_lock_tokens_refuse(self):
        for change in (lambda r, p: r.paths.pop(p), lambda r, p: setattr(r.paths[p], 'writer_closed', False),
                       lambda r, p: setattr(r.paths[p], 'writes', 2),
                       lambda r, p: setattr(r.paths[p], 'data', b'{"pid":11,"at":0,"host":"wrong"}'),
                       lambda r, p: r.paths.update({p + '.other': r.paths[p]})):
            r, token = self.writer()
            change(r, token)
            with self.assertRaises(RuntimeError):
                self.opening(r)
        r, token = self.writer()
        self.opening(r)
        r.paths[token] = copy.copy(r.paths[token])
        with self.assertRaisesRegex(RuntimeError, 'token changed'):
            self.write(r, raw(0))

    def test_append_flags_truncation_empty_close_and_cross_phase_refuse(self):
        for flags in ('O_WRONLY|O_CREAT|O_TRUNC|O_APPEND|O_CLOEXEC', 'O_RDWR|O_CREAT|O_APPEND|O_CLOEXEC',
                      'O_WRONLY|O_APPEND|O_CLOEXEC'):
            r, _ = self.writer()
            with self.subTest(flags=flags), self.assertRaises(RuntimeError):
                self.opening(r, flags)
        r, _ = self.writer()
        self.opening(r)
        with self.assertRaisesRegex(RuntimeError, 'without complete record'):
            r.event((11, 'close', ['20'], '0', 12, 12))
        self.write(r, raw(0))
        mark(r, 3)
        with self.assertRaisesRegex(RuntimeError, 'crosses phase'):
            r.event((11, 'close', ['20'], '0', 12, 12))

    def test_rule_new_answer_wrong_journal_paths_and_alias_publication_refuse(self):
        r, _ = self.writer(3)
        mark(r, 5)
        with self.assertRaisesRegex(RuntimeError, 'wrong phase'):
            self.opening(r)
        for path in ('/base/workspace/.orca/runs/other.jsonl', '/base/workspace/.orca/runs/controlled.jsonl.tmp',
                     '/base/workspace/.orca/runs/controlled.jsonl.lock/owner.11.' + U + '.json'):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                r.family(path)
        r, _ = self.writer()
        self.opening(r)
        for op in ('rename', 'link', 'unlink'):
            args = [json.dumps(r.journal_path), json.dumps(r.journal_path + '.alias')]
            if op == 'unlink':
                args.pop()
            with self.subTest(op=op), self.assertRaises(RuntimeError):
                r.event((11, op, args, '0', 12, 12))

    def test_pending_lock_or_open_at_phase_ack_refuses(self):
        r, _ = self.writer()
        with self.assertRaisesRegex(RuntimeError, 'survives phase'):
            r.event((10, 'write', ['9', '"ack"', '3'], '3', 12, 12))

    def test_shared_descriptor_close_overlap_still_refuses(self):
        r, _ = self.writer()
        self.opening(r)
        r.check_intervals((11, 'close', ['20'], '0', 12, 20))
        with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
            r.check_intervals((10, 'write', ['20', '"x"', '1'], '1', 13, 13))

    def test_readonly_journal_reopen_and_close_use_base_byte_lineage(self):
        r, _ = self.writer()
        self.opening(r)
        self.write(r, raw(0))
        r.event((11, 'close', ['20'], '0', 12, 12))
        r.event((11, 'openat', ['AT_FDCWD', json.dumps(r.journal_path), 'O_RDONLY|O_CLOEXEC'], '20', 13, 13))
        data = encoded(raw(0))
        r.event((11, 'read', ['20', json.dumps(data.decode()), str(len(data))], str(len(data)), 14, 14))
        r.event((11, 'close', ['20'], '0', 15, 15))
        self.assertNotIn(20, r.handles)
        self.assertEqual(r.journal_closes, [12])

    def test_no_new_journal_mapping_or_vector_write_permission(self):
        r, _ = self.writer()
        self.opening(r)
        for call, args, result in [('mmap', ['NULL', '4096', 'PROT_READ', 'MAP_PRIVATE', '20', '0'], '0x123'),
                                   ('writev', ['20', '[{iov_base="x", iov_len=1}]', '1'], '1')]:
            with self.subTest(call=call), self.assertRaises(RuntimeError):
                r.event((11, call, args, result, 12, 12))

    def test_journal_open_preserves_named_resource_exclusion_and_interval_history(self):
        r, _ = self.writer()
        r.resources = [Object('resource', stat.S_IFREG | 0o400, {'/base/fixture'})]
        with self.assertRaisesRegex(RuntimeError, 'named-resource lifetime'):
            self.opening(r)
        r.resources[0].names.clear()
        r.event((11, 'openat', ['AT_FDCWD', json.dumps(r.journal_path),
                 'O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC', '0666'], '20', 10, 12))
        self.assertEqual(r.open_intervals, [(10, 12)])

    def test_unfinished_token_close_cannot_qualify_another_threads_journal_open(self):
        r, path = self.writer()
        token = r.paths[path]
        token.writer_closed = False
        token.writer_close_entry = token.writer_close_completion = None
        r.handles[30] = Handle(token, {'O_WRONLY'})
        close = (11, 'close', ['30'], '0', 5, 20)
        r.check_intervals(close)
        r.event(close)
        self.assertTrue(token.writer_closed)
        self.assertEqual(token.writer_close_completion, 20)
        opening = (10, 'openat', ['AT_FDCWD', json.dumps(r.journal_path),
                   'O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC', '0666'], '20', 10, 10)
        # Distinct token/journal entities do not conflict in the base interval
        # table. The connected publication-order predicate must reject this.
        r.check_intervals(opening)
        with self.assertRaisesRegex(RuntimeError, 'token close completion must precede journal operation'):
            r.event(opening)

    def test_settled_token_close_qualifies_later_journal_open_with_exact_raw_order(self):
        r, path = self.writer()
        token = r.paths[path]
        token.writer_closed = False
        token.writer_close_entry = token.writer_close_completion = None
        r.handles[30] = Handle(token, {'O_WRONLY'})
        close = (11, 'close', ['30'], '0', 5, 9)
        r.check_intervals(close)
        r.event(close)
        self.opening(r, entered=10)
        self.assertIs(r.handles[20].journal_token, token)
        self.assertEqual(token.writer_close_completion, 9)

    def test_token_close_missing_type_alias_or_boundary_completion_refuses(self):
        for completion in (None, True, 10, 11):
            r, path = self.writer()
            r.paths[path].writer_close_completion = completion
            with self.subTest(completion=completion), self.assertRaisesRegex(
                    RuntimeError, 'token close completion must precede journal operation'):
                self.opening(r, entered=10)


class ConnectedSidecarPublicationControls(unittest.TestCase):
    def previous(self):
        r = replay()
        mark(r, 1)
        final = r.base + '/workspace/orca.permissions.json'
        temporary = final + '.10.tmp'
        parent = r.base + '/workspace'
        r.paths[parent] = Object('original-directory', stat.S_IFDIR | 0o700, {parent})
        obj = Object('sidecar-temp', stat.S_IFREG | 0o600, {final}, b'initial', physical=(0, 1, 42),
                     writer_closed=True, writer_close_completion=5, publication_entry=6, publication_completion=7,
                     publication_path=final, publication_temporary_path=temporary, publication_method='rename')
        r.paths[final], r.objects = obj, [obj]
        r.used_paths.add(temporary)
        return r, obj, temporary

    def opening(self, r, path):
        r.event((11, 'openat', ['AT_FDCWD', json.dumps(path),
                 'O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC', '0600'], '20', 10, 10))

    def test_second_source_pid_temporary_creates_distinct_exclusive_lineage(self):
        r, previous, path = self.previous()
        self.opening(r, path)
        self.assertIsNot(r.paths[path], previous)
        self.assertIs(r.paths[previous.publication_path], previous)
        self.assertIn('O_EXCL', r.handles[20].flags)

    def test_bootstrap_still_refuses_any_reused_writer_path(self):
        r, _, path = self.previous()
        self.assertFalse(Replay.fresh_writer(r, path, 'sidecar-temp', 10))

    def test_third_publication_wrong_phase_missing_physical_and_unfinished_previous_refuse(self):
        for change in (lambda r, o: r.objects.append(copy.copy(o)),
                       lambda r, o: mark(r, 3), lambda r, o: setattr(o, 'physical', None),
                       lambda r, o: setattr(o, 'writer_close_completion', 8),
                       lambda r, o: setattr(o, 'publication_completion', 11)):
            r, previous, path = self.previous()
            change(r, previous)
            with self.assertRaises(RuntimeError):
                self.opening(r, path)

    def test_sidecar_reuse_does_not_allow_other_private_temporary_reuse(self):
        r, _, _ = self.previous()
        path = r.base + '/credentials.json.10.12345678.tmp'
        r.used_paths.add(path)
        self.assertFalse(r.fresh_writer(path, 'credentials-temp', 10))


if __name__ == '__main__':
    unittest.main()
