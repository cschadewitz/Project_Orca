"""Worker error bookkeeping under inert OS injection; historical AST only."""
import ast
from pathlib import Path
import unittest
from unittest.mock import patch

import controlled_supervisor as supervisor
from test_attempt_cleanup import FalsePrivateError
from test_diagnostic_rollback import FakeOS
from test_finalizer_worker_guard import ForbiddenAdapter


class WorkerErrorControls(unittest.TestCase):
    def close(self, failures, fake, number):
        with patch.object(supervisor, 'os', fake), \
             patch.object(supervisor, 'threading', ForbiddenAdapter()), \
             patch.object(supervisor, 'run_traced', side_effect=AssertionError('tracer forbidden')):
            self.assertIsNone(failures.close_worker_send(number))

    def assert_first(self, failures, original):
        with self.assertRaises(type(original)) as caught:
            failures.raise_first()
        self.assertIs(caught.exception, original)
        self.assertTrue(caught.exception.__suppress_context__)

    def test_one_close_for_original_send_including_zero(self):
        for number in (0, 17):
            failures, fake = supervisor.AttemptCleanupFailures(), FakeOS()
            self.close(failures, fake, number)
            self.assertEqual(fake.closed, [number])
            self.assertFalse(failures.failed())

    def test_absent_consumed_slot_does_not_close(self):
        failures, fake = supervisor.AttemptCleanupFailures(), FakeOS()
        self.close(failures, fake, None)
        self.assertEqual(fake.closed, [])
        self.assertFalse(failures.failed())

    def test_close_only_failure_prevents_apparent_success_without_formatting(self):
        failures, fake, original = supervisor.AttemptCleanupFailures(), FakeOS(), FalsePrivateError()
        fake.close_failures[17] = original
        self.close(failures, fake, 17)
        self.assertEqual(fake.closed, [17])
        self.assert_first(failures, original)

    def test_body_error_survives_close_failure_as_same_object(self):
        failures, fake = supervisor.AttemptCleanupFailures(), FakeOS()
        body, close = FalsePrivateError(), FalsePrivateError()
        failures.body_failed(body); fake.close_failures[17] = close
        self.close(failures, fake, 17)
        self.assertEqual(fake.closed, [17])
        self.assertIs(failures._cleanup, close)
        self.assert_first(failures, body)

    def test_consumed_source_slot_does_not_retry_failed_numeric_handle(self):
        failures, fake, original = supervisor.AttemptCleanupFailures(), FakeOS(), FalsePrivateError()
        fake.close_failures[17] = original
        send = 17
        # Inert ownership bookkeeping only; actual source transfer is AST-checked.
        transferred, send = send, None
        self.close(failures, fake, transferred)
        self.close(failures, fake, send)
        self.assertEqual(fake.closed, [17])
        self.assert_first(failures, original)

    def test_close_baseexception_is_private_and_first_cleanup_stays_sticky(self):
        for original in (KeyboardInterrupt(), SystemExit(1), GeneratorExit()):
            failures, fake = supervisor.AttemptCleanupFailures(), FakeOS()
            fake.close_failures[17] = original
            self.close(failures, fake, 17)
            failures.cleanup_failed(FalsePrivateError())
            self.assertEqual(fake.closed, [17])
            self.assert_first(failures, original)


class WorkerSourceControls(unittest.TestCase):
    def source(self):
        tree = ast.parse((Path(__file__).parent / 'controlled_supervisor.py').read_text())
        fn = next(n for n in tree.body if getattr(n, 'name', None) == 'observe')
        control = next(n for n in fn.body if getattr(n, 'name', None) == 'control')
        attempt = [n for n in fn.body if isinstance(n, ast.Try) and n.finalbody][-1]
        return fn, control, attempt

    def test_worker_handler_captures_original_without_formatting_or_main_holder(self):
        _, control, _ = self.source()
        body = next(n for n in control.body if isinstance(n, ast.Try))
        self.assertEqual(len(body.handlers), 1)
        self.assertEqual(ast.unparse(body.handlers[0].type), 'BaseException')
        self.assertEqual(body.handlers[0].name, 'error')
        self.assertEqual([ast.dump(n) for n in body.handlers[0].body],
                         [ast.dump(n) for n in ast.parse('worker_failures.body_failed(error)').body])
        calls = [ast.unparse(n.func) for n in ast.walk(control) if isinstance(n, ast.Call)]
        self.assertNotIn('repr', calls)
        self.assertNotIn('str', calls)
        self.assertFalse(any(name.startswith('cleanup.') for name in calls))

    def test_worker_consumes_send_before_single_final_close(self):
        _, control, _ = self.source()
        self.assertIsInstance(control.body[0], ast.Nonlocal)
        self.assertEqual(control.body[0].names, ['send'])
        final = next(n.finalbody for n in control.body if isinstance(n, ast.Try))
        self.assertEqual([ast.dump(n) for n in final], [ast.dump(n) for n in ast.parse(
            'worker_send = send\nsend = None\nworker_failures.close_worker_send(worker_send)').body])

    def test_both_main_reads_follow_original_join_and_inactivity_gate(self):
        _, _, attempt = self.source()
        indexes = [i for i,n in enumerate(attempt.body) if isinstance(n, ast.Expr)
                   and ast.unparse(n.value) == 'worker_failures.raise_first()']
        self.assertEqual(len(indexes), 2)
        expected = ast.parse('worker.join(timeout=1)\nrequire_control_worker_inactive(worker)\nworker_failures.raise_first()').body
        for i in indexes:
            self.assertEqual([ast.dump(n) for n in attempt.body[i-2:i+1]], [ast.dump(n) for n in expected])
        final = ast.Module(body=attempt.finalbody, type_ignores=[])
        self.assertNotIn('worker_failures', [n.id for n in ast.walk(final) if isinstance(n, ast.Name)])

    def test_separate_private_holder_exists_before_control_and_worker_start(self):
        fn, control, _ = self.source()
        init = next(i for i,n in enumerate(fn.body) if isinstance(n, ast.Assign)
                    and ast.unparse(n) == 'worker_failures = AttemptCleanupFailures()')
        self.assertLess(init, fn.body.index(control))
        self.assertNotIn('errors', [n.id for n in ast.walk(fn) if isinstance(n, ast.Name)])
        self.assertNotIn('worker_failures', ast.unparse(next(n for n in fn.body if isinstance(n, ast.Assign)
                         and any(isinstance(t, ast.Name) and t.id == 'report' for t in n.targets))))

    def test_main_final_group_does_not_adopt_worker_send(self):
        _, _, attempt = self.source()
        transfer = next(n for n in attempt.finalbody if isinstance(n, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == 'final_handles' for t in n.targets))
        self.assertEqual(ast.unparse(transfer.value),
                         '(out_read, err_read, out_write, err_write, command, ack, receive, lifetime)')


if __name__ == '__main__':
    unittest.main()
