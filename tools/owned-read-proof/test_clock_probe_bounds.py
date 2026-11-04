"""Owned-file byte controls and AST wiring checks; never execute a clock probe."""
import ast
import inspect
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import controlled_timestamps as clock


NATIVE_OPEN = os.open
NATIVE_READ = os.read
NATIVE_CLOSE = os.close
NATIVE_FSTAT = os.fstat
CAP = 1_048_576
READ_SIZE = 65_536


class PrivateError(Exception):
    def __str__(self):
        raise AssertionError('private exception must not be formatted')


class OwnedTraceControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='clock-probe-bounds-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'clock-probe.trace'
        # Dependencies remain inert even if a regression accidentally reaches one.
        for target in ('subprocess.run', 'run_traced'):
            guard = patch('controlled_timestamps.' + target,
                          side_effect=AssertionError('process execution forbidden in byte controls'))
            guard.start()
            self.addCleanup(guard.stop)

    def write(self, data):
        self.path.write_bytes(data)
        self.path.chmod(0o600)

    def opened(self, calls):
        def acquire(path, flags, *args, **kwargs):
            number = NATIVE_OPEN(path, flags, *args, **kwargs)
            calls.append((os.fspath(path), flags, number))
            return number
        return acquire

    def assert_closed_once(self, opened, closed):
        self.assertEqual(closed, [entry[2] for entry in reversed(opened)])
        self.assertEqual(len(closed), len(set(closed)))
        for number in closed:
            with self.assertRaises(OSError):
                NATIVE_FSTAT(number)

    def test_exact_bytes_at_empty_chunk_and_cap_boundaries(self):
        self.assertEqual(clock.CLOCK_PROBE_TRACE_LIMIT, CAP)
        for size in (0, 1, READ_SIZE - 1, READ_SIZE, READ_SIZE + 1, CAP - 1, CAP):
            data = (b'\xff \t\r\n\n' * ((size + 5) // 6))[:size]
            self.write(data)
            requested = []
            def read(number, amount):
                requested.append(amount)
                return NATIVE_READ(number, amount)
            with self.subTest(size=size), patch.object(clock.os, 'read', side_effect=read):
                result = clock.read_clock_probe_trace(self.path)
            self.assertEqual(result, data)
            self.assertIs(type(result), bytes)
            self.assertEqual(requested[-1], 1)  # Exactly one non-joined sentinel.
            self.assertEqual(sum(requested), size + 1)
            self.assertTrue(all(0 < amount <= READ_SIZE for amount in requested))

    def test_oversize_refuses_before_read_open_or_allocation(self):
        self.write(b'')
        with self.path.open('r+b') as stream:
            stream.truncate(CAP + 1)
        opened = []
        with patch.object(clock.os, 'open', side_effect=self.opened(opened)), \
                patch.object(clock.os, 'read', side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(RuntimeError, 'fixed source byte bound'):
                clock.read_clock_probe_trace(self.path)
        self.assertEqual(len(opened), 1)
        self.assertTrue(opened[0][1] & os.O_PATH)

    def test_fifo_directory_symlink_and_alias_never_get_read_opened(self):
        for kind in ('fifo', 'directory', 'symlink', 'alias'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.directory.name) as root:
                candidate = Path(root) / 'input'
                target = Path(root) / 'target'
                target.write_bytes(b'owned')
                target.chmod(0o600)
                if kind == 'fifo':
                    os.mkfifo(candidate, 0o600)
                elif kind == 'directory':
                    candidate.mkdir(mode=0o700)
                elif kind == 'symlink':
                    candidate.symlink_to(target)
                else:
                    os.link(target, candidate)
                opened = []
                with patch.object(clock.os, 'open', side_effect=self.opened(opened)), \
                        patch.object(clock.os, 'read', side_effect=AssertionError('must not read')):
                    with self.assertRaisesRegex(RuntimeError, 'unaliased regular file'):
                        clock.read_clock_probe_trace(candidate)
                self.assertEqual(len(opened), 1)
                self.assertTrue(opened[0][1] & os.O_PATH)
                self.assertTrue(opened[0][1] & os.O_NOFOLLOW)

    def test_device_metadata_is_rejected_on_owned_pin_without_device_read_open(self):
        self.write(b'owned')
        opened = []
        def device_info(number):
            original = NATIVE_FSTAT(number)
            fields = {key: getattr(original, key) for key in (
                'st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_nlink', 'st_size',
                'st_mtime_ns', 'st_ctime_ns')}
            fields['st_mode'] = stat.S_IFCHR | 0o600
            return type('InertDeviceMetadata', (), fields)()
        with patch.object(clock.os, 'open', side_effect=self.opened(opened)), \
                patch.object(clock.os, 'fstat', side_effect=device_info), \
                patch.object(clock.os, 'read', side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(RuntimeError, 'unaliased regular file'):
                clock.read_clock_probe_trace(self.path)
        self.assertEqual(len(opened), 1)
        self.assertTrue(opened[0][1] & os.O_PATH)

    def test_nonprivate_mode_refuses_before_read_open(self):
        self.write(b'owned')
        self.path.chmod(0o644)
        opened = []
        with patch.object(clock.os, 'open', side_effect=self.opened(opened)):
            with self.assertRaisesRegex(RuntimeError, 'private unaliased'):
                clock.read_clock_probe_trace(self.path)
        self.assertEqual(len(opened), 1)

    def test_reader_opens_only_trusted_procfd_of_validated_pin(self):
        self.write(b'exact \r\n\xff')
        opened, closed = [], []
        def close(number):
            closed.append(number)
            NATIVE_CLOSE(number)
        with patch.object(clock.os, 'open', side_effect=self.opened(opened)), \
                patch.object(clock.os, 'close', side_effect=close):
            self.assertEqual(clock.read_clock_probe_trace(self.path), b'exact \r\n\xff')
        self.assertEqual(len(opened), 2)
        self.assertEqual(opened[1][0], '/proc/self/fd/' + str(opened[0][2]))
        self.assertEqual(opened[1][1], os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        self.assert_closed_once(opened, closed)

    def test_partial_reads_make_bounded_progress_without_truncation(self):
        data = b'\xff\r\n ' * (READ_SIZE // 4 + 9)
        self.write(data)
        requested = []
        def partial(number, amount):
            requested.append(amount)
            return NATIVE_READ(number, min(amount, 397))
        with patch.object(clock.os, 'read', side_effect=partial):
            self.assertEqual(clock.read_clock_probe_trace(self.path), data)
        self.assertTrue(all(0 < amount <= READ_SIZE for amount in requested))
        self.assertEqual(requested[-1], 1)

    def test_growth_is_refused_by_sentinel_without_returning_prefix(self):
        self.write(b'x' * 123)
        requested = []
        def grow(number, amount):
            requested.append(amount)
            value = NATIVE_READ(number, amount)
            if len(requested) == 1:
                with self.path.open('ab') as stream:
                    stream.write(b'growth')
            return value
        with patch.object(clock.os, 'read', side_effect=grow):
            with self.assertRaisesRegex(RuntimeError, 'grew beyond retained size'):
                clock.read_clock_probe_trace(self.path)
        self.assertEqual(requested, [123, 1])

    def test_early_eof_is_refused_without_returning_prefix(self):
        self.write(b'x' * (READ_SIZE + 20))
        calls = []
        def truncate(number, amount):
            calls.append(amount)
            value = NATIVE_READ(number, amount)
            if len(calls) == 1:
                with self.path.open('wb'):
                    pass
            return value
        with patch.object(clock.os, 'read', side_effect=truncate):
            with self.assertRaisesRegex(RuntimeError, 'ended before retained size'):
                clock.read_clock_probe_trace(self.path)
        self.assertEqual(calls, [READ_SIZE, 20])

    def test_replacement_during_procfd_open_is_refused_before_read(self):
        self.write(b'original')
        replacement = self.path.with_name('replacement')
        replacement.write_bytes(b'replaced')
        replacement.chmod(0o600)
        def replace(path, flags, *args, **kwargs):
            if os.fspath(path).startswith('/proc/self/fd/'):
                os.replace(replacement, self.path)
            return NATIVE_OPEN(path, flags, *args, **kwargs)
        with patch.object(clock.os, 'open', side_effect=replace), \
                patch.object(clock.os, 'read', side_effect=AssertionError('must not read')):
            with self.assertRaises(RuntimeError):
                clock.read_clock_probe_trace(self.path)

    def test_path_replacement_after_read_is_refused(self):
        self.write(b'original')
        replacement = self.path.with_name('replacement')
        replacement.write_bytes(b'original')
        replacement.chmod(0o600)
        def replace(number, amount):
            value = NATIVE_READ(number, amount)
            if amount == 1:
                os.replace(replacement, self.path)
            return value
        with patch.object(clock.os, 'read', side_effect=replace):
            with self.assertRaises(RuntimeError):
                clock.read_clock_probe_trace(self.path)

    def test_same_size_metadata_change_after_read_is_refused(self):
        self.write(b'original')
        before = self.path.stat()
        def change(number, amount):
            value = NATIVE_READ(number, amount)
            if amount == 1:
                os.utime(self.path, ns=(before.st_atime_ns, before.st_mtime_ns + 1))
            return value
        with patch.object(clock.os, 'read', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'changed during read'):
                clock.read_clock_probe_trace(self.path)

    def test_missing_input_preserves_acquisition_error_without_close_or_retry(self):
        failure = PrivateError()
        with patch.object(clock.os, 'open', side_effect=failure) as acquire, \
                patch.object(clock.os, 'close', side_effect=AssertionError('no owned fd')):
            with self.assertRaises(PrivateError) as caught:
                clock.read_clock_probe_trace(self.path)
        self.assertIs(caught.exception, failure)
        self.assertEqual(acquire.call_count, 1)

    def test_read_open_failure_preserves_private_error_and_closes_only_pin_once(self):
        self.write(b'owned')
        opened, closed = [], []
        failure = PrivateError()
        def acquire(path, flags, *args, **kwargs):
            if os.fspath(path).startswith('/proc/self/fd/'):
                raise failure
            return self.opened(opened)(path, flags, *args, **kwargs)
        def close(number):
            closed.append(number)
            NATIVE_CLOSE(number)
        with patch.object(clock.os, 'open', side_effect=acquire), \
                patch.object(clock.os, 'close', side_effect=close):
            with self.assertRaises(PrivateError) as caught:
                clock.read_clock_probe_trace(self.path)
        self.assertIs(caught.exception, failure)
        self.assert_closed_once(opened, closed)

    def test_read_failure_beats_ambiguous_cleanup_failures_without_formatting(self):
        self.write(b'owned')
        opened, closed = [], []
        failure = PrivateError()
        def close(number):
            closed.append(number)
            NATIVE_CLOSE(number)
            raise PrivateError()
        with patch.object(clock.os, 'open', side_effect=self.opened(opened)), \
                patch.object(clock.os, 'read', side_effect=failure), \
                patch.object(clock.os, 'close', side_effect=close):
            with self.assertRaises(PrivateError) as caught:
                clock.read_clock_probe_trace(self.path)
        self.assertIs(caught.exception, failure)
        self.assert_closed_once(opened, closed)

    def test_first_close_failure_refuses_success_and_both_closes_are_consumed(self):
        self.write(b'owned')
        opened, closed = [], []
        failures = [PrivateError(), PrivateError()]
        def close(number):
            closed.append(number)
            NATIVE_CLOSE(number)
            raise failures[len(closed) - 1]
        with patch.object(clock.os, 'open', side_effect=self.opened(opened)), \
                patch.object(clock.os, 'close', side_effect=close):
            with self.assertRaises(PrivateError) as caught:
                clock.read_clock_probe_trace(self.path)
        self.assertIs(caught.exception, failures[0])
        self.assert_closed_once(opened, closed)

    def test_preparation_is_exclusive_private_and_empty(self):
        clock.prepare_clock_probe_trace(self.path)
        info = self.path.lstat()
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_nlink, 1)
        self.assertEqual(info.st_size, 0)
        self.assertEqual(clock.read_clock_probe_trace(self.path), b'')

    def test_preparation_rejects_existing_file_without_mutating_it(self):
        self.write(b'existing\r\n')
        before = self.path.lstat()
        with self.assertRaises(FileExistsError):
            clock.prepare_clock_probe_trace(self.path)
        self.assertEqual(clock._clock_probe_stamp(self.path.lstat()), clock._clock_probe_stamp(before))
        self.assertEqual(self.path.read_bytes(), b'existing\r\n')

    def test_preparation_rejects_symlink_without_touching_target(self):
        target = self.path.with_name('target')
        target.write_bytes(b'existing target')
        before = target.lstat()
        self.path.symlink_to(target)
        with self.assertRaises(FileExistsError):
            clock.prepare_clock_probe_trace(self.path)
        self.assertEqual(clock._clock_probe_stamp(target.lstat()), clock._clock_probe_stamp(before))
        self.assertTrue(self.path.is_symlink())

    def test_preparation_error_beats_close_error_and_descriptor_closes_once(self):
        opened, closed = [], []
        failure = PrivateError()
        def close(number):
            closed.append(number)
            NATIVE_CLOSE(number)
            raise PrivateError()
        with patch.object(clock.os, 'open', side_effect=self.opened(opened)), \
                patch.object(clock.os, 'fchmod', side_effect=failure), \
                patch.object(clock.os, 'close', side_effect=close):
            with self.assertRaises(PrivateError) as caught:
                clock.prepare_clock_probe_trace(self.path)
        self.assertIs(caught.exception, failure)
        self.assert_closed_once(opened, closed)


class PureCommandAndIntegrationControls(unittest.TestCase):
    def test_fixed_tracer_limit_and_harmless_producer_argv(self):
        expected = ['prlimit', '--fsize=1048576:1048576', '--core=0:0', '/owned/strace',
                    '--kill-on-exit', '--always-show-pid', clock.OPTION, '-o',
                    '/owned/clock-probe.trace', '/usr/bin/true']
        with patch.dict(os.environ, {'CLOCK_PROBE_TRACE_LIMIT': '999999999', 'STRACE_OPTIONS': '-T'}):
            self.assertEqual(clock.clock_probe_command('/owned/strace', Path('/owned/clock-probe.trace')),
                             expected)
        self.assertEqual(tuple(inspect.signature(clock.clock_probe_command).parameters), ('tracer', 'path'))
        with self.assertRaises(TypeError):
            clock.clock_probe_command('/owned/strace', Path('/owned/clock-probe.trace'), maximum=CAP + 1)
        changed = clock.clock_probe_command('/owned/strace', Path('/owned/clock-probe.trace'))
        changed.append('--arbitrary')
        self.assertEqual(clock.clock_probe_command('/owned/strace', Path('/owned/clock-probe.trace')), expected)

    def test_production_wiring_only_by_ast_no_probe_or_extracted_body_execution(self):
        tree = ast.parse(Path(clock.__file__).read_text())
        probe = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and
                     node.name == 'probe_clock')
        calls = [node for node in ast.walk(probe) if isinstance(node, ast.Call)]
        named = lambda name: [node for node in calls if isinstance(node.func, ast.Name) and
                              node.func.id == name]
        prepare, command, read, launch = [named(name) for name in (
            'prepare_clock_probe_trace', 'clock_probe_command', 'read_clock_probe_trace', 'run_traced')]
        self.assertEqual([len(group) for group in (prepare, command, read, launch)], [1, 1, 1, 1])
        self.assertEqual(ast.dump(launch[0].args[0]), ast.dump(command[0]))
        self.assertLess(prepare[0].lineno, launch[0].lineno)
        self.assertLess(launch[0].lineno, read[0].lineno)
        kwargs = {keyword.arg: keyword.value for keyword in launch[0].keywords}
        self.assertEqual(ast.literal_eval(kwargs['timeout']), 5)
        for key in ('stdout', 'stderr'):
            self.assertEqual(ast.dump(kwargs[key]), ast.dump(ast.parse('subprocess.PIPE', mode='eval').body))
        # No catches/retries can replace a prlimit acquisition/timeout error.
        self.assertFalse(any(isinstance(node, (ast.Try, ast.While, ast.For)) for node in ast.walk(probe)))
        returncode = next(node for node in named('require') if any(
            isinstance(part, ast.Attribute) and part.attr == 'returncode' for part in ast.walk(node)))
        self.assertLess(returncode.lineno, read[0].lineno)
        self.assertFalse(any(isinstance(node.func, ast.Attribute) and
                             isinstance(node.func.value, ast.Name) and node.func.value.id == 'path' and
                             node.func.attr in ('read_text', 'read_bytes', 'touch') for node in calls))
        decode = next(node for node in calls if isinstance(node.func, ast.Attribute) and
                      isinstance(node.func.value, ast.Name) and node.func.value.id == 'raw' and
                      node.func.attr == 'decode')
        self.assertEqual([ast.literal_eval(arg) for arg in decode.args], ['utf-8'])
        self.assertLess(read[0].lineno, decode.lineno)
        hashes = [value for node in ast.walk(probe) if isinstance(node, ast.Dict)
                  for key, value in zip(node.keys, node.values) if isinstance(key, ast.Constant) and
                  key.value == 'traceSha256']
        self.assertEqual(len(hashes), 1)
        self.assertEqual(ast.dump(hashes[0]), ast.dump(ast.parse('sha(raw)', mode='eval').body))
        retained_probe = next(node for node in ast.walk(probe) if isinstance(node, ast.Dict) and
                              any(isinstance(key, ast.Constant) and key.value == 'traceSha256'
                                  for key in node.keys))
        self.assertEqual({ast.literal_eval(key) for key in retained_probe.keys},
                         {'start', 'finish', 'traceSha256', 'firstPrefixNs', 'lastPrefixNs'})
        helpers = [node for node in calls if isinstance(node.func, ast.Attribute) and
                   isinstance(node.func.value, ast.Name) and node.func.value.id == 'subprocess' and
                   node.func.attr == 'run']
        self.assertEqual(len(helpers), 2)
        self.assertEqual([node.args[0].elts[1].value for node in helpers], ['--help', '--version'])
        for helper in helpers:
            self.assertEqual({key.arg: ast.literal_eval(key.value) for key in helper.keywords},
                             {'capture_output': True, 'check': True, 'timeout': 5})
        self.assertEqual(clock.OPTION, '--absolute-timestamps=format:unix,precision:ns')
        self.assertEqual(clock.KIND, 'strace-6.13-unix-entry-nanoseconds-v1')
        self.assertEqual(clock.SOURCE, '3fce8bcc9afd381cd07c0e06051921307d6322b3')


if __name__ == '__main__':
    unittest.main()
