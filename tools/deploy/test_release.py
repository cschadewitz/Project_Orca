"""Isolated deployment tests: no live service, credentials, config or store is used."""
import importlib.util
import json
import os
import selectors
import signal
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

    def test_typed_states_refuse_every_effect_and_preserve_existing_journal(self):
        record = {"previous": str(self.old), "candidate": str(self.new), "token": "retained", "opened": True}
        release.write_json(self.deployment.pending, record)
        journal = self.deployment.pending.read_bytes()
        for state in ("enrolled", "enrollment-pending", "missing", "corrupt", "unknown-build"):
            observations = []
            def inspect(action, roles, previous):
                observations.append((action, roles, previous))
                raise RuntimeError("typed refused: " + state)
            self.deployment.typed_inspector = inspect
            for operation in (lambda: self.deployment.stage("v0.6.2"),
                              lambda: self.deployment.activate(self.new),
                              lambda: self.deployment.restore(record),
                              *(lambda kind=kind: self.deployment.launch(kind, []) for kind in ("cli", "acp", "daemon")),
                              lambda: self.deployment.exec_release("daemon", [])):
                with patch.object(release, "run") as run, patch.object(os, "execve") as execute:
                    with self.assertRaisesRegex(RuntimeError, "typed refused"):
                        operation()
                    run.assert_not_called()
                    execute.assert_not_called()
                self.assertEqual(self.calls, [])
                self.assertEqual(self.deployment.pending.read_bytes(), journal)
                self.assertEqual((self.root / "current").resolve(), self.old)
            self.assertTrue(all(tuple(role for role, _ in roles) == ("cli", "acp", "daemon")
                                for _, roles, _ in observations))

    def test_unavailable_stable_bridge_refuses_claims_without_parsing_or_running_selected_code(self):
        for name in ("typed-workspace", "typed-enrollment.intent", ".orca-typed-workspace"):
            witness = self.root / name
            witness.write_bytes(b"corrupt or old typed evidence")
            with patch.object(os, "execve") as execute:
                with self.assertRaisesRegex(RuntimeError, "trusted inspection bridge missing"):
                    self.deployment.launch("daemon", [])
                with self.assertRaisesRegex(RuntimeError, "trusted inspection bridge missing"):
                    self.deployment.restore({})
                execute.assert_not_called()
            self.assertEqual(witness.read_bytes(), b"corrupt or old typed evidence")
            self.assertEqual(self.calls, [])
            witness.unlink()

    def test_previous_root_typed_evidence_refuses_before_restore_even_with_live_legacy(self):
        record = {"previous": str(self.old), "candidate": str(self.new), "token": "t", "opened": False}
        release.write_json(self.deployment.pending, record)
        original = self.deployment.pending.read_bytes()
        def inspect(action, roles, previous):
            if str(self.old) in previous:
                raise RuntimeError("previous root typed; recovery refused")
            return lambda: None
        self.deployment.typed_inspector = inspect
        with self.assertRaisesRegex(RuntimeError, "previous root typed"):
            self.deployment.restore(record)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.deployment.pending.read_bytes(), original)
        self.assertEqual((self.root / "current").resolve(), self.old)

    def test_automatic_failure_rollback_cannot_bypass_a_new_typed_refusal(self):
        refuse = False
        def inspect(action, roles, previous):
            if refuse:
                raise RuntimeError("typed state unavailable; preserve failed candidate")
            return lambda: None
        self.deployment.typed_inspector = inspect
        def health(path):
            nonlocal refuse
            if path == self.new:
                refuse = True
                raise RuntimeError("synthetic health failure")
        self.deployment.health = health
        with self.assertRaisesRegex(RuntimeError, "typed state unavailable"):
            self.deployment.activate(self.new)
        self.assertEqual((self.root / "current").resolve(), self.new)
        self.assertEqual(sum(c[0] == "stop" for c in self.calls), 1)
        self.assertTrue(self.deployment.pending.exists())
        self.assertFalse(any(c[0] == "resume" for c in self.calls))

    def test_lost_lifetime_identity_before_intent_preserves_state_and_stops_no_service(self):
        def health(path):
            lock = self.root / "typed-lifetime.lock"
            lock.rename(self.root / "retained-old-lock")
            lock.write_text("new identity")
        self.deployment.health = health
        with self.assertRaisesRegex(RuntimeError, "identity/ownership changed"):
            self.deployment.activate(self.new)
        self.assertEqual((self.root / "current").resolve(), self.old)
        self.assertFalse(self.deployment.pending.exists())
        self.assertTrue((self.root / "retained-old-lock").exists())
        self.assertEqual(self.calls, [])

    def test_lost_inspection_refuses_at_final_dispatch_without_spawn(self):
        calls = 0
        def inspect(action, roles, previous):
            def assert_current():
                nonlocal calls
                calls += 1
                if calls > 1:
                    raise RuntimeError("retained owner lost")
            return assert_current
        self.deployment.typed_inspector = inspect
        with patch.object(os, "execve") as execute:
            with self.assertRaisesRegex(RuntimeError, "retained owner lost"):
                self.deployment.exec_release("cli", ["run"])
            execute.assert_not_called()

    def test_bool_or_json_cannot_be_inspection_ownership(self):
        for result in (True, {"state": "enrolled"}, lambda: True):
            self.deployment.typed_inspector = lambda *args: result
            with patch.object(os, "execve") as execute:
                with self.assertRaisesRegex(RuntimeError, "ownership unavailable"):
                    self.deployment.exec_release("daemon", [])
                execute.assert_not_called()

    def test_real_paused_daemon_blocks_enrollment_despite_free_admission_lock(self):
        # A disposable Python fake build executes via the real stable daemon wrapper.
        script = self.old / "packages/cli/dist/main.js"
        script.parent.mkdir(parents=True)
        script.write_text("import os, signal\nprint('held', flush=True)\nos.kill(os.getpid(), signal.SIGSTOP)\nsignal.pause()\n")
        child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("orca-release.py")),
                                  "--deployment", str(self.manifest), "daemon"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=5), "fake daemon did not reach wrapper exec")
            self.assertEqual(child.stdout.readline(), b"held\n")
            _, stopped = os.waitpid(child.pid, os.WUNTRACED)
            self.assertTrue(os.WIFSTOPPED(stopped))
            with release.lock(self.root / "admission.lock"):
                with self.assertRaisesRegex(RuntimeError, "Typed lifetime busy"):
                    with self.deployment.typed_enrollment_window():
                        self.fail("paused daemon did not retain lifetime ownership")
        finally:
            child.send_signal(signal.SIGCONT)
            child.terminate()
            child.communicate(timeout=5)

    def test_surviving_child_retains_lifetime_lock_after_supervisor_exit(self):
        adapter = str(Path(__file__).with_name("orca-release.py"))
        code = ("import importlib.util, os, subprocess, sys\n"
                f"spec=importlib.util.spec_from_file_location('release',{adapter!r})\n"
                "r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)\n"
                f"with r.typed_lifetime_lock(r.Path({str(self.root / 'typed-lifetime.lock')!r})):\n"
                " subprocess.Popen([sys.executable,'-c','import os,sys; print(os.getpid(),flush=True); sys.stdin.read(1)'],close_fds=False)\n"
                " os._exit(0)\n")
        supervisor = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        orphan = None
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(supervisor.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=5))
            orphan = int(supervisor.stdout.readline())
            self.assertEqual(supervisor.wait(timeout=5), 0)
            with self.assertRaisesRegex(RuntimeError, "Typed lifetime busy"):
                with self.deployment.typed_enrollment_window():
                    self.fail("surviving writer lost exclusion")
            supervisor.stdin.write(b"x")
            supervisor.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(supervisor.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=5))
            self.assertEqual(supervisor.stdout.read(), b"")
            with self.deployment.typed_enrollment_window():
                pass
        finally:
            if orphan is not None:
                try:
                    os.kill(orphan, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            supervisor.stdin.close()
            supervisor.stdout.close()
            supervisor.stderr.close()
            if supervisor.poll() is None:
                supervisor.kill()
                supervisor.wait(timeout=5)

    def test_lifetime_identity_replacement_and_alias_refuse_without_removing_evidence(self):
        path = self.root / "typed-lifetime.lock"
        with release.typed_lifetime_lock(path) as assertion:
            retired = self.root / "retired-lifetime.lock"
            path.rename(retired)
            path.write_text("replacement")
            with self.assertRaisesRegex(RuntimeError, "identity/ownership changed"):
                assertion()
            self.assertTrue(retired.exists())
        path.unlink()
        path.symlink_to(retired)
        with self.assertRaises(OSError):
            with release.typed_lifetime_lock(path):
                self.fail("symlink lock accepted")
        path.unlink()
        os.link(retired, path)
        with self.assertRaisesRegex(RuntimeError, "identity/ownership changed"):
            with release.typed_lifetime_lock(path):
                self.fail("hardlink lock accepted")

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
