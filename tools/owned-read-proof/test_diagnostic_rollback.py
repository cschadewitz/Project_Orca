"""Actual diagnostic owners with injected handles/counters/polls; no host probes."""
from contextlib import ExitStack, contextmanager
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import controlled_diagnostics as diagnostics


class PrivateError(BaseException):
    def __str__(self):
        raise AssertionError('private exception string conversion')

    def __repr__(self):
        raise AssertionError('private exception representation')


EXPECTED = {'pid': 9, 'starttime': 1234, 'ppid': 8, 'pgrp': 7, 'session': 7}
FIELDS = ['0'] * 22
for index, value in {0: 'R', 1: '8', 2: '7', 3: '7', 7: '1', 9: '2',
                     11: '3', 12: '4', 19: '1234', 21: '5'}.items():
    FIELDS[index] = value
RAW_STAT = '9 (synthetic) ' + ' '.join(FIELDS)


class FakeOS:
    O_PATH, O_DIRECTORY, O_NOFOLLOW = os.O_PATH, os.O_DIRECTORY, os.O_NOFOLLOW
    O_CLOEXEC, O_RDONLY = os.O_CLOEXEC, os.O_RDONLY

    def __init__(self):
        self.acquisitions, self.closed, self.inherit, self.reads = [], [], [], []
        self.acquire_failure = self.inherit_failure = self.read_failure = self.stat_failure = None
        self.close_failures = {}
        self.data = b'synthetic'

    def _acquire(self, operation, *args):
        index = len(self.acquisitions)
        self.acquisitions.append((operation, *args))
        if self.acquire_failure is not None and index == self.acquire_failure[0]:
            raise self.acquire_failure[1]
        return 100 + index

    def pidfd_open(self, pid):
        return self._acquire('pidfd_open', pid)

    def dup(self, number):
        return self._acquire('dup', number)

    def open(self, path, flags, dir_fd=None):
        return self._acquire('open', path, flags, dir_fd)

    def close(self, number):
        self.closed.append(number)
        if number in self.close_failures:
            raise self.close_failures[number]

    def set_inheritable(self, number, value):
        index = len(self.inherit)
        self.inherit.append((number, value))
        if self.inherit_failure is not None and index == self.inherit_failure[0]:
            raise self.inherit_failure[1]

    def fstat(self, number):
        if self.stat_failure is not None:
            raise self.stat_failure
        return (0o40500, 123, 456)

    def read(self, number, length):
        self.reads.append((number, length))
        if self.read_failure is not None:
            raise self.read_failure
        return self.data


@contextmanager
def injected_pins(fake):
    calls, poll_calls = [], []
    failures = {}
    def counter(number, name):
        index = len(calls); calls.append((number, name))
        if index in failures:
            raise failures[index]
        if name == 'stat':
            return RAW_STAT
        if name == 'schedstat':
            return '1 2 3'
        if name == 'io':
            return 'rchar: 7\n'
        raise AssertionError('unexpected synthetic counter')
    poll = SimpleNamespace(register=lambda *args: poll_calls.append(args), poll=lambda timeout: [])
    with ExitStack() as stack:
        stack.enter_context(patch.object(diagnostics, 'os', fake))
        stack.enter_context(patch.object(diagnostics, 'read_at', side_effect=counter))
        stack.enter_context(patch.object(diagnostics, 'select', SimpleNamespace(POLLIN=1, poll=lambda: poll)))
        yield failures, calls, poll_calls


