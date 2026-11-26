"""One-step server setup (#881): every step idempotent, a re-run verifies and repairs, an
unmanaged installation is refused, a failed first setup leaves no `current` link or
enabled unit, only a release this setup staged and verified is ever started, and the
operator's own settings survive a re-run. No network and no live systemd: `systemctl` and `loginctl` are stubs that keep
their state in a file, staging writes a release record, and the daemon's health is a switch.
The live path (a real sshd, the app's own ssh) is packages/app/test/server-setup.test.ts."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup_module = load("server_setup", "orca-server-setup.py")
release = load("release", "orca-release.py")
ADAPTER = Path(__file__).with_name("orca-release.py").read_text()

SYSTEMCTL = """#!/usr/bin/env python3
import json, sys
from pathlib import Path
state_file = Path(__file__).with_name("systemd.json")
state = json.loads(state_file.read_text()) if state_file.exists() else {}
args = [a for a in sys.argv[1:] if a != "--user"]
state.setdefault("calls", []).append(args)
code = 0
if args[0] in state.get("broken", []):
    state_file.write_text(json.dumps(state))
    print("systemctl: " + args[0] + " is broken", file=sys.stderr)
    sys.exit(1)
if args[0] == "show-environment":
    code = 0 if state.get("manager", True) else 1
elif args[0] == "is-enabled":
    print("enabled" if state.get("enabled") else "disabled"); code = 0 if state.get("enabled") else 1
elif args[0] == "is-active":
    print("active" if state.get("active") else "inactive"); code = 0 if state.get("active") else 3
elif args[0] == "enable":
    state["enabled"] = True
elif args[0] == "start":
    state["active"] = True
elif args[0] == "stop":
    state["active"] = False
elif args[0] == "disable":
    state["enabled"] = False
    if "--now" in args: state["active"] = False
elif args[0] == "show":
    print(4242 if state.get("active") else 0)
state_file.write_text(json.dumps(state))
sys.exit(code)
"""
LOGINCTL = """#!/usr/bin/env python3
import json, sys
from pathlib import Path
state_file = Path(__file__).with_name("loginctl.json")
state = json.loads(state_file.read_text()) if state_file.exists() else {"linger": True}
if sys.argv[1] == "show-user" and state.get("unreadable", 0) > 0:
    state["unreadable"] -= 1
    state_file.write_text(json.dumps(state))
    sys.exit(1)
if sys.argv[1] in ("enable-linger", "disable-linger"):
    state.setdefault("changes", []).append(sys.argv[1])
if sys.argv[1] == "show-user":
    print("yes" if state["linger"] else "no")
elif sys.argv[1] == "enable-linger":
    state["linger"] = True
elif sys.argv[1] == "disable-linger":
    state["linger"] = False
