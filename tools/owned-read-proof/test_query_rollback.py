"""Actual query-owner functions with injected OS/path interfaces, never live probes."""
from contextlib import ExitStack, contextmanager
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import kernel_runtime_queries as queries


class PrivateError(BaseException):
    def __str__(self):
        raise AssertionError('private exception string conversion')

    def __repr__(self):
        raise AssertionError('private exception representation')


MOUNTS = ('1 0 0:1 / / rw - overlay overlay rw\n'
          '2 1 0:30 / /proc ro - proc proc rw\n'
          '3 1 0:31 /.. /sys/fs/cgroup ro - cgroup2 cgroup2 rw\n')


class FakeOS:
    O_PATH, O_DIRECTORY, O_CLOEXEC = os.O_PATH, os.O_DIRECTORY, os.O_CLOEXEC
    O_NOFOLLOW, O_RDONLY = os.O_NOFOLLOW, os.O_RDONLY
    major, minor = staticmethod(os.major), staticmethod(os.minor)

    def __init__(self):
        self.opened, self.closed, self.paths = [], [], {}
        self.open_failure = self.close_failure = self.stat_failure = None

    def open(self, path, flags, dir_fd=None):
        index = len(self.opened)
        self.opened.append((path, flags, dir_fd))
        if self.open_failure is not None and self.open_failure[0] == index:
            raise self.open_failure[1]
        number = 10 + index
        self.paths[number] = path
        return number

    def close(self, number):
        self.closed.append(number)
        if self.close_failure is not None and number in self.close_failure:
            raise self.close_failure[number]

    def stat(self, path):
        if self.stat_failure is not None:
            raise self.stat_failure
        if path != '/':
            raise AssertionError('unexpected synthetic stat target')
        return SimpleNamespace(st_dev=1, st_ino=1)

    def fstat(self, number):
        dev = os.makedev(0, 30 if self.paths[number].startswith('/proc') else 31)
        return SimpleNamespace(st_dev=dev, st_ino=number + 100, st_mode=0o100444,
                               st_uid=1000, st_gid=1000, st_size=0, st_nlink=1)


@contextmanager
def injected_constructor(fake):
    failures = {}
    class FakePath:
        def __init__(self, path):
            self.path = path

        def read_text(self):
            if self.path in failures:
                raise failures[self.path]
            if self.path == '/proc/self/mountinfo':
                return MOUNTS
            if self.path.startswith('/proc/self/fdinfo/'):
                number = int(self.path.rsplit('/', 1)[1])
                return 'mnt_id:\t' + ('2' if fake.paths[number].startswith('/proc') else '3') + '\n'
            raise AssertionError('unexpected synthetic read target')
    with ExitStack() as stack:
        stack.enter_context(patch.object(queries, 'os', fake))
        stack.enter_context(patch.object(queries, 'Path', FakePath))
        stack.enter_context(patch.object(queries, 'namespaces', return_value={'mnt': 'mnt:[fixture]'}))
        stack.enter_context(patch.object(queries, 'fs_type', side_effect=lambda n:
            0x9fa0 if fake.paths[n].startswith('/proc') else 0x63677270))
        stack.enter_context(patch.object(queries, 'open_exact', side_effect=lambda p: fake.open(p, 0)))
        yield failures


