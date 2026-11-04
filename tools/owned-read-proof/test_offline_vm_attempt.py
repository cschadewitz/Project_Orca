"""Synthetic memory/owned temporary-file fixtures only; no manager or launcher."""
import ast
import json
import os
from pathlib import Path
import pickle
import tempfile
import unittest
from unittest.mock import patch

from offline_vm_attempt import (AttemptSpecimen, Event, FIXTURE_BYTES, FIXTURE_FILES,
                                FRAMES, InertAcknowledgment, MemoryEvidenceFixture,
                                SEQUENCE, SpecimenRefusal)


class PrivateError(BaseException):
    def __str__(self):
        raise AssertionError('must not stringify private error')

    def __repr__(self):
        raise AssertionError('must not represent private error')


class FileFixture(MemoryEvidenceFixture):
    """Test-owned directory only; intentionally not a deployable custody adapter.

    The reservation is exclusive fixture bookkeeping, NOT allocated disk blocks,
    an owner quota, crash-tested recovery, hostile-path validation or durable media.
    """
    def __init__(self, directory):
        super().__init__()
        self.directory = directory
        self.descriptors = {}

    def reserve(self):
        super().reserve()
        fd = os.open('reservation', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.directory)
        try:
            os.fsync(fd)
        except BaseException:
            try:
                os.close(fd)
            except BaseException:
                pass  # Preserve the original sync failure, never retry close.
            raise
        else:
            os.close(fd)
        os.fsync(self.directory)

    def create(self, event):
        super().create(event)
        fd = os.open(event.value + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.directory)
        try:
            self.descriptors[event] = fd
        except BaseException:
            try:
                os.close(fd)
            except BaseException:
                pass  # Factory retains original registration error precedence.
            raise
        return event

    def write(self, handle, data):
        count = os.write(self.descriptors[handle], data)
        super().write(handle, data[:count])
        return count

    def sync_file(self, handle):
        super().sync_file(handle)
        os.fsync(self.descriptors[handle])

    def publish(self, handle):
        os.link(handle.value + '.tmp', handle.value, src_dir_fd=self.directory,
                dst_dir_fd=self.directory, follow_symlinks=False)
        super().publish(handle)

    def sync_directory(self):
        super().sync_directory()
        os.fsync(self.directory)

    def close(self, handle):
        super().close(handle)
        fd = self.descriptors.pop(handle)
        os.close(fd)


