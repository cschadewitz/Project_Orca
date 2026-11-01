"""Injected retention bookkeeping; source-only historical disposal guard checks."""
import ast
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import controlled_diagnostics as diagnostics
from test_diagnostic_rollback import FakeOS, PrivateError
from test_sparse_rollback import InertPin


class Pin(InertPin):
    expected = {'pid': 9}
    identity = (1, 2, 3)


class Thread:
    def __init__(self, ident=1, alive=False, identity_error=None, query_error=None):
        self.identity = ident
        self.alive = alive
        self.identity_error, self.query_error = identity_error, query_error
        self.queries = 0

    @property
    def ident(self):
        if self.identity_error is not None:
            raise self.identity_error
        return self.identity

    def is_alive(self):
        self.queries += 1
        if self.query_error is not None:
            raise self.query_error
        return self.alive


def owner(thread=None):
    value = diagnostics.SparseDiagnostics.__new__(diagnostics.SparseDiagnostics)
    value._retention_state = 'ready'
    value._first_failure = value._cleanup_error = None
    value.thread, value.stopped = thread, False
    value.samples, value.errors, value.processes = [], [], {'supervisor': Pin(), 'leader': Pin()}
    value.resource = 100
    return value


@contextmanager
def injected(value, stop_error=None, stop_action=None, write_error=None, chmod_error=None):
    fake, events, stop_calls = FakeOS(), [], []
    def stop():
        stop_calls.append('stop')
        if stop_action is not None:
            stop_action()
        if stop_error is not None:
            raise stop_error
        value.stopped = True
    def path(destination):
        events.append(('path', destination))
        def write(text):
            events.append(('write', text))
            if write_error is not None:
                raise write_error
        def chmod(mode):
            events.append(('chmod', mode))
            if chmod_error is not None:
                raise chmod_error
        return SimpleNamespace(write_text=write, chmod=chmod)
    with patch.object(value, 'stop', side_effect=stop), \
         patch.object(diagnostics, 'Path', side_effect=path), \
         patch.object(diagnostics, 'os', fake):
        yield fake, events, stop_calls


