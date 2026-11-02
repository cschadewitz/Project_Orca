"""Actual diagnostic writer under inert effects or isolated synthetic file fixtures."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import pickle
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import controlled_diagnostics as diagnostics
from test_retention_rollback import owner, Thread


class PrivateFailure(BaseException):
    def __str__(self):
        raise AssertionError('private error string conversion')

    def __repr__(self):
        raise AssertionError('private error representation')

    def __bool__(self):
        raise AssertionError('private error truthiness')


class Forbidden:
    def __getattr__(self, name):
        raise AssertionError('unexpected external operation: ' + name)


class WriterOS(Forbidden):
    O_WRONLY, O_CREAT, O_EXCL = os.O_WRONLY, os.O_CREAT, os.O_EXCL
    O_NOFOLLOW, O_CLOEXEC = os.O_NOFOLLOW, os.O_CLOEXEC

    def __init__(self):
        self.events, self.progress, self.output = [], [], bytearray()
        self.errors, self.close_errors = {}, {}
        self.number = 53

    def fail(self, stage):
        if stage in self.errors:
            raise self.errors[stage]

    def open(self, destination, flags, mode):
        assert flags == self.O_WRONLY | self.O_CREAT | self.O_EXCL | self.O_NOFOLLOW | self.O_CLOEXEC
        assert mode == 0o600
        self.events.append(('open', str(destination), flags, mode))
        self.fail('open')
        return self.number

    def fchmod(self, number, mode):
        assert (number, mode) == (self.number, 0o600)
        self.events.append(('fchmod', number, mode))
        self.fail('fchmod')

    def write(self, number, payload):
        assert number == self.number
        self.events.append(('write', number, bytes(payload)))
        self.fail('write')
        result = self.progress.pop(0) if self.progress else len(payload)
        if isinstance(result, BaseException):
            raise result
        if type(result) is int and 0 < result <= len(payload):
            self.output.extend(payload[:result])
        return result

    def fsync(self, number):
        assert number == self.number
        self.events.append(('fsync', number))
        self.fail('fsync')

    def close(self, number):
        self.events.append(('close', number))
        if number in self.close_errors:
            raise self.close_errors[number]


def inert(fake):
    stack = ExitStack()
    stack.enter_context(patch.object(diagnostics, 'os', fake))
    for name in ('threading', 'select', 'time'):
        stack.enter_context(patch.object(diagnostics, name, Forbidden()))
    return stack


class WriterControls(unittest.TestCase):
    def test_one_descriptor_private_mode_complete_write_sync_then_close(self):
        fake = WriterOS()
        with inert(fake):
            self.assertIsNone(diagnostics._write_private_diagnostic('fixture', b'abcdef'))
        self.assertEqual([e[0] for e in fake.events], ['open', 'fchmod', 'write', 'fsync', 'close'])
        self.assertEqual(bytes(fake.output), b'abcdef')

    def test_positive_short_writes_advance_only_unwritten_suffix(self):
        fake = WriterOS(); fake.progress = [1, 2, 1, 2]
        with inert(fake):
            diagnostics._write_private_diagnostic('fixture', b'abcdef')
        self.assertEqual([e[2] for e in fake.events if e[0] == 'write'],
                         [b'abcdef', b'bcdef', b'def', b'ef'])
        self.assertEqual(bytes(fake.output), b'abcdef')
        self.assertEqual(fake.events[-2:], [('fsync', 53), ('close', 53)])

    def test_zero_negative_oversized_noninteger_or_boolean_progress_refuses(self):
        for result in (0, -1, 4, None, True, False, 1.0, '1'):
            fake = WriterOS(); fake.progress = [result]
            with inert(fake), self.assertRaisesRegex(RuntimeError, '^diagnostic writer made invalid progress$'):
                diagnostics._write_private_diagnostic('fixture', b'abc')
            self.assertEqual([e[0] for e in fake.events], ['open', 'fchmod', 'write', 'close'])

    def test_write_failure_after_short_progress_never_replays_bytes(self):
        fake, original = WriterOS(), PrivateFailure(); fake.progress = [2, original]
        with inert(fake), self.assertRaises(PrivateFailure) as caught:
            diagnostics._write_private_diagnostic('fixture', b'abcdef')
        self.assertIs(caught.exception, original)
        self.assertEqual(bytes(fake.output), b'ab')
        self.assertEqual([e[2] for e in fake.events if e[0] == 'write'], [b'abcdef', b'cdef'])
        self.assertEqual(fake.events[-1], ('close', 53))
        self.assertNotIn(('fsync', 53), fake.events)

    def test_each_preclose_failure_preserves_identity_over_close_failure(self):
        for stage in ('open', 'fchmod', 'write', 'fsync'):
            fake, original = WriterOS(), PrivateFailure(); fake.errors[stage] = original
            fake.close_errors[53] = PrivateFailure()
            with inert(fake), self.assertRaises(PrivateFailure) as caught:
                diagnostics._write_private_diagnostic('fixture', b'abc')
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.events.count(('close', 53)), 0 if stage == 'open' else 1)
            if stage in ('open', 'fchmod'):
                self.assertEqual(bytes(fake.output), b'')

    def test_close_failure_alone_refuses_without_retry(self):
        fake, original = WriterOS(), PrivateFailure(); fake.close_errors[53] = original
        with inert(fake), self.assertRaises(PrivateFailure) as caught:
            diagnostics._write_private_diagnostic('fixture', b'abc')
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.events.count(('close', 53)), 1)
        self.assertEqual(bytes(fake.output), b'abc')

    def test_interruption_is_not_retried(self):
        for original in (InterruptedError(), KeyboardInterrupt(), SystemExit(1), GeneratorExit()):
            fake = WriterOS(); fake.errors['write'] = original
            with inert(fake), self.assertRaises(type(original)) as caught:
                diagnostics._write_private_diagnostic('fixture', b'abc')
            self.assertIs(caught.exception, original)
            self.assertEqual(sum(e[0] == 'write' for e in fake.events), 1)
            self.assertEqual(fake.events.count(('close', 53)), 1)

    def test_payload_type_refuses_before_acquisition(self):
        for payload in ('abc', bytearray(b'abc'), memoryview(b'abc'), None):
            fake = WriterOS()
            with inert(fake), self.assertRaisesRegex(RuntimeError, 'encoded bytes'):
                diagnostics._write_private_diagnostic('fixture', payload)
            self.assertEqual(fake.events, [])


class RetentionIntegrationControls(unittest.TestCase):
    def test_actual_retention_uses_original_payload_and_cleans_after_writer(self):
        value, fake = owner(), WriterOS(); pins = dict(value.processes)
        with inert(fake), patch.object(value, 'stop', return_value=None):
            result = value.retain_and_close('fixture')
        self.assertEqual(bytes(fake.output), json.dumps(result, separators=(',', ':')).encode('utf-8'))
        self.assertEqual(result['authority'], 'none')
        self.assertEqual(fake.events[-2:], [('close', 53), ('close', 100)])
        self.assertEqual([pin.closes for pin in pins.values()], [1, 1])
        self.assertEqual(value._retention_state, 'consumed')

    def test_all_writer_failures_preserve_primary_and_drain_only_eligible_ownership(self):
        for stage in ('open', 'fchmod', 'write', 'fsync', 'close'):
            value, fake, original = owner(), WriterOS(), PrivateFailure()
            pins = dict(value.processes); cleanup = PrivateFailure()
            pins['leader'].cleanup = cleanup
            if stage == 'close': fake.close_errors[53] = original
            else: fake.errors[stage] = original
            fake.close_errors[100] = PrivateFailure()
            with inert(fake), patch.object(value, 'stop', return_value=None):
                with self.assertRaises(PrivateFailure) as caught:
                    value.retain_and_close('fixture')
                snapshot = list(fake.events)
                with self.assertRaisesRegex(RuntimeError, 'already attempted'):
                    value.retain_and_close('another fixture')
                self.assertEqual(fake.events, snapshot)
            self.assertIs(caught.exception, original)
            self.assertIs(value._first_failure, original)
            self.assertIs(value._cleanup_error, cleanup)
            self.assertEqual([pin.closes for pin in pins.values()], [1, 1])
            self.assertEqual(value.processes, {})
            self.assertIsNone(value.resource)
            self.assertEqual(fake.events.count(('close', 100)), 1)

    def test_uncertain_sampler_prevents_writer_and_retains_every_owner(self):
        for thread in (Thread(alive=True), Thread(ident=None), Thread(alive=0)):
            value, fake = owner(thread), WriterOS(); pins = dict(value.processes)
            with inert(fake), patch.object(value, 'stop', return_value=None):
                with self.assertRaisesRegex(RuntimeError, 'sampler ownership uncertain'):
                    value.retain_and_close('fixture')
            self.assertEqual(fake.events, [])
            self.assertEqual(value.processes, pins)
            self.assertEqual([pin.closes for pin in pins.values()], [0, 0])
            self.assertEqual(value.resource, 100)

    def test_existing_first_failure_stays_private_and_sticky(self):
        value, fake = owner(), WriterOS(); first, later = PrivateFailure(), PrivateFailure()
        value._first_failure = first; fake.errors['write'] = later
        with inert(fake), patch.object(value, 'stop', return_value=None):
            with self.assertRaises(PrivateFailure) as caught:
                value.retain_and_close('fixture')
        self.assertIs(caught.exception, later)  # Existing per-attempt precedence.
        self.assertIs(value._first_failure, first)

    def test_private_owner_serialization_refuses_without_printing_active_error(self):
        value, original = owner(), PrivateFailure(); value._first_failure = original
        try:
            raise original
        except PrivateFailure:
            for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
                with self.assertRaises(TypeError) as caught:
                    pickle.dumps(value, protocol=protocol)
                self.assertTrue(caught.exception.__suppress_context__)
                self.assertIsNone(caught.exception.__cause__)
                self.assertIs(caught.exception.__context__, original)
        self.assertIs(value._first_failure, original)


class IsolatedFileControls(unittest.TestCase):
    def setUp(self):
        effects = ExitStack()
        self.addCleanup(effects.close)
        for name in ('threading', 'select', 'time'):
            effects.enter_context(patch.object(diagnostics, name, Forbidden()))

    def test_existing_regular_symlink_fifo_and_directory_refuse_without_changes(self):
        with tempfile.TemporaryDirectory(prefix='orca-diagnostic-writer-test-') as directory:
            root = Path(directory)
            target = root / 'target'; target.write_bytes(b'existing private bytes')
            regular = root / 'regular'; regular.write_bytes(b'prior evidence')
            link = root / 'link'; link.symlink_to(target)
            dangling = root / 'dangling'; dangling.symlink_to(root / 'absent')
            fifo = root / 'fifo'; os.mkfifo(fifo, 0o600)
            subdir = root / 'directory'; subdir.mkdir()
            for path in (regular, link, dangling, fifo, subdir):
                before = path.lstat()
                with self.assertRaises(FileExistsError):
                    diagnostics._write_private_diagnostic(path, b'replacement forbidden')
                after = path.lstat()
                self.assertEqual((after.st_ino, after.st_mode, after.st_size),
                                 (before.st_ino, before.st_mode, before.st_size))
            self.assertEqual(target.read_bytes(), b'existing private bytes')
            self.assertEqual(regular.read_bytes(), b'prior evidence')
            self.assertFalse((root / 'absent').exists())

    def test_new_isolated_file_has_exact_bytes_and_private_mode(self):
        with tempfile.TemporaryDirectory(prefix='orca-diagnostic-writer-test-') as directory:
            path = Path(directory) / 'diagnostics.json'
            self.assertIsNone(diagnostics._write_private_diagnostic(path, b'{"authority":"none"}'))
            self.assertEqual(path.read_bytes(), b'{"authority":"none"}')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_mode_and_bytes_stay_on_exact_writer_after_synthetic_name_replacement(self):
        with tempfile.TemporaryDirectory(prefix='orca-diagnostic-writer-test-') as directory:
            path = Path(directory) / 'artifact'; moved = Path(directory) / 'original'
            def opened(destination, flags, mode):
                number = os.open(destination, flags, mode)
                path.rename(moved)
                path.write_bytes(b'decoy must stay unchanged'); path.chmod(0o640)
                return number
            adapter = SimpleNamespace(open=opened, fchmod=os.fchmod, write=os.write,
                                      fsync=os.fsync, close=os.close,
                                      **{n: getattr(os, n) for n in ('O_WRONLY', 'O_CREAT', 'O_EXCL', 'O_NOFOLLOW', 'O_CLOEXEC')})
            with patch.object(diagnostics, 'os', adapter):
                diagnostics._write_private_diagnostic(path, b'original descriptor bytes')
            self.assertEqual(moved.read_bytes(), b'original descriptor bytes')
            self.assertEqual(stat.S_IMODE(moved.stat().st_mode), 0o600)
            self.assertEqual(path.read_bytes(), b'decoy must stay unchanged')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            # This deliberately demonstrates the limit: no path-custody claim.


if __name__ == '__main__':
    unittest.main()
