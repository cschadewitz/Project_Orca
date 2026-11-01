"""Sparse owner registration/constructor tests; injected dependencies only."""
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import controlled_diagnostics as diagnostics
from test_diagnostic_rollback import EXPECTED, RAW_STAT, FakeOS, PrivateError, injected_pins


class InertLock:
    def __init__(self, enter_error=None, exit_error=None):
        self.enter_error, self.exit_error = enter_error, exit_error

    def __enter__(self):
        if self.enter_error is not None:
            raise self.enter_error
        return self

    def __exit__(self, *args):
        if self.exit_error is not None:
            raise self.exit_error


class InertPin:
    def __init__(self, cleanup=None):
        self.cleanup, self.closes = cleanup, 0

    def close(self):
        self.closes += 1
        if self.cleanup is not None:
            raise self.cleanup


class FailedInsertion(dict):
    def __init__(self, error, partial):
        super().__init__()
        self.error, self.partial = error, partial

    def __setitem__(self, key, value):
        if self.partial:
            super().__setitem__(key, value)
        raise self.error

    def get(self, *args):
        raise AssertionError('rollback must use internal dict storage')

    def pop(self, *args):
        raise AssertionError('rollback must use internal dict storage')

    def popitem(self):
        raise AssertionError('rollback must use internal dict storage')


def bare_owner():
    owner = diagnostics.SparseDiagnostics.__new__(diagnostics.SparseDiagnostics)
    owner.processes, owner.lock = {}, InertLock()
    owner._first_failure = owner._cleanup_error = None
    return owner


@contextmanager
def construction(owner, fake, lock=None, read_error=None, before_read=None, raw=RAW_STAT):
    paths = []
    def path(value):
        paths.append(value)
        def read_text():
            if before_read is not None:
                before_read()
            if read_error is not None:
                raise read_error
            return raw
        return SimpleNamespace(read_text=read_text)
    inert_threading = SimpleNamespace(Lock=lambda: lock or InertLock(), Event=lambda: object())
    with ExitStack() as stack:
        stack.enter_context(patch.object(diagnostics, 'os', fake))
        stack.enter_context(patch.object(diagnostics, 'Path', side_effect=path))
        stack.enter_context(patch.object(diagnostics, 'threading', inert_threading))
        yield paths