class RetentionRollbackControls(unittest.TestCase):
    def assert_preserved(self, value, pins, fake, events):
        self.assertEqual(value._retention_state, 'uncertain')
        self.assertEqual(value.processes, pins)
        self.assertEqual(value.resource, 100)
        self.assertEqual([pin.closes for pin in pins.values()], [0, 0])
        self.assertEqual(fake.closed, [])
        self.assertEqual(events, [])

    def assert_consumed(self, value, pins, fake):
        self.assertEqual(value._retention_state, 'consumed')
        self.assertEqual(value.processes, {})
        self.assertIsNone(value.resource)
        self.assertEqual([pin.closes for pin in pins.values()], [1, 1])
        self.assertEqual(fake.closed, [100])

    def test_no_sampler_and_started_nonrunning_sampler_success(self):
        for thread in (None, Thread()):
            value = owner(thread); pins = dict(value.processes)
            with injected(value) as (fake, events, calls):
                result = value.retain_and_close('private-fixture')
            self.assert_consumed(value, pins, fake)
            self.assertEqual(result['authority'], 'none')
            self.assertIs(result['samplerStopped'], True)
            self.assertEqual(list(result['pins']), ['supervisor', 'leader'])
            self.assertEqual(events[-1], ('chmod', 0o600))
            self.assertEqual(calls, ['stop'])

    def test_alive_never_started_and_nonboolean_liveness_refuse_and_retain(self):
        for thread in (Thread(alive=True), Thread(ident=None), Thread(alive=0)):
            value = owner(thread); value.stopped = True; pins = dict(value.processes)
            with injected(value) as (fake, events, calls):
                with self.assertRaisesRegex(RuntimeError, 'sampler ownership uncertain'):
                    value.retain_and_close('private-fixture')
            self.assert_preserved(value, pins, fake, events)
            self.assertEqual(calls, ['stop'])

    def test_identity_or_liveness_query_error_preserves_exact_error_and_ownership(self):
        for position in ('identity_error', 'query_error'):
            original = PrivateError()
            value = owner(Thread(**{position: original})); pins = dict(value.processes)
            with injected(value) as (fake, events, _):
                with self.assertRaises(PrivateError) as caught:
                    value.retain_and_close('private-fixture')
            self.assertIs(caught.exception, original)
            self.assertIs(value._first_failure, original)
            self.assert_preserved(value, pins, fake, events)

    def test_changed_sampler_identity_refuses_without_querying_replacement(self):
        for initial in (None, Thread()):
            value = owner(initial); pins = dict(value.processes); replacement = Thread()
            with injected(value, stop_action=lambda: setattr(value, 'thread', replacement)) as (fake, events, _):
                with self.assertRaisesRegex(RuntimeError, 'sampler ownership uncertain'):
                    value.retain_and_close('private-fixture')
            self.assertEqual(replacement.queries, 0)
            self.assert_preserved(value, pins, fake, events)

    def test_stop_failure_with_present_sampler_retains_even_if_nonrunning(self):
        for thread in (Thread(), Thread(alive=True), Thread(ident=None)):
            original = PrivateError(); value = owner(thread); pins = dict(value.processes)
            with injected(value, stop_error=original) as (fake, events, _):
                with self.assertRaises(PrivateError) as caught:
                    value.retain_and_close('private-fixture')
            self.assertIs(caught.exception, original)
            self.assertEqual(thread.queries, 0)
            self.assert_preserved(value, pins, fake, events)

    def test_stop_failure_without_sampler_cleans_and_keeps_primary(self):
        original, cleanup = PrivateError(), PrivateError()
        value = owner(); pins = dict(value.processes)
        pins['leader'].cleanup = cleanup
        with injected(value, stop_error=original) as (fake, events, _):
            fake.close_failures[100] = PrivateError()
            with self.assertRaises(PrivateError) as caught:
                value.retain_and_close('private-fixture')
        self.assertIs(caught.exception, original)
        self.assertIs(value._first_failure, original)
        self.assertIs(value._cleanup_error, cleanup)
        self.assert_consumed(value, pins, fake)
        self.assertEqual(events, [])

    def test_stop_failure_after_sampler_appears_keeps_ownership(self):
        original = PrivateError(); value = owner(); pins = dict(value.processes)
        with injected(value, stop_error=original, stop_action=lambda: setattr(value, 'thread', Thread())) as (fake, events, _):
            with self.assertRaises(PrivateError) as caught:
                value.retain_and_close('private-fixture')
        self.assertIs(caught.exception, original)
        self.assert_preserved(value, pins, fake, events)

    def test_value_preparation_failure_still_drains_eligible_ownership(self):
        original = PrivateError(); value = owner(); pins = dict(value.processes)
        class BrokenIdentity:
            def __iter__(self):
                raise original
        pins['supervisor'].identity = BrokenIdentity()
        with injected(value) as (fake, events, _):
            with self.assertRaises(PrivateError) as caught:
                value.retain_and_close('private-fixture')
        self.assertIs(caught.exception, original)
        self.assert_consumed(value, pins, fake)
        self.assertEqual(events, [])

    def test_path_serialization_write_and_chmod_errors_win_over_cleanup(self):
        for stage in ('path', 'serialize', 'write', 'chmod'):
            original = PrivateError(); value = owner(); pins = dict(value.processes)
            pins['leader'].cleanup = PrivateError()
            arguments = {stage + '_error': original} if stage in ('write', 'chmod') else {}
            with injected(value, **arguments) as (fake, events, _):
                fake.close_failures[100] = PrivateError()
                if stage == 'path':
                    override = patch.object(diagnostics, 'Path', side_effect=original)
                elif stage == 'serialize':
                    override = patch.object(diagnostics.json, 'dumps', side_effect=original)
                else:
                    override = patch.object(value, 'samples', value.samples)
                with override, self.assertRaises(PrivateError) as caught:
                    value.retain_and_close('private-fixture')
            self.assertIs(caught.exception, original)
            self.assertIs(value._first_failure, original)
            self.assert_consumed(value, pins, fake)
            if stage == 'chmod':
                self.assertTrue(any(event[0] == 'write' for event in events))

    def test_each_and_all_disposal_failures_attempt_every_slot_and_fixed_refuse(self):
        for failed in (('leader',), ('supervisor',), ('resource',), ('leader', 'supervisor', 'resource')):
            value = owner(); pins = dict(value.processes); errors = {name: PrivateError() for name in failed}
            for name, pin in pins.items():
                pin.cleanup = errors.get(name)
            with injected(value) as (fake, events, _):
                if 'resource' in errors:
                    fake.close_failures[100] = errors['resource']
                with self.assertRaisesRegex(RuntimeError, '^diagnostic retention cleanup uncertain$') as caught:
                    value.retain_and_close('private-fixture')
            self.assertTrue(caught.exception.__suppress_context__)
            self.assert_consumed(value, pins, fake)
            self.assertIs(value._cleanup_error, next(errors[n] for n in ('leader', 'supervisor', 'resource') if n in errors))
            self.assertEqual(events[-1], ('chmod', 0o600))

    def test_existing_private_errors_stay_sticky_and_refuse_success(self):
        value = owner(); pins = dict(value.processes)
        first, cleanup = PrivateError(), PrivateError()
        value._first_failure, value._cleanup_error = first, cleanup
        pins['leader'].cleanup = PrivateError()
        with injected(value) as (fake, _, _):
            with self.assertRaisesRegex(RuntimeError, 'retention cleanup uncertain'):
                value.retain_and_close('private-fixture')
        self.assertIs(value._first_failure, first)
        self.assertIs(value._cleanup_error, cleanup)
        self.assert_consumed(value, pins, fake)

    def test_repeat_after_success_failure_and_uncertainty_has_no_side_effects(self):
        for stage in ('success', 'write', 'uncertain'):
            value = owner(Thread(alive=True) if stage == 'uncertain' else None)
            arguments = {'write_error': PrivateError()} if stage == 'write' else {}
            with injected(value, **arguments) as (fake, events, calls):
                if stage == 'success':
                    value.retain_and_close('first')
                else:
                    with self.assertRaises(PrivateError if stage == 'write' else RuntimeError):
                        value.retain_and_close('first')
                snapshot = (list(fake.closed), list(events), list(calls))
                with self.assertRaisesRegex(RuntimeError, '^diagnostic retention already attempted$'):
                    value.retain_and_close('second')
                self.assertEqual((fake.closed, events, calls), snapshot)

    def test_reentrant_attempt_refuses_before_second_stop_write_or_disposal(self):
        value = owner(); pins = dict(value.processes)
        with injected(value, stop_action=lambda: value.retain_and_close('nested')) as (fake, events, calls):
            with self.assertRaisesRegex(RuntimeError, '^diagnostic retention already attempted$'):
                value.retain_and_close('outer')
        self.assertEqual(calls, ['stop'])
        self.assertEqual(events, [])
        self.assert_consumed(value, pins, fake)

    def test_actual_stop_uses_original_single_join_bound_with_inert_thread(self):
        value = owner(); calls = []
        value.samples = [None] * diagnostics.MAX_SAMPLES  # No final capture needed.
        value.done = SimpleNamespace(set=lambda: calls.append('set'))
        value.thread = Thread()
        value.thread.join = lambda **kwargs: calls.append(('join', kwargs))
        with injected(value) as (fake, _, _):
            value.stop = diagnostics.SparseDiagnostics.stop.__get__(value)
            value.retain_and_close('private-fixture')
        self.assertEqual(calls, ['set', ('join', {'timeout': 1})])
        self.assertEqual(fake.closed, [100])

    def test_actual_stop_early_return_does_not_override_alive_or_unstarted_refusal(self):
        for thread in (Thread(alive=True), Thread(ident=None)):
            value = owner(thread); value.stopped = True; pins = dict(value.processes)
            with injected(value) as (fake, events, _):
                value.stop = diagnostics.SparseDiagnostics.stop.__get__(value)
                with self.assertRaisesRegex(RuntimeError, 'sampler ownership uncertain'):
                    value.retain_and_close('private-fixture')
            self.assert_preserved(value, pins, fake, events)


