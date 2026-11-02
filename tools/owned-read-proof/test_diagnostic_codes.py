"""Actual collection paths with inert adapters only; no sampler thread or host reads."""
import ast
from contextlib import ExitStack, contextmanager
import json
from pathlib import Path
import pickle
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import controlled_diagnostics as diagnostics


class Forbidden:
    def __getattr__(self, name):
        raise AssertionError('unexpected effect boundary')


class PrivateName(type):
    def __getattribute__(cls, name):
        if name == '__name__':
            raise AssertionError('private class name projected')
        return super().__getattribute__(name)


class PrivateBehavior:
    def __str__(self):
        raise AssertionError('private error stringified')

    def __repr__(self):
        raise AssertionError('private error represented')

    def __bool__(self):
        raise AssertionError('private error truth tested')


class PrivateOS(PrivateBehavior, OSError, metaclass=PrivateName):
    pass


class PrivateRuntime(PrivateBehavior, RuntimeError, metaclass=PrivateName):
    pass


class PrivateValue(PrivateBehavior, ValueError, metaclass=PrivateName):
    pass


class PrivateBase(PrivateBehavior, BaseException, metaclass=PrivateName):
    pass


class FalseyError(ValueError):
    def __bool__(self):
        return False

    def __str__(self):
        raise AssertionError('falsey error stringified')

    def __repr__(self):
        raise AssertionError('falsey error represented')


class Lock:
    def __init__(self):
        self.held, self.entries = False, 0

    def __enter__(self):
        assert not self.held, 'nonreentrant lock acquired twice'
        self.held = True
        self.entries += 1
        return self

    def __exit__(self, *args):
        assert self.held
        self.held = False


class Event:
    def __init__(self):
        self.waits, self.sets = [], 0

    def wait(self, period):
        self.waits.append(period)
        return True

    def set(self):
        self.sets += 1


class InertThread:
    def __init__(self, *, target, daemon):
        assert daemon is True
        self.target, self.starts, self.joins = target, 0, []
        self.ident, self.alive = 1, False

    def start(self):
        self.starts += 1  # Does not run target or create a thread.

    def join(self, *, timeout):
        self.joins.append(timeout)

    def is_alive(self):
        return self.alive


class CheckedOwner(diagnostics.SparseDiagnostics):
    def __setattr__(self, name, value):
        if name == '_collection_failure' and value is not None:
            assert self.lock.held, 'collection error written outside original lock'
        super().__setattr__(name, value)


class Pin:
    expected, identity = {'pid': 9}, (1, 2, 3)

    def __init__(self, error=None):
        self.error, self.calls, self.closes = error, 0, 0

    def sample(self):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return {'ticks': 7}

    def close(self):
        self.closes += 1


def owner():
    value = CheckedOwner.__new__(CheckedOwner)
    value._collection_failure = value._first_failure = value._cleanup_error = None
    value._retention_state = 'ready'
    value.trace = SimpleNamespace(stat=lambda: SimpleNamespace(st_size=17))
    value.phases = [None]
    value.lock, value.done = Lock(), Event()
    value.thread, value.stopped = None, False
    value.resource = 100
    value.processes, value.samples, value.errors = {'supervisor': Pin()}, [], []
    return value


@contextmanager
def injected(resource_error=None, failed_resource='cpu.stat'):
    reads, writes, closes = [], [], []
    def read(directory, name):
        assert directory == 100
        reads.append(name)
        if name == failed_resource and resource_error is not None:
            raise resource_error
        return 'usage 7\n' if name in {'cpu.stat', 'memory.events'} else '9\n'
    with ExitStack() as stack:
        for name in ('os', 'select', 'Path'):
            stack.enter_context(patch.object(diagnostics, name, Forbidden()))
        stack.enter_context(patch.object(diagnostics, 'threading', SimpleNamespace(Thread=InertThread)))
        stack.enter_context(patch.object(diagnostics, 'time', SimpleNamespace(monotonic_ns=lambda: 11, time_ns=lambda: 12)))
        stack.enter_context(patch.object(diagnostics, 'read_at', side_effect=read))
        stack.enter_context(patch.object(diagnostics, '_write_private_diagnostic', side_effect=lambda path, payload: writes.append(payload)))
        yield reads, writes, closes