class WalkRollbackControls(unittest.TestCase):
    def test_success_transfers_only_final_descriptor_with_original_flags(self):
        fake = FakeOS()
        with patch.object(queries, 'os', fake):
            self.assertEqual(queries.open_exact('/a/b'), 12)
        self.assertEqual(fake.closed, [10, 11])
        self.assertEqual(fake.opened, [('/', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC, None),
            ('a', os.O_CLOEXEC | os.O_NOFOLLOW | os.O_PATH | os.O_DIRECTORY, 10),
            ('b', os.O_CLOEXEC | os.O_NOFOLLOW | os.O_RDONLY, 11)])

    def test_failure_at_each_open_closes_only_still_owned_descriptor(self):
        for index, expected in ((0, []), (1, [10]), (2, [10, 11])):
            fake, original = FakeOS(), PrivateError()
            fake.open_failure = (index, original)
            with patch.object(queries, 'os', fake), self.assertRaises(PrivateError) as caught:
                queries.open_exact('/a/b')
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.closed, expected)

    def test_predecessor_close_failure_consumes_it_and_cleans_child_once(self):
        for failed, expected in ((10, [10, 11]), (11, [10, 11, 12])):
            fake, original = FakeOS(), PrivateError()
            fake.close_failure = {failed: original}
            with patch.object(queries, 'os', fake), self.assertRaises(PrivateError) as caught:
                queries.open_exact('/a/b')
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.closed, expected)

    def test_secondary_child_cleanup_failure_preserves_original_close_error(self):
        fake, original = FakeOS(), PrivateError('ORIGINAL')
        fake.close_failure = {10: original, 11: PrivateError('SECONDARY')}
        with patch.object(queries, 'os', fake), self.assertRaises(PrivateError) as caught:
            queries.open_exact('/a/b')
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.closed, [10, 11])

    def test_secondary_cleanup_failure_preserves_original_open_error(self):
        fake, original = FakeOS(), PrivateError()
        fake.open_failure = (1, original)
        fake.close_failure = {10: PrivateError()}
        with patch.object(queries, 'os', fake), self.assertRaises(PrivateError) as caught:
            queries.open_exact('/a/b')
        self.assertIs(caught.exception, original)
        self.assertEqual(fake.closed, [10])

    def test_noncanonical_paths_refuse_before_any_open(self):
        for path in ('relative', '/', '/a//b', '/a/../b', '/a/./b'):
            fake = FakeOS()
            with patch.object(queries, 'os', fake), self.assertRaises(RuntimeError):
                queries.open_exact(path)
            self.assertEqual(fake.opened, [])


