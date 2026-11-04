"""Actual refusal helper with inert errors; launcher integration inspected as AST only."""
import ast
from pathlib import Path
import unittest
from unittest.mock import patch

import controlled_supervisor as supervisor
from run import OwnedCleanupError


class PrivateFailure(BaseException):
    def __str__(self):
        raise AssertionError('private error string conversion')

    def __repr__(self):
        raise AssertionError('private error representation')

    def __bool__(self):
        raise AssertionError('private error truthiness')


class RefusalControls(unittest.TestCase):
    def test_empty_holder_always_refuses_without_any_side_effect(self):
        failures = supervisor.AttemptCleanupFailures()
        with patch.object(supervisor, 'os') as os_calls, \
             patch.object(supervisor, 'run_traced') as traced:
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, '^original traced-call completion unavailable$'):
                    failures.refuse_unreturned_traced_call()
            self.assertEqual(os_calls.mock_calls, [])
            traced.assert_not_called()
        self.assertFalse(failures.failed())

    def test_all_captured_failures_refuse_and_keep_original_identity(self):
        # These are inert exceptions, not executions of the corresponding runtime
        # paths. Every non-returning traced outcome takes the same source gate.
        for error in (OwnedCleanupError('synthetic unsettled owner'),
                      OSError('synthetic stream or restoration failure'),
                      RuntimeError('synthetic callback failure'),
                      KeyboardInterrupt(), SystemExit(), PrivateFailure()):
            failures = supervisor.AttemptCleanupFailures()
            failures.body_failed(error)
            failures.cleanup_failed(PrivateFailure())
            with patch.object(supervisor, 'os') as os_calls:
                with self.assertRaises(type(error)) as caught:
                    failures.refuse_unreturned_traced_call()
                self.assertIs(caught.exception, error)
                self.assertEqual(os_calls.mock_calls, [])
            with self.assertRaises(type(error)) as repeated:
                failures.raise_first()
            self.assertIs(repeated.exception, error)

    def test_existing_first_cleanup_failure_is_preserved_without_body_failure(self):
        failures, first = supervisor.AttemptCleanupFailures(), PrivateFailure()
        failures.cleanup_failed(first)
        failures.cleanup_failed(RuntimeError('later'))
        with self.assertRaises(PrivateFailure) as caught:
            failures.refuse_unreturned_traced_call()
        self.assertIs(caught.exception, first)

    def test_no_success_argument_or_settlement_input_is_accepted(self):
        failures = supervisor.AttemptCleanupFailures()
        for supplied in (True, False, {'settled': True}, object()):
            with self.assertRaises(TypeError):
                failures.refuse_unreturned_traced_call(supplied)
        with self.assertRaises(RuntimeError):
            failures.refuse_unreturned_traced_call()


