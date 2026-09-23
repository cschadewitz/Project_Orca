"""Isolated deployment tests: no live service, credentials, config or store is used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("orca-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {"root": str(self.root), "launchAudit": "all-cli-acp-and-daemon-launches-migrated",
                       "cwd": str(self.root), "cliConfig": str(self.root / "orca.yaml"),
                       "acpConfig": str(self.root / "kepler.yaml"), "daemonConfig": str(self.root / "orca.yaml"),
                       "url": "http://127.0.0.1:6722", "service": "orca", "repository": "owner/repo"}
        self.manifest = self.root / "deployment.json"
        self.manifest.write_text(json.dumps(self.config))
        self.deployment = release.Deployment(self.manifest)
        self.old = self.make_release("0.6.0")
        self.new = self.make_release("0.6.1")
        release.select(self.root, self.old)
        self.calls = []
        self.deployment.inspect_processes = lambda: 42
        self.deployment.systemctl = lambda *args: self.calls.append(args)
        self.deployment.health = lambda path: self.calls.append(("health", path.name))
        self.deployment.barrier = lambda action, token: self.calls.append((action, token))
        for path in (".orca", ".orca-kepler", "credentials", "orca.yaml", "kepler.yaml"):
            (self.root / path).write_text("operator state")

    def make_release(self, version, epoch="v1"):
        path = self.root / "releases" / ("v" + version)
        path.mkdir()
        release.write_json(path / ".orca-release.json", {"version": version, "node": sys.executable,
                           "compatibility": {"storeEpoch": epoch, "protocol": {"major": 1, "minor": 8},
                                             "capabilities": ["runs.control"]}})
        return path

    def test_activation_preserves_operator_state_and_stores(self):
        self.deployment.activate(self.new)
        self.assertEqual((self.root / "current").resolve(), self.new)
        self.assertFalse(self.deployment.pending.exists())
        self.assertTrue(self.old.exists())
        for path in (".orca", ".orca-kepler", "credentials", "orca.yaml", "kepler.yaml"):
            self.assertEqual((self.root / path).read_text(), "operator state")
        self.assertLess(next(i for i, c in enumerate(self.calls) if c[0] == "prepare"),
                        next(i for i, c in enumerate(self.calls) if c[0] == "stop"))

    def test_busy_does_not_stop_service_or_change_pointer(self):
        def busy(action, token):
            raise RuntimeError("Daemon busy: runs.start")
        self.deployment.barrier = busy
        with self.assertRaisesRegex(RuntimeError, "busy"):
            self.deployment.activate(self.new)
        self.assertEqual((self.root / "current").resolve(), self.old)
        self.assertFalse(any(c[0] == "stop" for c in self.calls))

    def test_candidate_health_failure_restores_and_checks_previous(self):
        def health(path):
            if path == self.new:
                raise RuntimeError("protocol mismatch")
            self.calls.append(("health", path.name))
        self.deployment.health = health
        with self.assertRaisesRegex(RuntimeError, "restored and healthy"):
            self.deployment.activate(self.new)
        self.assertEqual((self.root / "current").resolve(), self.old)
        self.assertEqual(sum(c == ("health", self.old.name) for c in self.calls), 2)
        self.assertFalse(self.deployment.pending.exists())

    def test_failed_recovery_keeps_admission_closed_and_journal(self):
        count = 0
        def health(path):
            nonlocal count
            count += 1
            if count > 1:
                raise RuntimeError("offline")
        self.deployment.health = health
        with self.assertRaisesRegex(RuntimeError, "offline"):
            self.deployment.activate(self.new)
        self.assertTrue(self.deployment.pending.exists())
        with self.assertRaisesRegex(RuntimeError, "pending"):
            self.deployment.launch("cli", ["run"])
        self.assertFalse(any(c[0] == "resume" for c in self.calls))

    def test_incompatible_store_never_activates_or_rolls_back(self):
        incompatible = self.make_release("0.7.0", "v2")
        with self.assertRaisesRegex(RuntimeError, "Store compatibility"):
            self.deployment.activate(incompatible)
        with self.assertRaisesRegex(RuntimeError, "Store compatibility"):
            self.deployment.restore({"previous": str(self.old), "candidate": str(incompatible), "token": "t"})
        self.assertEqual(self.calls, [])

    def test_real_shared_and_exclusive_locks_reject_competing_processes(self):
        with release.lock(self.root / "admission.lock", exclusive=False):
            with self.assertRaisesRegex(RuntimeError, "Busy"):
                self.deployment.activate(self.new)
        with release.lock(self.root / "update.lock"):
            child = subprocess.run([sys.executable, str(Path(__file__).with_name("orca-release.py")),
                                    "--deployment", str(self.manifest), "update", "v0.6.1"], capture_output=True, text=True)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn("Busy", child.stderr)
        self.assertEqual((self.root / "current").resolve(), self.old)

    def test_launch_resolves_code_and_assets_before_exec_and_keeps_acp_config(self):
        with patch.object(os, "execve") as execute:
            self.deployment.launch("acp", [])
            executable, arguments, env = execute.call_args.args
            self.assertEqual(executable, sys.executable)
            self.assertIn(str(self.old / "packages/cli/dist/main.js"), arguments)
            self.assertIn(self.config["acpConfig"], arguments)
            self.assertEqual(env["ORCA_RELEASE"], str(self.old))
            release.select(self.root, self.new)
            self.assertEqual(env["ORCA_RELEASE"], str(self.old))

    def test_activation_daemon_launches_with_closed_admission(self):
        release.write_json(self.deployment.pending, {"token": "health-check-token"})
        with patch.object(os, "execve") as execute:
            self.deployment.launch("daemon", [])
            self.assertEqual(execute.call_args.args[2]["ORCA_ADMISSION_FILE"], str(self.deployment.pending))

    def test_hello_checks_version_protocol_methods_and_capabilities(self):
        meta = release.metadata(self.old)
        hello = {"orcaVersion": "0.6.0", "protocol": {"major": 1, "minor": 8},
                 "capabilities": ["runs.control"], "methods": ["hello", "maintenance"]}
        release.verify_hello(hello, meta)
        release.verify_hello({**hello, "processId": 42}, meta, 42)
        with self.assertRaisesRegex(RuntimeError, "managed process"):
            release.verify_hello({**hello, "processId": 99}, meta, 42)
        for key, value in (("orcaVersion", "0.5.0"), ("protocol", {"major": 2, "minor": 8}),
                           ("capabilities", []), ("methods", ["hello"])):
            with self.assertRaises(RuntimeError):
                release.verify_hello({**hello, key: value}, meta)

    def test_fetch_failure_keeps_current(self):
        with patch.object(release, "capture", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                self.deployment.stage("v0.6.2")
        self.assertEqual((self.root / "current").resolve(), self.old)

    def test_build_failure_leaves_previous_release_and_no_activatable_candidate(self):
        def capture(args, **kwargs):
            if args[1:3] == ["release", "view"]:
                return json.dumps({"tagName": "v0.6.2", "isDraft": False, "isPrerelease": False})
            return "abc123"
        def command(args, **kwargs):
            if args[1:3] == ["repo", "clone"]:
                checkout = Path(args[4])
                (checkout / "package.json").write_text(json.dumps({"version": "0.6.2"}))
                (checkout / "release-compatibility.json").write_text(json.dumps({"storeEpoch": "v1"}))
            if args[-2:] == ["run", "build"]:
                raise RuntimeError("build failed")
        with patch.object(release, "capture", side_effect=capture), patch.object(release, "run", side_effect=command):
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                self.deployment.stage("v0.6.2")
        self.assertEqual((self.root / "current").resolve(), self.old)
        self.assertFalse((self.root / "releases/v0.6.2").exists())

    def test_uncertain_resume_requires_quiescence_before_recovery(self):
        record = {"previous": str(self.old), "candidate": str(self.new), "token": "t", "opened": True}
        release.write_json(self.deployment.pending, record)
        def busy(action, token):
            raise RuntimeError("Daemon busy: runs.start")
        self.deployment.barrier = busy
        with self.assertRaisesRegex(RuntimeError, "busy"):
            self.deployment.restore(record)
        self.assertFalse(any(c[0] == "stop" for c in self.calls))
        self.assertTrue(self.deployment.pending.exists())

    def test_unverified_launch_inventory_blocks_bootstrap(self):
        self.config.pop("launchAudit")
        self.manifest.write_text(json.dumps(self.config))
        with self.assertRaisesRegex(RuntimeError, "inventory"):
            release.Deployment(self.manifest)

    def test_path_outside_release_directory_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "outside"):
            release.select(self.root, self.root)


class ReleaseAssetsTests(unittest.TestCase):
    def test_both_architectures_and_hashes_are_required(self):
        import base64
        import hashlib
        spec = importlib.util.spec_from_file_location("assets", Path(__file__).with_name("release-assets.py"))
        assets = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assets)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for arch in ("x64", "arm64"):
                nested = root / arch
                nested.mkdir()
                name = f"ORCA-0.6.0-win-{arch}.exe"
                body = ("installer " + arch).encode()
                (nested / name).write_bytes(body)
                (nested / (name + ".blockmap")).write_text("sidecar")
                digest = base64.b64encode(hashlib.sha512(body).digest()).decode()
                (nested / f"latest-{arch}.yml").write_text(f"version: 0.6.0\npath: {name}\nsha512: {digest}\n")
            assets.verify(root, "0.6.0")
            self.assertFalse((root / "x64").exists())
            (root / "ORCA-0.6.0-win-arm64.exe").write_text("corrupted")
            with self.assertRaisesRegex(RuntimeError, "corrupt"):
                assets.verify(root, "0.6.0")
            with self.assertRaises(FileNotFoundError):
                assets.verify(root, "0.6.0-beta.1")

    def test_asset_collisions_are_not_silently_overwritten(self):
        spec = importlib.util.spec_from_file_location("assets", Path(__file__).with_name("release-assets.py"))
        assets = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assets)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "file.exe").write_text("one")
            (root / "nested").mkdir()
            (root / "nested/file.exe").write_text("two")
            with self.assertRaisesRegex(RuntimeError, "collision"):
                assets.verify(root, "0.6.0")


if __name__ == "__main__":
    unittest.main()
