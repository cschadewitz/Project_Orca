"""Injected ownership failures and pure projections; no historical launcher runs."""
import ast
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from offline_cleanup import CleanupScope, MAX_RESOURCES
from controlled_observation import public_summary, public_checkpoint, safe_summary
from controlled_supervisor import LIMIT, RUN_NS


class PrivateError(RuntimeError):
    def __str__(self):
        raise AssertionError('private exception string conversion')

    def __repr__(self):
        raise AssertionError('private exception representation')


class CleanupControls(unittest.TestCase):
    def test_reverse_order_once_and_stable_terminal_outcome(self):
        scope, released = CleanupScope(), []
        for value in range(3):
            self.assertEqual(scope.acquire(lambda: value, released.append), value)
        outcome = scope.close()
        self.assertEqual(released, [2, 1, 0])
        self.assertEqual((outcome.status, outcome.attempted, outcome.failed), ('callbacks-returned', 3, 0))
        self.assertIs(scope.close(), outcome)
        self.assertEqual(released, [2, 1, 0])
        self.assertEqual(outcome.report()['authority'], 'none')
        self.assertFalse(outcome.report()['processSettlementVerified'])

    def test_failure_at_each_acquisition_releases_only_returned_resources(self):
        for fail_at in range(4):
            scope, released = CleanupScope(), []
            original = PrivateError()
            with self.subTest(fail_at=fail_at):
                try:
                    with scope:
                        for index in range(4):
                            def acquire():
                                if index == fail_at:
                                    raise original
                                return index
                            scope.acquire(acquire, released.append)
                except PrivateError as error:
                    self.assertIs(error, original)
                else:
                    self.fail('acquisition failure was suppressed')
                self.assertEqual(released, list(reversed(range(fail_at))))
                self.assertEqual(scope.close().status, 'uncertain')

    def test_every_cleanup_attempted_despite_multiple_failures(self):
        scope, released = CleanupScope(), []
        def dispose(value):
            released.append(value)
            if value in (0, 2):
                raise PrivateError()
        for value in range(4):
            scope.acquire(lambda: value, dispose)
        result = scope.close()
        self.assertEqual(released, [3, 2, 1, 0])
        self.assertEqual((result.status, result.attempted, result.failed), ('uncertain', 4, 2))
        self.assertIs(scope.close(), result)
        self.assertEqual(len(released), 4)

    def test_reused_numeric_handle_is_never_retried(self):
        scope, released, now_owned_elsewhere = CleanupScope(), [], set()
        def dispose(number):
            released.append(number)
            now_owned_elsewhere.add(number)
            raise PrivateError()
        scope.acquire(lambda: 7, dispose)
        result = scope.close()
        self.assertIs(scope.close(), result)
        self.assertEqual(released, [7])
        self.assertEqual(now_owned_elsewhere, {7})

    def test_non_none_cleanup_flags_cannot_claim_success(self):
        for value in (True, False, 0, 'ok'):
            scope = CleanupScope()
            scope.acquire(lambda: object(), lambda _: value)
            with self.subTest(type=type(value).__name__):
                self.assertEqual(scope.close().status, 'uncertain')

    def test_cleanup_uncertainty_prevents_returning_apparent_success(self):
        def attempt():
            with CleanupScope() as scope:
                scope.acquire(lambda: object(), lambda _: True)
                return 'apparent success'
        with self.assertRaisesRegex(RuntimeError, '^offline cleanup uncertain$'):
            attempt()

    def test_body_failure_is_preserved_when_cleanup_also_fails(self):
        original = PrivateError()
        scope = CleanupScope()
        try:
            with scope:
                scope.acquire(lambda: object(), lambda _: True)
                raise original
        except PrivateError as error:
            self.assertIs(error, original)
        else:
            self.fail('original body failure replaced or suppressed')
        self.assertEqual(scope.close().status, 'uncertain')

    def test_reentrant_close_or_acquisition_cannot_manufacture_success(self):
        for operation in ('close', 'acquire'):
            scope, released = CleanupScope(), []
            factory = Mock(side_effect=AssertionError('must not acquire during cleanup'))
            def dispose(value):
                released.append(value)
                try:
                    scope.close() if operation == 'close' else scope.acquire(factory, lambda _: None)
                except RuntimeError:
                    pass
            scope.acquire(lambda: 1, dispose)
            with self.subTest(operation=operation):
                self.assertEqual(scope.close().status, 'uncertain')
                self.assertEqual(released, [1])
                factory.assert_not_called()

    def test_close_during_factory_refuses_but_returned_resource_is_owned(self):
        scope, released = CleanupScope(), []
        def factory():
            with self.assertRaisesRegex(RuntimeError, 'scope unavailable'):
                scope.close()
            return 'returned resource'
        scope.acquire(factory, released.append)
        self.assertEqual(scope.close().status, 'uncertain')
        self.assertEqual(released, ['returned resource'])

    def test_closed_scope_and_resource_bound_refuse_before_factory(self):
        scope = CleanupScope()
        for value in range(MAX_RESOURCES):
            scope.acquire(lambda: value, lambda _: None)
        extra = Mock(side_effect=AssertionError('bound must precede factory'))
        with self.assertRaisesRegex(RuntimeError, 'scope unavailable'):
            scope.acquire(extra, lambda _: None)
        result = scope.close()
        with self.assertRaisesRegex(RuntimeError, 'scope unavailable'):
            scope.acquire(extra, lambda _: None)
        self.assertIs(scope.close(), result)
        extra.assert_not_called()

    def test_registration_allocation_precedes_factory(self):
        class RefusingList(list):
            def append(self, value):
                raise MemoryError('synthetic registration failure')
        scope = CleanupScope()
        scope._items = RefusingList()
        factory = Mock(side_effect=AssertionError('no resource before registration'))
        with self.assertRaises(MemoryError):
            scope.acquire(factory, lambda _: None)
        factory.assert_not_called()
        self.assertEqual(scope.close().status, 'uncertain')


