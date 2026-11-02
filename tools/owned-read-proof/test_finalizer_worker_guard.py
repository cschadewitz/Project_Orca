"""Inert check-only worker tests and source-only finalizer ordering inspection."""
import ast
from pathlib import Path
import unittest
from unittest.mock import patch

import controlled_supervisor as supervisor
from test_diagnostic_rollback import PrivateError


class InertWorker:
    def __init__(self, ident=17, alive=False, identity_error=None, query_error=None):
        self.identity, self.alive = ident, alive
        self.identity_error, self.query_error = identity_error, query_error
        self.calls = []

    @property
    def ident(self):
        self.calls.append('ident')
        if self.identity_error is not None:
            raise self.identity_error
        return self.identity

    def is_alive(self):
        self.calls.append('is_alive')
        if self.query_error is not None:
            raise self.query_error
        return self.alive

    def __getattr__(self, name):
        raise AssertionError('unexpected worker operation: ' + name)


class ForbiddenAdapter:
    def __getattr__(self, name):
        raise AssertionError('unexpected external operation: ' + name)


class WorkerStateControls(unittest.TestCase):
    def check(self, worker):
        with patch.object(supervisor, 'os', ForbiddenAdapter()), \
             patch.object(supervisor, 'threading', ForbiddenAdapter()), \
             patch.object(supervisor, 'run_traced', side_effect=AssertionError('tracer forbidden')):
            return supervisor.require_control_worker_inactive(worker)

    def test_started_nonrunning_worker_returns_no_capability_or_flag(self):
        worker = InertWorker()
        self.assertIsNone(self.check(worker))
        self.assertEqual(worker.calls, ['ident', 'is_alive'])

    def test_missing_or_report_shaped_worker_fixed_refuses(self):
        for worker in (None, False, {'ident': 17, 'is_alive': False, 'closed': True}):
            with self.assertRaisesRegex(RuntimeError, '^control-worker ownership uncertain$') as caught:
                self.check(worker)
            self.assertTrue(caught.exception.__suppress_context__)

    def test_never_started_worker_does_not_query_liveness(self):
        worker = InertWorker(ident=None, query_error=PrivateError())
        with self.assertRaisesRegex(RuntimeError, '^control-worker ownership uncertain$'):
            self.check(worker)
        self.assertEqual(worker.calls, ['ident'])

    def test_alive_and_nonboolean_liveness_refuse(self):
        for alive in (True, 0, 1, None, '', 'false', []):
            worker = InertWorker(alive=alive)
            with self.assertRaisesRegex(RuntimeError, '^control-worker ownership uncertain$'):
                self.check(worker)
            self.assertEqual(worker.calls, ['ident', 'is_alive'])

    def test_identity_failure_is_private_and_never_formatted(self):
        original = PrivateError()
        worker = InertWorker(identity_error=original)
        with self.assertRaisesRegex(RuntimeError, '^control-worker ownership uncertain$') as caught:
            self.check(worker)
        self.assertIs(caught.exception.__context__, original)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertEqual(worker.calls, ['ident'])

    def test_liveness_failure_is_private_and_never_formatted(self):
        original = PrivateError()
        worker = InertWorker(query_error=original)
        with self.assertRaisesRegex(RuntimeError, '^control-worker ownership uncertain$') as caught:
            self.check(worker)
        self.assertIs(caught.exception.__context__, original)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertEqual(worker.calls, ['ident', 'is_alive'])

    def test_each_call_checks_original_object_without_cached_acceptance(self):
        worker = InertWorker()
        self.assertIsNone(self.check(worker))
        worker.alive = True
        with self.assertRaisesRegex(RuntimeError, '^control-worker ownership uncertain$'):
            self.check(worker)
        self.assertEqual(worker.calls, ['ident', 'is_alive', 'ident', 'is_alive'])


class SourceOnlyFinalizerControls(unittest.TestCase):
    def source(self):
        tree = ast.parse((Path(__file__).parent / 'controlled_supervisor.py').read_text())
        return next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'observe')

    def finalizer(self, fn):
        # The last top-level try/finally owns the attempt; earlier setup has its
        # own finally. Its prefix and disposal tail are checked independently.
        matches = [node.finalbody for node in fn.body if isinstance(node, ast.Try) and node.finalbody]
        self.assertTrue(matches)
        return matches[-1]

    def test_finalizer_join_and_refusal_dominate_all_disposal_and_writes(self):
        fn = self.source()
        final = self.finalizer(fn)
        expected = ast.parse("""run.closed = False
try:
    worker.join(timeout=1)
    require_control_worker_inactive(worker)
except BaseException:
    cleanup.raise_body()
    raise RuntimeError('control-worker ownership uncertain') from None
""").body
        self.assertEqual([ast.dump(n) for n in final[:2]], [ast.dump(n) for n in expected])
        # The additional traced-return refusal must follow the worker check and
        # precede ownership transfer. Parse only, never execute this body.
        gate = ast.parse('if not traced_call_returned:\n    cleanup.refuse_unreturned_traced_call()').body[0]
        self.assertEqual(ast.dump(final[2]), ast.dump(gate))
        self.assertIsInstance(final[3], ast.Assign)
        tail_calls = [ast.unparse(node.func) for statement in final[3:]
                      for node in ast.walk(statement) if isinstance(node, ast.Call)]
        for name in ('cleanup.close_transferred', 'diagnostics.retain_and_close',
                     'retained.write_text', 'run.report_path.write_text'):
            self.assertIn(name, tail_calls)

    def test_existing_three_join_calls_keep_original_bound_with_only_one_in_finalizer(self):
        fn = self.source()
        def joins(node):
            return [n for n in ast.walk(node) if isinstance(n, ast.Call)
                    and ast.unparse(n.func) == 'worker.join']
        all_joins = joins(fn)
        self.assertEqual(len(all_joins), 3)
        expected = ast.parse('worker.join(timeout=1)').body[0].value
        self.assertTrue(all(ast.dump(n) == ast.dump(expected) for n in all_joins))
        final = self.finalizer(fn)
        self.assertEqual(sum(len(joins(n)) for n in final), 1)

    def test_worker_owned_send_disposal_stays_in_worker_finally(self):
        fn = self.source()
        control = next(n for n in fn.body if isinstance(n, ast.FunctionDef) and n.name == 'control')
        final = next(n.finalbody for n in control.body if isinstance(n, ast.Try))
        self.assertEqual([ast.dump(n) for n in final], [ast.dump(n) for n in ast.parse(
            'worker_send = send\nsend = None\nworker_failures.close_worker_send(worker_send)').body])


if __name__ == '__main__':
    unittest.main()
