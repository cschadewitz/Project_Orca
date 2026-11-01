"""Actual finite cleanup helper under inert OS/owner injection; AST integration."""
import ast
import pickle
from pathlib import Path
import unittest
from unittest.mock import patch

import controlled_supervisor as supervisor
from test_diagnostic_rollback import FakeOS, PrivateError
from test_sparse_rollback import InertPin


class FalsePrivateError(PrivateError):
    def __bool__(self):
        raise AssertionError('private exception truthiness')


class CleanupFailureControls(unittest.TestCase):
    def test_pair_and_final_group_attempt_every_nonempty_slot_in_order(self):
        for numbers in ((10, 11), (0, 11, None, None, 14, 15, 16, 17)):
            fake, owner = FakeOS(), InertPin()
            failure = supervisor.AttemptCleanupFailures()
            with patch.object(supervisor, 'os', fake):
                self.assertIsNone(failure.close_transferred(numbers, owner))
            self.assertEqual(fake.closed, [n for n in numbers if n is not None])
            self.assertEqual(owner.closes, 1)
            self.assertFalse(failure.failed())
            self.assertIsNone(failure.raise_first())

    def test_each_fd_and_owner_failure_still_attempts_remaining_cleanup(self):
        numbers = tuple(range(8))
        for position in range(9):
            fake, original = FakeOS(), FalsePrivateError()
            owner = InertPin(original if position == 8 else None)
            if position < 8:
                fake.close_failures[position] = original
            failure = supervisor.AttemptCleanupFailures()
            with patch.object(supervisor, 'os', fake):
                failure.close_transferred(numbers, owner)
            self.assertEqual(fake.closed, list(numbers))
            self.assertEqual(owner.closes, 1)
            self.assertTrue(failure.failed())
            with self.assertRaises(FalsePrivateError) as caught:
                failure.raise_first()
            self.assertIs(caught.exception, original)
            self.assertTrue(caught.exception.__suppress_context__)

    def test_combined_disposal_errors_keep_first_exact_error(self):
        fake = FakeOS(); errors = [PrivateError() for _ in range(9)]
        fake.close_failures = dict(enumerate(errors[:8])); owner = InertPin(errors[8])
        failure = supervisor.AttemptCleanupFailures()
        with patch.object(supervisor, 'os', fake):
            failure.close_transferred(tuple(range(8)), owner)
        self.assertEqual(fake.closed, list(range(8)))
        self.assertEqual(owner.closes, 1)
        self.assertIs(failure._cleanup, errors[0])

    def test_body_error_wins_over_prior_and_later_cleanup_errors(self):
        primary, earlier, later = FalsePrivateError(), FalsePrivateError(), FalsePrivateError()
        failure = supervisor.AttemptCleanupFailures()
        failure.cleanup_failed(earlier)
        failure.body_failed(primary)
        failure.cleanup_failed(later)
        failure.body_failed(later)
        with self.assertRaises(FalsePrivateError) as caught:
            failure.raise_first()
        self.assertIs(caught.exception, primary)
        self.assertIs(failure._cleanup, earlier)

    def test_finalization_errors_do_not_replace_prior_disposal_error(self):
        first, diagnostic, metadata = PrivateError(), PrivateError(), PrivateError()
        failure = supervisor.AttemptCleanupFailures()
        failure.cleanup_failed(first)
        failure.cleanup_failed(diagnostic)
        failure.cleanup_failed(metadata)
        with self.assertRaises(PrivateError) as caught:
            failure.raise_first()
        self.assertIs(caught.exception, first)

    def test_first_diagnostic_or_metadata_error_is_retained_when_no_prior_error(self):
        for original in (PrivateError(), FalsePrivateError()):
            failure = supervisor.AttemptCleanupFailures()
            failure.cleanup_failed(original)
            with self.assertRaises(type(original)) as caught:
                failure.raise_first()
            self.assertIs(caught.exception, original)

    def test_raise_body_does_not_raise_cleanup_when_worker_refusal_must_win(self):
        failure = supervisor.AttemptCleanupFailures()
        failure.cleanup_failed(PrivateError())
        self.assertIsNone(failure.raise_body())
        original = PrivateError(); failure.body_failed(original)
        with self.assertRaises(PrivateError) as caught:
            failure.raise_body()
        self.assertIs(caught.exception, original)

    def test_normal_pair_failure_then_final_group_never_retries_consumed_writers(self):
        for failed in (10, 11):
            fake, original = FakeOS(), PrivateError()
            fake.close_failures[failed] = original
            failure = supervisor.AttemptCleanupFailures()
            with patch.object(supervisor, 'os', fake):
                failure.close_transferred((10, 11))
                with self.assertRaises(PrivateError) as caught:
                    failure.raise_first()
                failure.body_failed(caught.exception)
                # Normal writer slots were consumed; the source correspondence
                # test below separately verifies the actual historical transfer.
                failure.close_transferred((20, 21, None, None, 24, 25, 26, 27))
            self.assertEqual(fake.closed, [10, 11, 20, 21, 24, 25, 26, 27])
            self.assertEqual(fake.closed.count(10), 1)
            self.assertEqual(fake.closed.count(11), 1)
            with self.assertRaises(PrivateError) as final:
                failure.raise_first()
            self.assertIs(final.exception, original)

    def test_invalid_or_unbounded_groups_are_rejected_without_disposal(self):
        fake, owner = FakeOS(), InertPin()
        for numbers in ([], [1, 2], (), (1,), tuple(range(9)), iter((1, 2))):
            with patch.object(supervisor, 'os', fake):
                with self.assertRaisesRegex(RuntimeError, '^invalid transferred cleanup group$'):
                    supervisor.AttemptCleanupFailures().close_transferred(numbers, owner)
        self.assertEqual(fake.closed, [])
        self.assertEqual(owner.closes, 0)

    def test_repr_and_pickle_do_not_format_or_serialize_private_errors(self):
        failure = supervisor.AttemptCleanupFailures()
        failure.body_failed(PrivateError())
        failure.cleanup_failed(PrivateError())
        self.assertEqual(repr(failure), '<AttemptCleanupFailures: private contents omitted>')
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with self.assertRaisesRegex(TypeError, '^private cleanup failure serialization disabled$'):
                pickle.dumps(failure, protocol=protocol)