class SourceOnlyRetentionGuards(unittest.TestCase):
    def test_historical_diagnostic_call_has_original_worker_refusal_before_retention(self):
        source = (Path(__file__).parent / 'controlled_supervisor.py').read_text()
        tree = ast.parse(source)
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'observe')
        matches = []
        for node in ast.walk(fn):
            if isinstance(node, ast.Try) and len(node.body) > 1:
                first, second = node.body[:2]
                if isinstance(first, ast.Try) and isinstance(second, ast.Assign) and isinstance(second.value, ast.Call):
                    if isinstance(second.value.func, ast.Attribute) and second.value.func.attr == 'retain_and_close':
                        matches.append(first)
        self.assertEqual(len(matches), 1)
        expected = ast.parse("""try:
    require(worker.ident is not None and worker.is_alive() is False,
            'diagnostic control-worker ownership uncertain')
except BaseException:
    raise RuntimeError('diagnostic control-worker ownership uncertain') from None
""").body[0]
        self.assertEqual(ast.dump(matches[0]), ast.dump(expected))

    def test_all_four_first_executable_launch_refusals_remain_exact(self):
        for file, names in (('controlled_supervisor.py', ('observe', 'bootstrap')),
                            ('controlled_observation.py', ('observe_new', 'diagnose_bootstrap'))):
            tree = ast.parse((Path(__file__).parent / file).read_text())
            for name in names:
                fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
                body = fn.body[1:] if ast.get_docstring(fn) is not None else fn.body
                self.assertEqual(ast.dump(body[0]), ast.dump(ast.parse(
                    "raise RuntimeError('non-live preparation: observer launch disabled')").body[0]))


if __name__ == '__main__':
    unittest.main()