class PinRollbackControls(unittest.TestCase):
    def test_native_duplicated_and_mixed_success_close_only_owned_results(self):
        for procfd, pidfd in ((None, None), (70, 80), (70, None), (None, 80)):
            fake = FakeOS()
            with injected_pins(fake) as (_, calls, polls):
                owner = diagnostics.PinnedProcess(EXPECTED, procfd, pidfd)
                self.assertEqual(owner.expected, EXPECTED)
                self.assertEqual((owner.pidfd, owner.procfd), (100, 101))
                self.assertEqual(fake.inherit, [(100, False), (101, False)])
                self.assertEqual(calls, [(101, n) for n in ('stat', 'stat', 'schedstat', 'io', 'stat')])
                self.assertEqual(polls, [(100, 1)])
                owner.close(); owner.close()
            self.assertEqual(fake.closed, [101, 100])
            self.assertNotIn(70, fake.closed); self.assertNotIn(80, fake.closed)
            self.assertEqual(fake.acquisitions[0], ('dup', pidfd) if pidfd is not None else ('pidfd_open', 9))
            self.assertEqual(fake.acquisitions[1], ('dup', procfd) if procfd is not None else
                ('open', '/proc/9', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, None))

    def test_each_native_duplicated_or_mixed_acquisition_failure_rolls_back(self):
        for procfd, pidfd in ((None, None), (70, 80), (70, None), (None, 80)):
            for index in (0, 1):
                fake, original = FakeOS(), PrivateError()
                fake.acquire_failure = (index, original)
                owner = diagnostics.PinnedProcess.__new__(diagnostics.PinnedProcess)
                with injected_pins(fake), self.assertRaises(PrivateError) as caught:
                    owner.__init__(EXPECTED, procfd, pidfd)
                self.assertIs(caught.exception, original)
                self.assertIs(owner._first_failure, original)
                self.assertEqual(fake.closed, [] if index == 0 else [100])
                self.assertIsNone(owner.pidfd); self.assertIsNone(owner.procfd)

    def test_each_inherit_failure_attempts_both_handles(self):
        for index in (0, 1):
            fake, original = FakeOS(), PrivateError()
            fake.inherit_failure = (index, original)
            with injected_pins(fake), self.assertRaises(PrivateError) as caught:
                diagnostics.PinnedProcess(EXPECTED)
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.closed, [101, 100])

    def test_initial_fstat_failure_attempts_both_handles(self):
        fake, original = FakeOS(), PrivateError()
        fake.stat_failure = original
        with injected_pins(fake), self.assertRaises(PrivateError) as caught:
            diagnostics.PinnedProcess(EXPECTED)
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.closed, [101, 100])

    def test_every_initial_sample_read_failure_preserves_original(self):
        for index in range(5):
            fake, original = FakeOS(), PrivateError()
            with injected_pins(fake) as (failures, _, _):
                failures[index] = original
                with self.assertRaises(PrivateError) as caught:
                    diagnostics.PinnedProcess(EXPECTED)
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.closed, [101, 100])

    def test_wrong_initial_identity_still_refuses_and_rolls_back(self):
        fake = FakeOS()
        with injected_pins(fake), self.assertRaisesRegex(RuntimeError, 'initial process identity'):
            diagnostics.PinnedProcess({**EXPECTED, 'starttime': 5678})
        self.assertEqual(fake.closed, [101, 100])

    def test_missing_expected_field_opens_and_closes_nothing(self):
        fake = FakeOS()
        with injected_pins(fake), self.assertRaises(KeyError):
            diagnostics.PinnedProcess({})
        self.assertEqual(fake.acquisitions, [])
        self.assertEqual(fake.closed, [])

    def test_constructor_error_survives_both_cleanup_failures(self):
        fake, original, cleanup = FakeOS(), PrivateError('PRIMARY'), PrivateError('CLEANUP')
        fake.inherit_failure = (0, original)
        fake.close_failures = {101: cleanup, 100: PrivateError('LATER')}
        owner = diagnostics.PinnedProcess.__new__(diagnostics.PinnedProcess)
        with injected_pins(fake):
            with self.assertRaises(PrivateError) as caught:
                owner.__init__(EXPECTED)
            self.assertIs(caught.exception, original)
            self.assertIs(owner._first_failure, original)
            self.assertIs(owner._cleanup_error, cleanup)
            with self.assertRaisesRegex(RuntimeError, '^diagnostic pin cleanup uncertain$'):
                owner.close()
        self.assertEqual(fake.closed, [101, 100])

    def test_each_close_failure_consumes_slot_and_never_retries(self):
        for failed in (100, 101):
            fake, original = FakeOS(), PrivateError('PRIVATE')
            with injected_pins(fake):
                owner = diagnostics.PinnedProcess(EXPECTED)
                fake.close_failures = {failed: original}
                for _ in range(2):
                    with self.assertRaisesRegex(RuntimeError, '^diagnostic pin cleanup uncertain$') as caught:
                        owner.close()
                    self.assertTrue(caught.exception.__suppress_context__)
                self.assertIs(owner._cleanup_error, original)
                self.assertIsNone(owner.procfd); self.assertIsNone(owner.pidfd)
            self.assertEqual(fake.closed, [101, 100])

    def test_uncertain_close_still_drains_a_later_owned_slot(self):
        fake = FakeOS()
        with injected_pins(fake):
            owner = diagnostics.PinnedProcess(EXPECTED)
            fake.close_failures = {101: PrivateError()}
            with self.assertRaises(RuntimeError):
                owner.close()
            owner.pidfd = 102
            with self.assertRaises(RuntimeError):
                owner.close()
        self.assertEqual(fake.closed, [101, 100, 102])


