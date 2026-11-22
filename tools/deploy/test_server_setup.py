"""One-step server setup (#881): every step idempotent, a re-run verifies and repairs, an
unmanaged installation is refused, and a failed first setup leaves no `current` link or
enabled unit. No network and no live systemd: `systemctl` and `loginctl` are stubs that keep
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

    def setup(self, version="0.8.0"):
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

        made = Under(None, version, 6722, ADAPTER, home=self.home, systemctl=str(self.bin / "systemctl"))
        made.proc = self.proc
        return made

    def run_setup(self, version="0.8.0"):
        out = io.StringIO()
        with redirect_stdout(out):
            code = self.setup(version).run()
        lines = [json.loads(line[len("orca-setup: "):]) for line in out.getvalue().splitlines() if line.startswith("orca-setup: ")]
        return code, lines

    def results(self, lines):
        return {line["step"]: line["result"] for line in lines if "step" in line}

    def test_a_clean_machine_becomes_a_managed_server(self):
        code, lines = self.run_setup()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.results(lines), {"platform": "ok", "inventory": "ok", "adapter": "changed", "files": "changed",
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

    def test_a_server_on_another_version_keeps_it(self):
        self.assertEqual(self.run_setup("0.8.0")[0], 0)
        code, lines = self.run_setup("0.8.1")
        self.assertEqual(code, 0)
        select = next(line for line in lines if line.get("step") == "select")
        self.assertEqual(select["result"], "ok")
        self.assertIn("update to v0.8.1", select["detail"])
        self.assertEqual(lines[-1]["version"], "0.8.0")

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
