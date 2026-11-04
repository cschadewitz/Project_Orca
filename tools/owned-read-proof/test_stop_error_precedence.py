"""Inert diagnostic-stop error ordering; historical integration is AST only."""
import ast
from pathlib import Path
import unittest
from unittest.mock import patch

import controlled_supervisor as supervisor
from test_attempt_cleanup import FalsePrivateError
from test_finalizer_worker_guard import ForbiddenAdapter


class InertDiagnostics:
    def __init__(self, error=None, result=None):
        self.error, self.result, self.calls = error, result, 0

    def __bool__(self):
        raise AssertionError('diagnostic truthiness forbidden')

    def stop(self):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


class StopErrorControls(unittest.TestCase):
    def stop(self, failures, diagnostics):
        with patch.object(supervisor, 'os', ForbiddenAdapter()), \
             patch.object(supervisor, 'threading', ForbiddenAdapter()), \
             patch.object(supervisor, 'run_traced', side_effect=AssertionError('tracer forbidden')):
            self.assertIsNone(failures.stop_diagnostics(diagnostics))

    def assert_first(self, failures, original):
        with self.assertRaises(type(original)) as caught:
            failures.raise_first()
        self.assertIs(caught.exception, original)
        self.assertTrue(caught.exception.__suppress_context__)

    def test_absent_diagnostics_preserve_body_without_new_failure(self):
        failures = supervisor.AttemptCleanupFailures()
        original = FalsePrivateError(); failures.body_failed(original)
        self.stop(failures, None)
        self.assertIsNone(failures._cleanup)
        self.assert_first(failures, original)

    def test_successful_stop_result_is_not_an_authority_or_settlement_flag(self):
        for result in (None, False, True, {'settled': True}, object()):
            failures, diagnostics = supervisor.AttemptCleanupFailures(), InertDiagnostics(result=result)
            self.stop(failures, diagnostics)
            self.assertEqual(diagnostics.calls, 1)
            self.assertFalse(failures.failed())

    def test_stop_error_alone_is_exact_private_first_error(self):
        original = FalsePrivateError()
        failures, diagnostics = supervisor.AttemptCleanupFailures(), InertDiagnostics(original)
        self.stop(failures, diagnostics)
        self.assertEqual(diagnostics.calls, 1)
        self.assertIsNone(failures._body)
        self.assert_first(failures, original)

    def test_body_error_dominates_stop_error_and_later_cleanup(self):
        original, stop, later = FalsePrivateError(), FalsePrivateError(), FalsePrivateError()
        failures, diagnostics = supervisor.AttemptCleanupFailures(), InertDiagnostics(stop)
        failures.body_failed(original)
        self.stop(failures, diagnostics)
        failures.cleanup_failed(later)
        self.assertEqual(diagnostics.calls, 1)
        self.assertIs(failures._cleanup, stop)
        self.assert_first(failures, original)

    def test_successful_stop_does_not_clear_original_body_error(self):
        original = FalsePrivateError()
        failures, diagnostics = supervisor.AttemptCleanupFailures(), InertDiagnostics()
        failures.body_failed(original)
        self.stop(failures, diagnostics)
        self.assertEqual(diagnostics.calls, 1)
        self.assert_first(failures, original)

    def test_baseexceptions_are_retained_without_skipping_the_stop_attempt(self):
        for original in (KeyboardInterrupt(), SystemExit(1), GeneratorExit()):
            failures, diagnostics = supervisor.AttemptCleanupFailures(), InertDiagnostics(original)
            self.stop(failures, diagnostics)
            self.assertEqual(diagnostics.calls, 1)
            self.assert_first(failures, original)

    def test_existing_cleanup_error_survives_stop_method_lookup_failure(self):
        original, lookup = FalsePrivateError(), FalsePrivateError()
        class LookupFailure:
            @property
            def stop(self):
                raise lookup
        failures = supervisor.AttemptCleanupFailures()
        failures.cleanup_failed(original)
        self.stop(failures, LookupFailure())
        self.assertIsNone(failures._body)
        self.assert_first(failures, original)


class StopSourceControls(unittest.TestCase):
    def source(self):
        tree = ast.parse((Path(__file__).parent / 'controlled_supervisor.py').read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'observe')
        attempt = [n for n in fn.body if isinstance(n, ast.Try) and n.finalbody][-1]
        return fn, attempt, attempt.body[0]

    def test_original_run_call_stays_inside_capture_before_stop(self):
        _, _, inner = self.source()
        self.assertIsInstance(inner, ast.Try)
        self.assertEqual(len(inner.body), 2)
        self.assertEqual(ast.unparse(inner.body[0].value.func), 'run_traced')
        self.assertEqual(ast.dump(inner.body[1]),
                         ast.dump(ast.parse('traced_call_returned = True').body[0]))
        self.assertEqual(len(inner.handlers), 1)
        self.assertEqual(ast.unparse(inner.handlers[0].type), 'BaseException')
        self.assertEqual(inner.handlers[0].name, 'error')
        self.assertEqual([ast.dump(n) for n in inner.handlers[0].body],
                         [ast.dump(n) for n in ast.parse('cleanup.body_failed(error)').body])
        self.assertEqual([ast.dump(n) for n in inner.finalbody],
                         [ast.dump(n) for n in ast.parse('cleanup.stop_diagnostics(diagnostics)').body])
        self.assertEqual(inner.orelse, [])

    def test_first_error_is_raised_before_following_join_and_replay(self):
        _, attempt, _ = self.source()
        self.assertEqual([ast.dump(n) for n in attempt.body[1:3]],
                         [ast.dump(n) for n in ast.parse('cleanup.raise_first()\nworker.join(timeout=1)').body])
        calls = [ast.unparse(n) for n in ast.walk(attempt) if isinstance(n, ast.Call)]
        self.assertEqual(calls.count('cleanup.stop_diagnostics(diagnostics)'), 1)
        self.assertNotIn('diagnostics.stop()', calls)

    def test_entry_refusal_remains_first_executable_statement(self):
        fn, _, _ = self.source()
        self.assertEqual(ast.dump(fn.body[1]), ast.dump(ast.parse(
            "raise RuntimeError('non-live preparation: observer launch disabled')").body[0]))


if __name__ == '__main__':
    unittest.main()
