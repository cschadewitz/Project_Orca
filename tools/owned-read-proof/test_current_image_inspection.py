"""Real offline build/physical controls; no image execution or designation."""
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import current_image_inspection as inspection
from controlled_connected import ConnectedDesignation
from controlled_observation import observe_new, diagnose_bootstrap
from controlled_supervisor import REPO, bootstrap, observe


class OfflineImageControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reference = tempfile.TemporaryDirectory(prefix='orca-offline-image-reference-')
        cls.addClassCleanup(cls.reference.cleanup)
        cls.original = Path(cls.reference.name) / 'image'
        subprocess.run([shutil.which('node'), str(REPO / 'tools/owned-read-proof/build-controlled.mjs'),
                        str(cls.original)], cwd=REPO, check=True, capture_output=True, timeout=15)
        inspection.inspect_current_image(str(cls.original))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='orca-offline-inspection-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / 'image'
        shutil.copytree(self.original, self.image)

    def refused(self, call):
        with self.assertRaisesRegex(RuntimeError, '^current image inspection refused$'):
            call()

    def test_fixed_current_bytes_are_only_a_non_authoritative_snapshot(self):
        candidate = inspection.inspect_current_image(str(self.image))
        self.assertIsNone(candidate.recheck())
        self.assertNotIsInstance(candidate, ConnectedDesignation)
        report = candidate.report()
        self.assertEqual(report['authority'], 'none')
        self.assertIsNone(report['acceptingToken'])
        for field in ('productionEligible', 'observationAuthorized', 'loadedImageVerified'):
            self.assertIs(report[field], False)
        self.assertNotIn(str(self.root), json.dumps(report))
        for method in ('bind', 'association', 'authorize', 'execute', 'launch'):
            self.assertFalse(hasattr(candidate, method))
        report['observationAuthorized'] = True
        self.assertFalse(candidate.report()['observationAuthorized'])
        self.refused(lambda: inspection.inspect_current_image(report))

    def test_missing_extra_or_changed_inventory_refuses(self):
        child = self.image / 'controlled-child.mjs'
        child.unlink()
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        shutil.copyfile(self.original / child.name, child)
        (self.image / 'extra').write_text('not an allowed image input')
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))

    def test_inventory_stops_at_fourth_entry(self):
        yielded = []
        @contextmanager
        def many_entries(_):
            def entries():
                for name in [name for name, _, _ in inspection.OUTPUTS] + ['extra']:
                    yielded.append(name)
                    yield SimpleNamespace(name=name)
                self.fail('unbounded fifth directory entry requested')
            yield entries()
        with patch.object(inspection.os, 'scandir', side_effect=many_entries):
            self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        self.assertEqual(len(yielded), 4)

    def test_complete_manifest_is_pinned_not_candidate_declared_policy(self):
        manifest = self.image / 'controlled-build.json'
        value = json.loads(manifest.read_bytes())
        value['sources'].pop(next(iter(value['sources'])))
        manifest.chmod(0o600)
        manifest.write_text(json.dumps(value))
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))

    def test_equal_length_output_tamper_refuses(self):
        producer = self.image / 'controlled-producer.mjs'
        data = producer.read_bytes()
        producer.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))

    def test_same_bytes_replacement_cannot_reuse_original_snapshot(self):
        candidate = inspection.inspect_current_image(str(self.image))
        child = self.image / 'controlled-child.mjs'
        replacement = self.root / 'replacement'
        shutil.copyfile(child, replacement)
        os.replace(replacement, child)
        self.refused(candidate.recheck)
        # A new offline snapshot may describe identical bytes in another file;
        # it does not inherit continuity or an original-run capability.
        newer = inspection.inspect_current_image(str(self.image))
        self.assertNotEqual(candidate, newer)
        self.assertFalse(newer.report()['observationAuthorized'])

    def test_directory_replacement_cannot_reuse_original_snapshot(self):
        candidate = inspection.inspect_current_image(str(self.image))
        self.image.rename(self.root / 'old-image')
        shutil.copytree(self.original, self.image)
        self.refused(candidate.recheck)

    def test_symlink_file_root_and_ancestor_refuse(self):
        child = self.image / 'controlled-child.mjs'
        child.unlink()
        child.symlink_to(self.original / child.name)
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        alias = self.root / 'alias'
        alias.symlink_to(self.original, target_is_directory=True)
        self.refused(lambda: inspection.inspect_current_image(str(alias)))
        parent_alias = self.root / 'parent-alias'
        parent_alias.symlink_to(Path(self.reference.name), target_is_directory=True)
        self.refused(lambda: inspection.inspect_current_image(str(parent_alias / 'image')))

    def test_hardlink_fifo_and_writable_modes_refuse(self):
        child = self.image / 'controlled-child.mjs'
        alias = self.root / 'alias'
        os.link(child, alias)
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        alias.unlink()
        child.chmod(0o666)
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        child.unlink()
        os.mkfifo(child, mode=0o600)
        self.refused(lambda: inspection.inspect_current_image(str(self.image)))

    def test_special_file_replacement_between_stat_and_pin_has_no_read_open(self):
        real_open = os.open
        child = self.image / 'controlled-child.mjs'
        replaced = False
        def replace_then_open(name, flags, **kwargs):
            nonlocal replaced
            if name == child.name and flags & os.O_PATH:
                replaced = True
                child.unlink()
                os.mkfifo(child, mode=0o600)
            fd = real_open(name, flags, **kwargs)
            if not flags & os.O_PATH and not flags & os.O_DIRECTORY:
                self.assertTrue(stat.S_ISREG(os.fstat(fd).st_mode))
            return fd
        with patch.object(inspection.os, 'open', side_effect=replace_then_open):
            self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        self.assertTrue(replaced)

    def test_invalid_path_has_fixed_private_refusal(self):
        for value in (None, True, {}, 'private-token', str(self.image) + '/',
                      str(self.image) + '/..', str(self.image) + '\x00private-token'):
            with self.subTest(type=type(value).__name__):
                self.refused(lambda: inspection.inspect_current_image(value))

    def test_read_failure_closes_every_acquired_descriptor_without_private_error(self):
        opened, closed = [], []
        real_open, real_close = os.open, os.close
        def tracked_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            opened.append(fd)
            return fd
        def tracked_close(fd):
            closed.append(fd)
            return real_close(fd)
        with patch.object(inspection.os, 'open', side_effect=tracked_open), \
             patch.object(inspection.os, 'close', side_effect=tracked_close), \
             patch.object(inspection.os, 'read', side_effect=OSError('private-token/payload/path')):
            self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        self.assertTrue(opened)
        self.assertEqual(closed, list(reversed(opened)))

    def test_mutation_after_first_file_read_is_detected_before_return(self):
        manifest = self.image / 'controlled-build.json'
        real_read = os.read
        mutated = False
        def read_then_mutate(fd, maximum):
            nonlocal mutated
            data = real_read(fd, maximum)
            # Child is read after the manifest; alter earlier bytes while the
            # later member is being read. Final retained-descriptor stamps refuse.
            if not mutated and os.fstat(fd).st_size == 5713:
                mutated = True
                manifest.chmod(0o600)
                manifest.write_bytes(b'x' * 48027)
            return data
        with patch.object(inspection.os, 'read', side_effect=read_then_mutate):
            self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        self.assertTrue(mutated)

    def test_name_replacement_during_descriptor_read_refuses(self):
        for replace_directory in (False, True):
            with self.subTest(directory=replace_directory), tempfile.TemporaryDirectory() as value:
                root = Path(value)
                image, replacement = root / 'image', root / 'replacement'
                shutil.copytree(self.original, image)
                if replace_directory:
                    shutil.copytree(self.original, replacement)
                else:
                    shutil.copyfile(self.original / 'controlled-child.mjs', replacement)
                real_read, replaced = os.read, False
                def read_then_replace(fd, maximum):
                    nonlocal replaced
                    data = real_read(fd, maximum)
                    if not replaced and os.fstat(fd).st_size == 5713:
                        replaced = True
                        if replace_directory:
                            image.rename(root / 'old-image')
                            replacement.rename(image)
                        else:
                            os.replace(replacement, image / 'controlled-child.mjs')
                    return data
                with patch.object(inspection.os, 'read', side_effect=read_then_replace):
                    self.refused(lambda: inspection.inspect_current_image(str(image)))
                self.assertTrue(replaced)

    def test_close_error_still_attempts_every_acquired_descriptor(self):
        opened, closed = [], []
        real_open, real_close = os.open, os.close
        def tracked_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            opened.append(fd)
            return fd
        def close_then_error(fd):
            real_close(fd)
            closed.append(fd)
            if len(closed) == 1:
                raise OSError('private cleanup detail')
        with patch.object(inspection.os, 'open', side_effect=tracked_open), \
             patch.object(inspection.os, 'close', side_effect=close_then_error):
            self.refused(lambda: inspection.inspect_current_image(str(self.image)))
        self.assertEqual(closed, list(reversed(opened)))


