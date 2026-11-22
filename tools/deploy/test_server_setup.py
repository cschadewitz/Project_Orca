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
elif args[0] == "disable":
    state["enabled"] = False
    if "--now" in args: state["active"] = False
elif args[0] == "show":
    print(4242 if state.get("active") else 0)
state_file.write_text(json.dumps(state))
sys.exit(code)
"""
LOGINCTL = "#!/bin/sh\n[ \"$1\" = show-user ] && echo yes\nexit 0\n"


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

    def set_systemd(self, **values):
        state = self.systemd()
        state.update(values)
        (self.bin / "systemd.json").write_text(json.dumps(state))

    def setup(self, version="0.8.0", expect_account=None):
        test = self

        class Under(setup_module.Setup):
            def run_stage(self, source):
                test.staged.append(source)
                if test.stage_fails:
                    return type("Result", (), {"returncode": 1, "stderr": "orca-release: no complete server bundle yet; retry later\n"})()
                stage = self.root / "releases" / ("v" + self.version)
                (stage / "runtime" / "bin").mkdir(parents=True)
                (stage / "runtime" / "bin" / "node").write_text("#!/bin/sh\n")
                (stage / "orca-daemon.mjs").write_text("// daemon\n")
                release.write_json(stage / ".orca-release.json", {
                    "version": self.version, "sha": "a" * 40, "node": "runtime/bin/node", "entry": "orca-daemon.mjs",
                    "source": "bundle", "compatibility": {"storeEpoch": "e", "protocol": {"major": 2, "minor": 2}, "capabilities": []}})
                return type("Result", (), {"returncode": 0, "stderr": ""})()

            def check_health(self):
                if not test.healthy:
                    raise RuntimeError("Health check failed: connection refused")

        made = Under(None, version, 6722, ADAPTER, home=self.home, systemctl=str(self.bin / "systemctl"),
                     expect_account=expect_account)
        made.proc = self.proc
        return made

    def run_setup(self, version="0.8.0", inspect=False, expect_account=None):
        out = io.StringIO()
        with redirect_stdout(out):
            made = self.setup(version, expect_account)
            code = made.inspect() if inspect else made.run()
        lines = [json.loads(line[len("orca-setup: "):]) for line in out.getvalue().splitlines() if line.startswith("orca-setup: ")]
        return code, lines

    def results(self, lines):
        return {line["step"]: line["result"] for line in lines if "step" in line}

    def test_a_clean_machine_becomes_a_managed_server(self):
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines), {"account": "ok", "platform": "ok", "inventory": "ok", "existing": "ok",
                                               "adapter": "changed", "files": "changed",
                                               "stage": "changed", "select": "changed", "unit": "changed", "linger": "ok",
                                               "start": "changed"})
        self.assertEqual(lines[-1], {"done": True, "root": str(self.root), "command": str(self.root / "orca"),
                                     "version": "0.8.0", "port": 6722})
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
                 for p in sorted(self.home.rglob("*"))}
        return files, {k: v for k, v in self.systemd().items() if k != "calls"}

    def assert_refused_unchanged(self, before, lines, code, step, words):
        self.assertEqual(code, 2, lines)
        self.assertEqual((lines[-1]["step"], lines[-1]["result"]), (step, "refused"), lines)
        self.assertIn(words, lines[-1]["detail"])
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
        self.assert_refused_unchanged(before, lines, code, "files", "sets service")

    def test_inspect_changes_nothing_and_says_who_and_what(self):
        before = self.snapshot()
        code, lines = self.run_setup(inspect=True)
        self.assertEqual(code, 0, lines)
        self.assertEqual(lines[-1], {"inspected": True, "account": setup_module.getpass.getuser(),
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
        self.assertEqual(self.run_setup(expect_account=setup_module.getpass.getuser())[0], 0)

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
        code, lines = self.run_setup()
        self.assertEqual(code, 1)
        self.assertEqual((lines[-1]["step"], lines[-1]["result"]), ("start", "failed"))
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
        self.assertEqual((lines[-1]["step"], lines[-1]["result"]), ("stage", "failed"))
        self.assertIn("retry later", lines[-1]["detail"])
        self.assertFalse(os.path.lexists(self.root / "current"))
        self.assertFalse(self.systemd().get("enabled"))

    def test_a_failed_repair_leaves_the_installation_as_it_found_it(self):
        self.assertEqual(self.run_setup()[0], 0)
        self.set_systemd(active=False)
        self.healthy = False
        code, lines = self.run_setup()
        self.assertEqual(code, 1)
        # The link and unit it did not create this run stay: it only failed to start.
        self.assertTrue(os.path.lexists(self.root / "current"))
        self.assertTrue((self.home / ".config" / "systemd" / "user" / "orca.service").exists())
        self.assertTrue(self.systemd()["enabled"])

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
        # A real run, refused on this test host's platform or systemd, still reads the adapter.
        result = subprocess.run([sys.executable, "-", "--version", "0.8.0", "--root", str(self.tmp / "srv")],
                                input=program, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, "HOME": str(self.home)})
        line = json.loads(result.stdout.splitlines()[-1][len("orca-setup: "):])
        self.assertIn(line["result"], ("ok", "refused", "failed"))


if __name__ == "__main__":
    unittest.main()
