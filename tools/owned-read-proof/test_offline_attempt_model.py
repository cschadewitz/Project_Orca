"""Inert fault injection only; no historical body, OS resource or process runs."""
import ast
import json
from pathlib import Path
import pickle
import unittest
from unittest.mock import Mock, patch

from offline_attempt_model import InertAttempt, InertEndpoint, PrivateFirstFailure, PAIR_COUNT


class SecretError(BaseException):
    def __str__(self):
        raise AssertionError('private error string conversion')

    def __repr__(self):
        raise AssertionError('private error representation')


class FirstFailureControls(unittest.TestCase):
    def test_original_exception_identity_survives_later_failures(self):
        holder, first = PrivateFirstFailure(), SecretError('PRIVATE')
        holder.capture('acquisition', first)
        holder.capture('body', SecretError('LATER'))
        holder.capture('cleanup', SecretError('CLEANUP'))
        self.assertIs(holder.original_error(), first)
        self.assertNotIn('PRIVATE', repr(holder) + json.dumps(holder.public_report()))
        self.assertFalse(holder.public_report()['privateEvidencePersisted'])

    def test_holder_refuses_serialization_and_unknown_phases(self):
        holder = PrivateFirstFailure()
        holder.capture('body', SecretError('PRIVATE'))
        with self.assertRaisesRegex(TypeError, 'serialization disabled'):
            pickle.dumps(holder)
        for phase, error in ((SecretError(), SecretError()), ('PRIVATE', SecretError()), ('body', object())):
            with self.assertRaises(ValueError):
                holder.capture(phase, error)
        self.assertEqual(set(holder.public_report()), {'record', 'authority', 'failurePresent',
                                                     'privateEvidencePersisted', 'observationAuthorized'})


