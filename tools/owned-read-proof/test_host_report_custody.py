"""Real native files/FDs in isolated synthetic roots only; never an observer.

Individual syscall faults exercise uncertainty, not whole-attempt ownership,
process settlement, host provisioning or durable-media qualification.
"""
import ast
from contextlib import contextmanager
import errno
import hashlib
import os
from pathlib import Path
import pickle
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch

import host_report_custody as subject


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PrivateFailure(BaseException):
    def __str__(self):
        raise AssertionError('private string conversion')

    def __repr__(self):
        raise AssertionError('private representation')

    def __bool__(self):
        raise AssertionError('private truthiness')


class HostReportCustodyTests(unittest.TestCase):
    @contextmanager
    def fixture(self, data=b'report', lane='bootstrap'):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, source = base / 'private', base / 'source'
            root.mkdir(mode=0o700)
            source.mkdir(mode=0o700)
            final, pending = subject._NAMES[lane]
            (source / final).write_bytes(data)
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            source_root = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            source_fd = os.open(source / final, os.O_RDONLY)
            owner = subject.HostReportCustody(lane)
            try:
                yield owner, root, source, root_fd, source_root, source_fd, final, pending
            finally:
                owner.close()
                for fd in (source_fd, source_root, root_fd):
                    os.close(fd)

    def assert_public(self, call):
        try:
            call()
        except subject.CustodyError as error:
            self.assertEqual(str(error), 'private report custody unavailable')
            self.assertIsNone(error.__context__)
            self.assertIsNone(error.__cause__)
        else:
            self.fail('missing fixed public refusal')

    @staticmethod
    def publish(owner, fd, root, data=b'report'):
        return owner.publish(fd, root, len(data), sha(data))

    def test_passive_constructor_fixed_lanes_and_nonserializable_owner(self):
        with patch.object(subject.os, 'dup', side_effect=AssertionError('effect')):
            owner = subject.HostReportCustody('bootstrap')
        self.assertEqual(repr(owner), '<HostReportCustody>')
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with self.assertRaisesRegex(TypeError, 'cannot be serialized'):
                pickle.dumps(owner, protocol)
        for lane in ('../secret', '', 'BOOTSTRAP', True, object()):
            self.assert_public(lambda: subject.HostReportCustody(lane))
        owner.close()

    def test_real_full_reservation_one_inode_and_controller_retains_root(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            self.assertEqual(owner.reserve(root_fd).state, 'reserved')
            info = (root / pending).stat()
            self.assertEqual(info.st_size, subject.REPORT_LIMIT)
            self.assertGreaterEqual(info.st_blocks * 512, subject.REPORT_LIMIT)
            self.assertEqual(info.st_nlink, 1)
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            self.assertEqual({p.name for p in root.iterdir()}, {pending})
            self.assertNotEqual(owner._root.value, root_fd)
            self.assertFalse(os.get_inheritable(owner._root.value))
            os.fstat(root_fd)

    def test_both_lanes_complete_exact_bytes_aliases_and_borrowed_offset(self):
        data = bytes(range(256)) * 1100
        for lane in ('bootstrap', 'connected'):
            with self.subTest(lane=lane), self.fixture(data, lane) as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                os.lseek(src_fd, 9, os.SEEK_SET)
                self.assertTrue(self.publish(owner, src_fd, src_root, data).known_acknowledged)
                self.assertEqual((root / final).read_bytes(), data)
                self.assertEqual((root / pending).read_bytes(), data)
                a, b = (root / final).stat(), (root / pending).stat()
                self.assertEqual((a.st_dev, a.st_ino), (b.st_dev, b.st_ino))
                self.assertEqual(a.st_nlink, 2)
                self.assertEqual(stat.S_IMODE(a.st_mode), 0o400)
                self.assertEqual({p.name for p in root.iterdir()}, {final, pending})
                self.assertEqual(os.lseek(src_fd, 0, os.SEEK_CUR), 9)
                self.assertIsNone(owner._report.value)
                self.assertIsNone(owner._source.value)
                self.assertIsNone(owner._source_root.value)
                snapshot = owner.reconcile()
                self.assertTrue(snapshot.aliases_valid and snapshot.original_inode_observed)
                self.assertTrue(snapshot.complete_bytes_observed and snapshot.known_acknowledged)
                owner.close()
                with patch.object(subject.os, 'pwrite', side_effect=AssertionError('replay')):
                    self.assertTrue(owner.outcome().known_acknowledged)

    def test_empty_exact_ceiling_and_bounded_native_io(self):
        for data in (b'', b'x' * subject.REPORT_LIMIT):
            with self.subTest(size=len(data)), self.fixture(data) as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                real_read, real_write = os.pread, os.pwrite
                reads, writes = [], []
                def read(fd, amount, offset):
                    self.assertLessEqual(amount, subject._COPY_CHUNK)
                    reads.append(amount)
                    return real_read(fd, amount, offset)
                def write(fd, chunk, offset):
                    self.assertLessEqual(offset + len(chunk), len(data))
                    writes.append(len(chunk))
                    return real_write(fd, chunk, offset)
                with patch.object(subject.os, 'pread', side_effect=read), patch.object(subject.os, 'pwrite', side_effect=write):
                    self.publish(owner, src_fd, src_root, data)
                self.assertEqual(sum(writes), len(data))
                self.assertEqual((root / final).read_bytes(), data)
                self.assertTrue(reads)

    def test_positive_short_native_reads_and_writes_are_progress(self):
        data = bytes(range(256)) * 700
        with self.fixture(data) as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            owner.reserve(root_fd)
            real_read, real_write = os.pread, os.pwrite
            writes = []
            def read(fd, amount, offset):
                return real_read(fd, min(amount, 8191), offset)
            def write(fd, chunk, offset):
                amount = min(117, len(chunk))
                writes.append(amount)
                return real_write(fd, chunk[:amount], offset)
            with patch.object(subject.os, 'pread', side_effect=read), patch.object(subject.os, 'pwrite', side_effect=write):
                self.publish(owner, src_fd, src_root, data)
            self.assertGreater(len(writes), 100)
            self.assertEqual((root / final).read_bytes(), data)

    def test_invalid_size_digest_scalars_precede_source_acquisition_and_write(self):
        for size, digest in ((-1, sha(b'')), (subject.REPORT_LIMIT + 1, sha(b'')),
                             (True, sha(b'')), (0, 'secret/path'), (0, object())):
            with self.subTest(size=size), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                with patch.object(subject.os, 'dup', side_effect=AssertionError('acquire')), patch.object(subject.os, 'pwrite', side_effect=AssertionError('write')):
                    self.assert_public(lambda: owner.publish(src_fd, src_root, size, digest))
                self.assertEqual(owner.outcome().first_failure_code, 'size')
                self.assertEqual((root / pending).stat().st_size, subject.REPORT_LIMIT)

    def test_actual_source_size_hash_and_types_precede_payload_write(self):
        for case in ('size', 'hash', 'oversize', 'directory', 'fifo', 'writable'):
            with self.subTest(case=case), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                fd, size, digest, extra = src_fd, 6, sha(b'report'), None
                if case == 'size':
                    size = 5
                elif case == 'hash':
                    digest = sha(b'changed')
                elif case == 'oversize':
                    with (source / final).open('r+b') as stream:
                        stream.truncate(subject.REPORT_LIMIT + 1)
                elif case == 'directory':
                    fd = src_root
                elif case == 'fifo':
                    os.mkfifo(source / 'fifo')
                    fd = extra = os.open(source / 'fifo', os.O_RDONLY | os.O_NONBLOCK)
                elif case == 'writable':
                    fd = extra = os.open(source / final, os.O_RDWR)
                try:
                    with patch.object(subject.os, 'pwrite', side_effect=AssertionError('write')):
                        self.assert_public(lambda: owner.publish(fd, src_root, size, digest))
                    self.assertFalse((root / final).exists())
                finally:
                    if extra is not None:
                        os.close(extra)

    def test_source_symlink_extra_alias_and_wrong_directory_refuse(self):
        for case in ('symlink', 'hardlink', 'different-root'):
            with self.subTest(case=case), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                if case == 'symlink':
                    (source / final).rename(source / 'target')
                    (source / final).symlink_to('target')
                elif case == 'hardlink':
                    os.link(source / final, source / 'alias')
                directory_fd = root_fd if case == 'different-root' else src_root
                with patch.object(subject.os, 'pwrite', side_effect=AssertionError('write')):
                    self.assert_public(lambda: self.publish(owner, src_fd, directory_fd))

    def test_root_mode_type_owner_and_path_fd_refuse_before_allocation(self):
        for case in ('mode', 'regular', 'owner', 'path-fd'):
            with self.subTest(case=case), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                descriptor, extra = root_fd, None
                if case == 'mode':
                    root.chmod(0o755)
                elif case == 'regular':
                    descriptor = src_fd
                elif case == 'path-fd':
                    descriptor = extra = os.open(root, os.O_PATH)
                try:
                    with patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocate')):
                        if case == 'owner':
                            with patch.object(subject.os, 'geteuid', return_value=os.geteuid() + 1):
                                self.assert_public(lambda: owner.reserve(descriptor))
                        else:
                            self.assert_public(lambda: owner.reserve(descriptor))
                    self.assertEqual(owner.outcome().first_failure_code, 'protection')
                    self.assertFalse((root / pending).exists())
                finally:
                    if extra is not None:
                        os.close(extra)

    def test_existing_pending_final_symlink_and_create_race_are_untouched(self):
        for case in ('pending', 'final', 'symlink', 'create-race'):
            with self.subTest(case=case), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                target = root / (pending if case in ('pending', 'create-race') else final)
                if case == 'symlink':
                    target.symlink_to(source / final)
                elif case != 'create-race':
                    target.write_bytes(b'original')
                real_open = os.open
                def race(name, flags, *args, **kwargs):
                    if name == pending:
                        target.write_bytes(b'original')
                    return real_open(name, flags, *args, **kwargs)
                with patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocate')):
                    if case == 'create-race':
                        with patch.object(subject.os, 'open', side_effect=race):
                            self.assert_public(lambda: owner.reserve(root_fd))
                    else:
                        self.assert_public(lambda: owner.reserve(root_fd))
                self.assertEqual(target.read_bytes(), b'report' if case == 'symlink' else b'original')

    def test_unsupported_full_and_lost_allocation_ack_keep_pending_no_retry(self):
        for error_number in (errno.EOPNOTSUPP, errno.ENOSPC):
            with self.subTest(errno=error_number), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                error = OSError(error_number, '/private/secret')
                with patch.object(subject.os, 'posix_fallocate', side_effect=error) as allocate:
                    self.assert_public(lambda: owner.reserve(root_fd))
                    self.assert_public(lambda: owner.reserve(root_fd))
                    self.assertEqual(allocate.call_count, 1)
                self.assertIs(owner._first_failure, error)
                self.assertTrue((root / pending).exists())
                self.assertFalse((root / final).exists())
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            real_allocate, error = os.posix_fallocate, PrivateFailure()
            def allocate(fd, offset, length):
                real_allocate(fd, offset, length)
                raise error
            with patch.object(subject.os, 'posix_fallocate', side_effect=allocate):
                self.assert_public(lambda: owner.reserve(root_fd))
            self.assertEqual((root / pending).stat().st_size, subject.REPORT_LIMIT)
            self.assertIs(owner._first_failure, error)
            self.assertFalse(owner.reconcile().known_acknowledged)
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            with patch.object(subject.os, 'posix_fallocate', None):
                self.assert_public(lambda: owner.reserve(root_fd))
            self.assertEqual(owner.outcome().first_failure_code, 'unsupported')
            self.assertEqual(list(root.iterdir()), [])

    def test_partial_copy_and_later_close_failure_preserve_first_private_error(self):
        data = b'a' * 120000
        with self.fixture(data) as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            owner.reserve(root_fd)
            first, later = PrivateFailure(), PrivateFailure()
            real_write, real_close = os.pwrite, os.close
            report_fd, writes = owner._report.value, []
            def write(fd, chunk, offset):
                if writes:
                    raise first
                writes.append(real_write(fd, chunk[:9], offset))
                return writes[-1]
            def close(fd):
                real_close(fd)
                if fd == report_fd:
                    raise later
            with patch.object(subject.os, 'pwrite', side_effect=write), patch.object(subject.os, 'close', side_effect=close):
                self.assert_public(lambda: self.publish(owner, src_fd, src_root, data))
            self.assertIs(owner._first_failure, first)
            self.assertEqual(owner.outcome().first_failure_phase, 'copy')
            self.assertEqual((root / pending).read_bytes()[:10], b'a' * 9 + b'\0')
            self.assertFalse((root / final).exists())
            self.assertFalse(owner.reconcile().complete_bytes_observed)
            with patch.object(subject.os, 'pwrite', side_effect=AssertionError('retry')):
                self.assert_public(lambda: self.publish(owner, src_fd, src_root, data))
            self.assertIs(owner._first_failure, first)

    def test_invalid_write_progress_is_terminal(self):
        for count in (0, -1, True, 1000):
            with self.subTest(count=count), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                with patch.object(subject.os, 'pwrite', return_value=count) as write:
                    self.assert_public(lambda: self.publish(owner, src_fd, src_root))
                    self.assertEqual(write.call_count, 1)
                self.assertEqual(owner.outcome().first_failure_code, 'write-progress')
                self.assertFalse((root / final).exists())

    def test_source_changes_during_preflight_or_copy_refuse(self):
        for case in ('hash-mutation', 'hash-replacement', 'copy-mutation', 'copy-growth', 'copy-truncation'):
            data = b'a' * 100000
            with self.subTest(case=case), self.fixture(data) as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                real_read, real_write, changed = os.pread, os.pwrite, []
                def mutate():
                    if changed:
                        return
                    changed.append(True)
                    if case == 'hash-replacement':
                        (source / final).rename(source / 'original')
                        (source / final).write_bytes(data)
                    elif case == 'copy-growth':
                        with (source / final).open('ab') as stream:
                            stream.write(b'z')
                    elif case == 'copy-truncation':
                        with (source / final).open('r+b') as stream:
                            stream.truncate(7)
                    else:
                        with (source / final).open('r+b') as stream:
                            stream.write(b'z')
                def read(fd, amount, offset):
                    result = real_read(fd, amount, offset)
                    if case.startswith('hash-') and offset == 0:
                        mutate()
                    return result
                def write(fd, chunk, offset):
                    result = real_write(fd, chunk, offset)
                    if case.startswith('copy-'):
                        mutate()
                    return result
                with patch.object(subject.os, 'pread', side_effect=read), patch.object(subject.os, 'pwrite', side_effect=write):
                    self.assert_public(lambda: self.publish(owner, src_fd, src_root, data))
                self.assertTrue(changed)
                self.assertEqual(owner.outcome().first_failure_code, 'source-changed')
                self.assertFalse((root / final).exists())

    def test_destination_substitution_alias_and_root_mode_changes_detected(self):
        for case in ('replacement', 'symlink', 'extra-alias', 'mode'):
            with self.subTest(case=case), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                if case in ('replacement', 'symlink'):
                    (root / pending).rename(root / 'original')
                    if case == 'replacement':
                        (root / pending).write_bytes(b'replacement')
                    else:
                        (root / pending).symlink_to(source / final)
                elif case == 'extra-alias':
                    os.link(root / pending, root / 'unexpected-alias')
                else:
                    root.chmod(0o750)
                with patch.object(subject.os, 'pwrite', side_effect=AssertionError('write')):
                    self.assert_public(lambda: self.publish(owner, src_fd, src_root))
                self.assertFalse((root / final).exists())

    def test_sync_and_seal_failures_private_without_public_chain(self):
        for syscall, when in (('fsync', 'reserve-file'), ('fsync', 'reserve-directory'),
                              ('fsync', 'publish-file'), ('fchmod', 'seal')):
            with self.subTest(when=when), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                error, real_sync, sync_calls = PrivateFailure(), os.fsync, []
                def sync(fd):
                    sync_calls.append(fd)
                    if len(sync_calls) == (1 if when == 'reserve-file' else 2):
                        raise error
                    return real_sync(fd)
                if when.startswith('reserve-'):
                    with patch.object(subject.os, syscall, side_effect=sync):
                        self.assert_public(lambda: owner.reserve(root_fd))
                else:
                    owner.reserve(root_fd)
                    with patch.object(subject.os, syscall, side_effect=error):
                        self.assert_public(lambda: self.publish(owner, src_fd, src_root))
                self.assertIs(owner._first_failure, error)
                self.assertFalse((root / final).exists())
                self.assertTrue((root / pending).exists())
                self.assertFalse(owner.outcome().known_acknowledged)

    def test_publication_create_race_never_replaces_existing_final(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            owner.reserve(root_fd)
            real_link = os.link
            def race(*args, **kwargs):
                (root / final).write_bytes(b'other original')
                return real_link(*args, **kwargs)
            with patch.object(subject.os, 'link', side_effect=race):
                self.assert_public(lambda: self.publish(owner, src_fd, src_root))
            self.assertEqual((root / final).read_bytes(), b'other original')
            self.assertEqual((root / pending).read_bytes(), b'report')
            self.assertEqual((root / pending).stat().st_nlink, 1)

    def test_lost_publication_and_sync_ack_absorbing_readonly_reconciliation(self):
        for boundary in ('link', 'directory-sync'):
            with self.subTest(boundary=boundary), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                real_link, real_sync, error = os.link, os.fsync, PrivateFailure()
                def link(*args, **kwargs):
                    real_link(*args, **kwargs)
                    if boundary == 'link':
                        raise error
                def sync(fd):
                    real_sync(fd)
                    if boundary == 'directory-sync' and fd == owner._root.value:
                        raise error
                with patch.object(subject.os, 'link', side_effect=link), patch.object(subject.os, 'fsync', side_effect=sync):
                    self.assert_public(lambda: self.publish(owner, src_fd, src_root))
                self.assertIs(owner._first_failure, error)
                self.assertEqual((root / final).stat().st_nlink, 2)
                with patch.object(subject.os, 'pwrite', side_effect=AssertionError('write')), patch.object(subject.os, 'link', side_effect=AssertionError('link')), patch.object(subject.os, 'fsync', side_effect=AssertionError('sync')), patch.object(subject.os, 'unlink', side_effect=AssertionError('unlink')):
                    observed = owner.reconcile()
                    self.assertTrue(observed.final_present and observed.complete_bytes_observed)
                    self.assertFalse(observed.known_acknowledged)
                    self.assertEqual(owner.outcome().state, 'uncertain')
                    self.assert_public(lambda: self.publish(owner, src_fd, src_root))
                self.assertIs(owner._first_failure, error)

    def test_restart_cannot_recover_original_ack_or_publish(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            owner.reserve(root_fd)
            self.publish(owner, src_fd, src_root)
            owner.close()
            restarted = subject.HostReportCustody('bootstrap')
            try:
                with patch.object(subject.os, 'pwrite', side_effect=AssertionError('write')), patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocate')), patch.object(subject.os, 'link', side_effect=AssertionError('link')), patch.object(subject.os, 'fsync', side_effect=AssertionError('sync')):
                    observed = restarted.reconcile(root_fd)
                    self.assertTrue(observed.pending_present and observed.final_present and observed.aliases_valid)
                    self.assertFalse(observed.original_inode_observed or observed.complete_bytes_observed or observed.known_acknowledged)
                    self.assert_public(lambda: restarted.publish(src_fd, src_root, 6, sha(b'report')))
                    self.assert_public(lambda: restarted.reserve(root_fd))
            finally:
                restarted.close()
            self.assertEqual((root / final).read_bytes(), b'report')

    def test_reconcile_substitution_and_content_change_detected_without_repair(self):
        for case in ('substitution', 'content'):
            with self.subTest(case=case), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                self.publish(owner, src_fd, src_root)
                if case == 'substitution':
                    (root / final).unlink()
                    (root / final).write_bytes(b'report')
                else:
                    (root / pending).chmod(0o600)
                    (root / pending).write_bytes(b'change')
                    (root / pending).chmod(0o400)
                with patch.object(subject.os, 'pwrite', side_effect=AssertionError('repair')), patch.object(subject.os, 'unlink', side_effect=AssertionError('delete')):
                    self.assert_public(owner.reconcile)
                self.assertEqual(owner.outcome().state, 'uncertain')
                self.assertTrue(owner.outcome().known_acknowledged)

    def test_reconcile_raced_fifo_opens_nonblocking_then_refuses(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            owner.reserve(root_fd)
            real_open, calls = os.open, []
            def substitute(name, flags, *args, **kwargs):
                if name == pending:
                    self.assertTrue(flags & os.O_NONBLOCK)
                    (root / pending).rename(root / 'original')
                    os.mkfifo(root / pending)
                    calls.append('fifo')
                return real_open(name, flags, *args, **kwargs)
            with patch.object(subject.os, 'open', side_effect=substitute):
                self.assert_public(owner.reconcile)
            self.assertEqual(calls, ['fifo'])
            self.assertEqual(owner.outcome().first_failure_code, 'destination-changed')

    def test_close_once_lost_ack_numeric_reuse_and_all_eligible_closes(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            owner.reserve(root_fd)
            target, real_close, error = owner._report.value, os.close, PrivateFailure()
            calls, reused = [], []
            def close(fd):
                calls.append(fd)
                real_close(fd)
                if fd == target:
                    reused.append(os.dup(root_fd))
                    self.assertEqual(reused[0], target)
                    raise error
            try:
                with patch.object(subject.os, 'close', side_effect=close):
                    result = owner.close()
                    owner.close()
                self.assertEqual(calls.count(target), 1)
                self.assertEqual(len(calls), 2)
                self.assertEqual(result.state, 'uncertain')
                self.assertEqual(result.first_failure_code, 'incomplete')
                os.fstat(reused[0])
                os.fstat(root_fd)
            finally:
                for fd in reused:
                    real_close(fd)

    def test_close_error_after_ack_retains_historical_ack_and_original_private_error(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            owner.reserve(root_fd)
            self.publish(owner, src_fd, src_root)
            target, error, real_close = owner._root.value, PrivateFailure(), os.close
            calls = []
            def close(fd):
                calls.append(fd)
                real_close(fd)
                raise error
            with patch.object(subject.os, 'close', side_effect=close):
                outcome = owner.close()
                owner.close()
            self.assertEqual(calls, [target])
            self.assertIs(owner._first_failure, error)
            self.assertEqual(outcome.first_failure_phase, 'close')
            self.assertEqual(outcome.state, 'uncertain')
            self.assertTrue(outcome.known_acknowledged)

    def test_registration_before_followup_failure_allows_cleanup(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            error = PrivateFailure()
            with patch.object(subject.os, 'get_inheritable', side_effect=error):
                self.assert_public(lambda: owner.reserve(root_fd))
            duplicate = owner._root.value
            self.assertIsNotNone(duplicate)
            self.assertIs(owner._first_failure, error)
            owner.close()
            with self.assertRaises(OSError):
                os.fstat(duplicate)
            os.fstat(root_fd)

    def test_reconcile_close_failure_does_not_hide_behind_earlier_private_error(self):
        with self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
            first, later = PrivateFailure(), PrivateFailure()
            with patch.object(subject.os, 'posix_fallocate', side_effect=first):
                self.assert_public(lambda: owner.reserve(root_fd))
            real_close = os.close
            def close(fd):
                real_close(fd)
                raise later
            with patch.object(subject.os, 'close', side_effect=close):
                self.assert_public(owner.reconcile)
            self.assertIs(owner._first_failure, first)

    def test_single_thread_and_reentrant_refusal_have_no_native_effect(self):
        owner, results = subject.HostReportCustody('bootstrap'), []
        def other():
            try:
                owner.reserve(-1)
            except subject.CustodyError:
                results.append('refused')
        worker = threading.Thread(target=other)
        worker.start()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results, ['refused'])
        owner._busy = True
        try:
            with patch.object(subject.os, 'dup', side_effect=AssertionError('effect')):
                self.assert_public(lambda: owner.reserve(-1))
        finally:
            owner._busy = False
            owner.close()

    def test_fork_identity_and_reused_thread_identifier_do_not_transfer_owner(self):
        owner = subject.HostReportCustody('bootstrap')
        try:
            with patch.object(subject.os, 'getpid', return_value=owner._pid + 1), patch.object(subject.os, 'dup', side_effect=AssertionError('effect')):
                self.assert_public(lambda: owner.reserve(-1))
                self.assert_public(owner.outcome)
            # The numeric thread ID is unchanged; a different Thread object must
            # still refuse. No child process or fork is launched by this test.
            with patch.object(subject.threading, 'current_thread', return_value=object()), patch.object(subject.os, 'dup', side_effect=AssertionError('effect')):
                self.assert_public(lambda: owner.reserve(-1))
                self.assert_public(owner.outcome)
        finally:
            owner.close()

    def test_post_hash_destination_mutations_are_observed_at_seal_and_publication(self):
        for boundary in ('hash', 'mode', 'file-sync', 'link'):
            with self.subTest(boundary=boundary), self.fixture() as (owner, root, source, root_fd, src_root, src_fd, final, pending):
                owner.reserve(root_fd)
                report_fd = owner._report.value
                real_read, real_mode, real_sync, real_link = os.pread, os.fchmod, os.fsync, os.link
                changed = []
                def mutate():
                    if changed:
                        return
                    changed.append(True)
                    info = (root / pending).stat()
                    (root / pending).chmod(0o600)
                    with (root / pending).open('r+b') as stream:
                        stream.write(b'c')
                    os.utime(root / pending, ns=(info.st_atime_ns, info.st_mtime_ns + 1))
                    (root / pending).chmod(0o600 if boundary == 'hash' else 0o400)
                def read(fd, amount, offset):
                    result = real_read(fd, amount, offset)
                    if boundary == 'hash' and fd == report_fd and offset == 0:
                        mutate()
                    return result
                def mode(fd, bits):
                    real_mode(fd, bits)
                    if boundary == 'mode':
                        mutate()
                def sync(fd):
                    real_sync(fd)
                    if boundary == 'file-sync' and fd == report_fd:
                        mutate()
                def link(*args, **kwargs):
                    real_link(*args, **kwargs)
                    if boundary == 'link':
                        mutate()
                with patch.object(subject.os, 'pread', side_effect=read), patch.object(subject.os, 'fchmod', side_effect=mode), patch.object(subject.os, 'fsync', side_effect=sync), patch.object(subject.os, 'link', side_effect=link):
                    self.assert_public(lambda: self.publish(owner, src_fd, src_root))
                self.assertTrue(changed)
                self.assertEqual(owner.outcome().first_failure_code, 'destination-changed')
                self.assertFalse(owner.outcome().known_acknowledged)
                self.assertTrue((root / pending).exists())
                self.assertEqual((root / final).exists(), boundary == 'link')

    def test_module_has_no_observer_import_launcher_or_mutating_repair_path(self):
        tree = ast.parse(Path(subject.__file__).read_text())
        imports = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        imports |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        self.assertEqual(imports, {'fcntl', 'hashlib', 'os', 'stat', 'threading', 'dataclasses'})
        calls = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertTrue({'posix_fallocate', 'pread', 'pwrite', 'fsync', 'link'} <= calls)
        self.assertFalse({'unlink', 'replace', 'rename', 'system', 'spawn', 'Popen'} & calls)
        self.assertEqual(subject.REPORT_LIMIT, 1048576)


if __name__ == '__main__':
    unittest.main()