class ConstructorRollbackControls(unittest.TestCase):
    def test_success_retains_same_three_global_queries_and_closes_reverse_once(self):
        fake = FakeOS()
        with injected_constructor(fake):
            owner = queries.KernelRuntimeQueries()
            self.assertEqual(owner.fds, [10, 11, 12])
            self.assertEqual(list(owner.value['queries']), [p for p in queries.QUERIES if p != '/proc/self/cgroup'])
            self.assertEqual(owner.value['queries']['/sys/fs/cgroup//memory.max']['mount']['root'], '/..')
            owner.close(); owner.close()
        self.assertEqual(fake.closed, [12, 11, 10])

    def test_failure_at_each_query_open_rolls_back_all_earlier_queries(self):
        for index in range(3):
            fake, original = FakeOS(), PrivateError()
            fake.open_failure = (index, original)
            owner = queries.KernelRuntimeQueries.__new__(queries.KernelRuntimeQueries)
            with injected_constructor(fake), self.assertRaises(PrivateError) as caught:
                owner.__init__()
            self.assertIs(caught.exception, original)
            self.assertIs(owner._first_failure, original)
            self.assertEqual(fake.closed, list(reversed(range(10, 10 + index))))
            self.assertEqual(owner.fds, [])

    def test_failure_after_each_query_registration_closes_that_query_too(self):
        for index in range(3):
            fake, original = FakeOS(), PrivateError()
            owner = queries.KernelRuntimeQueries.__new__(queries.KernelRuntimeQueries)
            with injected_constructor(fake) as failures:
                failures[f'/proc/self/fdinfo/{10 + index}'] = original
                with self.assertRaises(PrivateError) as caught:
                    owner.__init__()
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.closed, list(reversed(range(10, 11 + index))))
            self.assertEqual(owner.fds, [])

    def test_constructor_keeps_original_when_multiple_cleanup_attempts_fail(self):
        fake, original = FakeOS(), PrivateError('ORIGINAL')
        cleanup_error = PrivateError('CLEANUP')
        fake.close_failure = {12: cleanup_error, 10: PrivateError('LATER')}
        owner = queries.KernelRuntimeQueries.__new__(queries.KernelRuntimeQueries)
        with injected_constructor(fake) as failures:
            failures['/proc/self/fdinfo/12'] = original
            with self.assertRaises(PrivateError) as caught:
                owner.__init__()
            self.assertIs(caught.exception, original)
            self.assertIs(owner._first_failure, original)
            self.assertIs(owner._cleanup_error, cleanup_error)
            with self.assertRaisesRegex(RuntimeError, '^query descriptor cleanup uncertain$'):
                owner.close()
        self.assertEqual(fake.closed, [12, 11, 10])

    def test_metadata_failure_before_acquisition_never_closes_unowned_handle(self):
        for stage in ('mountinfo', 'root'):
            fake, original = FakeOS(), PrivateError()
            with injected_constructor(fake) as failures:
                if stage == 'mountinfo':
                    failures['/proc/self/mountinfo'] = original
                else:
                    fake.stat_failure = original
                with self.assertRaises(PrivateError) as caught:
                    queries.KernelRuntimeQueries()
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.opened, [])
            self.assertEqual(fake.closed, [])

    def test_registration_reservation_failure_precedes_next_query_open(self):
        fake, original = FakeOS(), PrivateError()
        class RefusingList(list):
            def append(self, value):
                raise original
        with injected_constructor(fake):
            owner = queries.KernelRuntimeQueries()
            owner.fds = RefusingList(owner.fds)
            before = list(fake.opened)
            with self.assertRaises(PrivateError) as caught:
                owner.retain('/proc/meminfo', '/proc/meminfo')
            self.assertIs(caught.exception, original)
            self.assertEqual(fake.opened, before)
            owner.close()
        self.assertEqual(fake.closed, [12, 11, 10])

    def test_constructor_reservation_failure_rolls_back_each_earlier_query(self):
        original_retain = queries.KernelRuntimeQueries.retain
        for fail_at in range(3):
            fake, original = FakeOS(), PrivateError()
            class RefusingList(list):
                def append(self, value):
                    raise original
            def retain(owner, path, resolved):
                if len(fake.opened) == fail_at:
                    owner.fds = RefusingList(owner.fds)
                return original_retain(owner, path, resolved)
            owner = queries.KernelRuntimeQueries.__new__(queries.KernelRuntimeQueries)
            with injected_constructor(fake), patch.object(queries.KernelRuntimeQueries, 'retain', new=retain):
                with self.assertRaises(PrivateError) as caught:
                    owner.__init__()
            self.assertIs(caught.exception, original)
            self.assertIs(owner._first_failure, original)
            self.assertEqual(len(fake.opened), fail_at)
            self.assertEqual(fake.closed, list(reversed(range(10, 10 + fail_at))))

    def test_wrong_filesystem_still_refuses_and_rolls_back(self):
        fake = FakeOS()
        with injected_constructor(fake), patch.object(queries, 'fs_type', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'wrong held query filesystem/type'):
                queries.KernelRuntimeQueries()
        self.assertEqual(fake.closed, [10])

    def test_close_attempts_all_fds_and_never_retries_after_failure(self):
        fake, original = FakeOS(), PrivateError('PRIVATE')
        with injected_constructor(fake):
            owner = queries.KernelRuntimeQueries()
            fake.close_failure = {12: original, 11: PrivateError('SECONDARY')}
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, '^query descriptor cleanup uncertain$'):
                    owner.close()
            self.assertIs(owner._cleanup_error, original)
            self.assertEqual(owner.fds, [])
        self.assertEqual(fake.closed, [12, 11, 10])

    def test_uncertain_close_does_not_skip_later_registered_fd(self):
        fake = FakeOS()
        with injected_constructor(fake):
            owner = queries.KernelRuntimeQueries()
            fake.close_failure = {12: PrivateError()}
            with self.assertRaises(RuntimeError):
                owner.close()
            # Existing later-adoption paths are not terminal-state gated. A cached
            # outcome must not cause a newly tracked handle to escape disposal.
            owner.fds.append(99)
            with self.assertRaises(RuntimeError):
                owner.close()
        self.assertEqual(fake.closed, [12, 11, 10, 99])


if __name__ == '__main__':
    unittest.main()