class InertOwnershipControls(unittest.TestCase):
    def test_registration_failure_precedes_any_endpoint_creation(self):
        error = SecretError()
        class RefusingList(list):
            def append(self, item):
                raise error
        model = InertAttempt()
        model._scope._items = RefusingList()
        with patch.object(model, '_create_pair', side_effect=AssertionError('factory must not run')) as factory:
            with self.assertRaises(SecretError) as caught:
                model.acquire_pair()
            self.assertIs(caught.exception, error)
            factory.assert_not_called()
        self.assertIs(model.private_first_error(), error)
        self.assertEqual(model.close()['status'], 'uncertain')

    def test_each_partial_adoption_keeps_entire_pair_owned(self):
        for fail_at in (0, 1):
            model, created, original = InertAttempt(), [], SecretError()
            def make():
                endpoint = InertEndpoint(); created.append(endpoint)
                return endpoint
            calls = []
            def adopt(endpoint):
                calls.append(endpoint)
                if len(calls) == fail_at + 1:
                    raise original
                return endpoint
            with patch.object(model, '_new_endpoint', side_effect=make), \
                 patch.object(model, '_adopt_endpoint', side_effect=adopt):
                with self.assertRaises(SecretError) as caught:
                    model.acquire_pair()
            self.assertIs(caught.exception, original)
            self.assertEqual(len(created), 2)
            self.assertEqual(model.close()['status'], 'uncertain')
            self.assertEqual([e.attempts for e in created], [1, 1])
            self.assertIs(model.private_first_error(), original)

    def test_unreturned_partial_factory_rolls_back_without_replacing_error(self):
        model, first, original = InertAttempt(), InertEndpoint(), SecretError('ACQUIRE')
        first.failure = SecretError('CLEANUP')
        with patch.object(model, '_new_endpoint', side_effect=[first, original]):
            with self.assertRaises(SecretError) as caught:
                model.acquire_pair()
        self.assertIs(caught.exception, original)
        self.assertIs(model.private_first_error(), original)
        self.assertEqual(first.attempts, 1)
        self.assertEqual(model.close()['status'], 'uncertain')
        self.assertEqual(first.attempts, 1)

    def test_each_pair_and_endpoint_disposal_failure_still_attempts_all(self):
        for pair_index in range(PAIR_COUNT):
            for endpoint_index in (0, 1):
                model = InertAttempt()
                pairs = [model.acquire_pair() for _ in range(PAIR_COUNT)]
                original = SecretError()
                pairs[pair_index][endpoint_index].failure = original
                result = model.close()
                self.assertEqual(result['status'], 'uncertain')
                self.assertIs(model.private_first_error(), original)
                self.assertEqual([e.attempts for pair in pairs for e in pair], [1] * 8)
                self.assertEqual(model.close(), result)
                self.assertEqual([e.attempts for pair in pairs for e in pair], [1] * 8)

    def test_reverse_order_and_first_cleanup_failure_are_retained(self):
        model = InertAttempt()
        pairs = [model.acquire_pair() for _ in range(2)]
        expected = list(reversed([e for pair in pairs for e in pair]))
        for endpoint in expected:
            endpoint.failure = SecretError()
        order = []
        original_dispose = model._dispose_endpoint
        def dispose(endpoint):
            order.append(endpoint)
            original_dispose(endpoint)
        with patch.object(model, '_dispose_endpoint', side_effect=dispose):
            model.close()
        self.assertEqual(order, expected)
        self.assertIs(model.private_first_error(), expected[0].failure)

    def test_body_error_survives_cleanup_errors_without_conversion(self):
        model, original = InertAttempt(), SecretError('BODY')
        with self.assertRaises(SecretError) as caught:
            with model:
                pair = model.acquire_pair()
                pair[0].failure = SecretError('CLEANUP')
                raise original
        self.assertIs(caught.exception, original)
        self.assertIs(model.private_first_error(), original)
        self.assertEqual([e.attempts for e in pair], [1, 1])
        self.assertNotIn('BODY', json.dumps(model.close()))

    def test_cleanup_only_failure_prevents_apparent_context_success(self):
        model = InertAttempt()
        with self.assertRaisesRegex(RuntimeError, 'inert attempt uncertain'):
            with model:
                model.acquire_pair()[1].failure = SecretError()
        self.assertEqual(model.close()['status'], 'uncertain')

    def test_one_consumed_endpoint_is_never_retried_during_pair_cleanup(self):
        model = InertAttempt()
        pair = model.acquire_pair()
        model._dispose_endpoint(pair[0])
        model.close()
        self.assertEqual([e.attempts for e in pair], [1, 1])

    def test_bound_closed_and_failed_model_never_create_more_endpoints(self):
        for state in ('bound', 'closed', 'failed'):
            model = InertAttempt()
            if state == 'bound':
                for _ in range(PAIR_COUNT):
                    model.acquire_pair()
            elif state == 'closed':
                model.close()
            else:
                model.capture_body_failure(SecretError())
            with patch.object(model, '_create_pair', new=Mock(side_effect=AssertionError('must not create'))) as factory:
                with self.assertRaisesRegex(RuntimeError, 'inert acquisition unavailable'):
                    model.acquire_pair()
                factory.assert_not_called()
            result = model.close()
            if state != 'closed':
                self.assertEqual(result['status'], 'uncertain')

    def test_public_results_have_no_authority_even_without_failures(self):
        model = InertAttempt(); model.acquire_pair()
        result = model.close()
        self.assertEqual(result['status'], 'model-callbacks-returned')
        self.assertEqual(result['authority'], 'none')
        for field in ('processSettlementVerified', 'privateEvidencePersisted', 'observationAuthorized'):
            self.assertFalse(result[field])
        result['observationAuthorized'] = True
        self.assertFalse(model.close()['observationAuthorized'])

    def test_model_has_no_live_imports_or_observer_integration(self):
        root = Path(__file__).parent
        tree = ast.parse((root / 'offline_attempt_model.py').read_text())
        imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]
        self.assertEqual(len(imports), 1)
        self.assertIsInstance(imports[0], ast.ImportFrom)
        self.assertEqual(imports[0].module, 'offline_cleanup')
        for name in ('controlled_supervisor.py', 'controlled_observation.py'):
            self.assertNotIn('offline_attempt_model', (root / name).read_text())


if __name__ == '__main__':
    unittest.main()