class SourceOnlyTransferControls(unittest.TestCase):
    def source(self):
        tree = ast.parse((Path(__file__).parent / 'controlled_supervisor.py').read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'observe')
        attempt = [n for n in fn.body if isinstance(n, ast.Try) and n.finalbody][-1]
        return fn, attempt

    def assert_sequence(self, statements, code):
        expected = [ast.dump(n) for n in ast.parse(code).body]
        actual = [ast.dump(n) for n in statements]
        self.assertTrue(any(actual[i:i + len(expected)] == expected
                            for i in range(len(actual) - len(expected) + 1)))

    def test_normal_output_slots_are_cleared_before_pair_disposal(self):
        _, attempt = self.source()
        self.assert_sequence(attempt.body, """writer_handles = (out_write, err_write)
out_write = err_write = None
cleanup.close_transferred(writer_handles)
cleanup.raise_first()
""")
        calls = [ast.unparse(n) for n in ast.walk(attempt) if isinstance(n, ast.Call)]
        self.assertNotIn('os.close(out_write)', calls)
        self.assertNotIn('os.close(err_write)', calls)

    def test_final_owner_slots_are_cleared_before_bounded_helper_and_diagnostics(self):
        _, attempt = self.source(); final = attempt.finalbody
        self.assert_sequence(final[2:], """final_handles = (out_read, err_read, out_write, err_write, command, ack, receive, lifetime)
final_provenance = provenance
out_read = err_read = out_write = err_write = command = ack = receive = lifetime = None
provenance = None
cleanup.close_transferred(final_handles, final_provenance)
""")
        helper = next(i for i, n in enumerate(final) if isinstance(n, ast.Expr)
                      and ast.unparse(n.value) == 'cleanup.close_transferred(final_handles, final_provenance)')
        self.assertIsInstance(final[helper + 1], ast.If)
        self.assertEqual(ast.unparse(final[helper + 1].test), 'diagnostics is not None')
        self.assertEqual([ast.dump(n) for n in final[-2:]], [ast.dump(n) for n in ast.parse(
            'cleanup.raise_first()\nrun.closed = True').body])

    def test_body_capture_precedes_fixed_refusal_without_exception_formatting(self):
        _, attempt = self.source()
        self.assertEqual(len(attempt.handlers), 1)
        self.assertEqual([ast.dump(n) for n in attempt.handlers[0].body], [ast.dump(n) for n in ast.parse(
            "cleanup.body_failed(error)\nreport['refusal'] = 'supervisor original attempt refused'").body])

    def test_final_diagnostic_and_metadata_errors_enter_only_cleanup_slot(self):
        _, attempt = self.source()
        final_tree = ast.Module(body=attempt.finalbody, type_ignores=[])
        calls = [ast.unparse(n.func) for n in ast.walk(final_tree) if isinstance(n, ast.Call)]
        self.assertNotIn('cleanup.body_failed', calls)
        self.assertEqual(calls.count('cleanup.cleanup_failed'), 2)
        self.assertNotIn('str', calls)
        self.assertNotIn('repr', calls)


if __name__ == '__main__':
    unittest.main()
