"""Actual run_traced under complete inert boundary replacement; no live processes."""
import ast
from contextlib import ExitStack
from pathlib import Path
import pickle
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import run


class PrivateFailure(BaseException):
    def __str__(self):
        raise AssertionError('private string conversion')

    def __repr__(self):
        raise AssertionError('private representation')

    def __bool__(self):
        raise AssertionError('private truthiness')


class Strict:
    def __getattr__(self, name):
        raise AssertionError('unprovided inert operation: ' + name)


class FalseFailure(PrivateFailure):
    def __bool__(self):
        return False


class Stream(Strict):
    def __init__(self, owner, name, error=None):
        self.owner, self.name, self.error, self.calls = owner, name, error, 0

    def close(self):
        self.calls += 1
        self.owner.events.append(self.name + '.close')
        assert getattr(self.owner.process, self.name) is None
        if self.error is not None:
            raise self.error


class Process(Strict):
    pid = 701

    def __init__(self, owner):
        self.owner, self.returncode = owner, None
        self.stdout, self.stderr = Stream(owner, 'stdout'), Stream(owner, 'stderr')

    def communicate(self, timeout):
        self.owner.events.append(('communicate', timeout))
        if self.owner.body_error is not None:
            raise self.owner.body_error
        self.returncode = self.owner.returncode
        return 'synthetic output', 'synthetic diagnostic'

    def wait(self, timeout):
        self.owner.events.append(('wait', timeout))
        if self.owner.wait_error is not None:
            raise self.owner.wait_error
        self.returncode = -9
        return self.returncode


class Boundaries(Strict):
    """Every effectful module reference is replaced, without fallback to real APIs."""
    WNOHANG = 1
    SIGKILL = 9

    def __init__(self):
        self.events = []
        self.body_error = self.launch_error = self.kill_error = self.wait_error = None
        self.restore_error = self.get_error = self.set_error = None
        self.restore_result = 0
        self.returncode = 0
        self.reaps = [ChildProcessError()]
        self.times = [10]
        self.prctl_calls = 0
        self.process = Process(self)
        self.streams = (self.process.stdout, self.process.stderr)

    def CDLL(self, name, use_errno):
        assert name is None and use_errno is True
        self.events.append('CDLL')
        return self

    def c_int(self):
        self.events.append('c_int')
        return SimpleNamespace(value=0)

    def byref(self, value):
        self.events.append('byref')
        return value

    def get_errno(self):
        self.events.append('get_errno')
        return 5

    def prctl(self, operation, value, a, b, c):
        assert (a, b, c) == (0, 0, 0)
        self.prctl_calls += 1
        self.events.append(('prctl', operation, value.value if operation == 37 else value))
        if self.prctl_calls == 1:
            assert operation == 37
            if self.get_error is not None:
                raise self.get_error
            value.value = 0
        elif self.prctl_calls == 2:
            assert (operation, value) == (36, 1)
            if self.set_error is not None:
                raise self.set_error
        else:
            assert self.prctl_calls == 3 and (operation, value) == (36, 0)
            if self.restore_error is not None:
                raise self.restore_error
            return self.restore_result
        return 0

    def Popen(self, args, **kwargs):
        self.events.append(('Popen', tuple(args), kwargs))
        assert kwargs['start_new_session'] is True
        if self.launch_error is not None:
            raise self.launch_error
        return self.process

    def CompletedProcess(self, args, returncode, stdout, stderr):
        self.events.append('CompletedProcess')
        return SimpleNamespace(args=args, returncode=returncode, stdout=stdout, stderr=stderr)

    def killpg(self, pid, sig):
        assert (pid, sig) == (701, 9)
        self.events.append(('killpg', pid, sig))
        if self.kill_error is not None:
            raise self.kill_error

    def waitpid(self, pid, options):
        assert (pid, options) == (-1, 1)
        self.events.append(('waitpid', pid, options))
        assert self.reaps, 'unexpected extra reap attempt'
        value = self.reaps.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    def monotonic(self):
        self.events.append('monotonic')
        assert self.times, 'unexpected clock operation'
        return self.times.pop(0)

    def sleep(self, seconds):
        assert seconds == 0.01
        self.events.append(('sleep', seconds))

    def patches(self):
        stack = ExitStack()
        # Complete modules, not selected methods: no real prctl/Popen/OS/clock
        # reference can be reached through run's dependencies in these calls.
        for name in ('ctypes', 'subprocess', 'os', 'time', 'signal'):
            stack.enter_context(patch.object(run, name, self))
        for name in ('tempfile', 'shutil', 'fcntl', 'importlib'):
            stack.enter_context(patch.object(run, name, Strict()))
        return stack

    def invoke(self, **kwargs):
        with self.patches():
            return run.run_traced(['inert tracer'], **kwargs)


