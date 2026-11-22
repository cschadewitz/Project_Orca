"""Isolated deployment tests: no live service, credentials, config or store is used."""
import importlib.util
import json
import os
import selectors
import signal
import socket
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

    def test_expected_predecessor_is_checked_under_the_locks(self):
        # An app confirmed 0.6.0 -> 0.6.1; the timer moved the server to 0.6.1 first.
        self.deployment.activate(self.new)
        newer = self.make_release("0.6.2")
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, "^Server moved: it runs 0.6.1, not the 0.6.0"):
            self.deployment.activate(newer, "0.6.0")
        self.assertEqual((self.root / "current").resolve(), self.new)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.deployment.pending.exists())
        self.deployment.activate(newer, "0.6.1")
        self.assertEqual((self.root / "current").resolve(), newer)

    def test_expect_current_from_the_command_line(self):
        script = Path(__file__).with_name("orca-release.py")
        run = lambda *extra: subprocess.run(
            [sys.executable, str(script), "--deployment", str(self.manifest), *extra],
            capture_output=True, text=True, timeout=30)
        moved = run("update", "--bundle", "v0.6.1", "--expect-current", "0.5.9")
        self.assertEqual(moved.returncode, 1)
        self.assertIn("orca-release: Server moved: it runs 0.6.0, not the 0.5.9", moved.stderr)
        self.assertEqual((self.root / "current").resolve(), self.old)
        for bad in (["update", "v0.6.1", "--expect-current"], ["update", "v0.6.1", "--expect-current", "v0.6.0"],
                    ["stage", "v0.6.1", "--expect-current", "0.6.0"]):
            result = run(*bad)
            self.assertEqual(result.returncode, 1)
            self.assertIn("--expect-current takes", result.stderr)

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

    def test_daemon_alone_learns_its_deployment_for_app_updates(self):
        # #879: the managed daemon reports these in hello so the app can run this adapter over
        # SSH. A CLI or ACP child is told nothing, even when the caller's environment has them.
        self.config["ring"] = "preview"
        self.manifest.write_text(json.dumps(self.config))
        deployment = release.Deployment(self.manifest)
        with patch.dict(os.environ, {"ORCA_DEPLOYMENT_RING": "stable", "ORCA_DEPLOYMENT_ADAPTER": "/elsewhere"}):
            with patch.object(os, "execve") as execute:
                deployment.launch("daemon", [])
                env = execute.call_args.args[2]
                self.assertEqual(env["ORCA_DEPLOYMENT_MANIFEST"], str(self.manifest.resolve()))
                self.assertEqual(env["ORCA_DEPLOYMENT_ADAPTER"],
                                 str(Path(__file__).with_name("orca-release.py").resolve()))
                self.assertEqual(env["ORCA_DEPLOYMENT_RING"], "preview")
            with patch.object(os, "execve") as execute:
                deployment.launch("cli", ["status"])
                env = execute.call_args.args[2]
                for name in release.DEPLOYMENT_ENV:
                    self.assertNotIn(name, env)

    def test_unknown_ring_is_not_reported(self):
        self.config["ring"] = "nightly"
        self.manifest.write_text(json.dumps(self.config))
        self.assertNotIn("ORCA_DEPLOYMENT_RING", release.Deployment(self.manifest).deployment_env())

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
                f"with r.typed_lifetime_lock(r.Path({str(self.root / 'typed-lifetime.lock')!r})) as owner:\n"
                " subprocess.Popen([sys.executable,'-c','import os,sys; print(os.getpid(),flush=True); sys.stdin.read(1)'],pass_fds=(owner.descriptor,))\n"
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

    @unittest.skipUnless(sys.platform == "linux", "Linux pidfd/descriptor inheritance fixture")
    def test_actual_stage_children_retain_exclusion_after_supervisor_death(self):
        # Actual Deployment.stage -> run/capture/subprocess.run/Popen. Only the
        # executable is substituted: no test-provided pass_fds/close_fds bypass.
        targets = ("release-view", "clone", "git-revision", "mise-trust", "mise-install",
                   "pnpm-install", "pnpm-typecheck", "pnpm-build", "node-path", "candidate-version",
                   "demo", "validate-cli", "validate-acp", "validate-daemon", "health")
        fixture = str(Path(__file__).with_name("tests") / "typed-lifetime-child.py")
        for target in targets:
            with self.subTest(dispatch=target), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                root = Path(temporary)
                config = {**self.config, "root": str(root), "cwd": str(root),
                          **{role + "Config": str(root / (role + ".yaml")) for role in ("cli", "acp", "daemon")}}
                (root / "deployment.json").write_text(json.dumps(config))
                deployment = release.Deployment(root / "deployment.json")
                with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
                    notify.bind(str(root / "notify"))
                    supervisor = subprocess.Popen([sys.executable, "-B", fixture, "stage", str(root), target],
                                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    producer = producer_fd = None
                    try:
                        with selectors.DefaultSelector() as selector:
                            selector.register(notify, selectors.EVENT_READ)
                            self.assertTrue(selector.select(timeout=5), "stage did not dispatch " + target)
                        observed = json.loads(notify.recv(4096))
                        producer = observed["pid"]
                        producer_fd = os.pidfd_open(producer)
                        self.assertEqual(observed["label"], target)
                        self.assertFalse(observed["unrelated"], "unrelated inheritable FD leaked")
                        supervisor.kill()
                        supervisor.wait(timeout=5)
                        with self.assertRaisesRegex(RuntimeError, "Typed lifetime busy"):
                            with deployment.typed_enrollment_window():
                                self.fail("stage producer lost lifetime exclusion: " + target)
                    finally:
                        if supervisor.poll() is None:
                            supervisor.kill()
                        if producer is not None:
                            try:
                                os.kill(producer, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                        if producer_fd is not None:
                            with selectors.DefaultSelector() as selector:
                                selector.register(producer_fd, selectors.EVENT_READ)
                                self.assertTrue(selector.select(timeout=5), "fixture producer did not stop")
                            os.close(producer_fd)
                        supervisor.communicate(timeout=5)
                    # The real direct producer has stopped; kernel exclusion now releases.
                    with deployment.typed_enrollment_window():
                        pass

    def test_normal_and_exceptional_context_cleanup_do_not_unlock_a_surviving_child(self):
        for exceptional in (False, True):
            with self.subTest(exceptional=exceptional):
                children = []
                @release.typed_operation("update")
                def start(deployment):
                    child = deployment.typed_process(subprocess.Popen, [sys.executable, "-c",
                        "import sys; print('ready',flush=True); sys.stdin.read(1)"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    children.append(child)
                    with selectors.DefaultSelector() as selector:
                        selector.register(child.stdout, selectors.EVENT_READ)
                        self.assertTrue(selector.select(timeout=5))
                    self.assertEqual(child.stdout.readline(), b"ready\n")
                    if exceptional:
                        raise RuntimeError("synthetic parent unwind")
                    return child
                try:
                    if exceptional:
                        with self.assertRaisesRegex(RuntimeError, "synthetic parent unwind"):
                            start(self.deployment)
                    else:
                        start(self.deployment)
                    # Parent descriptor has closed on both paths. LOCK_UN here
                    # would drop the shared open-file description in the child.
                    self.assertEqual(self.deployment._typed_lifetimes, [])
                    self.assertEqual(self.deployment._typed_assertions, [])
                    with self.assertRaisesRegex(RuntimeError, "Typed lifetime busy"):
                        with self.deployment.typed_enrollment_window():
                            self.fail("parent cleanup unlocked a surviving direct child")
                    children[0].communicate(b"x", timeout=5)
                    with self.deployment.typed_enrollment_window():
                        pass
                finally:
                    for child in children:
                        if child.poll() is None:
                            child.kill()
                        child.communicate(timeout=5)

    def test_every_stage_capture_rechecks_ownership_before_dispatch(self):
        for target in ("git-revision", "node-path", "candidate-version"):
            with self.subTest(dispatch=target):
                current, calls = True, []
                def inspect(*args):
                    def assertion():
                        if not current:
                            raise RuntimeError("synthetic ownership lost before capture")
                    return assertion
                self.deployment.typed_inspector = inspect
                def command(args, **kwargs):
                    nonlocal current
                    if args[:3] == ["gh", "repo", "clone"]:
                        checkout = Path(args[4])
                        (checkout / "package.json").write_text(json.dumps({"version": "0.6.2"}))
                        (checkout / "release-compatibility.json").write_text(json.dumps({"storeEpoch": "v1"}))
                        if target == "git-revision":
                            current = False
                    if args[-2:] == ["run", "build"] and target == "node-path":
                        current = False
                def capture(args, **kwargs):
                    nonlocal current
                    if args[:3] == ["gh", "release", "view"]:
                        return json.dumps({"tagName": "v0.6.2", "isDraft": False, "isPrerelease": False})
                    if args[0] == "git":
                        calls.append("git-revision")
                        return "a" * 40
                    if args[:2] == ["mise", "which"]:
                        calls.append("node-path")
                        if target == "candidate-version":
                            current = False
                        return sys.executable
                    calls.append("candidate-version")
                    return "0.6.2"
                with patch.object(release, "run", side_effect=command), patch.object(release, "capture", side_effect=capture):
                    with self.assertRaisesRegex(RuntimeError, "ownership lost before capture"):
                        self.deployment.stage("v0.6.2")
                self.assertNotIn(target, calls)
                self.assertFalse((self.root / "releases/v0.6.2").exists())
                self.assertEqual(self.calls, [])
                self.assertEqual((self.root / "current").resolve(), self.old)

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
                (nested / f"latest-{arch}.yml").write_text(
                    f"version: 0.6.0\nfiles:\n  - url: {name}\n    sha512: {digest}\n    size: {len(body)}\n"
                    f"path: {name}\nsha512: {digest}\nreleaseDate: '2026-11-21T00:00:00.000Z'\n"
                )
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