class SparseRollbackControls(unittest.TestCase):
    def test_success_transfers_pin_and_preserves_arguments(self):
        owner, pin = bare_owner(), InertPin()
        with patch.object(diagnostics, 'PinnedProcess', return_value=pin) as factory:
            owner.bind('leader', EXPECTED, 70, 80)
        factory.assert_called_once_with(EXPECTED, 70, 80)
        self.assertIs(owner.processes['leader'], pin)
        self.assertEqual(pin.closes, 0)

    def test_before_and_after_insertion_failures_detach_and_close_once(self):
        for partial in (False, True):
            owner, pin, original = bare_owner(), InertPin(), PrivateError()
            owner.processes = FailedInsertion(original, partial)
            with patch.object(diagnostics, 'PinnedProcess', return_value=pin):
                with self.assertRaises(PrivateError) as caught:
                    owner.bind('leader', EXPECTED)
            self.assertIs(caught.exception, original)
            self.assertIs(owner._first_failure, original)
            self.assertEqual(owner.processes, {})
            self.assertEqual(pin.closes, 1)

    def test_registration_error_wins_over_cleanup_and_lock_exit(self):
        owner = bare_owner()
        original, cleanup, exit_error = PrivateError(), PrivateError(), PrivateError()
        pin = InertPin(cleanup)
        owner.processes = FailedInsertion(original, True)
        owner.lock = InertLock(exit_error=exit_error)
        with patch.object(diagnostics, 'PinnedProcess', return_value=pin):
            with self.assertRaises(PrivateError) as caught:
                owner.bind('leader', EXPECTED)
        self.assertIs(caught.exception, original)
        self.assertIs(owner._first_failure, original)
        self.assertIs(owner._cleanup_error, cleanup)
        self.assertEqual(owner.processes, {})
        self.assertEqual(pin.closes, 1)

    def test_pin_constructor_failure_is_not_disposed_by_outer_bind(self):
        owner, original = bare_owner(), PrivateError()
        with patch.object(diagnostics, 'PinnedProcess', side_effect=original):
            with self.assertRaises(PrivateError) as caught:
                owner.bind('leader', EXPECTED)
        self.assertIs(caught.exception, original)
        self.assertEqual(owner.processes, {})

    def test_successful_registration_stays_owned_on_lock_exit_failure(self):
        owner, pin, original = bare_owner(), InertPin(), PrivateError()
        owner.lock = InertLock(exit_error=original)
        with patch.object(diagnostics, 'PinnedProcess', return_value=pin):
            with self.assertRaises(PrivateError) as caught:
                owner.bind('leader', EXPECTED)
        self.assertIs(caught.exception, original)
        self.assertIs(owner.processes['leader'], pin)
        self.assertEqual(pin.closes, 0)

    def test_existing_pin_and_first_errors_survive_later_failed_registration(self):
        owner, existing, new = bare_owner(), InertPin(), InertPin(PrivateError())
        first, cleanup, later = PrivateError(), PrivateError(), PrivateError()
        owner._first_failure, owner._cleanup_error = first, cleanup
        owner.processes = FailedInsertion(later, True)
        dict.__setitem__(owner.processes, 'supervisor', existing)
        with patch.object(diagnostics, 'PinnedProcess', return_value=new):
            with self.assertRaises(PrivateError) as caught:
                owner.bind('leader', EXPECTED)
        self.assertIs(caught.exception, later)
        self.assertIs(owner._first_failure, first)
        self.assertIs(owner._cleanup_error, cleanup)
        self.assertEqual(owner.processes, {'supervisor': existing})
        self.assertEqual((existing.closes, new.closes), (0, 1))

    def test_unknown_duplicate_and_lock_entry_refuse_before_acquisition(self):
        for mode in ('unknown', 'duplicate', 'lock'):
            owner, pin = bare_owner(), InertPin()
            original = PrivateError()
            if mode == 'duplicate':
                owner.processes['leader'] = pin
            if mode == 'lock':
                owner.lock = InertLock(enter_error=original)
            with patch.object(diagnostics, 'PinnedProcess') as factory:
                with self.assertRaises(PrivateError if mode == 'lock' else RuntimeError) as caught:
                    owner.bind('unknown' if mode == 'unknown' else 'leader', EXPECTED)
                factory.assert_not_called()
            if mode == 'lock':
                self.assertIs(caught.exception, original)
            else:
                self.assertEqual(str(caught.exception), 'unknown diagnostic process role' if mode == 'unknown'
                                 else 'diagnostic process role already pinned')
            self.assertEqual(pin.closes, 0)

    def test_constructor_success_retains_resource_and_pin(self):
        owner, fake, pin = bare_owner(), FakeOS(), InertPin()
        with construction(owner, fake) as paths, patch.object(diagnostics, 'PinnedProcess', return_value=pin):
            owner.__init__('synthetic-trace', [])
        self.assertEqual(paths, ['synthetic-trace', '/proc/self/stat'])
        self.assertEqual(owner.resource, 100)
        self.assertIs(owner.processes['supervisor'], pin)
        self.assertEqual(fake.closed, [])
        self.assertEqual(pin.closes, 0)
        self.assertIsNone(owner.thread)

    def test_resource_open_failure_disposes_nothing(self):
        owner, fake, original = bare_owner(), FakeOS(), PrivateError()
        fake.acquire_failure = (0, original)
        with construction(owner, fake), patch.object(diagnostics, 'PinnedProcess') as factory:
            with self.assertRaises(PrivateError) as caught:
                owner.__init__('synthetic-trace', [])
            factory.assert_not_called()
        self.assertIs(caught.exception, original)
        self.assertIs(owner._first_failure, original)
        self.assertIsNone(owner.resource)
        self.assertEqual(fake.closed, [])

    def test_own_stat_failure_wins_over_resource_cleanup_failure(self):
        owner, fake = bare_owner(), FakeOS()
        original, cleanup = PrivateError(), PrivateError()
        fake.close_failures[100] = cleanup
        with construction(owner, fake, read_error=original):
            with self.assertRaises(PrivateError) as caught:
                owner.__init__('synthetic-trace', [])
        self.assertIs(caught.exception, original)
        self.assertIs(owner._cleanup_error, cleanup)
        self.assertIsNone(owner.resource)
        self.assertEqual(fake.closed, [100])

    def test_malformed_own_stat_still_refuses_and_closes_resource(self):
        owner, fake = bare_owner(), FakeOS()
        with construction(owner, fake, raw='malformed'), patch.object(diagnostics, 'PinnedProcess') as factory:
            with self.assertRaises(ValueError):
                owner.__init__('synthetic-trace', [])
            factory.assert_not_called()
        self.assertEqual(fake.closed, [100])

    def test_constructor_registration_failures_do_not_double_dispose(self):
        for partial in (False, True):
            owner, fake = bare_owner(), FakeOS()
            original, cleanup = PrivateError(), PrivateError()
            pin = InertPin(cleanup)
            fake.close_failures[100] = PrivateError()
            def install():
                owner.processes = FailedInsertion(original, partial)
            with construction(owner, fake, before_read=install), patch.object(diagnostics, 'PinnedProcess', return_value=pin):
                with self.assertRaises(PrivateError) as caught:
                    owner.__init__('synthetic-trace', [])
            self.assertIs(caught.exception, original)
            self.assertIs(owner._cleanup_error, cleanup)
            self.assertEqual(owner.processes, {})
            self.assertIsNone(owner.resource)
            self.assertEqual(pin.closes, 1)
            self.assertEqual(fake.closed, [100])

    def test_constructor_lock_exit_failure_drains_registered_pin_before_resource(self):
        owner, fake = bare_owner(), FakeOS()
        original, cleanup = PrivateError(), PrivateError()
        pin = InertPin(cleanup)
        order = []
        def close_pin():
            order.append('pin'); pin.close()
        wrapper = SimpleNamespace(close=close_pin)
        close_resource = fake.close
        def close(number):
            order.append('resource'); close_resource(number)
        fake.close = close
        fake.close_failures[100] = PrivateError()
        with construction(owner, fake, lock=InertLock(exit_error=original)), patch.object(diagnostics, 'PinnedProcess', return_value=wrapper):
            with self.assertRaises(PrivateError) as caught:
                owner.__init__('synthetic-trace', [])
        self.assertIs(caught.exception, original)
        self.assertIs(owner._cleanup_error, cleanup)
        self.assertEqual(order, ['pin', 'resource'])
        self.assertEqual(pin.closes, 1)
        self.assertEqual(owner.processes, {})
        self.assertIsNone(owner.resource)

    def test_constructor_drains_all_registered_pins_despite_disposal_failures(self):
        owner, fake, original = bare_owner(), FakeOS(), PrivateError()
        first, second = InertPin(PrivateError()), InertPin(PrivateError())
        def install():
            owner.processes.update(supervisor=first, leader=second)
        with construction(owner, fake, read_error=original, before_read=install):
            with self.assertRaises(PrivateError) as caught:
                owner.__init__('synthetic-trace', [])
        self.assertIs(caught.exception, original)
        self.assertIs(owner._cleanup_error, second.cleanup)
        self.assertEqual((first.closes, second.closes), (1, 1))
        self.assertEqual(owner.processes, {})
        self.assertEqual(fake.closed, [100])

    def test_real_pin_constructor_rollback_is_not_repeated_by_sparse_owner(self):
        owner, fake, original = bare_owner(), FakeOS(), PrivateError()
        fake.inherit_failure = (0, original)
        with construction(owner, fake), injected_pins(fake):
            with self.assertRaises(PrivateError) as caught:
                owner.__init__('synthetic-trace', [])
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.closed, [102, 101, 100])
        self.assertEqual(owner.processes, {})
        self.assertIsNone(owner.resource)

    def test_real_pin_partial_registration_rollback_closes_each_fake_fd_once(self):
        owner, fake, original = bare_owner(), FakeOS(), PrivateError()
        def install():
            owner.processes = FailedInsertion(original, True)
        with construction(owner, fake, before_read=install), injected_pins(fake):
            with self.assertRaises(PrivateError) as caught:
                owner.__init__('synthetic-trace', [])
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.closed, [102, 101, 100])
        self.assertEqual(owner.processes, {})
        self.assertIsNone(owner.resource)


if __name__ == '__main__':
    unittest.main()
