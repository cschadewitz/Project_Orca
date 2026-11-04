"""The actual isolated zipapp on independent synthetic LOCAL bytes, never pve2."""
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

import build_controller as builder
import controller_cli as subject


class PrivateFailure(BaseException):
    def __str__(self): raise AssertionError('private string conversion')
    def __repr__(self): raise AssertionError('private representation')
    def __bool__(self): raise AssertionError('private truthiness')


class ControllerBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='orca-cli-bundle-test-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        cls.repo = cls.base / 'repo'; cls.repo.mkdir()
        for relative, _ in builder.INPUTS:
            target = cls.repo / relative; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((builder.REPO / relative).read_bytes())
        for args in (['git', 'init', '-q'], ['git', 'add', '.'],
                     ['git', '-c', 'user.name=ORCA local fixture', '-c', 'user.email=fixture@invalid.example',
                      'commit', '-qm', 'independent synthetic CLI build fixture']):
            subprocess.run(args, cwd=cls.repo, check=True, capture_output=True, timeout=10)
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=cls.repo, text=True).strip()
        cls.artifact = cls.base / 'orca-evidence.pyz'
        with patch.object(builder, 'REPO', cls.repo):
            cls.built = builder.build(cls.artifact, cls.commit)

    def cli(self, *args, artifact=None, flags=('-I', '-S', '-B'), cwd=None, env=None):
        return subprocess.run([sys.executable, *flags, str(artifact or self.artifact), *args],
                              cwd=cwd or self.base, env=env, capture_output=True, text=True, timeout=30)

    @contextmanager
    def parent(self):
        with tempfile.TemporaryDirectory(prefix='orca-cli-owned-local-') as directory:
            yield Path(directory)

    def selftest(self, parent):
        result = self.cli('selftest', '--output-parent', str(parent))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        data = json.loads(result.stdout)
        self.assertEqual(data['profile'], 'synthetic-local-selftest-not-observed-pilot')
        self.assertFalse(data['original_or_observation_authority'])
        return data, parent / data['trial_name']

    def test_reproducible_exact_archive_source_commit_whitelist_and_fixed_metadata(self):
        with self.parent() as parent, patch.object(builder, 'REPO', self.repo):
            again = parent / 'again.pyz'
            other = builder.build(again, self.commit)
            self.assertEqual(again.read_bytes(), self.artifact.read_bytes())
            self.assertEqual(other, self.built)
        with zipfile.ZipFile(self.artifact) as archive:
            self.assertEqual(archive.namelist(), ['__main__.py', 'orca_controller_cli.py',
                                                 'packet_exporter.py', 'packet_receiver.py', 'SOURCE.json'])
            manifest = json.loads(archive.read('SOURCE.json'))
            self.assertEqual(manifest['source_commit'], self.commit)
            self.assertEqual(len(manifest['inputs']), 5)
            for entry in archive.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(entry.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(entry.external_attr >> 16, 0o100644)
            for item in manifest['inputs']:
                committed = subprocess.check_output(['git', 'show', self.commit + ':' + item['path']], cwd=self.repo)
                self.assertEqual(hashlib.sha256(committed).hexdigest(), item['sha256'])
                if item['entry'] is not None: self.assertEqual(archive.read(item['entry']), committed)

    def test_real_packaged_synthetic_custody_export_receiver_roundtrip_and_readonly_verify(self):
        with self.parent() as parent:
            data, root = self.selftest(parent)
            self.assertEqual(data['new_trial_file_data_bytes'], 33554733)
            self.assertEqual(data['index_bytes'], 299)
            self.assertEqual(data['chunks'], 2)
            self.assertEqual(data['index_sha256'], '34d476697a8fd67b567231cf1a48e4fd4eebf7beabe5037e423ca5178777db3c')
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['custody.bin', 'packet'])
            files = list((root / 'packet').iterdir())
            self.assertEqual(sum(p.stat().st_size for p in files) + (root / 'custody.bin').stat().st_size, 33554733)
            for directory in (root, root / 'packet'): self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            for path in [root / 'custody.bin', *files]: self.assertEqual(path.stat().st_mode & 0o777, 0o400)
            before = {p.name: p.read_bytes() for p in files}
            verified = self.cli('verify-selftest', '--packet', str(root / 'packet'))
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertEqual(json.loads(verified.stdout)['payload_bytes'], subject.SELFTEST_SIZE)
            self.assertEqual(before, {p.name: p.read_bytes() for p in files})
            wrong = self.cli('verify-pilot', '--packet', str(root / 'packet'))
            self.assertEqual(wrong.returncode, 1)
            self.assertEqual(wrong.stdout, '')

    def test_actual_known_pilot_constants_and_independent_one_chunk_index_pin(self):
        self.assertEqual(subject.PILOT_SIZE, 16777216)
        self.assertEqual(subject.PILOT_SHA256, '080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e')
        self.assertEqual(len(subject.PILOT.index), 212)
        self.assertEqual(subject.PILOT.index_sha256, 'c3e2aedd222732c37f6784524fcf75cb85914485df412586299a3a7a69547e04')
        self.assertEqual(2 * subject.PILOT.size + len(subject.PILOT.index), 33554644)
        self.assertNotEqual(subject.PILOT.index_sha256, subject.SELFTEST.index_sha256)

    def test_pilot_wrong_size_hash_symlink_or_fifo_refuses_before_new_output(self):
        with self.parent() as parent:
            output = parent / 'output'; output.mkdir(mode=0o700)
            wrong = parent / 'independent-synthetic-not-observed-pilot.bin'
            wrong.write_bytes(b'P' * subject.PILOT_SIZE); wrong.chmod(0o644)
            small = parent / 'small'; small.write_bytes(b'x')
            link = parent / 'link'; link.symlink_to(wrong)
            fifo = parent / 'fifo'; os.mkfifo(fifo, 0o600)
            for path in (wrong, small, link, fifo):
                result = self.cli('pilot', '--source', str(path), '--output-parent', str(output))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertNotIn(str(path), result.stderr)
                self.assertNotIn('Traceback', result.stderr)
                self.assertEqual(list(output.iterdir()), [])
            self.assertEqual(wrong.stat().st_mode & 0o777, 0o644)  # Original mode is never changed.
            self.assertEqual(wrong.read_bytes(), b'P' * subject.PILOT_SIZE)

    def test_real_isolated_bundle_ignores_hostile_cwd_pythonpath_and_site_hooks(self):
        with self.parent() as parent:
            poison = parent / 'poison'; poison.mkdir()
            marker = poison / 'executed'
            for name in ('packet_exporter.py', 'packet_receiver.py', 'orca_controller_cli.py', 'sitecustomize.py', 'usercustomize.py'):
                (poison / name).write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("bad")\nraise RuntimeError("ambient fallback")\n')
            output = parent / 'output'; output.mkdir(mode=0o700)
            env = dict(os.environ, PYTHONPATH=str(poison), PYTHONHOME=str(poison), PYTHONSTARTUP=str(poison / 'sitecustomize.py'))
            result = self.cli('selftest', '--output-parent', str(output), cwd=poison, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists())
            self.assertFalse(list(parent.rglob('__pycache__')))

    def test_runtime_flags_are_real_prerequisites_not_caller_success_flags(self):
        with self.parent() as parent:
            for flags in (('-S', '-B'), ('-I', '-B'), ('-I', '-S')):
                result = self.cli('selftest', '--output-parent', str(parent), flags=flags)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')
                self.assertEqual(list(parent.iterdir()), [])

    def test_private_export_unknown_approval_and_parser_errors_never_echo_inputs_or_create_files(self):
        secret = 'UNREVIEWED_PRIVATE_ARG_DO_NOT_PROJECT'
        with self.parent() as parent:
            cases = (('private-export',), ('private-export', '--approve', secret),
                     (secret,), ('selftest', '--approved-owner', secret),
                     ('pilot', '--source', secret, '--expected-sha256', secret),
                     ('pilot',))
            for args in cases:
                result = self.cli(*args, cwd=parent)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')
                self.assertNotIn(secret, result.stderr)
                self.assertNotIn('Traceback', result.stderr)
                self.assertEqual(list(parent.iterdir()), [])

    def test_corrupt_extra_missing_or_compressed_archive_refuses_without_import_fallback(self):
        with self.parent() as parent:
            with zipfile.ZipFile(self.artifact) as original:
                entries = [(i, original.read(i.filename)) for i in original.infolist()]
            for case in ('corrupt', 'extra', 'missing', 'compressed', 'hashlib', 'json', 'zipfile'):
                path = parent / (case + '.pyz')
                with zipfile.ZipFile(path, 'w') as archive:
                    for info, data in entries:
                        info = zipfile.ZipInfo(info.filename, info.date_time)
                        info.create_system, info.external_attr = 3, 0o100644 << 16
                        if case == 'missing' and info.filename == 'packet_receiver.py': continue
                        if case == 'corrupt' and info.filename == 'orca_controller_cli.py': data += b'\n# changed\n'
                        if case == 'compressed' and info.filename == 'packet_exporter.py': info.compress_type = zipfile.ZIP_DEFLATED
                        archive.writestr(info, data)
                    if case == 'extra': archive.writestr('unreviewed.py', b'raise RuntimeError()')
                    if case in ('hashlib', 'json', 'zipfile'):
                        archive.writestr(case + '.py', b'print("UNREVIEWED_ARCHIVE_MODULE_EXECUTED")\nraise RuntimeError()\n')
                result = self.cli('--help', artifact=path, cwd=parent)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, 'reviewed bundle unavailable; stop without fallback\n')

    def test_builder_dirty_or_uncommitted_inputs_refuse_before_output_and_no_overwrite(self):
        with self.parent() as parent, patch.object(builder, 'REPO', self.repo):
            target = self.repo / 'tools/owned-read-proof/controller_cli.py'
            original = target.read_bytes()
            try:
                target.write_bytes(original + b'\n# uncommitted\n')
                with self.assertRaises(ValueError): builder.build(parent / 'bad.pyz', self.commit)
                self.assertFalse((parent / 'bad.pyz').exists())
            finally: target.write_bytes(original)
            output = parent / 'existing.pyz'; output.write_bytes(b'keep')
            with self.assertRaises(FileExistsError): builder.build(output, self.commit)
            self.assertEqual(output.read_bytes(), b'keep')

    def test_builder_uses_validated_snapshots_despite_later_workspace_mutation(self):
        with self.parent() as parent, patch.object(builder, 'REPO', self.repo):
            target = self.repo / 'tools/owned-read-proof/controller_cli.py'; original = target.read_bytes()
            real_zip = zipfile.ZipFile
            def mutate(*args, **kwargs):
                target.write_bytes(original + b'\n# later mutation\n')
                return real_zip(*args, **kwargs)
            try:
                with patch.object(builder.zipfile, 'ZipFile', side_effect=mutate):
                    result = builder.build(parent / 'snapshot.pyz', self.commit)
                self.assertEqual(result['sha256'], self.built['sha256'])
            finally: target.write_bytes(original)

    def test_builder_disables_replacement_objects_and_lazy_fetch_command_locally(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            self.assertEqual(args[:3], ['git', '--no-replace-objects', '--no-lazy-fetch'])
            self.assertEqual(kwargs['cwd'], builder.REPO)
            return type('Result', (), {'stdout': b'bounded metadata'})()
        with patch.object(builder.subprocess, 'run', side_effect=run):
            self.assertEqual(builder._git('rev-parse', 'HEAD'), b'bounded metadata')
        self.assertEqual(len(calls), 1)


class ControllerNativeFailureTests(unittest.TestCase):
    def public(self, call):
        with self.assertRaises(subject.TrialError) as caught:
            call()
        self.assertIsNone(caught.exception.__context__)
        self.assertIsNone(caught.exception.__cause__)
        self.assertEqual(str(caught.exception), 'nonsecret indexed trial unavailable; stop without retry or cleanup')

    def test_custody_reservation_failure_precedes_writes_and_preserves_first_error(self):
        with tempfile.TemporaryDirectory() as parent:
            owner, original = subject.TrialOwner(), PrivateFailure()
            with patch.object(subject.os, 'posix_fallocate', side_effect=original), \
                    patch.object(subject.os, 'pwrite', side_effect=AssertionError('unreserved write')):
                self.public(lambda: owner.run('selftest', parent))
            self.assertIs(owner._first_failure, original)
            self.assertEqual(owner._state, 'uncertain')
            self.public(lambda: owner.run('selftest', parent))
            self.assertEqual(len(list(Path(parent).iterdir())), 1)
            owner.close()

    def test_copy_error_survives_later_close_error_without_private_formatting(self):
        with tempfile.TemporaryDirectory() as parent:
            owner, original, cleanup, close = subject.TrialOwner(), PrivateFailure(), PrivateFailure(), os.close
            def uncertain(number):
                close(number)
                raise cleanup
            with patch.object(subject.os, 'pwrite', side_effect=original), \
                    patch.object(subject.os, 'close', side_effect=uncertain):
                self.public(lambda: owner.run('selftest', parent))
            self.assertIs(owner._first_failure, original)
            self.assertEqual(owner._first_phase, 'custody')

    def test_exporter_private_error_is_retained_as_original_not_only_wrapper(self):
        with tempfile.TemporaryDirectory() as parent:
            owner, original, allocate, calls = subject.TrialOwner(), PrivateFailure(), os.posix_fallocate, []
            def fail(number, offset, size):
                calls.append(size)
                if len(calls) == 2: raise original  # Custody succeeds; first export allocation fails.
                return allocate(number, offset, size)
            with patch.object(subject.os, 'posix_fallocate', side_effect=fail):
                self.public(lambda: owner.run('selftest', parent))
            self.assertIs(owner._first_failure, original)
            self.assertIs(owner._exporter._first_failure, original)
            self.assertEqual(owner._first_phase, 'prepare')

    def test_uncertain_close_consumes_reused_number_without_retry_or_further_payload_reads(self):
        with tempfile.TemporaryDirectory() as parent:
            owner, close, open_file, reused, calls = subject.TrialOwner(), os.close, os.open, [], []
            original = PrivateFailure()
            def uncertain(number):
                calls.append(number); close(number)
                replacement = open_file(parent, os.O_RDONLY | os.O_DIRECTORY)
                self.assertEqual(replacement, number); reused.append(replacement)
                raise original
            real_read = os.pread
            def read(number, amount, offset):
                self.assertFalse(calls, 'payload read after uncertain close')
                return real_read(number, amount, offset)
            try:
                with patch.object(subject.os, 'close', side_effect=uncertain), patch.object(subject.os, 'pread', side_effect=read):
                    self.public(lambda: owner.run('selftest', parent))
                    owner.close()
                self.assertEqual(len(calls), len(set(calls)))
                self.assertIs(owner._first_failure, original)
                for number in reused: os.fstat(number)
            finally:
                for number in reused: close(number)

    def test_original_pid_thread_and_custom_profile_refuse_before_native_effect(self):
        owner = subject.TrialOwner()
        class Profile:
            def __eq__(self, other): raise AssertionError('custom comparison')
        with tempfile.TemporaryDirectory() as parent, patch.object(subject.os, 'open', side_effect=AssertionError('effect')):
            self.public(lambda: owner.run(Profile(), parent))
        owner = subject.TrialOwner(); results = []
        def other():
            try: owner.close()
            except subject.TrialError: results.append('refused')
        thread = threading.Thread(target=other); thread.start(); thread.join(1)
        self.assertFalse(thread.is_alive()); self.assertEqual(results, ['refused'])
        with patch.object(subject.os, 'getpid', return_value=os.getpid() + 1): self.public(owner.close)
        owner.close()

    def test_result_delivery_failure_is_fixed_uncertain_and_never_retries_operation(self):
        original = PrivateFailure()
        class Output:
            def write(self, value): raise original
            def flush(self): raise original
        owner = subject.TrialOwner()
        with patch.object(subject.sys, 'flags', type('Flags', (), {'isolated': 1, 'no_site': 1})()), \
                patch.object(subject.sys, 'dont_write_bytecode', True), \
                patch.object(subject, 'TrialOwner', return_value=owner), \
                patch.object(owner, 'run', return_value={'scope': 'synthetic-only'}) as run, \
                patch.object(subject.sys, 'stdout', Output()), patch.object(subject.sys, 'stderr', io.StringIO()) as errors:
            self.assertEqual(subject.main(['selftest']), 1)
        self.assertEqual(run.call_count, 1)
        self.assertIs(owner._first_failure, original)
        self.assertEqual(owner._state, 'uncertain')
        self.assertEqual(errors.getvalue(), 'trial result delivery uncertain; preserve files and do not retry\n')

    def test_public_native_failure_codes_never_invoke_custom_error_attributes_or_values(self):
        import errno
        class Custom(OSError):
            @property
            def errno(self): raise AssertionError('custom errno access')
        class Value:
            def __eq__(self, other): raise AssertionError('custom error comparison')
        class Meta(type):
            def __eq__(self, other): raise AssertionError('private metaclass equality')
        class MetaFailure(BaseException, metaclass=Meta):
            pass
        owner = subject.TrialOwner()
        for error in (Custom('PRIVATE_ERROR'), PrivateFailure(), MetaFailure()):
            owner._first_failure, owner._first_phase = error, 'prepare'
            self.assertEqual(owner.failure_projection(), ('prepare', 'verification-or-close-unavailable'))
        native = OSError('PRIVATE_ERROR'); native.errno = Value()
        owner._first_failure = native
        self.assertEqual(owner.failure_projection(), ('prepare', 'verification-or-close-unavailable'))
        owner._first_failure = OSError(errno.EOPNOTSUPP, 'PRIVATE_ERROR')
        self.assertEqual(owner.failure_projection(), ('prepare', 'native-api-unsupported'))

    def test_packet_path_substitution_after_verification_refuses_success(self):
        with tempfile.TemporaryDirectory() as parent:
            owner, actual = subject.TrialOwner(), subject.PacketReceiver.verify
            def substitute(receiver, *args):
                value = actual(receiver, *args)
                root = Path(parent) / owner._trial_name
                (root / 'packet').rename(root / 'retained-packet')
                (root / 'packet').mkdir(mode=0o700)
                return value
            with patch.object(subject.PacketReceiver, 'verify', new=substitute):
                self.public(lambda: owner.run('selftest', parent))
            self.assertEqual(owner._state, 'uncertain')
            self.assertTrue((Path(parent) / owner._trial_name / 'retained-packet/packet-index.v1').exists())

    def test_successful_payload_close_followed_by_path_change_is_checked_before_result(self):
        with tempfile.TemporaryDirectory() as parent:
            owner, close, changed = subject.TrialOwner(), os.close, []
            def mutate(number):
                # The custody reader is retained by this controller until final disposal.
                custody = owner._custody.value
                close(number)
                if custody is None and owner._phase == 'close' and not changed:
                    root = Path(parent) / owner._trial_name
                    (root / 'packet').rename(root / 'retained-packet')
                    (root / 'packet').mkdir(mode=0o700)
                    changed.append(True)
            with patch.object(subject.os, 'close', side_effect=mutate):
                self.public(lambda: owner.run('selftest', parent))
            self.assertTrue(changed)
            self.assertEqual(owner._state, 'uncertain')


if __name__ == '__main__':
    unittest.main()
