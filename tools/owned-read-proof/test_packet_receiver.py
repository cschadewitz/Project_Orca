"""Real read-only native-FD verification in private synthetic temporary roots."""
import ast
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, replace
import hashlib
import fcntl
import stat
import os
from pathlib import Path
import pickle
import tempfile
import threading
import unittest
from unittest.mock import patch

import packet_receiver as subject


def sha(value):
    return hashlib.sha256(value).hexdigest()


class PrivateFailure(BaseException):
    def __str__(self):
        raise AssertionError('private string conversion')

    def __repr__(self):
        raise AssertionError('private representation')

    def __bool__(self):
        raise AssertionError('private truthiness')


class PacketReceiverTests(unittest.TestCase):
    @contextmanager
    def packet(self, payloads=(b'first', b'second', b''), edit=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            expected, lines, number = [], ['ORCA-UPLOAD-1\n'], 0
            for i, data in enumerate(payloads):
                identifier = f'{i + 1:032x}'
                expected.append(subject.ExpectedArtifact(identifier, len(data), sha(data)))
                count = (len(data) + subject.CHUNK_LIMIT - 1) // subject.CHUNK_LIMIT
                lines.append(f'A {identifier} {len(data)} {sha(data)} {count}\n')
                for offset in range(0, len(data), subject.CHUNK_LIMIT):
                    chunk = data[offset:offset + subject.CHUNK_LIMIT]
                    path = root / f'chunk-{number:08d}.bin'
                    path.write_bytes(chunk)
                    path.chmod(0o600)
                    lines.append(f'C {number:08d} {offset} {len(chunk)} {sha(chunk)}\n')
                    number += 1
            index = ''.join(lines).encode('ascii')
            if edit is not None:
                index = edit(index)
            (root / subject.INDEX_NAME).write_bytes(index)
            (root / subject.INDEX_NAME).chmod(0o600)
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            owner = subject.PacketReceiver()
            try:
                yield owner, root, root_fd, tuple(expected), sha(index)
            finally:
                owner.close()
                os.close(root_fd)

    def public(self, call):
        try:
            call()
        except subject.PacketError as error:
            self.assertEqual(str(error), 'private uploaded packet verification unavailable')
            self.assertIsNone(error.__context__)
            self.assertIsNone(error.__cause__)
        else:
            self.fail('missing fixed public refusal')

    def test_passive_constructor_private_owner_no_serialization(self):
        with patch.object(subject.os, 'open', side_effect=AssertionError('effect')):
            owner = subject.PacketReceiver()
        self.assertEqual(repr(owner), '<PacketReceiver>')
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with self.assertRaisesRegex(TypeError, 'cannot be serialized'):
                pickle.dumps(owner, protocol)
        owner.close()

    def test_exact_declared_inventory_and_immutable_scope_counts_preserve_borrowed_root(self):
        with self.packet() as (owner, root, fd, expected, digest):
            os.lseek(fd, 1, os.SEEK_SET)
            result = owner.verify(fd, digest, expected)
            self.assertEqual(result, subject.ByteVerification('declared-upload-bytes-only', 3, 2, 11,
                                                             (root / subject.INDEX_NAME).stat().st_size))
            with self.assertRaises(FrozenInstanceError):
                result.payload_bytes = 0
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 1)
            self.assertEqual(owner.outcome().state, 'verified')
            self.assertTrue(owner.outcome().closed)
            self.assertTrue(all(entry.fd is None for entry in owner._files))
            self.assertIsNone(owner._root.fd)
            self.public(lambda: owner.verify(fd, digest, expected))
            os.fstat(fd)

    def test_real_artifact_above_chunk_ceiling_whole_hash_and_bounded_pread(self):
        data = bytes(range(256)) * (subject.CHUNK_LIMIT // 256 + 23)
        with self.packet((data,)) as (owner, root, fd, expected, digest):
            real_read, calls = os.pread, []
            def read(descriptor, amount, offset):
                self.assertLessEqual(amount, subject.READ_SIZE)
                calls.append((amount, offset))
                return real_read(descriptor, amount, offset)
            with patch.object(subject.os, 'pread', side_effect=read):
                result = owner.verify(fd, digest, expected)
            self.assertEqual(result.chunks, 2)
            self.assertEqual(result.payload_bytes, len(data))
            self.assertEqual((root / 'chunk-00000000.bin').stat().st_size, subject.CHUNK_LIMIT)
            self.assertEqual((root / 'chunk-00000001.bin').stat().st_size, len(data) - subject.CHUNK_LIMIT)
            self.assertGreater(len(calls), 256)

    def test_positive_short_reads_are_progress(self):
        with self.packet((b'a' * 200000,)) as (owner, root, fd, expected, digest):
            real_read = os.pread
            with patch.object(subject.os, 'pread', side_effect=lambda f, n, o: real_read(f, min(n, 113), o)):
                self.assertEqual(owner.verify(fd, digest, expected).payload_bytes, 200000)

    def test_expected_inputs_mandatory_exact_and_precede_any_native_open(self):
        artifact = subject.ExpectedArtifact('0' * 32, 0, sha(b''))
        cases = ((None, (artifact,)), ('bad', (artifact,)), (sha(b''), []), (sha(b''), ()),
                 (sha(b''), (replace(artifact, size=True),)),
                 (sha(b''), (replace(artifact, size=-1),)),
                 (sha(b''), (replace(artifact, size=subject.MAX_DECLARED_BYTES + 1),)),
                 (sha(b''), (replace(artifact, identifier='../private'),)),
                 (sha(b''), (replace(artifact, sha256='secret'),)),
                 (sha(b''), (artifact, artifact)),
                 (sha(b''), tuple(artifact for _ in range(subject.MAX_ARTIFACTS + 1))))
        for digest, expected in cases:
            owner = subject.PacketReceiver()
            with self.subTest(size=len(expected)), patch.object(subject.os, 'open', side_effect=AssertionError('effect')):
                self.public(lambda: owner.verify(-1, digest, expected))
                self.assertEqual(owner.outcome().state, 'uncertain')
                self.assertTrue(owner.outcome().closed)

    def test_receiver_work_bounds_are_independent_of_source_quota(self):
        expected = tuple(subject.ExpectedArtifact(f'{i:032x}', subject.MAX_DECLARED_BYTES, sha(b''))
                         for i in (1, 2))
        owner = subject.PacketReceiver()
        with patch.object(subject.os, 'open', side_effect=AssertionError('effect')):
            self.public(lambda: owner.verify(-1, sha(b''), expected))
        self.assertEqual(owner.outcome().first_failure_code, 'receiver-bound')
        with self.packet() as (owner, root, fd, expected, digest):
            with patch.object(subject, 'MAX_CHUNKS', 1):
                self.public(lambda: owner.verify(fd, digest, expected))
            self.assertEqual(owner.outcome().first_failure_code, 'receiver-bound')

    def test_independent_index_digest_and_entire_inventory_cannot_be_self_declared(self):
        for case in ('digest', 'artifact-hash', 'artifact-size', 'missing-artifact', 'extra-artifact', 'order'):
            with self.subTest(case=case), self.packet() as (owner, root, fd, expected, digest):
                if case == 'digest':
                    digest = sha(b'other index')
                elif case == 'artifact-hash':
                    expected = (replace(expected[0], sha256=sha(b'other')), *expected[1:])
                elif case == 'artifact-size':
                    expected = (replace(expected[0], size=6), *expected[1:])
                elif case == 'missing-artifact':
                    expected = expected[:-1]
                elif case == 'extra-artifact':
                    expected += (subject.ExpectedArtifact('f' * 32, 0, sha(b'')),)
                else:
                    expected = tuple(reversed(expected))
                self.public(lambda: owner.verify(fd, digest, expected))
                self.assertEqual(owner.outcome().state, 'uncertain')

    def test_missing_extra_and_unexpected_directory_entries(self):
        for case in ('missing', 'extra', 'directory', 'unexpected-name'):
            with self.subTest(case=case), self.packet() as (owner, root, fd, expected, digest):
                if case == 'missing':
                    (root / 'chunk-00000000.bin').unlink()
                elif case == 'extra':
                    (root / 'chunk-00000002.bin').write_bytes(b'')
                elif case == 'directory':
                    (root / 'hidden').mkdir()
                else:
                    (root / 'private-path-or-token').write_bytes(b'secret')
                self.public(lambda: owner.verify(fd, digest, expected))
                self.assertEqual(owner.outcome().first_failure_code, 'inventory')

    def test_corruption_truncation_growth_and_whole_hash(self):
        for case in ('corrupt', 'truncate', 'growth', 'chunk-hash', 'whole-hash'):
            edit = None
            if case == 'chunk-hash':
                edit = lambda index: index.replace(sha(b'first').encode(), sha(b'other').encode(), 1)
            if case == 'whole-hash':
                # Give the index AND independent inventory the same incorrect
                # whole hash but correct chunk hashes: whole-byte hashing refuses.
                edit = lambda index: index.replace(sha(b'first').encode(), sha(b'other').encode(), 1)
            with self.subTest(case=case), self.packet(edit=edit) as (owner, root, fd, expected, digest):
                path = root / 'chunk-00000000.bin'
                if case == 'corrupt':
                    path.write_bytes(b'other')
                elif case == 'truncate':
                    path.write_bytes(b'firs')
                elif case == 'growth':
                    path.write_bytes(b'first!')
                elif case == 'chunk-hash':
                    # Replace only the C line hash, preserving the independently
                    # expected A row and expected whole-artifact hash.
                    data = (root / subject.INDEX_NAME).read_bytes()
                    data = data.replace(sha(b'other').encode(), sha(b'first').encode(), 1)
                    lines = data.splitlines(keepends=True)
                    lines[2] = lines[2].replace(sha(b'first').encode(), sha(b'other').encode())
                    data = b''.join(lines)
                    (root / subject.INDEX_NAME).write_bytes(data)
                    digest = sha(data)
                else:
                    expected = (replace(expected[0], sha256=sha(b'other')), *expected[1:])
                self.public(lambda: owner.verify(fd, digest, expected))
                self.assertEqual(owner.outcome().state, 'uncertain')
                if case == 'whole-hash':
                    self.assertEqual(owner.outcome().first_failure_code, 'artifact-digest')

    def test_malformed_index_offsets_counts_duplicates_reordering_and_extra_rows(self):
        transforms = (
            lambda x: x.replace(b'ORCA-UPLOAD-1', b'ORCA-UPLOAD-2'),
            lambda x: x.replace(b' 5 ', b' 05 ', 1),
            lambda x: x.replace(b'C 00000000 0 ', b'C 00000000 1 '),
            lambda x: x.replace(b'C 00000000 0 5 ', b'C 00000000 0 6 '),
            lambda x: x.replace(b'C 00000000 0 5 ', b'C 00000000 0 0 '),
            lambda x: x.replace(b'C 00000001 0 ', b'C 00000000 0 '),
            lambda x: x.replace(b'C 00000000', b'C 00000001'),
            lambda x: x.replace(b' 1\nC ', b' 2\nC ', 1),
            lambda x: x.replace(b'\n', b'\r\n'),
            lambda x: x.replace(b'A ', b'A  ', 1),
            lambda x: x + b'C 00000002 0 0 ' + b'0' * 64 + b'\n',
            lambda x: x[:-1],
            lambda x: x + b'\xff\n',
            lambda x: b'x' * subject.MAX_LINE_BYTES + b'\n',
            lambda x: b'ORCA-UPLOAD-1\n{"path":"../secret"}\n',
        )
        for i, edit in enumerate(transforms):
            with self.subTest(i=i), self.packet(edit=edit) as (owner, root, fd, expected, digest):
                self.public(lambda: owner.verify(fd, digest, expected))
                self.assertEqual(owner.outcome().first_failure_phase, 'index')

    def test_oversize_index_refuses_before_index_pread(self):
        with self.packet() as (owner, root, fd, expected, digest):
            with (root / subject.INDEX_NAME).open('r+b') as stream:
                stream.truncate(subject.MAX_INDEX_BYTES + 1)
            with patch.object(subject.os, 'pread', side_effect=AssertionError('oversize read')):
                self.public(lambda: owner.verify(fd, digest, expected))
            self.assertEqual(owner.outcome().first_failure_code, 'index-bound')

    def test_root_and_file_native_protection_symlinks_fifos_aliases(self):
        for case in ('root-mode', 'root-file', 'root-path-fd', 'file-mode', 'symlink', 'fifo', 'hardlink', 'index-alias'):
            with self.subTest(case=case), self.packet() as (owner, root, fd, expected, digest):
                borrowed, extra = fd, None
                path = root / 'chunk-00000000.bin'
                if case == 'root-mode':
                    root.chmod(0o755)
                elif case == 'root-file':
                    borrowed = extra = os.open(root / subject.INDEX_NAME, os.O_RDONLY)
                elif case == 'root-path-fd':
                    borrowed = extra = os.open(root, os.O_PATH)
                elif case == 'file-mode':
                    path.chmod(0o644)
                elif case == 'symlink':
                    path.unlink()
                    path.symlink_to('chunk-00000001.bin')
                elif case == 'fifo':
                    path.unlink()
                    os.mkfifo(path, 0o600)
                elif case == 'hardlink':
                    (root / 'chunk-00000001.bin').unlink()
                    os.link(path, root / 'chunk-00000001.bin')
                elif case == 'index-alias':
                    path.unlink()
                    os.link(root / subject.INDEX_NAME, path)
                try:
                    self.public(lambda: owner.verify(borrowed, digest, expected))
                finally:
                    if extra is not None:
                        os.close(extra)

    def test_mutation_after_read_or_after_earlier_artifact_is_detected(self):
        for case in ('index', 'chunk', 'earlier-chunk', 'path-replacement', 'extra-after-scan'):
            with self.subTest(case=case), self.packet() as (owner, root, fd, expected, digest):
                real_read, changed = os.pread, []
                def read(descriptor, amount, offset):
                    result = real_read(descriptor, amount, offset)
                    index_fd = owner._files[0].fd
                    first_fd = owner._files[1].fd
                    second_fd = owner._files[2].fd
                    should = ((case == 'index' and descriptor == index_fd) or
                              (case in ('chunk', 'path-replacement') and descriptor == first_fd) or
                              (case in ('earlier-chunk', 'extra-after-scan') and descriptor == second_fd))
                    if should and not changed:
                        changed.append(True)
                        path = root / (subject.INDEX_NAME if case == 'index' else 'chunk-00000000.bin')
                        if case == 'path-replacement':
                            path.unlink()
                            path.write_bytes(b'first')
                            path.chmod(0o600)
                        elif case == 'extra-after-scan':
                            (root / 'extra').write_bytes(b'')
                        else:
                            with path.open('r+b') as stream:
                                stream.write(b'x')
                            info = path.stat()
                            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1))
                    return result
                with patch.object(subject.os, 'pread', side_effect=read):
                    self.public(lambda: owner.verify(fd, digest, expected))
                self.assertTrue(changed)

    def test_mutation_during_close_rejected_before_result(self):
        with self.packet() as (owner, root, fd, expected, digest):
            real_close, changed = os.close, []
            def close(descriptor):
                if owner._files and descriptor == owner._files[0].fd:
                    self.fail('descriptor must be consumed before close')
                readable_file = (stat.S_ISREG(os.fstat(descriptor).st_mode) and
                                 not fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_PATH)
                real_close(descriptor)
                if readable_file and not changed:
                    changed.append(True)
                    (root / 'chunk-00000000.bin').write_bytes(b'other')
            with patch.object(subject.os, 'close', side_effect=close):
                self.public(lambda: owner.verify(fd, digest, expected))
            self.assertEqual(owner.outcome().first_failure_code, 'input-changed')

    def test_native_failure_privacy_first_error_precedence_and_absorbing_no_retry(self):
        with self.packet() as (owner, root, fd, expected, digest):
            first, later, real_close = PrivateFailure(), PrivateFailure(), os.close
            calls, reads = [], []
            def read_failure(*args):
                reads.append(True)
                raise first
            def close(descriptor):
                calls.append(descriptor)
                real_close(descriptor)
                if reads:
                    raise later
            with patch.object(subject.os, 'pread', side_effect=read_failure) as read, patch.object(subject.os, 'close', side_effect=close):
                self.public(lambda: owner.verify(fd, digest, expected))
                self.public(lambda: owner.verify(fd, digest, expected))
                owner.close()
                self.assertEqual(read.call_count, 1)
            self.assertIs(owner._first_failure, first)
            self.assertEqual(owner.outcome().first_failure_phase, 'index')
            self.assertEqual(len(calls), len(set(calls)))
            os.fstat(fd)

    def test_close_lost_ack_numeric_reuse_is_never_retried(self):
        with self.packet((b'first',)) as (owner, root, fd, expected, digest):
            real_close, error, calls, reused = os.close, PrivateFailure(), [], []
            def close(descriptor):
                calls.append(descriptor)
                real_close(descriptor)
                if not reused:
                    reused.append(os.dup(fd))
                    self.assertEqual(reused[0], descriptor)
                    raise error
            try:
                with patch.object(subject.os, 'close', side_effect=close):
                    self.public(lambda: owner.verify(fd, digest, expected))
                    owner.close()
                self.assertIs(owner._first_failure, error)
                self.assertEqual(calls.count(reused[0]), 1)
                os.fstat(reused[0])
                self.assertIsNone(owner._root.fd)
                self.assertTrue(all(entry.fd is None for entry in owner._files))
            finally:
                for descriptor in reused:
                    real_close(descriptor)

    def test_open_registration_before_followup_failure(self):
        with self.packet() as (owner, root, fd, expected, digest):
            real_close, calls, error = os.close, [], PrivateFailure()
            def close(descriptor):
                calls.append(descriptor)
                real_close(descriptor)
            with patch.object(subject.os, 'get_inheritable', side_effect=error), patch.object(subject.os, 'close', side_effect=close):
                self.public(lambda: owner.verify(fd, digest, expected))
            self.assertIs(owner._first_failure, error)
            self.assertEqual(len(calls), 1)
            self.assertIsNone(owner._root.fd)
            os.fstat(fd)

    def test_scan_detection_precedes_close_failure_with_real_iterator(self):
        with self.packet() as (owner, root, fd, expected, digest):
            (root / 'unexpected-private-name').write_bytes(b'')
            real_scan, later, closed = os.scandir, PrivateFailure(), []
            class LostClose:
                def __init__(self, descriptor):
                    self.original = real_scan(descriptor)
                def __iter__(self):
                    return self
                def __next__(self):
                    return next(self.original)
                def close(self):
                    self.original.close()
                    closed.append(True)
                    raise later
            with patch.object(subject.os, 'scandir', side_effect=LostClose):
                self.public(lambda: owner.verify(fd, digest, expected))
            self.assertEqual(closed, [True])
            self.assertEqual(owner.outcome().first_failure_code, 'inventory')
            self.assertIsNot(owner._first_failure, later)
            self.assertIsNone(owner._scan)

    def test_all_open_registration_boundaries_close_original_descriptors_once(self):
        for failure_call in (1, 2, 3, 4, 5):
            with self.subTest(failure_call=failure_call), self.packet() as (owner, root, fd, expected, digest):
                real_check, real_close, error = os.get_inheritable, os.close, PrivateFailure()
                checks, closes = [], []
                def inheritable(descriptor):
                    checks.append(descriptor)
                    if len(checks) == failure_call:
                        raise error
                    return real_check(descriptor)
                def close(descriptor):
                    closes.append(descriptor)
                    real_close(descriptor)
                with patch.object(subject.os, 'get_inheritable', side_effect=inheritable), patch.object(subject.os, 'close', side_effect=close):
                    self.public(lambda: owner.verify(fd, digest, expected))
                self.assertIs(owner._first_failure, error)
                self.assertEqual(len(closes), failure_call)
                self.assertEqual(set(checks), set(closes))
                os.fstat(fd)

    def test_special_inputs_never_receive_a_read_open(self):
        for target in (subject.INDEX_NAME, 'chunk-00000000.bin'):
            for kind in ('fifo', 'symlink', 'device-stat'):
                with self.subTest(target=target, kind=kind), self.packet() as (owner, root, fd, expected, digest):
                    path = root / target
                    if kind == 'fifo':
                        path.unlink()
                        os.mkfifo(path, 0o600)
                    elif kind == 'symlink':
                        path.unlink()
                        path.symlink_to('chunk-00000001.bin')
                    real_open, real_stat, pinned, attempted = os.open, os.fstat, [], []
                    def open_checked(name, flags, *args, **kwargs):
                        if name != '.' and not name.startswith('/proc/self/fd/'):
                            self.assertTrue(flags & os.O_PATH)
                        if name.startswith('/proc/self/fd/'):
                            number = int(name.rsplit('/', 1)[1])
                            if number in pinned:
                                attempted.append(True)
                                raise AssertionError('unvalidated special-file read-open')
                            self.assertTrue(stat.S_ISREG(real_stat(number).st_mode))
                        opened = real_open(name, flags, *args, **kwargs)
                        if name == target:
                            pinned.append(opened)
                        return opened
                    def fstat(descriptor):
                        info = real_stat(descriptor)
                        if kind == 'device-stat' and descriptor in pinned:
                            # No real device is created/opened. The actual O_PATH
                            # FD receives the same type check as a device inode.
                            fields = list(info)
                            fields[0] = stat.S_IFCHR | 0o600
                            return os.stat_result(fields)
                        return info
                    with patch.object(subject.os, 'open', side_effect=open_checked), patch.object(subject.os, 'fstat', side_effect=fstat):
                        self.public(lambda: owner.verify(fd, digest, expected))
                    self.assertTrue(pinned)
                    self.assertEqual(attempted, [])
                    self.assertEqual(owner.outcome().first_failure_code, 'protection')
                    self.assertIsNone(owner._pin.fd)

    def test_procfd_reader_remains_regular_when_candidate_path_becomes_fifo(self):
        with self.packet() as (owner, root, fd, expected, digest):
            real_open, changed = os.open, []
            def open_checked(name, flags, *args, **kwargs):
                if name.startswith('/proc/self/fd/') and not changed:
                    pin = int(name.rsplit('/', 1)[1])
                    self.assertTrue(stat.S_ISREG(os.fstat(pin).st_mode))
                    (root / subject.INDEX_NAME).rename(root / 'retained-original')
                    os.mkfifo(root / subject.INDEX_NAME, 0o600)
                    changed.append(True)
                    reader = real_open(name, flags, *args, **kwargs)
                    self.assertTrue(stat.S_ISREG(os.fstat(reader).st_mode))
                    return reader
                return real_open(name, flags, *args, **kwargs)
            with patch.object(subject.os, 'open', side_effect=open_checked), patch.object(subject.os, 'pread', side_effect=AssertionError('post-substitution read')) as read:
                self.public(lambda: owner.verify(fd, digest, expected))
            self.assertTrue(changed)
            self.assertEqual(read.call_count, 0)
            self.assertEqual(owner.outcome().first_failure_code, 'input-changed')
            self.assertIsNone(owner._pin.fd)

    def test_pin_close_uncertainty_blocks_reads_and_never_closes_reused_pin(self):
        for failure_close in (1, 2):
            with self.subTest(failure_close=failure_close), self.packet() as (owner, root, fd, expected, digest):
                real_close, real_read, error = os.close, os.pread, PrivateFailure()
                pin_closes, reused, reads_after_failure, closes, failure_position = [], [], [], [], []
                def close(descriptor):
                    is_pin = bool(fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_PATH)
                    closes.append(descriptor)
                    real_close(descriptor)
                    if is_pin:
                        pin_closes.append(descriptor)
                        if len(pin_closes) == failure_close:
                            reused.append(os.dup(fd))
                            self.assertEqual(reused[0], descriptor)
                            failure_position.append(len(closes))
                            raise error
                def read(descriptor, amount, offset):
                    if reused:
                        reads_after_failure.append(True)
                        raise AssertionError('read after uncertain pin close')
                    return real_read(descriptor, amount, offset)
                try:
                    with patch.object(subject.os, 'close', side_effect=close), patch.object(subject.os, 'pread', side_effect=read):
                        self.public(lambda: owner.verify(fd, digest, expected))
                        owner.close()
                    self.assertIs(owner._first_failure, error)
                    self.assertEqual(owner.outcome().first_failure_phase, 'close')
                    self.assertEqual(reads_after_failure, [])
                    # The index pin's number can be reused for the next chunk
                    # pin before failure; no close follows the failed consumption.
                    self.assertEqual(closes[failure_position[0]:].count(reused[0]), 0)
                    os.fstat(reused[0])
                    self.assertIsNone(owner._pin.fd)
                    self.assertIsNone(owner._root.fd)
                    self.assertTrue(all(entry.fd is None for entry in owner._files))
                finally:
                    for descriptor in reused:
                        real_close(descriptor)

    def test_zero_and_oversize_native_read_progress_refuse(self):
        for mode in ('zero', 'oversize'):
            with self.subTest(mode=mode), self.packet() as (owner, root, fd, expected, digest):
                def read(descriptor, amount, offset):
                    return b'' if mode == 'zero' else b'x' * (amount + 1)
                with patch.object(subject.os, 'pread', side_effect=read) as native_read:
                    self.public(lambda: owner.verify(fd, digest, expected))
                self.assertEqual(native_read.call_count, 1)
                self.assertEqual(owner.outcome().first_failure_code, 'read-size')

    def test_origin_process_thread_reentrancy_and_pickle_refuse_without_io(self):
        owner = subject.PacketReceiver()
        with patch.object(subject.os, 'getpid', return_value=owner._pid + 1):
            self.public(lambda: owner.verify(-1, 'x', ()))
            self.public(owner.close)
        with patch.object(subject.threading, 'current_thread', return_value=object()):
            self.public(lambda: owner.verify(-1, 'x', ()))
        results = []
        def other():
            try:
                owner.verify(-1, 'x', ())
            except subject.PacketError:
                results.append('refused')
        worker = threading.Thread(target=other)
        worker.start()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results, ['refused'])
        owner._busy = True
        try:
            self.public(lambda: owner.verify(-1, 'x', ()))
            self.public(owner.close)
        finally:
            owner._busy = False
            owner.close()

    def test_source_qualification_refuses_even_after_byte_verification(self):
        with self.packet() as (owner, root, fd, expected, digest):
            self.assertEqual(owner.verify(fd, digest, expected).scope, 'declared-upload-bytes-only')
        with self.assertRaisesRegex(subject.SourcePacketUnavailable, '^current source packet qualification unavailable$'):
            subject.certify_current_source_packet()
        self.assertIn('clock-trace-source-byte-cap-missing', subject.source_packet_gaps())
        self.assertIn('enabled-diagnostic-serialized-cap-missing', subject.source_packet_gaps())
        self.assertIn('checkpoint-standalone-budget-policy-missing', subject.source_packet_gaps())

    def test_source_has_no_writer_observer_reconstruction_or_authority_import(self):
        tree = ast.parse(Path(subject.__file__).read_text())
        imports = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        imports |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        self.assertEqual(imports, {'fcntl', 'hashlib', 'os', 'stat', 'sys', 'threading', 'dataclasses'})
        calls = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertFalse({'write', 'pwrite', 'unlink', 'replace', 'rename', 'mkdir', 'fsync', 'Popen', 'system'} & calls)
        self.assertEqual(subject.CHUNK_LIMIT, 16 * 1024 * 1024)
        self.assertEqual(subject.READ_SIZE, 65536)


if __name__ == '__main__':
    unittest.main()