class PrivacyControls(unittest.TestCase):
    def test_formerly_copied_strings_and_nested_secrets_never_escape(self):
        secret = 'PRIVATE_TOKEN_AND_PAYLOAD'
        fields = ('record', 'sourceHead', 'traceSha256', 'imageProducerSha256', 'imageChildSha256',
                  'imageBuildSha256', 'reportSha256', 'refusal', 'producerStderr', 'root',
                  'observerImplementation', 'diagnosticRefusal')
        private = dict.fromkeys(fields, secret)
        private['diagnostic'] = {'config': secret, 'errors': [PrivateError()], 'nested': {'payload': secret}}
        private['phaseLog'] = [{'token': 'a' * 64}]
        private['imageProducerSha256'] = 'a' * 64
        result = public_summary(private)
        encoded = json.dumps(result)
        self.assertNotIn(secret, encoded)
        self.assertNotIn('a' * 64, encoded)
        self.assertEqual(result['refusal'], 'observation-refused')
        self.assertEqual(private['refusal'], secret)
        self.assertIsInstance(private['diagnostic']['errors'][0], PrivateError)

    def test_exception_objects_and_unknown_deep_values_are_not_traversed(self):
        error = PrivateError()
        cycle = {}; cycle['self'] = cycle
        private = {'refusal': error, 'diagnostic': cycle, 'unknown': error}
        result = public_checkpoint({'attempts': [private], 'refusal': error, 'unknown': cycle})
        json.dumps(result)
        self.assertEqual(result['refusal'], 'observation-refused')
        self.assertIs(private['refusal'], error)

    def test_only_exact_bounded_numeric_fields_are_projected(self):
        bounds = {'traceBytes': (0, LIMIT), 'elapsedNanoseconds': (0, RUN_NS), 'returncode': (-255, 255)}
        for field, (low, high) in bounds.items():
            for value in (low, high):
                self.assertEqual(public_summary({field: value})[field], value)
            for value in (True, False, low - 1, high + 1, float('nan'), float('inf'), 1.0, 'private'):
                with self.subTest(field=field, type=type(value).__name__):
                    result = public_summary({field: value})
                    self.assertNotIn(field, result)
                    self.assertEqual(result['refusal'], 'summary-field-refused')

    def test_report_flags_and_serialized_success_cannot_supply_authority(self):
        incoming = {'authority': 'execution', 'acceptingToken': 'private', 'productionEligible': True,
                    'observationAuthorized': True, 'connectedCommandsReleased': True, 'success': True}
        for project in (public_summary, public_checkpoint):
            result = project(incoming)
            self.assertEqual(result['authority'], 'none')
            self.assertIsNone(result['acceptingToken'])
            self.assertFalse(result['productionEligible'])
            self.assertFalse(result['observationAuthorized'])
            self.assertNotIn('connectedCommandsReleased', result)
            self.assertNotIn('success', result)

    def test_checkpoint_bounds_and_unknown_containers_refuse_without_conversion(self):
        for value in (None, PrivateError(), {'attempts': [0, 1, 2]}, {'attempts': PrivateError()}):
            result = public_checkpoint(value)
            self.assertIn('refusal', result)
            self.assertEqual(result['attempts'], [])
        result = public_checkpoint({'attempts': [{'refusal': PrivateError()}, {'traceBytes': LIMIT}]})
        self.assertEqual(len(result['attempts']), 2)
        self.assertNotIn('attempts', result['attempts'][0])

    def test_safe_summary_does_no_file_replay_or_launch_work(self):
        class Run:
            report = {'refusal': PrivateError()}
            def __getattr__(self, name):
                raise AssertionError('private runtime/file property accessed')
        with patch('builtins.open', side_effect=AssertionError('unexpected file access')), \
             patch('controlled_observation.subprocess.run', side_effect=AssertionError('unexpected process')):
            result = safe_summary(Run(), PrivateError())
        self.assertEqual(result['refusal'], 'observation-refused')

    def test_all_four_first_executable_refusals_remain_and_checkpoints_project(self):
        directory = Path(__file__).parent
        for filename, functions in (('controlled_supervisor.py', ('observe', 'bootstrap')),
                                    ('controlled_observation.py', ('observe_new', 'diagnose_bootstrap'))):
            tree = ast.parse((directory / filename).read_text())
            found = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in functions}
            self.assertEqual(set(found), set(functions))
            for function in found.values():
                body = function.body
                if isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                    body = body[1:]
                self.assertIsInstance(body[0], ast.Raise)
                self.assertEqual(ast.literal_eval(body[0].exc.args[0]), 'non-live preparation: observer launch disabled')
                if filename == 'controlled_observation.py':
                    self.assertTrue(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and
                                        n.func.id == 'public_checkpoint' for n in ast.walk(function)))
                    self.assertIsInstance(body[-1], ast.Return)
                    self.assertEqual(body[-1].value.id, 'public')


if __name__ == '__main__':
    unittest.main()