class TracedFailureControls(unittest.TestCase):
    def capture(self, f, **kwargs):
        with self.assertRaises(BaseException) as caught:
            f.invoke(**kwargs)
        return caught.exception

    def assert_streams_consumed_once(self, f):
        self.assertEqual([s.calls for s in f.streams], [1, 1])
        self.assertIsNone(f.process.stdout)
        self.assertIsNone(f.process.stderr)
        self.assertEqual(f.prctl_calls, 3)

    def test_success_only_returns_after_streams_and_restoration(self):
        f = Boundaries()
        result = f.invoke(timeout=17, cwd='synthetic', pass_fds=(41,))
        self.assertEqual((result.returncode, result.stdout), (0, 'synthetic output'))
        self.assertIn(('communicate', 17), f.events)
        self.assertEqual(f.events[-3:], ['stdout.close', 'stderr.close', ('prctl', 36, 0)])
        self.assert_streams_consumed_once(f)

    def test_reaped_leader_never_signals_or_waits_reused_numeric_group(self):
        for code in (0, -9):
            f = Boundaries(); f.returncode = code
            self.assertEqual(f.invoke().returncode, code)
            self.assertIn(('communicate', 30), f.events)
            self.assertFalse(any(isinstance(e, tuple) and e[0] in ('killpg', 'wait') for e in f.events))

    def test_body_failure_preserved_after_successful_settlement(self):
        for original in (PrivateFailure(), FalseFailure(), KeyboardInterrupt(), SystemExit(2), GeneratorExit()):
            f = Boundaries(); f.body_error = original
            self.assertIs(self.capture(f), original)
            self.assertIn(('killpg', 701, 9), f.events)
            self.assertIn(('wait', 5), f.events)
            self.assert_streams_consumed_once(f)

    def test_callback_failure_has_same_identity_and_no_communicate(self):
        f, original = Boundaries(), PrivateFailure()
        def callback(process):
            self.assertIs(process, f.process)
            f.events.append('callback')
            raise original
        self.assertIs(self.capture(f, on_started=callback), original)
        self.assertNotIn(('communicate', 30), f.events)
        self.assertIn(('wait', 5), f.events)
        self.assert_streams_consumed_once(f)

    def test_failed_kill_wait_or_reap_is_unsafe_despite_later_failures(self):
        for phase in ('kill', 'wait', 'reap'):
            f, first, settlement = Boundaries(), PrivateFailure(), PrivateFailure()
            f.body_error = first
            if phase == 'kill': f.kill_error = settlement
            elif phase == 'wait': f.wait_error = settlement
            else: f.reaps = [settlement]
            f.streams[0].error = PrivateFailure(); f.streams[1].error = PrivateFailure()
            f.restore_error = PrivateFailure()
            error = self.capture(f)
            self.assertIsInstance(error, run.OwnedCleanupError)
            self.assertIs(error._first_failure, first)
            self.assertIs(error._settlement_failure, settlement)
            self.assertTrue(error.__suppress_context__)
            self.assertIsNone(error.__cause__)
            self.assertEqual(str(error), 'Owned cleanup incomplete; disposal unsafe')
            self.assertEqual(repr(error), "OwnedCleanupError('Owned cleanup incomplete; disposal unsafe')")
            self.assert_streams_consumed_once(f)
            for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
                with self.assertRaises(TypeError): pickle.dumps(error, protocol=protocol)

    def test_wait_timeout_preserves_exact_timeout_privately(self):
        f = Boundaries(); f.body_error = PrivateFailure()
        # Construct only the exception type, never subprocess behavior.
        from subprocess import TimeoutExpired
        timeout = TimeoutExpired('synthetic', 5)
        f.wait_error = timeout
        error = self.capture(f)
        self.assertIsInstance(error, run.OwnedCleanupError)
        self.assertIs(error._settlement_failure, timeout)
        self.assertEqual(f.events.count(('wait', 5)), 1)

    def test_settlement_error_first_when_body_succeeded(self):
        f, original = Boundaries(), PrivateFailure()
        f.reaps = [original]; f.restore_error = PrivateFailure()
        error = self.capture(f)
        self.assertIsInstance(error, run.OwnedCleanupError)
        self.assertIs(error._first_failure, original)
        self.assertIs(error._settlement_failure, original)
        self.assert_streams_consumed_once(f)

    def test_adopted_tracee_deadline_stays_five_seconds(self):
        f = Boundaries(); f.reaps = [(0, 0)]; f.times = [10, 15]
        error = self.capture(f)
        self.assertIsInstance(error, run.OwnedCleanupError)
        self.assertIsInstance(error._settlement_failure, run.OwnedCleanupError)
        self.assertNotIn(('sleep', 0.01), f.events)
        self.assert_streams_consumed_once(f)

    def test_reap_loop_scope_and_sleep_are_unchanged(self):
        f = Boundaries(); f.reaps = [(702, 0), (0, 0), ChildProcessError()]; f.times = [10, 11]
        self.assertEqual(f.invoke().returncode, 0)
        self.assertEqual(f.events.count(('waitpid', -1, 1)), 3)
        self.assertEqual(f.events.count(('sleep', 0.01)), 1)

    def test_missing_group_still_attempts_original_wait(self):
        f = Boundaries(); f.body_error = PrivateFailure(); f.kill_error = ProcessLookupError()
        self.assertIs(self.capture(f), f.body_error)
        self.assertEqual(f.events.count(('wait', 5)), 1)

    def test_stream_errors_do_not_mask_body_or_skip_other_stream(self):
        f = Boundaries(); f.body_error = PrivateFailure()
        f.streams[0].error = PrivateFailure(); f.streams[1].error = PrivateFailure()
        f.restore_error = PrivateFailure()
        self.assertIs(self.capture(f), f.body_error)
        self.assert_streams_consumed_once(f)

    def test_stream_first_error_precedes_second_stream_and_restoration(self):
        for position in (0, 1):
            f, first = Boundaries(), PrivateFailure()
            f.streams[position].error = first
            f.restore_error = PrivateFailure()
            self.assertIs(self.capture(f), first)
            self.assert_streams_consumed_once(f)

    def test_aliased_stream_is_consumed_once_even_when_close_raises(self):
        f = Boundaries(); stream = f.streams[0]; stream.error = PrivateFailure()
        f.process.stderr = stream
        self.assertIs(self.capture(f), stream.error)
        self.assertEqual(stream.calls, 1)
        self.assertIsNone(f.process.stdout); self.assertIsNone(f.process.stderr)

    def test_restoration_failure_after_success_cannot_return_success(self):
        for original in (PrivateFailure(), KeyboardInterrupt(), SystemExit(1)):
            f = Boundaries(); f.restore_error = original
            self.assertIs(self.capture(f), original)
            self.assert_streams_consumed_once(f)
        f = Boundaries(); f.restore_result = -1
        self.assertIsInstance(self.capture(f), OSError)

    def test_start_failure_is_unsafe_without_inventing_original_handle(self):
        for original in (PrivateFailure(), OSError('synthetic start failure'), KeyboardInterrupt()):
            f = Boundaries(); f.launch_error = original; f.restore_error = PrivateFailure()
            error = self.capture(f)
            self.assertIsInstance(error, run.OwnedCleanupError)
            self.assertIs(error._first_failure, original)
            self.assertIs(error._settlement_failure, original)
            self.assertEqual(f.prctl_calls, 3)
            self.assertEqual([s.calls for s in f.streams], [0, 0])
            self.assertEqual(sum(isinstance(e, tuple) and e[0] == 'Popen' for e in f.events), 1)
            self.assertFalse(any(isinstance(e, tuple) and e[0] in ('killpg', 'wait', 'waitpid') for e in f.events))

    def test_initial_prctl_failure_never_reaches_popen(self):
        for phase in ('get_error', 'set_error'):
            f, original = Boundaries(), PrivateFailure(); setattr(f, phase, original)
            self.assertIs(self.capture(f), original)
            self.assertFalse(any(isinstance(e, tuple) and e[0] == 'Popen' for e in f.events))

    def test_private_holder_neither_formats_nor_serializes_first_error(self):
        failures, original = run._TracedFailures(), PrivateFailure()
        failures.record(original); failures.record(PrivateFailure())
        self.assertEqual(repr(failures), '<_TracedFailures: private contents omitted>')
        with self.assertRaises(PrivateFailure) as caught: failures.raise_first()
        self.assertIs(caught.exception, original)
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with self.assertRaises(TypeError): pickle.dumps(failures, protocol=protocol)

    def test_falsey_first_error_survives_unsafe_cleanup(self):
        f = Boundaries(); f.body_error = FalseFailure(); f.wait_error = PrivateFailure()
        error = self.capture(f)
        self.assertIsInstance(error, run.OwnedCleanupError)
        self.assertIs(error._first_failure, f.body_error)
        self.assertIs(error._settlement_failure, f.wait_error)

    def test_serialization_refusal_suppresses_active_private_exception_context(self):
        holder, original = run._TracedFailures(), PrivateFailure()
        holder.record(original)
        carrier = run.OwnedCleanupError('synthetic unsafe owner')
        carrier._first_failure = original
        try:
            raise original
        except PrivateFailure:
            for value in (holder, carrier):
                for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
                    with self.assertRaises(TypeError) as caught:
                        pickle.dumps(value, protocol=protocol)
                    self.assertTrue(caught.exception.__suppress_context__)
                    self.assertIsNone(caught.exception.__cause__)
                    self.assertIs(caught.exception.__context__, original)

    def test_captured_unsafe_error_cannot_be_downgraded_by_earlier_body_failure(self):
        f = Boundaries(); f.body_error = PrivateFailure()
        f.streams[0].error = run.OwnedCleanupError('synthetic unsafe owner')
        error = self.capture(f)
        self.assertIsInstance(error, run.OwnedCleanupError)
        self.assertIs(error._first_failure, f.body_error)
        self.assertIs(error._settlement_failure, f.streams[0].error)