class AttemptControls(unittest.TestCase):
    def test_closed_sequence_order_bounds_and_no_authority(self):
        store, ack = MemoryEvidenceFixture(), InertAcknowledgment()
        attempt = AttemptSpecimen(store, ack)
        for event in SEQUENCE:
            with patch.object(ack, 'acknowledge', side_effect=lambda value: store.calls.append('ack')):
                attempt.record(event)
            self.assertEqual(store.calls[-6:], ['write', 'file-sync', 'publish', 'directory-sync', 'close', 'ack'])
        self.assertEqual(len(store.published), 5)
        self.assertLessEqual(2 * sum(map(len, store.published.values())), FIXTURE_BYTES)
        report = attempt.report()
        self.assertEqual(report['acknowledgedModelRecords'], 5)
        self.assertEqual(report['authority'], 'none')
        for key in ('observationAuthorized', 'processSettlementVerified',
                    'custodyIntegrationVerified', 'durableMediaVerified'):
            self.assertIs(report[key], False)
        with self.assertRaises(TypeError):
            pickle.dumps(attempt)

    def test_reorder_duplicate_terminal_and_unknown_event_refuse_without_io(self):
        for prefix, bad in ((0, Event.CONNECTED_INTENT), (0, 'reserved'),
                            (0, Event.UNCERTAIN), (1, Event.RESERVED),
                            (3, Event.BOOTSTRAP_INTENT), (5, Event.CONNECTED_RECORDED)):
            store = MemoryEvidenceFixture()
            attempt = AttemptSpecimen(store, InertAcknowledgment())
            for event in SEQUENCE[:prefix]:
                attempt.record(event)
            before = list(store.calls)
            with self.assertRaises(SpecimenRefusal):
                attempt.record(bad)
            with self.assertRaises(SpecimenRefusal):
                attempt.record(Event.RESERVED)
            self.assertEqual(store.calls, before)
            self.assertEqual(attempt.report()['status'], 'uncertain')

    def test_exact_test_reservation_and_one_original_store(self):
        for capacity in (FIXTURE_BYTES - 1, FIXTURE_BYTES + 1, True):
            store = MemoryEvidenceFixture(capacity)
            with self.assertRaises(SpecimenRefusal):
                AttemptSpecimen(store, InertAcknowledgment()).record(Event.RESERVED)
            self.assertEqual(store.calls, ['reserve'])
        store = MemoryEvidenceFixture(file_capacity=FIXTURE_FILES - 1)
        with self.assertRaises(SpecimenRefusal):
            AttemptSpecimen(store, InertAcknowledgment()).record(Event.RESERVED)
        store = MemoryEvidenceFixture()
        AttemptSpecimen(store, InertAcknowledgment()).record(Event.RESERVED)
        before = dict(store.published)
        with self.assertRaises(SpecimenRefusal):
            AttemptSpecimen(store, InertAcknowledgment()).record(Event.RESERVED)
        self.assertEqual(store.published, before)

    def test_each_storage_failure_is_absorbing_and_preserves_private_first_error(self):
        for method in ('reserve', 'create', 'write', 'sync_file', 'publish', 'sync_directory', 'close'):
            for after in (False, True):
                # A failing create factory must own its unreturned resource; covered
                # separately below. Memory before-create failure acquires nothing.
                if method == 'create' and after:
                    continue
                store, error = MemoryEvidenceFixture(), PrivateError('SECRET')
                attempt = AttemptSpecimen(store, InertAcknowledgment())
                original = getattr(store, method)
                def fail(*args):
                    if after:
                        original(*args)
                    raise error
                with patch.object(store, method, side_effect=fail):
                    with self.assertRaises(SpecimenRefusal):
                        attempt.record(Event.RESERVED)
                self.assertIs(attempt.private_first_error(), error)
                before = list(store.calls)
                with self.assertRaises(SpecimenRefusal):
                    attempt.record(Event.RESERVED)
                self.assertEqual(store.calls, before)
                self.assertNotIn('SECRET', json.dumps(attempt.report()))
                self.assertLessEqual(store.calls.count('close'), 1)

    def test_write_and_close_failure_keeps_first_object(self):
        store, first = MemoryEvidenceFixture(), PrivateError('FIRST')
        attempt = AttemptSpecimen(store, InertAcknowledgment())
        with patch.object(store, 'write', side_effect=first), \
             patch.object(store, 'close', side_effect=PrivateError('SECOND')) as close:
            with self.assertRaises(SpecimenRefusal):
                attempt.record(Event.RESERVED)
            self.assertIs(attempt.private_first_error(), first)
            close.assert_called_once()

    def test_short_writes_progress_but_invalid_results_stop(self):
        store = MemoryEvidenceFixture()
        original = store.write
        with patch.object(store, 'write', side_effect=lambda handle, data: original(handle, data[:1])):
            AttemptSpecimen(store, InertAcknowledgment()).record(Event.RESERVED)
        self.assertEqual(store.calls.count('write'), len(FRAMES[Event.RESERVED]))
        for value in (0, -1, True, len(FRAMES[Event.RESERVED]) + 1, None):
            store = MemoryEvidenceFixture()
            with patch.object(store, 'write', return_value=value) as write:
                with self.assertRaises(SpecimenRefusal):
                    AttemptSpecimen(store, InertAcknowledgment()).record(Event.RESERVED)
                write.assert_called_once()
            self.assertNotIn('publish', store.calls)

    def test_lost_ack_retains_published_record_and_never_resends(self):
        store, ack, error = MemoryEvidenceFixture(), InertAcknowledgment(), PrivateError()
        attempt = AttemptSpecimen(store, ack)
        with patch.object(ack, 'acknowledge', side_effect=error) as receive:
            with self.assertRaises(SpecimenRefusal):
                attempt.record(Event.RESERVED)
            self.assertEqual(store.published[Event.RESERVED], FRAMES[Event.RESERVED])
            with self.assertRaises(SpecimenRefusal):
                attempt.record(Event.RESERVED)
            receive.assert_called_once()
        self.assertIs(attempt.private_first_error(), error)
        self.assertEqual(attempt.report()['acknowledgedModelRecords'], 0)

    def test_reentrant_create_adopts_then_closes_returned_handle(self):
        store = MemoryEvidenceFixture()
        attempt = AttemptSpecimen(store, InertAcknowledgment())
        original = store.create
        def create(event):
            handle = original(event)
            with self.assertRaises(SpecimenRefusal):
                attempt.record(Event.RESERVED)
            return handle
        with patch.object(store, 'create', side_effect=create):
            with self.assertRaises(SpecimenRefusal):
                attempt.record(Event.RESERVED)
        self.assertEqual(store.closed, {Event.RESERVED})
        self.assertNotIn('write', store.calls)

    def test_failed_factory_keeps_unreturned_resource_cleanup_local(self):
        store, error = MemoryEvidenceFixture(), PrivateError()
        attempt = AttemptSpecimen(store, InertAcknowledgment())
        original = store.create
        def create(event):
            handle = original(event)
            store.close(handle)
            raise error
        with patch.object(store, 'create', side_effect=create):
            with self.assertRaises(SpecimenRefusal):
                attempt.record(Event.RESERVED)
        self.assertEqual(store.calls.count('close'), 1)
        self.assertIs(attempt.private_first_error(), error)

    def test_invalid_and_reentrant_ack_do_not_advance_state(self):
        for reentrant in (False, True):
            store, ack = MemoryEvidenceFixture(), InertAcknowledgment()
            attempt = AttemptSpecimen(store, ack)
            def receive(event):
                if reentrant:
                    with self.assertRaises(SpecimenRefusal):
                        attempt.record(Event.RESERVED)
                    return None
                return True
            with patch.object(ack, 'acknowledge', side_effect=receive):
                with self.assertRaises(SpecimenRefusal):
                    attempt.record(Event.RESERVED)
            self.assertEqual(attempt.report()['acknowledgedModelRecords'], 0)
            self.assertIn(Event.RESERVED, store.published)

    def test_uncertainty_slot_has_reserved_capacity_and_is_terminal(self):
        store = MemoryEvidenceFixture()
        attempt = AttemptSpecimen(store, InertAcknowledgment())
        for event in SEQUENCE[:-1]:
            attempt.record(event)
        attempt.record(Event.UNCERTAIN)
        self.assertIn(Event.UNCERTAIN, store.published)
        self.assertLessEqual(2 * sum(map(len, store.published.values())), FIXTURE_BYTES)
        with self.assertRaises(SpecimenRefusal):
            attempt.record(Event.CONNECTED_RECORDED)


class FilesystemControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='orca-inert-vm-')
        self.addCleanup(self.directory.cleanup)
        self.fd = os.open(self.directory.name, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.fd)
        self.store = FileFixture(self.fd)
        self.ack = InertAcknowledgment()
        self.attempt = AttemptSpecimen(self.store, self.ack)

    def test_actual_create_write_sync_link_directory_sync_then_ack(self):
        def acknowledge(event):
            root = Path(self.directory.name)
            self.assertEqual((root / event.value).read_bytes(), FRAMES[event])
            self.assertEqual((root / event.value).stat().st_ino,
                             (root / (event.value + '.tmp')).stat().st_ino)
            self.assertEqual(self.store.descriptors, {})
        with patch.object(self.ack, 'acknowledge', side_effect=acknowledge):
            for event in SEQUENCE:
                self.attempt.record(event)
        paths = list(Path(self.directory.name).iterdir())
        self.assertLessEqual(len(paths), FIXTURE_FILES)
        self.assertLessEqual(sum(p.stat().st_size for p in paths), FIXTURE_BYTES)

    def test_second_fixture_same_directory_cannot_replace_reservation(self):
        self.attempt.record(Event.RESERVED)
        before = {p.name: p.read_bytes() for p in Path(self.directory.name).iterdir()}
        other = AttemptSpecimen(FileFixture(self.fd), InertAcknowledgment())
        with self.assertRaises(SpecimenRefusal):
            other.record(Event.RESERVED)
        self.assertEqual(before, {p.name: p.read_bytes() for p in Path(self.directory.name).iterdir()})

    def test_existing_publication_is_not_overwritten(self):
        path = Path(self.directory.name) / 'reserved'
        path.write_bytes(b'prior synthetic evidence')
        with self.assertRaises(SpecimenRefusal):
            self.attempt.record(Event.RESERVED)
        self.assertEqual(path.read_bytes(), b'prior synthetic evidence')
        self.assertEqual(self.store.descriptors, {})

    def test_symlink_and_fifo_collisions_do_not_follow_or_open_existing_targets(self):
        for name in ('reservation', 'reserved.tmp', 'reserved'):
            for kind in ('symlink', 'fifo'):
                with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as root:
                    sentinel = Path(root) / 'sentinel'
                    sentinel.write_bytes(b'private synthetic sentinel')
                    collision = Path(root) / name
                    if kind == 'symlink':
                        collision.symlink_to(sentinel)
                    else:
                        os.mkfifo(collision, 0o600)
                    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        store = FileFixture(fd)
                        with self.assertRaises(SpecimenRefusal):
                            AttemptSpecimen(store, InertAcknowledgment()).record(Event.RESERVED)
                        self.assertEqual(sentinel.read_bytes(), b'private synthetic sentinel')
                        self.assertEqual(store.descriptors, {})
                        self.assertTrue(collision.is_symlink() if kind == 'symlink' else collision.is_fifo())
                    finally:
                        os.close(fd)

    def test_non_directory_fixture_fd_refuses_without_mutation(self):
        path = Path(self.directory.name) / 'ordinary-file'
        path.write_bytes(b'synthetic')
        fd = os.open(path, os.O_RDONLY)
        try:
            with self.assertRaises(SpecimenRefusal):
                AttemptSpecimen(FileFixture(fd), InertAcknowledgment()).record(Event.RESERVED)
            self.assertEqual(path.read_bytes(), b'synthetic')
        finally:
            os.close(fd)

    def test_lost_ack_preserves_real_files_without_another_write(self):
        with patch.object(self.ack, 'acknowledge', side_effect=OSError('synthetic lost acknowledgment')) as receive:
            with self.assertRaises(SpecimenRefusal):
                self.attempt.record(Event.RESERVED)
            root = Path(self.directory.name)
            before = {p.name: (p.stat().st_ino, p.read_bytes()) for p in root.iterdir()}
            with self.assertRaises(SpecimenRefusal):
                self.attempt.record(Event.RESERVED)
            self.assertEqual(before, {p.name: (p.stat().st_ino, p.read_bytes()) for p in root.iterdir()})
            receive.assert_called_once()

    def test_file_and_directory_fsync_errors_refuse_ack_without_deleting_bytes(self):
        for failure_call in (1, 2, 3, 4):
            with self.subTest(failure_call=failure_call), tempfile.TemporaryDirectory() as root:
                fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    store, ack = FileFixture(fd), InertAcknowledgment()
                    attempt = AttemptSpecimen(store, ack)
                    original, calls = os.fsync, []
                    def sync(handle):
                        calls.append(handle)
                        if len(calls) == failure_call:
                            raise OSError('synthetic fsync failure')
                        return original(handle)
                    with patch('os.fsync', side_effect=sync), patch.object(ack, 'acknowledge') as receive:
                        with self.assertRaises(SpecimenRefusal):
                            attempt.record(Event.RESERVED)
                        receive.assert_not_called()
                    self.assertEqual(store.descriptors, {})
                    self.assertTrue((Path(root) / 'reservation').exists())
                finally:
                    os.close(fd)

    def test_reservation_sync_error_survives_factory_close_error(self):
        first, second, original = PrivateError('SYNC'), PrivateError('CLOSE'), os.close
        def close(fd):
            original(fd)
            raise second
        with patch('os.fsync', side_effect=first), patch('os.close', side_effect=close) as release:
            with self.assertRaises(SpecimenRefusal):
                self.attempt.record(Event.RESERVED)
            release.assert_called_once()
        self.assertIs(self.attempt.private_first_error(), first)

    def test_registration_error_survives_factory_rollback_error(self):
        first, second, original, releases = PrivateError('REGISTER'), PrivateError('CLOSE'), os.close, []
        class RefusingRegistry(dict):
            def __setitem__(self, key, value):
                raise first
        self.store.descriptors = RefusingRegistry()
        def close(fd):
            releases.append(fd)
            original(fd)
            if len(releases) == 2:  # Reservation close succeeded; creation rollback fails.
                raise second
        with patch('os.close', side_effect=close):
            with self.assertRaises(SpecimenRefusal):
                self.attempt.record(Event.RESERVED)
        self.assertEqual(len(releases), 2)
        self.assertEqual(self.store.descriptors, {})
        self.assertIs(self.attempt.private_first_error(), first)

    def test_partial_actual_write_then_failure_is_retained(self):
        original, calls = self.store.write, []
        def write(handle, data):
            calls.append(handle)
            if len(calls) == 1:
                return original(handle, data[:3])
            raise OSError('synthetic write failure')
        with patch.object(self.store, 'write', side_effect=write):
            with self.assertRaises(SpecimenRefusal):
                self.attempt.record(Event.RESERVED)
        self.assertEqual((Path(self.directory.name) / 'reserved.tmp').read_bytes(), FRAMES[Event.RESERVED][:3])
        self.assertFalse((Path(self.directory.name) / 'reserved').exists())
        self.assertEqual(self.store.descriptors, {})


class BoundaryControls(unittest.TestCase):
    def test_source_has_no_runtime_adapter_and_guard_sources_are_not_imported(self):
        tree = ast.parse(Path(__file__).with_name('offline_vm_attempt.py').read_text())
        imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
        self.assertEqual(imports, {'enum', 'offline_attempt_model'})
        self.assertFalse(any(isinstance(node, ast.Import) for node in ast.walk(tree)))
        self.assertFalse(any(hasattr(InertAcknowledgment(), name)
                             for name in ('launch', 'send', 'connect', 'execute', 'resume')))


if __name__ == '__main__':
    unittest.main()