class NonliveEntryControls(unittest.TestCase):
    def test_unsupported_platform_refuses_without_fallback(self):
        with patch.object(inspection.sys, 'platform', 'unsupported'), \
             patch.object(inspection.os, 'open') as opened:
            with self.assertRaisesRegex(RuntimeError, '^current image inspection refused$'):
                inspection.inspect_current_image('/unused')
            opened.assert_not_called()

    def test_every_public_observation_entry_refuses_before_side_effects(self):
        calls = (lambda: observe(object(), object()), lambda: observe_new(object(), object()),
                 diagnose_bootstrap, bootstrap)
        targets = ('controlled_supervisor.subprocess.run', 'controlled_supervisor.run_traced',
                   'controlled_supervisor.probe_clock', 'controlled_supervisor.os.open',
                   'controlled_supervisor.tempfile.mkdtemp', 'controlled_supervisor.threading.Thread',
                   'controlled_observation.committed_observer', 'controlled_observation.observe')
        for call in calls:
            with self.subTest(entry=call), ExitStack() as stack:
                effects = [stack.enter_context(patch(target, side_effect=AssertionError('unexpected side effect')))
                           for target in targets]
                with self.assertRaisesRegex(RuntimeError, '^non-live preparation: observer launch disabled$'):
                    call()
                for effect in effects:
                    effect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
