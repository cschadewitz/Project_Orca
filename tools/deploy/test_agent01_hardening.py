"""Pure/mocked checks for the disposable probe. Never call a real manager or read host procfs."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "hardening_probe", ROOT / "docs/preparation/private-mcp-access/agent01-owner-staging/probe-hardening.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
ABSENT = "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\n"


def snapshots():
    parent = {"nnp": 0, "umask": "0022", "uids": [1000] * 4, "ns": {"mnt": [4, 10], "user": [4, 20]},
              "dirs": {"/tmp": [1, 100, 0, 0o1777], "/var/tmp": [1, 200, 0, 0o1777],
                       probe.TEMP: [2, 300, 1000, 0o700]}, "tmpdir_matches": False}
    child = copy.deepcopy(parent)
    child.update(nnp=1, umask="0077", tmpdir_matches=True)
    child["ns"]["mnt"] = [4, 11]
    child["dirs"]["/tmp"][1] = 101
    child["dirs"]["/var/tmp"][1] = 201
    return parent, child


class ProbeTests(unittest.TestCase):
    def test_command_is_one_bounded_transient_python_with_clean_environment(self):
        command = probe.invocation()
        for option in ["--user", "--unit=orca-preflight-hardening-20261004.service", "--wait", "--pipe", "--collect",
                       "--property=Type=exec", "--property=PrivateTmp=yes", "--property=NoNewPrivileges=yes",
                       "--property=UMask=0077", "--property=Restart=no", "--property=RuntimeMaxSec=15s",
                       "--property=TimeoutStartSec=10s", "--property=TimeoutStopSec=5s", "--property=KillMode=control-group"]:
            self.assertIn(option, command)
        self.assertEqual(command[-6:], ["/usr/bin/python3", "-I", "-S", "-B", probe.SCRIPT, "--inside"])
        self.assertEqual(command.count("/usr/bin/python3"), 1)
        self.assertIn("TMPDIR=/srv/dev/orca-temp-cal", command)
        self.assertNotIn("--scope", command)
        self.assertNotIn("--ignore-failure", command)
        self.assertNotIn("--setenv", command)

    def test_report_requires_each_hardening_observation(self):
        parent, child = snapshots()
        self.assertTrue(probe.compare(parent, child)["passed"])
        for mutate in [lambda x: x.update(nnp=0), lambda x: x.update(umask="0022"),
                       lambda x: x.update(uids=[0] * 4), lambda x: x.update(tmpdir_matches=False),
                       lambda x: x["ns"].update(mnt=parent["ns"]["mnt"]),
                       lambda x: x["dirs"].update({"/tmp": parent["dirs"]["/tmp"]}),
                       lambda x: x["dirs"].update({"/var/tmp": parent["dirs"]["/var/tmp"]}),
                       lambda x: x["dirs"].update({probe.TEMP: [2, 301, 1000, 0o700]}),
                       lambda x: x["dirs"].update({probe.TEMP: [2, 300, 1000, 0o755]})]:
            changed = copy.deepcopy(child)
            mutate(changed)
            self.assertFalse(probe.compare(parent, changed)["passed"])

    def test_user_namespace_change_is_observation_not_worker_acceptance(self):
        parent, child = snapshots()
        self.assertFalse(probe.compare(parent, child)["user_namespace_changed"])
        child["ns"]["user"] = [4, 21]
        result = probe.compare(parent, child)
        self.assertTrue(result["passed"])
        self.assertTrue(result["user_namespace_changed"])

    def test_existing_unit_or_dropin_refuses_before_any_start(self):
        for output in [ABSENT.replace("not-found", "loaded"), ABSENT.replace("DropInPaths=", "DropInPaths=/unexpected")]:
            with patch.object(probe, "command", return_value=(0, output)) as command:
                with self.assertRaises(ValueError):
                    probe.precheck()
                self.assertEqual(command.call_count, 1)
        with patch.object(probe, "command", side_effect=[(4, ABSENT), (0, "/synthetic/user\n")]), \
                patch.object(probe.os, "lstat", return_value=object()):
            with self.assertRaisesRegex(ValueError, "unit-or-dropin-present"):
                probe.precheck()

    def test_precheck_scans_manager_paths_for_generic_prefix_and_dependency_overrides(self):
        with patch.object(probe, "command", side_effect=[(4, ABSENT), (0, "/synthetic/user\n")]) as command, \
                patch.object(probe.os, "lstat", side_effect=FileNotFoundError) as lookup:
            probe.precheck()
            paths = {call.args[0] for call in lookup.call_args_list}
            for suffix in ["service.d", "orca-.service.d", probe.UNIT + ".requires", probe.UNIT + ".wants"]:
                self.assertIn("/synthetic/user/" + suffix, paths)
            self.assertEqual(command.call_count, 2)
            self.assertTrue(all(call.args[0][0] == "/usr/bin/systemctl" for call in command.call_args_list))


if __name__ == "__main__":
    unittest.main()