class ReaderRollbackControls(unittest.TestCase):
    def test_success_preserves_relative_nonfollowing_flags_and_read_bound(self):
        fake = FakeOS()
        with patch.object(diagnostics, 'os', fake):
            self.assertEqual(diagnostics.read_at(70, 'stat'), 'synthetic')
        self.assertEqual(fake.acquisitions, [('open', 'stat', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 70)])
        self.assertEqual(fake.reads, [(100, diagnostics.READ_BOUND + 1)])
        self.assertEqual(fake.closed, [100])

    def test_failed_open_never_closes_borrowed_directory(self):
        fake, original = FakeOS(), PrivateError()
        fake.acquire_failure = (0, original)
        with patch.object(diagnostics, 'os', fake), self.assertRaises(PrivateError) as caught:
            diagnostics.read_at(70, 'stat')
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.closed, [])

    def test_read_error_wins_over_secondary_close_error(self):
        fake, original = FakeOS(), PrivateError('READ')
        fake.read_failure = original
        fake.close_failures = {100: PrivateError('CLOSE')}
        with patch.object(diagnostics, 'os', fake), self.assertRaises(PrivateError) as caught:
            diagnostics.read_at(70, 'stat')
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.closed, [100])

    def test_counter_bound_failure_wins_over_secondary_close_error(self):
        fake = FakeOS(); fake.data = b'x' * (diagnostics.READ_BOUND + 1)
        fake.close_failures = {100: PrivateError()}
        with patch.object(diagnostics, 'os', fake), self.assertRaisesRegex(RuntimeError, 'fixed read bound'):
            diagnostics.read_at(70, 'stat')
        self.assertEqual(fake.closed, [100])

    def test_decode_failure_wins_over_secondary_close_error(self):
        fake = FakeOS(); fake.data = b'\xff'
        fake.close_failures = {100: PrivateError()}
        with patch.object(diagnostics, 'os', fake), self.assertRaises(UnicodeDecodeError):
            diagnostics.read_at(70, 'stat')
        self.assertEqual(fake.closed, [100])

    def test_success_path_close_failure_refuses_data_with_fixed_public_text(self):
        fake, original = FakeOS(), PrivateError('PRIVATE')
        fake.close_failures = {100: original}
        with patch.object(diagnostics, 'os', fake):
            with self.assertRaisesRegex(RuntimeError, '^diagnostic reader cleanup uncertain$') as caught:
                diagnostics.read_at(70, 'stat')
            self.assertIs(caught.exception.__context__, original)
            self.assertTrue(caught.exception.__suppress_context__)
        self.assertEqual(fake.closed, [100])


if __name__ == '__main__':
    unittest.main()