class DirectoryContractControls(unittest.TestCase):
    def test_actual_directory_wrapper_preserves_unsafe_result_without_filesystem_effects(self):
        for phase in ('body', 'settlement', 'startup'):
            f = Boundaries(); f.body_error = PrivateFailure()
            if phase == 'settlement': f.wait_error = PrivateFailure()
            if phase == 'startup': f.launch_error = PrivateFailure()
            f.restore_error = PrivateFailure()
            paths = []
            temporary = SimpleNamespace(mkdtemp=lambda **kwargs: 'synthetic owned directory')
            removal = SimpleNamespace(rmtree=lambda path: paths.append(path))
            with f.patches(), patch.object(run, 'tempfile', temporary), patch.object(run, 'shutil', removal):
                with self.assertRaises(BaseException) as caught:
                    with run.proof_directory() as directory:
                        self.assertEqual(directory, 'synthetic owned directory')
                        run.run_traced(['inert tracer'])
            if phase != 'body':
                self.assertIsInstance(caught.exception, run.OwnedCleanupError)
                self.assertEqual(paths, [])
            else:
                self.assertIs(caught.exception, f.body_error)
                self.assertEqual(paths, ['synthetic owned directory'])

    def test_only_original_wait_scope_and_timeouts_in_actual_source(self):
        tree = ast.parse(Path(run.__file__).read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_traced')
        calls = [ast.unparse(n) for n in ast.walk(fn) if isinstance(n, ast.Call)]
        self.assertEqual(calls.count('os.waitpid(-1, os.WNOHANG)'), 1)
        self.assertEqual(calls.count('process.wait(timeout=5)'), 1)
        self.assertEqual(calls.count('time.sleep(0.01)'), 1)
        self.assertNotIn('process.poll()', calls)


if __name__ == '__main__':
    unittest.main()
