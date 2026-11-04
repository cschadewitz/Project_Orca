"""Real owned local FD allocation/copy/publication; no host or observation calls."""
import ast
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, replace
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

import packet_exporter as subject
from host_report_custody import HostReportCustody
from packet_receiver import (PacketReceiver, PacketError, ExpectedArtifact,
                             SourcePacketUnavailable, certify_current_source_packet)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PrivateFailure(BaseException):
    def __str__(self):
        raise AssertionError('private error formatting')

    def __repr__(self):
        raise AssertionError('private error representation')

    def __bool__(self):
        raise AssertionError('private error truthiness')


class PacketExporterTests(unittest.TestCase):
    @contextmanager
    def fixture(self, payloads=(b'first', b'second', b'')):
        with tempfile.TemporaryDirectory(prefix='orca-export-test-') as directory:
            root = Path(directory)
            source, target = root / 'source', root / 'target'
            source.mkdir(mode=0o700); target.mkdir(mode=0o700)
            expected, descriptors, paths = [], [], []
            target_fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
            owner = subject.PacketExporter()
            try:
                for i, data in enumerate(payloads):
                    path = source / f'artifact-{i}'
                    path.write_bytes(data); path.chmod(0o600)
                    descriptors.append(os.open(path, os.O_RDONLY))
                    paths.append(path)
                    expected.append(ExpectedArtifact(f'{i + 1:032x}', len(data), sha(data)))
                capacity = sum(map(len, payloads)) + subject.MAX_INDEX_BYTES
                yield owner, target, target_fd, tuple(descriptors), tuple(expected), capacity, paths
            finally:
                owner.close()
                for number in descriptors:
                    os.close(number)
                os.close(target_fd)

    def public(self, call):
        with self.assertRaises(subject.ExportError) as caught:
            call()
        self.assertEqual(str(caught.exception), 'private packet export unavailable')
        self.assertIsNone(caught.exception.__context__)
        self.assertIsNone(caught.exception.__cause__)

    def verified(self, root_fd, plan):
        return PacketReceiver().verify(root_fd, plan.index_sha256, plan.inventory)

    def test_passive_constructor_and_original_owner_not_serializable(self):
        with patch.object(subject.os, 'open', side_effect=AssertionError('native effect')):
            owner = subject.PacketExporter()
        self.assertEqual(repr(owner), '<PacketExporter>')
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with self.assertRaisesRegex(TypeError, 'cannot be serialized'):
                pickle.dumps(owner, protocol)
        self.assertEqual(owner.close().state, 'closed')

    def test_real_two_stage_export_roundtrip_including_empty_and_borrowed_offsets(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            os.lseek(root_fd, 1, os.SEEK_SET)
            for number in fds: os.lseek(number, 2, os.SEEK_SET)
            plan = owner.prepare(fds, expected, root_fd, capacity)
            self.assertEqual(plan.scope, 'declared-export-bytes-only')
            self.assertEqual((plan.payload_bytes, plan.chunks), (11, 2))
            self.assertEqual(plan.reserved_data_bytes, 11 + plan.index_bytes)
            self.assertEqual(list(target.iterdir()), [])
            self.assertEqual(owner.outcome().state, 'prepared')
            with self.assertRaises(FrozenInstanceError): plan.scope = 'authority'
            self.assertEqual(owner.publish().state, 'published')
            self.assertTrue(owner.outcome().closed)
            result = self.verified(root_fd, plan)
            self.assertEqual((result.artifacts, result.chunks, result.payload_bytes), (3, 2, 11))
            self.assertEqual(os.lseek(root_fd, 0, os.SEEK_CUR), 1)
            for number in fds:
                self.assertEqual(os.lseek(number, 0, os.SEEK_CUR), 2)
                os.fstat(number)
            for path in target.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
                self.assertEqual(path.stat().st_nlink, 1)
            self.public(owner.publish)
            self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))

    def test_above_chunk_ceiling_exact_index_whole_digest_and_bounded_io(self):
        data = bytes(range(256)) * (subject.CHUNK_LIMIT // 256 + 13)
        with self.fixture((data,)) as (owner, target, root_fd, fds, expected, capacity, _):
            read, write, allocations, first_write = os.pread, os.pwrite, [], []
            allocate = os.posix_fallocate
            def fallocate(number, offset, size):
                allocations.append(size)
                allocate(number, offset, size)
            def pread(number, amount, offset):
                self.assertLessEqual(amount, 65536)
                return read(number, amount, offset)
            def pwrite(number, value, offset):
                self.assertLessEqual(len(value), 65536)
                if not first_write:
                    self.assertEqual(len(allocations), 3)  # Two chunks + exact index, all before copy.
                    first_write.append(True)
                return write(number, value, offset)
            with patch.object(subject.os, 'posix_fallocate', side_effect=fallocate), \
                    patch.object(subject.os, 'pread', side_effect=pread), \
                    patch.object(subject.os, 'pwrite', side_effect=pwrite):
                plan = owner.prepare(fds, expected, root_fd, capacity)
                self.assertEqual(allocations, [subject.CHUNK_LIMIT, len(data) - subject.CHUNK_LIMIT, plan.index_bytes])
                owner.publish()
            self.assertEqual(self.verified(root_fd, plan).payload_bytes, len(data))
            self.assertEqual((target / 'chunk-00000000.bin').stat().st_size, subject.CHUNK_LIMIT)
            self.assertEqual((target / 'chunk-00000001.bin').stat().st_size, len(data) - subject.CHUNK_LIMIT)

    def test_empty_only_artifact_allocates_index_and_no_payload_chunk(self):
        with self.fixture((b'',)) as (owner, target, root_fd, fds, expected, capacity, _):
            plan = owner.prepare(fds, expected, root_fd, capacity)
            self.assertEqual((plan.payload_bytes, plan.chunks, plan.reserved_data_bytes), (0, 0, plan.index_bytes))
            owner.publish()
            self.assertEqual([p.name for p in target.iterdir()], ['packet-index.v1'])
            self.assertEqual(self.verified(root_fd, plan).artifacts, 1)

    def test_positive_short_reads_and_writes_progress_without_prefix_acceptance(self):
        with self.fixture((b'x' * 200000,)) as (owner, _, root_fd, fds, expected, capacity, _):
            read, write = os.pread, os.pwrite
            with patch.object(subject.os, 'pread', side_effect=lambda f, n, o: read(f, min(n, 113), o)), \
                    patch.object(subject.os, 'pwrite', side_effect=lambda f, v, o: write(f, v[:37], o)):
                plan = owner.prepare(fds, expected, root_fd, capacity)
                owner.publish()
            self.assertEqual(self.verified(root_fd, plan).payload_bytes, 200000)

    def test_exact_scalar_inventory_capacity_checks_precede_native_acquisitions(self):
        item = ExpectedArtifact('0' * 32, 0, sha(b''))
        cases = (((), (), 1000), ([0], (item,), 1000), ((0,), [item], 1000),
                 ((True,), (item,), 1000), ((-1,), (item,), 1000),
                 ((0,), (replace(item, identifier='../private'),), 1000),
                 ((0,), (replace(item, size=True),), 1000),
                 ((0,), (replace(item, size=-1),), 1000),
                 ((0,), (replace(item, size=subject.MAX_DECLARED_BYTES + 1),), 1000),
                 ((0,), (replace(item, sha256='private'),), 1000),
                 ((0, 1), (item, item), 1000), ((0,), (item,), False),
                 ((0,), (item,), 0), ((0,), (item,), 1),
                 ((0,), (item,), subject.MAX_DECLARED_BYTES + subject.MAX_INDEX_BYTES + 1),
                 (tuple(range(subject.MAX_ARTIFACTS + 1)), (item,) * (subject.MAX_ARTIFACTS + 1), 1000))
        for fds, expected, capacity in cases:
            owner = subject.PacketExporter()
            with self.subTest(count=len(expected)), \
                    patch.object(subject.os, 'open', side_effect=AssertionError('native acquisition')), \
                    patch.object(subject.os, 'dup', side_effect=AssertionError('native acquisition')):
                self.public(lambda: owner.prepare(fds, expected, -1, capacity))
            self.assertEqual(owner.outcome().state, 'uncertain')
            self.assertTrue(owner.outcome().closed)

    def test_payload_and_chunk_bounds_precede_native_effects(self):
        cases = ((ExpectedArtifact('1' * 32, subject.MAX_DECLARED_BYTES, sha(b'')),
                  ExpectedArtifact('2' * 32, 1, sha(b''))),)
        for expected in cases:
            owner = subject.PacketExporter()
            with patch.object(subject.os, 'dup', side_effect=AssertionError('native acquisition')):
                self.public(lambda: owner.prepare((0, 1), expected, -1,
                                                  subject.MAX_DECLARED_BYTES + subject.MAX_INDEX_BYTES))
            self.assertEqual(owner.outcome().first_failure_code, 'export-bound')
        with self.fixture((b'x' * (subject.CHUNK_LIMIT + 1),)) as (owner, target, root_fd, fds, expected, capacity, _):
            with patch.object(subject, 'MAX_CHUNKS', 1), patch.object(subject.os, 'dup', side_effect=AssertionError('native acquisition')):
                self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))
            self.assertEqual(list(target.iterdir()), [])

    def test_exact_capacity_succeeds_one_byte_less_refuses_before_allocation(self):
        with self.fixture((b'abc',)) as (owner, _, root_fd, fds, expected, capacity, _):
            plan = owner.prepare(fds, expected, root_fd, capacity)
            exact = plan.reserved_data_bytes
            owner.close()
        for shortage in (0, 1):
            with self.fixture((b'abc',)) as (owner, target, root_fd, fds, expected, _, _):
                if shortage:
                    with patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocation')):
                        self.public(lambda: owner.prepare(fds, expected, root_fd, exact - 1))
                    self.assertEqual(list(target.iterdir()), [])
                else:
                    self.assertEqual(owner.prepare(fds, expected, root_fd, exact).reserved_data_bytes, exact)

    def test_all_source_hashes_and_no_duplicate_inode_before_any_allocation(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            bad = (*expected[:-1], replace(expected[-1], sha256=sha(b'wrong last source')))
            with patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocation')):
                self.public(lambda: owner.prepare(fds, bad, root_fd, capacity))
            self.assertEqual(owner.outcome().first_failure_code, 'source-digest')
            self.assertEqual(list(target.iterdir()), [])
        with self.fixture((b'x', b'x')) as (owner, target, root_fd, fds, expected, capacity, _):
            with patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocation')):
                self.public(lambda: owner.prepare((fds[0], fds[0]), expected, root_fd, capacity))
            self.assertEqual(owner.outcome().first_failure_code, 'source-alias')

    def test_source_type_flags_mode_and_link_bound_refuse_before_reads_or_allocations(self):
        for case in ('mode', 'links', 'writable', 'path-only', 'directory'):
            with self.subTest(case=case), self.fixture((b'x',)) as (owner, target, root_fd, fds, expected, capacity, paths):
                extra = None
                if case == 'mode': paths[0].chmod(0o644)
                elif case == 'links':
                    os.link(paths[0], paths[0].with_name('alias1'))
                    os.link(paths[0], paths[0].with_name('alias2'))
                elif case == 'writable': extra = os.open(paths[0], os.O_RDWR)
                elif case == 'path-only': extra = os.open(paths[0], os.O_PATH)
                else: extra = os.open(paths[0].parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with patch.object(subject.os, 'pread', side_effect=AssertionError('source read')), \
                            patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocation')):
                        self.public(lambda: owner.prepare((extra,) if extra is not None else fds, expected, root_fd, capacity))
                finally:
                    if extra is not None: os.close(extra)
                self.assertEqual(list(target.iterdir()), [])

    def test_private_empty_root_and_independent_directory_position_required(self):
        for case in ('mode', 'extra', 'path-only'):
            with self.subTest(case=case), self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
                extra = None
                if case == 'mode': target.chmod(0o755)
                elif case == 'extra': (target / 'unrelated').write_bytes(b'keep')
                else: extra = os.open(target, os.O_PATH | os.O_DIRECTORY)
                try:
                    with patch.object(subject.os, 'posix_fallocate', side_effect=AssertionError('allocation')):
                        self.public(lambda: owner.prepare(fds, expected, extra if extra is not None else root_fd, capacity))
                finally:
                    if extra is not None: os.close(extra)
                if case == 'extra': self.assertEqual((target / 'unrelated').read_bytes(), b'keep')

    def test_final_index_reservation_failure_has_no_copy_write_or_named_output(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            real_allocate, allocations, original = os.posix_fallocate, [], PrivateFailure()
            def allocate(number, offset, size):
                allocations.append(size)
                if len(allocations) == 3: raise original  # Last index reservation.
                real_allocate(number, offset, size)
            with patch.object(subject.os, 'posix_fallocate', side_effect=allocate), \
                    patch.object(subject.os, 'pwrite', side_effect=AssertionError('copy before complete reservation')):
                self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))
            self.assertIs(owner._first_failure, original)
            self.assertEqual(owner.outcome().first_failure_phase, 'reserve')
            self.assertEqual(list(target.iterdir()), [])
            for number in fds: os.fstat(number)

    def test_unsupported_tmpfile_or_native_fd_exhaustion_has_no_fallback(self):
        for code in (errno.EOPNOTSUPP, errno.EMFILE):
            with self.subTest(code=code), self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
                original, real_open, calls = OSError(code, 'private setup'), os.open, []
                def open_file(name, flags, *args, **kwargs):
                    calls.append(flags)
                    if flags & os.O_TMPFILE == os.O_TMPFILE: raise original
                    return real_open(name, flags, *args, **kwargs)
                with patch.object(subject.os, 'open', side_effect=open_file):
                    self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))
                self.assertIs(owner._first_failure, original)
                self.assertEqual(len(calls), 2)  # Root + one failed unnamed allocation, no fallback.
                self.assertEqual(list(target.iterdir()), [])

    def test_copy_failure_preserves_private_first_error_and_originals(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, paths):
            original = PrivateFailure()
            before = [path.read_bytes() for path in paths]
            with patch.object(subject.os, 'pwrite', side_effect=original):
                self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))
            self.assertIs(owner._first_failure, original)
            self.assertEqual([path.read_bytes() for path in paths], before)
            self.assertEqual(list(target.iterdir()), [])
            self.public(owner.publish)

    def test_zero_write_progress_refuses_and_never_returns_a_plan(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            with patch.object(subject.os, 'pwrite', return_value=0):
                self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))
            self.assertEqual(owner.outcome().first_failure_code, 'write-progress')
            self.assertEqual(list(target.iterdir()), [])

    def test_source_change_during_copy_refuses_before_publication(self):
        with self.fixture((b'a' * 70000,)) as (owner, target, root_fd, fds, expected, capacity, paths):
            write, changed = os.pwrite, []
            def mutate(number, data, offset):
                result = write(number, data, offset)
                if not changed:
                    paths[0].write_bytes(b'b' * 70000)
                    changed.append(True)
                return result
            with patch.object(subject.os, 'pwrite', side_effect=mutate):
                self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))
            self.assertEqual(list(target.iterdir()), [])

    def test_caller_expected_and_returned_plan_mutations_cannot_change_internal_packet(self):
        with self.fixture((b'original',)) as (owner, _, root_fd, fds, expected, capacity, _):
            independent = tuple(ExpectedArtifact(e.identifier, e.size, e.sha256) for e in expected)
            plan = owner.prepare(fds, expected, root_fd, capacity)
            digest = plan.index_sha256
            object.__setattr__(expected[0], 'sha256', sha(b'other'))
            object.__setattr__(plan.inventory[0], 'sha256', sha(b'another'))
            object.__setattr__(plan, 'index_sha256', sha(b'fake index'))
            owner.publish()
            self.assertEqual(PacketReceiver().verify(root_fd, digest, independent).payload_bytes, 8)

    def test_prepare_publish_source_or_unnamed_output_mutation_refuses_before_link(self):
        for case in ('source', 'output'):
            with self.subTest(case=case), self.fixture((b'original',)) as (owner, target, root_fd, fds, expected, capacity, paths):
                owner.prepare(fds, expected, root_fd, capacity)
                if case == 'source': paths[0].write_bytes(b'modified')
                else: os.pwrite(owner._chunks[0].fd, b'modified', 0)
                with patch.object(subject.os, 'link', side_effect=AssertionError('publication')):
                    self.public(owner.publish)
                self.assertEqual(list(target.iterdir()), [])

    def test_foreign_create_only_target_is_never_overwritten_or_followed(self):
        for case in ('regular', 'symlink', 'fifo'):
            with self.subTest(case=case), self.fixture((b'copy',)) as (owner, target, root_fd, fds, expected, capacity, paths):
                owner.prepare(fds, expected, root_fd, capacity)
                real_link = os.link
                def collide(src, name, **kwargs):
                    destination = target / name
                    if case == 'regular': destination.write_bytes(b'foreign')
                    elif case == 'symlink': destination.symlink_to(paths[0])
                    else: os.mkfifo(destination, 0o600)
                    return real_link(src, name, **kwargs)
                with patch.object(subject.os, 'link', side_effect=collide):
                    self.public(owner.publish)
                self.assertFalse((target / 'packet-index.v1').exists())
                self.assertEqual(paths[0].read_bytes(), b'copy')
                if case == 'regular': self.assertEqual((target / 'chunk-00000000.bin').read_bytes(), b'foreign')
                elif case == 'symlink': self.assertTrue((target / 'chunk-00000000.bin').is_symlink())
                else: self.assertTrue(stat.S_ISFIFO((target / 'chunk-00000000.bin').stat().st_mode))

    def test_partial_chunk_publication_retained_and_index_absent(self):
        data = b'x' * (subject.CHUNK_LIMIT + 1)
        with self.fixture((data,)) as (owner, target, root_fd, fds, expected, capacity, _):
            plan = owner.prepare(fds, expected, root_fd, capacity)
            real_link, calls, original = os.link, [], PrivateFailure()
            def link(src, name, **kwargs):
                calls.append(name)
                if len(calls) == 2: raise original
                return real_link(src, name, **kwargs)
            with patch.object(subject.os, 'link', side_effect=link): self.public(owner.publish)
            self.assertIs(owner._first_failure, original)
            self.assertEqual([p.name for p in target.iterdir()], ['chunk-00000000.bin'])
            with self.assertRaises(PacketError): self.verified(root_fd, plan)
            self.public(owner.publish)
            self.assertEqual(len(calls), 2)

    def test_index_link_lost_reply_keeps_complete_bytes_but_uncertainty_is_absorbing(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            plan = owner.prepare(fds, expected, root_fd, capacity)
            real_link, original, calls = os.link, PrivateFailure(), []
            def lost(src, name, **kwargs):
                calls.append(name)
                real_link(src, name, **kwargs)
                if name == 'packet-index.v1': raise original
            with patch.object(subject.os, 'link', side_effect=lost): self.public(owner.publish)
            self.assertEqual(calls[-1], 'packet-index.v1')
            self.assertIs(owner._first_failure, original)
            self.assertEqual(owner.outcome().state, 'uncertain')
            self.assertEqual(self.verified(root_fd, plan).payload_bytes, 11)
            self.public(owner.publish)
            self.assertEqual(owner.close().state, 'uncertain')

    def test_final_root_sync_failure_retains_publication_without_success(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            plan = owner.prepare(fds, expected, root_fd, capacity)
            real_sync, calls, original = os.fsync, [], PrivateFailure()
            def sync(number):
                calls.append(number)
                real_sync(number)
                if len(calls) == 2: raise original  # Chunks sync, then final index sync.
            with patch.object(subject.os, 'fsync', side_effect=sync): self.public(owner.publish)
            self.assertEqual(owner.outcome().state, 'uncertain')
            self.assertIs(owner._first_failure, original)
            self.assertEqual(self.verified(root_fd, plan).payload_bytes, 11)

    def test_final_index_close_failure_refuses_and_consumes_descriptor_once(self):
        with self.fixture() as (owner, _, root_fd, fds, expected, capacity, _):
            plan = owner.prepare(fds, expected, root_fd, capacity)
            index, real_close, calls, original = owner._index.fd, os.close, [], PrivateFailure()
            def close(number):
                calls.append(number)
                real_close(number)
                if number == index: raise original
            with patch.object(subject.os, 'close', side_effect=close):
                self.public(owner.publish)
                owner.close()
            self.assertEqual(calls.count(index), 1)
            self.assertIs(owner._first_failure, original)
            self.assertEqual(self.verified(root_fd, plan).payload_bytes, 11)

    def test_ambiguous_close_never_retries_a_reused_native_descriptor(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            owner.prepare(fds, expected, root_fd, capacity)
            real_close, real_open, reused, calls = os.close, os.open, [], []
            original = PrivateFailure()
            def close(number):
                calls.append(number)
                real_close(number)
                replacement = real_open(target, os.O_RDONLY | os.O_DIRECTORY)
                self.assertEqual(replacement, number)
                reused.append(replacement)
                raise original
            try:
                with patch.object(subject.os, 'close', side_effect=close), \
                        patch.object(subject.os, 'pread', side_effect=AssertionError('read after uncertain close')):
                    self.assertEqual(owner.close().state, 'uncertain')
                    owner.close()
                self.assertEqual(len(calls), len(set(calls)))
                self.assertIs(owner._first_failure, original)
                for number in reused: os.fstat(number)
            finally:
                for number in reused: real_close(number)

    def test_first_write_error_survives_later_uncertain_close_without_formatting(self):
        with self.fixture() as (owner, target, root_fd, fds, expected, capacity, _):
            original, cleanup, close = PrivateFailure(), PrivateFailure(), os.close
            def uncertain(number):
                close(number)
                raise cleanup
            with patch.object(subject.os, 'pwrite', side_effect=original), \
                    patch.object(subject.os, 'close', side_effect=uncertain):
                self.public(lambda: owner.prepare(fds, expected, root_fd, capacity))
            self.assertIs(owner._first_failure, original)
            self.assertEqual(owner.outcome().first_failure_phase, 'copy')
            self.assertEqual(list(target.iterdir()), [])

    def test_late_source_change_on_owned_close_is_observed_through_borrowed_fd(self):
        with self.fixture((b'original',)) as (owner, _, root_fd, fds, expected, capacity, paths):
            owner.prepare(fds, expected, root_fd, capacity)
            source, close = owner._sources[0].fd, os.close
            def mutate(number):
                close(number)
                if number == source: paths[0].write_bytes(b'modified')
            with patch.object(subject.os, 'close', side_effect=mutate): self.public(owner.publish)
            self.assertEqual(owner.outcome().first_failure_code, 'source-changed')
            os.fstat(fds[0])

    def test_original_pid_exact_thread_and_busy_boundaries_precede_native_effects(self):
        owner = subject.PacketExporter()
        with patch.object(subject.os, 'getpid', return_value=os.getpid() + 1), \
                patch.object(subject.os, 'open', side_effect=AssertionError('effect')):
            self.public(lambda: owner.prepare((), (), -1, 1))
            self.public(owner.close)
        results = []
        def other():
            try: owner.close()
            except subject.ExportError: results.append('refused')
        worker = threading.Thread(target=other); worker.start(); worker.join(1)
        self.assertFalse(worker.is_alive()); self.assertEqual(results, ['refused'])
        owner._busy = True
        self.public(owner.publish); self.public(owner.close)
        owner._busy = False
        owner.close()

    def test_real_report_custody_two_alias_copy_exports_new_unaliased_inode(self):
        with tempfile.TemporaryDirectory(prefix='orca-custody-export-') as directory:
            base = Path(directory); source = base / 'source'; custody = base / 'custody'; target = base / 'target'
            for p in (source, custody, target): p.mkdir(mode=0o700)
            report = source / 'bootstrap-attempt.json'; report.write_bytes(b'{"private":"synthetic"}'); report.chmod(0o600)
            source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            report_fd = os.open(report, os.O_RDONLY)
            custody_fd = os.open(custody, os.O_RDONLY | os.O_DIRECTORY)
            target_fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
            held = HostReportCustody('bootstrap'); exporter = subject.PacketExporter(); retained_fd = None
            try:
                held.reserve(custody_fd)
                held.publish(report_fd, source_fd, report.stat().st_size, sha(report.read_bytes()))
                retained = custody / 'bootstrap-attempt.json'
                self.assertEqual(retained.stat().st_nlink, 2)
                retained_fd = os.open(retained, os.O_RDONLY)
                expected = (ExpectedArtifact('1' * 32, retained.stat().st_size, sha(retained.read_bytes())),)
                plan = exporter.prepare((retained_fd,), expected, target_fd, subject.MAX_INDEX_BYTES)
                exporter.publish()
                self.assertEqual(self.verified(target_fd, plan).artifacts, 1)
                copied = target / 'chunk-00000000.bin'
                self.assertEqual(copied.stat().st_nlink, 1)
                self.assertNotEqual((copied.stat().st_dev, copied.stat().st_ino),
                                    (retained.stat().st_dev, retained.stat().st_ino))
                self.assertEqual(retained.stat().st_nlink, 2)
                with self.assertRaises(SourcePacketUnavailable): certify_current_source_packet()
            finally:
                exporter.close(); held.close()
                for number in (retained_fd, target_fd, custody_fd, report_fd, source_fd):
                    if number is not None: os.close(number)

    def test_source_has_no_observer_transport_journal_unlink_or_rename(self):
        tree = ast.parse(Path(subject.__file__).read_bytes())
        imports = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        imports |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        self.assertEqual(imports, {'fcntl', 'hashlib', 'os', 'stat', 'sys', 'threading', 'dataclasses', 'packet_receiver'})
        calls = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertFalse({'unlink', 'rename', 'replace', 'remove', 'mkdir', 'Popen', 'system', 'setrlimit'} & calls)


if __name__ == '__main__':
    unittest.main()
