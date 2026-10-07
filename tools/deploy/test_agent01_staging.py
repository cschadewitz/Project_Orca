"""Synthetic checks for the owner stager; Linux filesystem cases use only a disposable directory."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PACKET = ROOT / "docs/preparation/private-mcp-access/agent01-owner-staging"
spec = importlib.util.spec_from_file_location("owner_stager", PACKET / "stage-agent01.py")
stager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stager)


class PayloadTests(unittest.TestCase):
    def test_exact_rendered_bytes_and_hashes(self):
        manifest = json.loads((PACKET / "rendered-sha256.json").read_text())
        self.assertEqual(stager.SOURCE_COMMIT, "1199f7e4705d904f3f5dfda32a2644d0b8346e01")
        self.assertEqual(manifest["sourceCommit"], stager.SOURCE_COMMIT)
        self.assertEqual(manifest["sha256"], stager.EXPECTED_HASHES)
        self.assertEqual(set(stager.PAYLOAD), {"orca-daemon.service", "orca-tunnel.service", "tunnel-profile.yaml"})
        for name, data in stager.PAYLOAD.items():
            # Git's Windows checkout can use CRLF; the deliverable/script emit LF.
            self.assertEqual(data, (PACKET / name).read_bytes().replace(b"\r\n", b"\n"))
            self.assertEqual(hashlib.sha256(data).hexdigest(), manifest["sha256"][name])

    def test_wrong_platform_refuses_before_filesystem_access(self):
        with patch.object(stager.sys, "platform", "win32"), patch.object(stager, "checked_parent") as parent:
            with self.assertRaises(ValueError):
                stager.main()
            parent.assert_not_called()


@unittest.skipUnless(sys.platform == "linux", "real dir_fd, O_NOFOLLOW and POSIX mode checks require Linux")
class LinuxStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orca-stager-test-")
        self.root = Path(self.temp.name)
        self.parent = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.uid = patch.object(stager, "EXPECTED_UID", os.getuid())
        self.uid.start()

    def tearDown(self):
        self.uid.stop()
        os.close(self.parent)
        self.temp.cleanup()

    def test_private_stage_and_second_attempt_never_overwrites(self):
        stager.stage(self.parent)
        destination = self.root / stager.STAGE_NAME
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o700)
        self.assertEqual(len(list(destination.iterdir())), 4)
        for path in destination.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            stager.stage(self.parent)
        for name, data in stager.PAYLOAD.items():
            self.assertEqual((destination / name).read_bytes(), data)

    def test_existing_symlink_refused_without_touching_target(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (self.root / stager.STAGE_NAME).symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            stager.stage(self.parent)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_corrupted_payload_fails_before_creating_directory(self):
        with patch.dict(stager.PAYLOAD, {"orca-daemon.service": b"corrupt"}):
            with self.assertRaisesRegex(ValueError, "embedded-digest"):
                stager.stage(self.parent)
        self.assertFalse((self.root / stager.STAGE_NAME).exists())

    def test_interrupted_write_retains_partial_directory_and_refuses_retry(self):
        with patch.object(stager.os, "fsync", side_effect=OSError("synthetic interruption")):
            with self.assertRaises(OSError):
                stager.stage(self.parent)
        self.assertTrue((self.root / stager.STAGE_NAME).is_dir())
        with self.assertRaises(FileExistsError):
            stager.stage(self.parent)


if __name__ == "__main__":
    unittest.main()