class DiagnosticCodes(unittest.TestCase):
    def assert_private(self, value):
        encoded = json.dumps({'samples': value.samples, 'errors': value.errors})
        self.assertNotIn('SECRET', encoded)
        self.assertNotIn('Private', encoded)
        self.assertNotIn('Traceback', encoded)
        return encoded

    def test_process_catch_vocabulary_and_remaining_collection(self):
        for error_class in (PrivateOS, PrivateRuntime, PrivateValue, FalseyError):
            error = error_class('SECRET /private/path argv token')
            value = owner(); value.processes['supervisor'] = Pin(error)
            value.processes['leader'] = Pin()
            with injected() as (reads, _, _):
                value.capture()
            sample = value.samples[0]
            self.assertEqual(sample['processes'], {'supervisor': {'diagnosticError': 'process-sample-failed'}, 'leader': {'ticks': 7}})
            self.assertEqual(sample['resources'], {'cpu.stat': {'usage': 7}, 'io.stat': '9', 'memory.events': {'usage': 7}, 'memory.current': '9'})
            self.assertEqual(reads, list(diagnostics.RESOURCE_NAMES))
            self.assertEqual(set(sample), {'monotonicBeforeNs', 'wallNs', 'traceBytes', 'phaseEventCount', 'processes', 'resources', 'monotonicAfterNs'})
            self.assertEqual((sample['traceBytes'], sample['phaseEventCount']), (17, 1))
            self.assertIs(value._collection_failure, error)
            self.assertEqual(value.lock.entries, 1)
            self.assert_private(value)

    def test_resource_catches_all_existing_classes_at_each_resource(self):
        for error_class in (PrivateOS, PrivateRuntime, PrivateValue, FalseyError):
            for resource in diagnostics.RESOURCE_NAMES:
                error = error_class('SECRET'); value = owner()
                with injected(error, resource) as (reads, _, _):
                    value.capture()
                self.assertEqual(reads, list(diagnostics.RESOURCE_NAMES))
                self.assertEqual(value.samples[0]['resources'][resource], {'diagnosticError': 'resource-sample-failed'})
                self.assertEqual(value.samples[0]['processes'], {'supervisor': {'ticks': 7}})
                self.assertIs(value._collection_failure, error)
                self.assertEqual(value.lock.entries, 2)
                self.assert_private(value)

    def test_uncaught_base_errors_not_silently_broadened_in_capture(self):
        for site in ('process', 'resource'):
            original = PrivateBase('SECRET'); value = owner()
            if site == 'process':
                value.processes['supervisor'].error = original
            with injected(original if site == 'resource' else None):
                try:
                    value.capture()
                except BaseException as caught:
                    self.assertIs(caught, original)
                else:
                    self.fail('capture unexpectedly swallowed BaseException')
            self.assertIsNone(value._collection_failure)
            self.assertEqual(value.samples, [])
            self.assertFalse(value.lock.held)

    def test_actual_sampler_callback_and_final_capture_base_failures(self):
        for original in (PrivateBase('SECRET'), FalseyError('SECRET')):
            value = owner()
            with injected(), patch.object(value, 'capture', side_effect=original):
                value.start()
                self.assertIsNone(value._collection_failure)
                value.thread.target()  # The actual callback, on this test's stack.
                self.assertEqual(value.thread.starts, 1)
                self.assertEqual(value.errors, ['sampler-work-failed'])
                self.assertIs(value._collection_failure, original)
                value.stop()
            self.assertEqual(value.errors, ['sampler-work-failed', 'final-sample-failed'])
            self.assertIs(value._collection_failure, original)
            self.assertEqual(value.thread.joins, [1])
            self.assertEqual(value.lock.entries, 2)
            self.assert_private(value)

    def test_final_failure_can_be_first_and_is_sticky_against_later_records(self):
        value = owner(); original, later = PrivateBase('SECRET'), PrivateValue('SECRET later')
        with injected():
            value.start()
            with patch.object(value, 'capture', side_effect=original):
                value.stop()
            value.processes['supervisor'].error = later
            value.capture()
        self.assertEqual(value.errors, ['final-sample-failed'])
        self.assertIs(value._collection_failure, original)
        self.assertIsNone(value._first_failure)
        self.assert_private(value)

    def test_lock_recording_order_separate_from_structural_failure(self):
        value = owner()
        first, second, structural, worker, final = [PrivateValue('SECRET') for _ in range(5)]
        value._first_failure = structural
        value.processes['supervisor'].error = first
        with injected(second):
            value.capture()
            value.start()
            with patch.object(value, 'capture', side_effect=worker):
                value.thread.target()
            with patch.object(value, 'capture', side_effect=final):
                value.stop()
        self.assertIs(value._collection_failure, first)
        self.assertIs(value._first_failure, structural)
        self.assertEqual(value.errors, ['sampler-work-failed', 'final-sample-failed'])
        self.assertEqual(value.lock.entries, 4)
        self.assert_private(value)

    def test_success_period_join_final_sample_and_exact_count_bound(self):
        value = owner()
        with injected() as (reads, _, _):
            value.start(); value.thread.target(); value.stop()
            self.assertEqual(len(reads), 8)
        self.assertEqual(value.done.waits, [1.0])
        self.assertEqual(value.thread.joins, [1])
        self.assertEqual(len(value.samples), 2)
        self.assertIs(value.samples[-1]['finalAfterOwnedSettlement'], True)
        self.assertIsNone(value._collection_failure)
        self.assertEqual(value.errors, [])
        value = owner()
        with injected() as (reads, _, _):
            for _ in range(62):
                value.capture()
            with self.assertRaisesRegex(RuntimeError, 'sample count exceeds bound'):
                value.capture()
            self.assertEqual(len(reads), 248)
            value.start(); value.stop()  # At bound: no final capture.
            self.assertEqual(len(reads), 248)
        self.assertEqual((diagnostics.PERIOD_NS, diagnostics.MAX_SAMPLES, diagnostics.READ_BOUND), (1_000_000_000, 62, 8192))

    def test_retention_serializes_only_existing_projection_not_private_slot(self):
        value = owner(); original = PrivateValue('SECRET'); value.processes['supervisor'].error = original
        with injected() as (_, writes, closes):
            value.capture()
            with patch.object(diagnostics, 'Path', lambda path: path), \
                 patch.object(diagnostics, 'os', SimpleNamespace(close=closes.append)):
                result = value.retain_and_close('synthetic-only')
        self.assertEqual(set(result), {'config', 'authority', 'samples', 'errors', 'pins', 'samplerStopped'})
        self.assertEqual(json.loads(writes[0]), result)
        self.assertNotIn(b'SECRET', writes[0])
        self.assertNotIn(b'_collection_failure', writes[0])
        self.assertIs(value._collection_failure, original)
        self.assertEqual(closes, [100])
        self.assertEqual(result['authority'], 'none')

    def test_owner_pickle_refuses_with_active_private_exception_context(self):
        value = owner(); original = PrivateBase('SECRET')
        with value.lock:
            value._remember_collection_failure(original)
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            try:
                raise original
            except BaseException:
                with self.assertRaises(TypeError) as caught:
                    pickle.dumps(value, protocol=protocol)
            self.assertEqual(str(caught.exception), 'private diagnostic owner serialization disabled')
            self.assertTrue(caught.exception.__suppress_context__)
            self.assertIsNone(caught.exception.__cause__)
            self.assertIs(value._collection_failure, original)

    def test_existing_catch_classes_and_only_four_literal_error_codes(self):
        tree = ast.parse(Path(diagnostics.__file__).read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'SparseDiagnostics')
        functions = {node.name: node for node in cls.body if isinstance(node, ast.FunctionDef)}
        handlers = [node for node in ast.walk(functions['capture']) if isinstance(node, ast.ExceptHandler)]
        self.assertEqual([ast.unparse(node.type) for node in handlers], ['(OSError, RuntimeError, ValueError)'] * 2)
        for name in ('start', 'stop'):
            self.assertEqual([ast.unparse(node.type) for node in ast.walk(functions[name]) if isinstance(node, ast.ExceptHandler)], ['BaseException'])
        codes = []
        for name in ('capture', 'start', 'stop'):
            for node in ast.walk(functions[name]):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    self.assertNotIn(node.func.id, ('str', 'repr', 'type', 'bool'))
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.endswith('-failed'):
                    codes.append(node.value)
        self.assertEqual(set(codes), {'process-sample-failed', 'resource-sample-failed', 'sampler-work-failed', 'final-sample-failed'})
        self.assertEqual(len(codes), 4)


if __name__ == '__main__':
    unittest.main()