class SourceCorrespondence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse(Path(supervisor.__file__).read_text())
        cls.observe = next(n for n in cls.tree.body if isinstance(n, ast.FunctionDef) and n.name == 'observe')
        cls.attempt = [n for n in cls.observe.body if isinstance(n, ast.Try) and n.finalbody][-1]

    def test_marker_is_only_local_initial_false_and_post_call_true(self):
        name = 'traced_call_returned'
        writes = [n for n in ast.walk(self.observe) if isinstance(n, ast.Name)
                  and n.id == name and isinstance(n.ctx, (ast.Store, ast.Del))]
        self.assertEqual(len(writes), 2)
        self.assertNotIn(name, [arg.arg for arg in self.observe.args.args])
        self.assertFalse(any(isinstance(n, (ast.Global, ast.Nonlocal)) and name in n.names
                             for n in ast.walk(self.observe)))
        index = self.observe.body.index(self.attempt)
        self.assertEqual(ast.dump(self.observe.body[index - 1]),
                         ast.dump(ast.parse('traced_call_returned = False').body[0]))
        traced = self.attempt.body[0]
        self.assertIsInstance(traced, ast.Try)
        self.assertEqual(len(traced.body), 2)
        call, marker = traced.body
        self.assertIsInstance(call, ast.Assign)
        self.assertEqual(ast.unparse(call.targets[0]), 'result')
        self.assertEqual(ast.unparse(call.value.func), 'run_traced')
        self.assertEqual(ast.dump(marker), ast.dump(ast.parse('traced_call_returned = True').body[0]))
        self.assertEqual(len(traced.handlers), 1)
        self.assertEqual(ast.unparse(traced.handlers[0].type), 'BaseException')
        self.assertEqual([ast.dump(n) for n in traced.handlers[0].body],
                         [ast.dump(n) for n in ast.parse('cleanup.body_failed(error)').body])
        self.assertEqual([ast.dump(n) for n in traced.finalbody],
                         [ast.dump(n) for n in ast.parse('cleanup.stop_diagnostics(diagnostics)').body])
        self.assertEqual(next(k.value.value for k in call.value.keywords if k.arg == 'timeout'), 60)

    def test_gate_precedes_all_finalizer_transfers_and_retention_after_worker_check(self):
        final = self.attempt.finalbody
        self.assertEqual(ast.unparse(final[0]), 'run.closed = False')
        self.assertIsInstance(final[1], ast.Try)
        self.assertEqual([ast.unparse(n) for n in final[1].body],
                         ['worker.join(timeout=1)', 'require_control_worker_inactive(worker)'])
        expected = ast.parse('if not traced_call_returned:\n    cleanup.refuse_unreturned_traced_call()').body[0]
        self.assertEqual(ast.dump(final[2]), ast.dump(expected))
        self.assertEqual(ast.unparse(final[3]),
                         'final_handles = (out_read, err_read, out_write, err_write, command, ack, receive, lifetime)')
        self.assertEqual(ast.unparse(final[4]), 'final_provenance = provenance')
        self.assertEqual(ast.unparse(final[5]),
                         'out_read = err_read = out_write = err_write = command = ack = receive = lifetime = None')
        self.assertEqual(ast.unparse(final[6]), 'provenance = None')
        self.assertEqual(ast.unparse(final[7]), 'cleanup.close_transferred(final_handles, final_provenance)')
        before = ast.Module(body=final[:3], type_ignores=[])
        calls = [ast.unparse(n.func) for n in ast.walk(before) if isinstance(n, ast.Call)]
        self.assertNotIn('cleanup.close_transferred', calls)
        self.assertNotIn('diagnostics.retain_and_close', calls)
        self.assertEqual(ast.unparse(final[-1]), 'run.closed = True')

    def test_normal_output_disposal_is_after_traced_path_and_first_error_rethrow(self):
        body = self.attempt.body
        self.assertEqual(ast.unparse(body[1]), 'cleanup.raise_first()')
        pair = next(i for i, n in enumerate(body) if isinstance(n, ast.Expr)
                    and ast.unparse(n.value) == 'cleanup.close_transferred(writer_handles)')
        self.assertGreater(pair, 1)
        self.assertEqual(ast.unparse(body[pair - 1]), 'out_write = err_write = None')

    def test_refusal_helper_has_no_success_branch_or_runtime_calls(self):
        owner = next(n for n in self.tree.body if isinstance(n, ast.ClassDef) and n.name == 'AttemptCleanupFailures')
        method = next(n for n in owner.body if isinstance(n, ast.FunctionDef)
                      and n.name == 'refuse_unreturned_traced_call')
        self.assertEqual([arg.arg for arg in method.args.args], ['self'])
        self.assertEqual([ast.dump(n) for n in method.body[1:]], [ast.dump(n) for n in ast.parse(
            "self.raise_first()\nraise RuntimeError('original traced-call completion unavailable') from None").body])

    def test_all_four_launch_entrypoints_still_refuse_first(self):
        for filename, names in (('controlled_supervisor.py', ('observe', 'bootstrap')),
                                ('controlled_observation.py', ('observe_new', 'diagnose_bootstrap'))):
            tree = ast.parse(Path(__file__).with_name(filename).read_text())
            for name in names:
                fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
                body = fn.body
                if isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                    body = body[1:]
                self.assertEqual(ast.dump(body[0]), ast.dump(ast.parse(
                    "raise RuntimeError('non-live preparation: observer launch disabled')").body[0]))


if __name__ == '__main__':
    unittest.main()