state_file.write_text(json.dumps(state))
"""


class ServerSetupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, text in (("systemctl", SYSTEMCTL), ("loginctl", LOGINCTL)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        self.proc = self.tmp / "proc"
        self.proc.mkdir()
        self.healthy = True
        self.stage_fails = False
        self.staged = []
        self.scratches = []
        env = patch.dict(os.environ, {"PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin"})
        env.start()
        self.addCleanup(env.stop)
        for name, value in (("system", lambda: "Linux"), ("machine", lambda: "x86_64")):
            patcher = patch.object(setup_module.platform, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    @property
    def root(self):
        return self.home / ".local" / "share" / "orca-server"

    def systemd(self):
        path = self.bin / "systemd.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def set_linger(self, value):
        (self.bin / "loginctl.json").write_text(json.dumps({"linger": value}))

    def linger(self):
        path = self.bin / "loginctl.json"
        return json.loads(path.read_text())["linger"] if path.exists() else True

    def step(self, lines, name):
        return next(line for line in lines if line.get("step") == name)

    def set_systemd(self, **values):
        state = self.systemd()
        state.update(values)
        (self.bin / "systemd.json").write_text(json.dumps(state))

    def setup(self, version="0.8.0", expect_account=None, **expect):
        test = self

        class Under(setup_module.Setup):
            def run_stage(self, source, scratch):
                test.staged.append(source)
                test.scratches.append(scratch)
                if test.stage_fails:
                    return type("Result", (), {"returncode": 1, "stderr": "orca-release: no complete server bundle yet; retry later\n"})()
                stage = scratch / "releases" / ("v" + self.version)
                (stage / "runtime" / "bin").mkdir(parents=True)
                (stage / "runtime" / "bin" / "node").write_text("#!/bin/sh\n")
                (stage / "orca-daemon.mjs").write_text("// daemon\n")
                (stage / "workflows").mkdir()
                (stage / "workflows" / "review.yaml").write_text("name: review\n")
                release.write_json(stage / ".orca-release.json", {
                    "version": self.version, "sha": "a" * 40, "node": "runtime/bin/node", "entry": "orca-daemon.mjs",
                    "source": "bundle", "compatibility": {"storeEpoch": "e", "protocol": {"major": 2, "minor": 2}, "capabilities": []}})
                return type("Result", (), {"returncode": 0, "stderr": ""})()

            def check_health(self):
                if not test.healthy:
                    raise RuntimeError("Health check failed: connection refused")

        made = Under(None, version, 6722, ADAPTER, home=self.home, systemctl=str(self.bin / "systemctl"),
                     expect_account=expect_account, **expect)
        made.proc = self.proc
        made.loginctl_bin = str(self.bin / "loginctl")
        return made

    def run_setup(self, version="0.8.0", inspect=False, expect_account=None, **expect):
        out = io.StringIO()
        with redirect_stdout(out):
            made = self.setup(version, expect_account, **expect)
            code = made.inspect() if inspect else made.run()
        lines = [json.loads(line[len("orca-setup: "):]) for line in out.getvalue().splitlines() if line.startswith("orca-setup: ")]
        return code, lines

    def results(self, lines):
        return {line["step"]: line["result"] for line in lines if "step" in line}

    def test_a_clean_machine_becomes_a_managed_server(self):
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines), {"account": "ok", "platform": "ok", "inventory": "ok", "fence": "ok",
                                               "confirmed": "ok", "recover": "ok", "existing": "ok",
                                               "adapter": "changed", "files": "changed",
                                               "stage": "changed", "select": "changed", "unit": "changed", "linger": "ok",
                                               "start": "changed"})
        self.assertEqual(lines[-1], {"done": True, "root": str(self.root), "command": str(self.root / "orca"),
                                     "account": setup_module.pwd.getpwuid(os.geteuid()).pw_name, "version": "0.8.0", "port": 6722})
        self.assertFalse((self.root / ".setup-journal.json").exists())
        self.assertEqual(self.staged, ["0.8.0"])
        self.assertEqual(os.readlink(self.root / "current"), str((self.root / "releases" / "v0.8.0").resolve()))
        self.assertEqual((self.root / "orca-release.py").read_text(), ADAPTER)
        manifest = json.loads((self.root / "deployment.json").read_text())
        self.assertEqual(manifest["url"], "http://127.0.0.1:6722")
        self.assertEqual(manifest["launchAudit"], "all-cli-acp-and-daemon-launches-migrated")
        # The managed adapter accepts what setup wrote.
        release.Deployment(self.root / "deployment.json")
        wrapper = (self.root / "orca").read_text()
        self.assertIn(f"'{self.root}/orca-release.py' --deployment '{self.root}/deployment.json' cli", wrapper)
        unit = (self.home / ".config" / "systemd" / "user" / "orca.service").read_text()
        self.assertIn(f"ExecStart=/usr/bin/env python3 {self.root}/orca-release.py --deployment {self.root}/deployment.json daemon", unit)
        self.assertEqual((self.systemd()["enabled"], self.systemd()["active"]), (True, True))
        for name in ("deployment.json", "daemon.env", "orca.config.yaml"):
            self.assertEqual((self.root / name).stat().st_mode & 0o777, 0o600, name)

    def test_a_rerun_is_a_no_op_on_a_healthy_server_and_repairs_a_stopped_unit(self):
        self.assertEqual(self.run_setup()[0], 0)
        calls = len(self.systemd()["calls"])
        code, lines = self.run_setup()
        self.assertEqual(code, 0)
        self.assertEqual(set(self.results(lines).values()), {"ok"}, lines)
        self.assertEqual(self.staged, ["0.8.0"])
        # Only questions: nothing was enabled, started or reloaded.
        asked = [call[0] for call in self.systemd()["calls"][calls:]]
        self.assertTrue(set(asked) <= {"show-environment", "is-enabled", "is-active"}, asked)

        # The unit stopped: the next run starts it again, and says it repaired it.
        self.set_systemd(active=False)
        code, lines = self.run_setup()
        self.assertEqual(code, 0)
        self.assertEqual(self.results(lines)["start"], "repaired")
        self.assertTrue(self.systemd()["active"])

        # An operator's edits to the config survive a re-run.
        (self.root / "orca.config.yaml").write_text("workflows: ['/srv/mine/**/*.yaml']\n")
        self.run_setup()
        self.assertEqual((self.root / "orca.config.yaml").read_text(), "workflows: ['/srv/mine/**/*.yaml']\n")

    def snapshot(self):
        files = {str(p.relative_to(self.home)): (p.read_bytes() if p.is_file() and not p.is_symlink() else os.readlink(p)
                                                 if p.is_symlink() else None)
                 for p in sorted(self.home.rglob("*")) if not p.name.endswith(".lock")}  # empty lock files
        return files, {k: v for k, v in self.systemd().items() if k != "calls"}

    def assert_refused_unchanged(self, before, lines, code, step, words):
        self.assertEqual(code, 2, lines)
        if lines[-1].get("step") == "cleanup":  # refused after the journal: put back, and said so
            self.assertEqual(lines[-1]["result"], "ok", lines)
            lines = lines[:-1]
        self.assertEqual((lines[-1]["step"], lines[-1]["result"]), (step, "refused"), lines)
        self.assertIn(words, lines[-1]["detail"])
        self.assertFalse((self.root / ".setup-journal.json").exists())
        self.assertEqual(self.snapshot(), before)

    def test_a_server_on_another_version_is_refused_not_started_or_changed(self):
        self.assertEqual(self.run_setup("0.8.0")[0], 0)
        before = self.snapshot()
        code, lines = self.run_setup("0.8.1")
        self.assert_refused_unchanged(before, lines, code, "existing", "is v0.8.0, not v0.8.1")
        self.assertIn("orca-release.py", lines[-1]["detail"])
        self.assertEqual(self.staged, ["0.8.0"])

    def test_starts_only_the_release_it_staged_and_verified(self):
        """A retry trusts no release by its metadata: only by this setup's receipt for exactly
        this version, confined to the release directory."""
        releases = self.root / "releases"

        def plant_release(at):
            (at / "runtime" / "bin").mkdir(parents=True)
            (at / "runtime" / "bin" / "node").write_text("#!/bin/sh\n")
            (at / "orca-daemon.mjs").write_text("// someone else's\n")
            release.write_json(at / ".orca-release.json", {
                "version": "0.8.0", "sha": "b" * 40, "node": "runtime/bin/node", "entry": "orca-daemon.mjs",
                "source": "bundle", "compatibility": {"storeEpoch": "e", "protocol": {"major": 2, "minor": 2},
                                                      "capabilities": []}})

        # A release with good-looking metadata that this setup never staged (no receipt).
        self.root.mkdir(parents=True)
        (self.root / ".orca-setup.json").write_text(json.dumps({"by": "orca-server-setup", "version": 1}))
        plant_release(releases / "v0.8.0")
        before = self.snapshot()
        code, lines = self.run_setup()
        self.assert_refused_unchanged(before, lines, code, "existing", "no receipt from this setup")
        self.assertEqual(self.staged, [])

        # One it staged, changed afterwards: refused, and the running unit is not restarted.
        self.setUp()
        self.assertEqual(self.run_setup()[0], 0)
        (self.root / "releases" / "v0.8.0" / "orca-daemon.mjs").write_text("// changed\n")
        self.set_systemd(active=False)
        before = self.snapshot()
        code, lines = self.run_setup()
        self.assert_refused_unchanged(before, lines, code, "existing", "changed since this setup staged")
        self.assertFalse(self.systemd()["active"])

        # `current` pointing outside the release directory, at a copy of a verified release.
        self.setUp()
        self.assertEqual(self.run_setup()[0], 0)
        elsewhere = self.tmp / "elsewhere" / "v0.8.0"
        plant_release(elsewhere)
        (self.root / "current").unlink()
        (self.root / "current").symlink_to(elsewhere)
        before = self.snapshot()
        code, lines = self.run_setup()
        self.assert_refused_unchanged(before, lines, code, "existing", "not v0.8.0")

        # A release that is a link to somewhere else.
        self.setUp()
        self.root.mkdir(parents=True)
        (self.root / ".orca-setup.json").write_text(json.dumps({"by": "orca-server-setup", "version": 1}))
        plant_release(self.tmp / "outside" / "v0.8.0")
        releases = self.root / "releases"
        releases.mkdir()
        (releases / "v0.8.0").symlink_to(self.tmp / "outside" / "v0.8.0")
        before = self.snapshot()
        code, lines = self.run_setup()
        self.assert_refused_unchanged(before, lines, code, "existing", "is not a directory of")

    def test_restarts_reuse_only_an_unaltered_release(self):
        """The receipt covers every file the service consumes, not just its runtime."""
        self.assertEqual(self.run_setup()[0], 0)
        release_dir = self.root / "releases" / "v0.8.0"
        for name, change in (
            ("a changed workflow", lambda: (release_dir / "workflows" / "review.yaml").write_text("name: evil\n")),
            ("an added helper", lambda: (release_dir / "helper.mjs").write_text("// added\n")),
            ("a removed asset", lambda: (release_dir / "workflows" / "review.yaml").unlink()),
            ("a changed mode", lambda: (release_dir / "orca-daemon.mjs").chmod(0o777)),
            ("a planted link", lambda: (release_dir / "workflows" / "link.yaml").symlink_to("/etc/passwd")),
        ):
            with self.subTest(name):
                self.setUp()
                self.assertEqual(self.run_setup()[0], 0)
                release_dir = self.root / "releases" / "v0.8.0"
                change()
                self.set_systemd(active=False)
                before = self.snapshot()
                code, lines = self.run_setup()
                self.assert_refused_unchanged(before, lines, code, "existing", "changed since this setup staged")
                self.assertFalse(self.systemd()["active"])

    def test_refuses_before_any_change_when_the_server_is_not_what_was_confirmed(self):
        account = setup_module.pwd.getpwuid(os.geteuid()).pw_name
        # A changed preflight root: the confirmation named another directory.
        before = self.snapshot()
        code, lines = self.run_setup(expect_account=account, expect_root=str(self.tmp / "elsewhere"),
                                     expect_current="none")
        self.assertEqual((code, lines[-1]["result"]), (2, "refused"), lines)
        self.assertIn("not " + str(self.tmp / "elsewhere"), lines[-1]["detail"])
        self.assertEqual(self.snapshot(), before)  # nothing created, not even the directory
        self.assertEqual(self.staged, [])
        self.assertFalse(self.systemd().get("enabled"))
        # Confirmed as a repair, found a first install (and the other way round).
        code, lines = self.run_setup(expect_root=str(self.root), expect_current="0.8.0")
        self.assertEqual((code, lines[-1]["result"]), (2, "refused"))
        self.assertIn("first install", lines[-1]["detail"])
        self.assertFalse(self.root.exists())
        self.assertEqual(self.run_setup(expect_account=account, expect_root=str(self.root), expect_current="none")[0], 0)
        code, lines = self.run_setup(expect_root=str(self.root), expect_current="none")
        self.assertEqual((code, lines[-1]["result"]), (2, "refused"))
        self.assertIn("a repair of v0.8.0", lines[-1]["detail"])
        self.assertEqual(self.run_setup(expect_root=str(self.root), expect_current="0.8.0")[0], 0)

    def test_inventory_refusals_never_echo_command_lines(self):
        (self.proc / "778").mkdir()
        (self.proc / "778" / "cmdline").write_bytes(b"node\0/opt/orca-daemon.mjs\0--token\0s3cret-value\0")
        code, lines = self.run_setup()
        self.assertEqual(code, 2)
        self.assertIn("process 778", lines[-1]["detail"])
        self.assertNotIn("s3cret", lines[-1]["detail"])
        self.assertNotIn("--token", lines[-1]["detail"])

    def test_inventory_recognises_either_side_of_the_rename(self):
        # The v0.8.1 bridge: a process of a release after the Orrery rename is still one it did
        # not make. rename-keep-start: both names on purpose
        for pid, cmdline in (("781", b"node\0/opt/orrery-daemon.mjs\0serve\0"), ("782", b"orrery\0serve\0")):
            with self.subTest(cmdline=cmdline):
                shutil.rmtree(self.proc, ignore_errors=True)
                (self.proc / pid).mkdir(parents=True)
                (self.proc / pid / "cmdline").write_bytes(cmdline)
                code, lines = self.run_setup()
                self.assertEqual(code, 2)
                self.assertIn("process " + pid, lines[-1]["detail"])
        # rename-keep-end

    # A server set up before the rename (0.8) keeps its own names; today's layout is a stand-in
    # here, so these hold whether or not the names have been renamed yet.
    RENAMED = setup_module.Layout("renamed-server", ".renamed-setup.json", "renamed-server-setup", "renamed.service",
                                  "renamed-release.py", "renamed", "renamed-acp", "renamed.config.yaml",
                                  "renamed-acp.config.yaml")

    def layouts(self, current, *read):
        for name, value in (("LAYOUT", current), ("LAYOUTS", (current, *read))):
            patcher = patch.object(setup_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def set_up_before_the_rename(self):
        legacy = setup_module.LEGACY_LAYOUT
        with patch.object(setup_module, "LAYOUT", legacy), patch.object(setup_module, "LAYOUTS", (legacy,)):
            self.assertEqual(self.run_setup()[0], 0)
        return self.home / ".local" / "share" / legacy.directory, legacy

    def test_a_server_set_up_before_the_rename_is_recognised_and_repaired_in_place(self):
        root, legacy = self.set_up_before_the_rename()
        before = self.snapshot()
        self.layouts(self.RENAMED, setup_module.LEGACY_LAYOUT)
        code, lines = self.run_setup(inspect=True)
        self.assertEqual(code, 0, lines)
        self.assertEqual((lines[-1]["root"], lines[-1]["current"]), (str(root), "0.8.0"))
        self.assertEqual(self.snapshot(), before)
        # A repair keeps every name the server runs under: nothing is renamed, nothing added.
        self.set_systemd(active=False)
        code, lines = self.run_setup(expect_root=str(root), expect_current="0.8.0")
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines)["start"], "repaired")
        self.assertEqual(lines[-1]["command"], str(root / legacy.cli))
        self.assertFalse((self.home / ".local" / "share" / self.RENAMED.directory).exists())
        units = sorted(p.name for p in (self.home / ".config" / "systemd" / "user").iterdir())
        self.assertEqual(units, [legacy.service])
        self.assertEqual(sorted(p.name for p in root.iterdir() if "renamed" in p.name), [])
        self.assertEqual(json.loads((root / "deployment.json").read_text())["service"], legacy.service)

    def test_a_new_server_gets_todays_names_and_refuses_beside_another_install(self):
        self.layouts(self.RENAMED, setup_module.LEGACY_LAYOUT)
        root = self.home / ".local" / "share" / self.RENAMED.directory
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual((lines[-1]["root"], lines[-1]["command"]), (str(root), str(root / "renamed")))
        self.assertTrue((root / ".renamed-setup.json").is_file())
        for name in ("renamed-release.py", "renamed-acp", "renamed.config.yaml", "renamed-acp.config.yaml"):
            self.assertTrue((root / name).is_file(), name)
        self.assertIn("renamed-server-setup", (self.home / ".config" / "systemd" / "user" / "renamed.service").read_text())
        # A unit under the old name that this setup did not write is another installation.
        self.setUp()
        self.layouts(self.RENAMED, setup_module.LEGACY_LAYOUT)
        units = self.home / ".config" / "systemd" / "user"
        units.mkdir(parents=True)
        (units / setup_module.LEGACY_LAYOUT.service).write_text("[Service]\n")
        code, lines = self.run_setup()
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (2, "inventory", "refused"))
        self.assertIn(f"systemd user unit {setup_module.LEGACY_LAYOUT.service}", lines[-1]["detail"])

    def test_a_rerun_keeps_the_operators_deployment_settings(self):
        self.assertEqual(self.run_setup()[0], 0)
        manifest = json.loads((self.root / "deployment.json").read_text())
        manifest["cliConfig"] = "/srv/operator/orca.config.yaml"
        manifest["feed"] = {"channel": "stable", "tokenFile": "/srv/operator/feed.token"}
        del manifest["launchAudit"]
        (self.root / "deployment.json").write_text(json.dumps(manifest, indent=2) + "\n")
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines)["files"], "repaired")
        after = json.loads((self.root / "deployment.json").read_text())
        # Every operator setting kept; only the missing key added back.
        self.assertEqual(after, {**manifest, "launchAudit": "all-cli-acp-and-daemon-launches-migrated"})
        # Then a no-op.
        code, lines = self.run_setup()
        self.assertEqual(self.results(lines)["files"], "ok")
        self.assertEqual(json.loads((self.root / "deployment.json").read_text()), after)

        # A key setup owns, changed: refused for the operator to repair, never rewritten.
        after["service"] = "other.service"
        (self.root / "deployment.json").write_text(json.dumps(after, indent=2) + "\n")
        before = self.snapshot()
        code, lines = self.run_setup()
        self.assert_refused_unchanged(before, lines, code, "existing", "sets service")

    def test_inspect_changes_nothing_and_says_who_and_what(self):
        before = self.snapshot()
        code, lines = self.run_setup(inspect=True)
        self.assertEqual(code, 0, lines)
        self.assertEqual(lines[-1], {"inspected": True, "account": setup_module.pwd.getpwuid(os.geteuid()).pw_name,
                                     "root": str(self.root), "current": None})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.staged, [])
        self.assertEqual(self.run_setup()[0], 0)
        self.assertEqual(self.run_setup(inspect=True)[1][-1]["current"], "0.8.0")
        # A refusal shows up at inspection, before anything is confirmed.
        self.setUp()
        (self.bin / "orca").write_text("#!/bin/sh\nexec python3 /opt/orca/orca-release.py cli \"$@\"\n")
        code, lines = self.run_setup(inspect=True)
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (2, "inventory", "refused"))

    def test_runs_only_as_the_confirmed_account(self):
        before = self.snapshot()
        code, lines = self.run_setup(expect_account="someone-else")
        self.assert_refused_unchanged(before, lines, code, "account", "not someone-else as confirmed")
        self.assertEqual(self.run_setup(expect_account=setup_module.pwd.getpwuid(os.geteuid()).pw_name)[0], 0)

    def test_refuses_an_unmanaged_installation_and_changes_nothing(self):
        cases = {
            "launcher": lambda: ((self.bin / "orca").write_text(
                "#!/bin/sh\nexec python3 /srv/dev/orca-live/orca-release.py --deployment x cli \"$@\"\n"), "launcher"),
            "unit": lambda: (self.home.joinpath(".config", "systemd", "user").mkdir(parents=True, exist_ok=True),
                             self.home.joinpath(".config", "systemd", "user", "orca.service").write_text("[Service]\n"),
                             "systemd user unit orca.service"),
            "process": lambda: ((self.proc / "777").mkdir(), (self.proc / "777" / "cmdline").write_bytes(
                b"node\0/srv/dev/orca-live/packages/cli/dist/main.js\0serve\0"), "process 777"),
            "directory": lambda: (self.root.mkdir(parents=True), (self.root / "notes.txt").write_text("x"),
                                  "was not made by this setup"),
        }
        for name, plant in cases.items():
            with self.subTest(name):
                self.setUp()
                expected = plant()[-1]
                code, lines = self.run_setup()
                self.assertEqual(code, 2)
                refused = lines[-1]
                self.assertEqual((refused["step"], refused["result"]), ("inventory", "refused"))
                self.assertIn(expected, refused["detail"])
                self.assertIn("docs/UPDATING.md", refused["detail"])
                self.assertFalse((self.root / "orca-release.py").exists())
                self.assertEqual(self.staged, [])
                self.assertFalse(self.systemd().get("enabled"))

    def test_the_screen_reader_called_orca_is_not_an_orca_installation(self):
        (self.bin / "orca").write_text("#!/usr/bin/python3\nimport orca\norca.main()\n")
        self.assertEqual(self.run_setup()[0], 0)

    def test_a_failed_first_setup_leaves_no_current_link_or_enabled_unit(self):
        self.healthy = False
        self.set_linger(False)
        code, lines = self.run_setup()
        self.assertEqual(code, 1)
        self.assertEqual(self.step(lines, "start")["result"], "failed")
        self.assertEqual((lines[-1]["step"], lines[-1]["result"]), ("cleanup", "ok"))
        self.assertFalse(self.linger())  # lingering, enabled by this run, is off again
        self.assertFalse((self.root / ".setup-journal.json").exists())
        self.assertFalse(os.path.lexists(self.root / "current"))
        self.assertFalse((self.home / ".config" / "systemd" / "user" / "orca.service").exists())
        self.assertFalse(self.systemd()["enabled"])
        self.assertFalse(self.systemd()["active"])
        # The release stays staged: the next run reuses it.
        self.healthy = True
        self.assertEqual(self.run_setup()[0], 0)
        self.assertEqual(self.staged, ["0.8.0"])

        # A bundle that is not published yet: a typed failure, nothing selected or enabled.
        self.setUp()
        self.stage_fails = True
        code, lines = self.run_setup()
        self.assertEqual(code, 1)
        self.assertEqual(self.step(lines, "stage")["result"], "failed")
        self.assertIn("retry later", self.step(lines, "stage")["detail"])
        self.assertEqual(lines[-1]["step"], "cleanup")
        self.assertFalse(os.path.lexists(self.root / "current"))
        self.assertFalse(self.systemd().get("enabled"))

    def test_a_failed_repair_leaves_the_installation_as_it_found_it(self):
        self.assertEqual(self.run_setup()[0], 0)
        unit = self.home / ".config" / "systemd" / "user" / "orca.service"
        # An enabled but stopped unit, with an older unit file of this setup's.
        self.set_systemd(active=False)
        older = unit.read_text().replace("TimeoutStopSec=20", "TimeoutStopSec=10")
        unit.write_text(older)
        self.healthy = False
        code, lines = self.run_setup()
        self.assertEqual(code, 1)
        self.assertEqual((lines[-1]["step"], lines[-1]["result"]), ("cleanup", "ok"), lines)
        # Started for the repair, health failed: stopped again, not left running.
        self.assertFalse(self.systemd()["active"])
        self.assertTrue(self.systemd()["enabled"])
        self.assertEqual(unit.read_text(), older)
        self.assertTrue(os.path.lexists(self.root / "current"))

    def test_an_unconfirmed_cleanup_says_so_and_the_next_run_finishes_it(self):
        self.healthy = False
        self.set_systemd(broken=["stop", "disable"])
        code, lines = self.run_setup()
        self.assertEqual(code, 1)
        self.assertEqual((lines[-1]["step"], lines[-1]["result"]), ("cleanup", "failed"), lines)
        self.assertIn("active is not back", lines[-1]["detail"])
        self.assertTrue((self.root / ".setup-journal.json").exists())
        # Fixed: the next run first puts back what the last one left, then sets up.
        self.set_systemd(broken=[])
        self.healthy = True
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines)["recover"], "repaired")
        self.assertFalse((self.root / ".setup-journal.json").exists())

    def test_a_run_cut_off_midway_is_put_back_by_the_next(self):
        """The process dies (the session's end, a kill) before it can put anything back: the
        journal it wrote before its first change lets the next run do it."""
        self.set_linger(False)
        test = self

        class Killed(BaseException):
            pass

        def die():
            raise Killed()
        made = self.setup()
        made.check_health = die
        with redirect_stdout(io.StringIO()), self.assertRaises(Killed):
            made.run()
        self.assertTrue(self.systemd()["active"])
        self.assertTrue(self.linger())
        journal = json.loads((self.root / ".setup-journal.json").read_text())["before"]
        self.assertEqual(journal, {"unit": None, "enabled": False, "active": False, "current": None, "linger": False,
                                   "files": {name: None for name, _ in setup_module.OWNED_FILES}})
        # The next run (unhealthy too) first puts back what the cut-off one changed.
        test.healthy = False
        code, lines = self.run_setup()
        self.assertEqual(self.results(lines)["recover"], "repaired")
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (1, "cleanup", "ok"))
        self.assertEqual((self.systemd()["active"], self.systemd()["enabled"], self.linger()), (False, False, False))
        self.assertFalse(os.path.lexists(self.root / "current"))

    def kill_at(self, method, after=None):
        """A run that dies (a kill, the session's end) inside `method`, after `after` ran."""
        class Killed(BaseException):
            pass
        made = self.setup()
        original = getattr(made, method)

        def die(*args):
            if after:
                after(made, original, *args)
            raise Killed()
        setattr(made, method, die)
        with redirect_stdout(io.StringIO()), self.assertRaises(Killed):
            made.run()

    def test_a_confirmed_repair_stays_bound_through_recovery(self):
        """A run cut off after it created `current` leaves a provisional link: that is not a
        repair. Inspection says install, and a confirmation for a repair is refused unchanged."""
        self.kill_at("check_health")
        self.assertTrue(os.path.lexists(self.root / "current"))
        code, lines = self.run_setup(inspect=True)
        self.assertEqual((code, lines[-1]["current"]), (0, None), lines)
        before = self.snapshot()
        code, lines = self.run_setup(expect_root=str(self.root), expect_current="0.8.0")
        self.assertEqual((code, lines[-1]["result"]), (2, "refused"), lines)
        self.assertIn("first install", lines[-1]["detail"])
        self.assertEqual(self.snapshot(), before)
        self.assertTrue((self.root / ".setup-journal.json").exists())
        # Confirmed as what it is: recovered, then installed.
        code, lines = self.run_setup(expect_root=str(self.root), expect_current="none")
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines)["recover"], "repaired")

    def test_an_interrupted_recovery_is_finished_by_the_next_run(self):
        self.kill_at("check_health")
        # The next run is cut off too, inside its recovery, after part of the put-back.
        self.kill_at("restore", after=lambda made, original, *args: made.systemctl("stop", "orca.service"))
        self.assertTrue((self.root / ".setup-journal.json").exists())
        self.healthy = False
        code, lines = self.run_setup()
        self.assertEqual(self.results(lines)["recover"], "repaired")
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (1, "cleanup", "ok"))
        self.assertEqual((self.systemd()["active"], self.systemd()["enabled"]), (False, False))
        self.assertFalse(os.path.lexists(self.root / "current"))
        self.assertFalse((self.root / ".setup-journal.json").exists())

    def test_two_setup_owners_never_share_a_transaction(self):
        """A second setup while the first holds the fence is refused, and touches neither the
        first's journal nor its result; the first finishes (journal retired) under its fence."""
        test = self
        seen = {}

        class First(type(self.setup())):
            def check_health(self):
                journal = (self.root / ".setup-journal.json").read_text()
                out = io.StringIO()
                with redirect_stdout(out):
                    seen["second"] = test.setup().run()
                seen["lines"] = out.getvalue()
                seen["journal_kept"] = (self.root / ".setup-journal.json").read_text() == journal

        made = First(None, "0.8.0", 6722, ADAPTER, home=self.home, systemctl=str(self.bin / "systemctl"))
        made.proc = self.proc
        made.loginctl_bin = str(self.bin / "loginctl")
        released = []
        original = made.release_fence

        def release():
            released.append(os.path.lexists(self.root / ".setup-journal.json"))
            original()
        made.release_fence = release
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(made.run(), 0)
        self.assertEqual(seen["second"], 2)
        self.assertIn("Another setup", seen["lines"])
        self.assertTrue(seen["journal_kept"])
        # The journal was gone before the fence was let go.
        self.assertEqual(released, [False])
        self.assertIn('"done": true', out.getvalue())

    def plant_release(self, at, daemon="// staged elsewhere\n"):
        (at / "runtime" / "bin").mkdir(parents=True)
        (at / "runtime" / "bin" / "node").write_text("#!/bin/sh\n")
        (at / "orca-daemon.mjs").write_text(daemon)
        release.write_json(at / ".orca-release.json", {
            "version": "0.8.0", "sha": "c" * 40, "node": "runtime/bin/node", "entry": "orca-daemon.mjs",
            "source": "bundle", "compatibility": {"storeEpoch": "e", "protocol": {"major": 2, "minor": 2},
                                                  "capabilities": []}})

    def test_an_interrupted_staging_leaves_only_its_own_scratch_to_remove(self):
        def stage_then_die(made, original, source, scratch):
            original(source, scratch)
        self.kill_at("run_stage", after=stage_then_die)
        scratch = self.scratches[0]
        self.assertTrue((scratch / "releases" / "v0.8.0").is_dir())
        # Nothing was published into the shared release directory.
        self.assertFalse(os.path.lexists(self.root / "releases" / "v0.8.0"))
        code, lines = self.run_setup(inspect=True)
        self.assertEqual(code, 0, lines)
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines)["recover"], "repaired")
        self.assertFalse(scratch.exists())
        self.assertEqual(self.staged, ["0.8.0", "0.8.0"])
        self.assertTrue((self.root / "receipts" / "v0.8.0.json").exists())
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith(".setup-stage-")], [])

    def test_recovery_never_removes_a_release_another_writer_staged(self):
        """An interrupted setup, then the adapter's own `stage` publishes v0.8.0 by itself: the
        next setup removes only its scratch, leaves that release intact, and refuses it for
        reconciliation (no receipt of this setup's) without starting it."""
        def stage_then_die(made, original, source, scratch):
            original(source, scratch)
        self.kill_at("run_stage", after=stage_then_die)
        independent = self.root / "releases" / "v0.8.0"
        independent.parent.mkdir(exist_ok=True)
        self.plant_release(independent)
        before_release = sorted(str(p.relative_to(independent)) for p in independent.rglob("*"))
        code, lines = self.run_setup()
        self.assertEqual(self.results(lines)["recover"], "repaired")
        self.assertEqual((code, self.step(lines, "existing")["result"]), (2, "refused"), lines)
        self.assertIn("no receipt from this setup", self.step(lines, "existing")["detail"])
        self.assertEqual(sorted(str(p.relative_to(independent)) for p in independent.rglob("*")), before_release)
        self.assertEqual((independent / "orca-daemon.mjs").read_text(), "// staged elsewhere\n")
        self.assertFalse(self.scratches[0].exists())
        self.assertFalse(self.systemd().get("active"))

    def test_holds_the_update_lock_so_no_other_writer_publishes_meanwhile(self):
        import fcntl
        seen = {}

        def stage_and_probe(made, original, source, scratch):
            with open(made.root / "update.lock", "a+") as other:
                try:
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    seen["free"] = True
                except BlockingIOError:
                    seen["free"] = False
        self.kill_at("run_stage", after=stage_and_probe)
        self.assertEqual(seen, {"free": False})

    def test_a_failed_run_puts_setups_own_files_back(self):
        self.assertEqual(self.run_setup()[0], 0)
        older = "# an older adapter\n" + ADAPTER
        (self.root / "orca-release.py").write_text(older)
        (self.root / "orca").unlink()
        self.set_systemd(active=False)
        self.healthy = False
        code, lines = self.run_setup()
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (1, "cleanup", "ok"), lines)
        self.assertEqual((self.root / "orca-release.py").read_text(), older)
        self.assertFalse((self.root / "orca").exists())

    def test_lingering_is_left_alone_when_its_state_is_unknown(self):
        (self.bin / "loginctl").write_text("#!/bin/sh\necho \"$@\" >> \"$(dirname \"$0\")/loginctl.calls\"\nexit 1\n")
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.step(lines, "linger")["result"], "warning")
        calls = (self.bin / "loginctl.calls").read_text()
        self.assertNotIn("enable-linger", calls)
        self.assertNotIn("disable-linger", calls)

    def test_rollback_keeps_the_unit_files_mode_and_refuses_a_linked_unit(self):
        self.assertEqual(self.run_setup()[0], 0)
        unit = self.home / ".config" / "systemd" / "user" / "orca.service"
        older = unit.read_text().replace("TimeoutStopSec=20", "TimeoutStopSec=10")
        unit.write_text(older)
        unit.chmod(0o600)
        self.healthy = False
        code, lines = self.run_setup()
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (1, "cleanup", "ok"), lines)
        self.assertEqual((unit.read_text(), unit.stat().st_mode & 0o777), (older, 0o600))
        # A unit that is a link is refused before anything changes, never replaced by a file.
        target = self.tmp / "elsewhere.service"
        target.write_text(older)
        unit.unlink()
        unit.symlink_to(target)
        self.healthy = True
        before = self.snapshot()
        code, lines = self.run_setup()
        self.assert_refused_unchanged(before, lines, code, "existing", "is not a plain file")
        self.assertTrue(unit.is_symlink())

    def test_lingering_follows_the_journaled_baseline(self):
        """Unknown when the run began: never changed, even if a later query answers."""
        (self.bin / "loginctl.json").write_text(json.dumps({"linger": False, "unreadable": 1}))
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.step(lines, "linger")["result"], "warning")
        self.assertNotIn("changes", json.loads((self.bin / "loginctl.json").read_text()))
        self.assertFalse(self.linger())

    def test_recovery_belongs_to_the_interrupted_transaction(self):
        self.kill_at("check_health")
        before = self.snapshot()
        for inspect in (True, False):
            code, lines = self.run_setup("0.8.1", inspect=inspect)
            self.assertEqual((code, lines[-1]["result"]), (2, "refused"), lines)
            self.assertIn("interrupted setup of v0.8.0 is pending", lines[-1]["detail"])
            self.assertEqual(self.snapshot(), before)
        # The same transaction's version finishes it.
        self.assertEqual(self.run_setup("0.8.0")[0], 0)

    def test_fenced_against_a_concurrent_setup_or_update(self):
        import fcntl
        self.assertEqual(self.run_setup()[0], 0)
        for name, plant in (
            ("admission.lock", "Another setup, an update or an ORCA command is running"),
            ("update.lock", "An update is running"),
        ):
            with self.subTest(name), open(self.root / name, "a+") as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                self.set_systemd(active=False)
                before = self.snapshot()
                code, lines = self.run_setup()
                self.assert_refused_unchanged(before, lines, code, "fence", plant)
        (self.root / "activation.json").write_text("{}")
        before = self.snapshot()
        code, lines = self.run_setup()
        self.assert_refused_unchanged(before, lines, code, "fence", "orca-release.py recover")

    def test_a_session_that_goes_away_loses_output_not_the_run(self):
        class Gone(io.StringIO):
            def write(self, text):
                raise BrokenPipeError()
        saved = sys.stdout
        sys.stdout = Gone()
        try:
            code = self.setup().run()
        finally:
            sys.stdout = saved
        self.assertEqual(code, 0)
        self.assertTrue(self.systemd()["active"])
        self.assertFalse((self.root / ".setup-journal.json").exists())

    def test_refuses_what_cannot_run_a_server(self):
        with patch.object(setup_module.platform, "machine", lambda: "aarch64"):
            code, lines = self.run_setup()
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (2, "platform", "refused"))
        self.set_systemd(manager=False)
        code, lines = self.run_setup()
        self.assertEqual((code, lines[-1]["step"], lines[-1]["result"]), (2, "platform", "refused"))
        self.assertIn("systemd user manager", lines[-1]["detail"])

    def test_the_embedded_adapter_runs_from_standard_input(self):
        """What the app sends: `python3 - ARGS` with the adapter embedded ahead of the setup."""
        import base64
        import subprocess
        program = ("EMBEDDED_ADAPTER = " + repr(base64.b64encode(ADAPTER.encode()).decode()) + "\n"
                   + Path(__file__).with_name("orca-server-setup.py").read_text())
        # A bad version is refused by the argument parser before anything else happens.
        result = subprocess.run([sys.executable, "-", "--version", "nope"], input=program, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--version takes", result.stderr)
        # A real run, refused on this test host's platform or systemd, still reads the adapter. It
        # stages from an empty local bundle directory: without --bundle it would download the
        # published release of that version, which made this test slow and network-bound once
        # v0.8.0 existed.
        empty = self.tmp / "no-bundle"
        empty.mkdir()
        result = subprocess.run([sys.executable, "-", "--version", "0.8.0", "--root", str(self.tmp / "srv"),
                                 "--bundle", str(empty)],
                                input=program, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, "HOME": str(self.home)})
        line = json.loads(result.stdout.splitlines()[-1][len("orca-setup: "):])
        self.assertIn(line["result"], ("ok", "refused", "failed"))



class OfflineBundleTests(unittest.TestCase):
    """#1234: only an explicit --offline-bundle asks the adapter to use what was carried."""

    def stage_args(self, **options):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        setup = setup_module.Setup(root.name, "0.8.0", 6722, "", **options)
        setup.manifest.write_text("{}")
        seen = []
        with patch.object(setup_module.subprocess, "run", lambda args, **_: seen.append(args)):
            setup.run_stage(str(options.get("bundle", "0.8.0")), Path(root.name))
        return seen[0][seen[0].index("stage"):]

    def test_an_ordinary_bundle_directory_is_staged_as_before(self):
        self.assertEqual(self.stage_args(bundle="/tmp/b"), ["stage", "--bundle", "/tmp/b"])

    def test_an_offline_bundle_says_so(self):
        self.assertEqual(self.stage_args(bundle="/tmp/b", offline=True), ["stage", "--bundle", "--offline", "/tmp/b"])

    def test_offline_needs_a_bundle(self):
        with self.assertRaises(SystemExit), redirect_stdout(io.StringIO()), patch("sys.stderr", io.StringIO()):
            setup_module.main(["--version", "0.8.0", "--offline-bundle", "--adapter", __file__])


if __name__ == "__main__":
    unittest.main()
