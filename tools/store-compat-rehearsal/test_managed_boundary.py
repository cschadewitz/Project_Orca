"""Store-epoch boundary rows of the managed Debian adapter, rehearsed in a temporary directory.

The previous release carries the contract v0.6.0 shipped; the candidate carries this
checkout's release-compatibility.json. No service, network, credential, operator store or
real release pointer is touched: systemctl, health, the admission barrier and process
inspection are recorders, and exec is patched. The rows are the M-rows of
docs/archive/preparation/store-compatibility-rehearsal/README.md.

ORCA_REHEARSAL_ADAPTER runs the same rows against another orca-release.py - for example the
v0.6.0 blob (`git show v0.6.0:tools/deploy/orca-release.py`), which is the adapter an
installed v0.6.0 host actually runs, because the bootstrap copies it outside releases/.
ORCA_REHEARSAL_NODE (a Node 24 executable, after `pnpm install`) adds the opt-in check of
that adapter's health RPC against this checkout's real token-authenticated daemon.
"""
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
ADAPTER = Path(os.environ.get("ORCA_REHEARSAL_ADAPTER") or REPO / "tools/deploy/orca-release.py").resolve()
spec = importlib.util.spec_from_file_location("orca_release_under_rehearsal", ADAPTER)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

# As shipped: `git show v0.6.0:release-compatibility.json`.
V060 = {"storeEpoch": "ownership-fences-v1", "protocol": {"major": 1, "minor": 8},
        "capabilities": ["runs.read", "runs.control", "runs.subscribe", "plan.read", "plan.write"]}
CANDIDATE = json.loads((REPO / "release-compatibility.json").read_text())
# Deliberately implausible and named nowhere else: no real candidate is chosen here, and the
# epoch comparison runs before any version comparison.
CANDIDATE_VERSION = "999.0.0"
OPERATOR_STATE = (".orca", ".orca-kepler", "orca.yaml", "kepler.yaml", "credentials")
CLEAN_ENV = {key: value for key, value in os.environ.items() if not key.startswith("ORCA_")}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ManagedStoreBoundary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="orca-store-boundary-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.config = {"root": str(self.root), "launchAudit": "all-cli-acp-and-daemon-launches-migrated",
                       "cwd": str(self.root), "cliConfig": str(self.root / "orca.yaml"),
                       "acpConfig": str(self.root / "kepler.yaml"), "daemonConfig": str(self.root / "orca.yaml"),
                       "url": "http://127.0.0.1:6722", "service": "orca", "repository": "unused/rehearsal"}
        self.manifest = self.root / "deployment.json"
        self.manifest.write_text(json.dumps(self.config))
        for name in OPERATOR_STATE:
            (self.root / name).write_text(f"operator state: {name}")
        self.deployment = release.Deployment(self.manifest)
        self.previous = self.make_release("0.6.0", V060)
        self.candidate = self.make_release(CANDIDATE_VERSION, CANDIDATE)
        release.select(self.root, self.previous)
        self.calls = []
        self.deployment.inspect_processes = lambda: self.calls.append(("inspect",)) or 42
        self.deployment.systemctl = lambda *args: self.calls.append(("systemctl", *args))
        self.deployment.health = lambda path, *rest, **named: self.calls.append(("health", Path(path).name))
        self.deployment.barrier = lambda action, token: self.calls.append((action, token))
        self.state = {name: digest(self.root / name) for name in OPERATOR_STATE}

    def make_release(self, version, contract):
        path = self.root / "releases" / ("v" + version)
        path.mkdir(parents=True)
        release.write_json(path / ".orca-release.json",
                           {"version": version, "node": sys.executable, "compatibility": contract})
        return path

    def assert_untouched(self, selected):
        self.assertEqual(self.calls, [])
        self.assertEqual((self.root / "current").resolve(), selected)
        self.assertEqual({name: digest(self.root / name) for name in OPERATOR_STATE}, self.state)

    def adapter(self, *args):
        return subprocess.run([sys.executable, "-B", str(ADAPTER), "--deployment", str(self.manifest), *args],
                              capture_output=True, text=True, env=CLEAN_ENV, timeout=60)

    def test_rehearsal_premise_the_candidate_crosses_the_epoch_and_protocol_major(self):
        self.assertNotEqual(CANDIDATE["storeEpoch"], V060["storeEpoch"])
        self.assertNotEqual(CANDIDATE["protocol"]["major"], V060["protocol"]["major"])

    def test_m1_cross_epoch_activation_is_refused_before_any_effect(self):
        with self.assertRaisesRegex(RuntimeError, "Store compatibility changed"):
            self.deployment.activate(self.candidate)
        # Refused before the journal, process inspection, health, admission or service.
        self.assertFalse(self.deployment.pending.exists())
        self.assert_untouched(self.previous)
        # The staged candidate is left for inspection; nothing deletes it.
        self.assertTrue((self.candidate / ".orca-release.json").exists())

    def test_m3_recovery_refuses_a_cross_epoch_journal_and_keeps_launchers_closed(self):
        record = {"previous": str(self.previous), "candidate": str(self.candidate), "token": "t", "opened": False}
        release.write_json(self.deployment.pending, record)
        with self.assertRaisesRegex(RuntimeError, "Store compatibility changed"):
            self.deployment.restore(dict(record))
        self.assertTrue(self.deployment.pending.exists())
        self.assert_untouched(self.previous)
        with patch.object(os, "execve") as execute:
            for kind, args in (("cli", ["runs"]), ("acp", [])):
                with self.assertRaisesRegex(RuntimeError, "pending"):
                    self.deployment.launch(kind, args)
            execute.assert_not_called()
            # The daemon is still started, but under the durable closed-admission file.
            self.deployment.launch("daemon", [])
            self.assertEqual(execute.call_args.args[2]["ORCA_ADMISSION_FILE"], str(self.deployment.pending))
        refused = self.adapter("recover")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("Store compatibility changed", refused.stderr)
        self.assertTrue(self.deployment.pending.exists())
        self.assert_untouched(self.previous)

    def test_m4_attempted_downgrade_is_refused_by_the_epoch_before_the_version(self):
        release.select(self.root, self.candidate)
        with self.assertRaisesRegex(RuntimeError, "Store compatibility changed"):
            self.deployment.activate(self.previous)
        older = self.make_release("998.0.0", CANDIDATE)
        with self.assertRaisesRegex(RuntimeError, "move forward"):
            self.deployment.activate(older)
        self.assert_untouched(self.candidate)
        # `update` reuses an existing release directory without staging or the network.
        refused = self.adapter("update", "v0.6.0")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("Store compatibility changed", refused.stderr)
        self.assertFalse(self.deployment.pending.exists())
        self.assert_untouched(self.candidate)

    def test_m5_launchers_trust_the_selected_pointer_without_a_compatibility_check(self):
        # A hand-edited or bootstrap-created pointer is the only launch-time guard: nothing
        # between it and exec compares store epochs. Recorded so the matrix stays true.
        release.select(self.root, self.candidate)
        with patch.object(os, "execve") as execute:
            self.deployment.launch("cli", ["runs"])
        self.assertIn(str(self.candidate / "packages/cli/dist/main.js"), execute.call_args.args[1])

    def test_m7_a_release_without_its_pinned_toolchain_cannot_be_used(self):
        meta = json.loads((self.previous / ".orca-release.json").read_text())
        release.write_json(self.previous / ".orca-release.json", {**meta, "node": str(self.root / "missing-node")})
        with self.assertRaisesRegex(RuntimeError, "Pinned Node executable is missing"):
            release.metadata(self.previous)
        with patch.object(os, "execve") as execute:
            with self.assertRaisesRegex(RuntimeError, "Pinned Node executable is missing"):
                self.deployment.launch("cli", ["runs"])
            execute.assert_not_called()


@unittest.skipUnless(os.environ.get("ORCA_REHEARSAL_NODE"), "Set ORCA_REHEARSAL_NODE to a Node 24 after pnpm install")
class AdapterAgainstCandidateDaemon(unittest.TestCase):
    """M2: whether this adapter can health-check the candidate's default token-mode daemon."""

    def test_m2_health_rpc_against_the_token_authenticated_daemon(self):
        with tempfile.TemporaryDirectory(prefix="orca-adapter-auth-") as temporary:
            workspace = Path(temporary).resolve()
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            daemon = subprocess.Popen([os.environ["ORCA_REHEARSAL_NODE"], "--import", "tsx", "packages/cli/src/main.ts",
                                       "--cwd", str(workspace), "serve", "--port", str(port)],
                                      cwd=REPO, env=CLEAN_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                token = workspace / "auth" / "local-client.token"
                deadline = time.monotonic() + 60
                while not token.exists() and time.monotonic() < deadline:
                    self.assertIsNone(daemon.poll(), "daemon exited before writing its token")
                    time.sleep(0.25)
                url = f"http://127.0.0.1:{port}"
                hello = {"client": "orca-release", "protocol": CANDIDATE["protocol"]}
                if "token_file" in inspect.signature(release.rpc).parameters:
                    result = None
                    while result is None and time.monotonic() < deadline:
                        try:
                            result = release.rpc(url, "hello", hello, token_file=str(token), use_environment=False)
                        except (OSError, RuntimeError):
                            time.sleep(0.25)
                    self.assertEqual(result["protocol"], CANDIDATE["protocol"])
                    self.assertIn("maintenance", result["methods"])
                else:
                    # An adapter that predates daemon credentials sends none and is refused.
                    with self.assertRaises(urllib.error.HTTPError) as refused:
                        release.rpc(url, "hello", hello)
                    self.assertEqual(refused.exception.code, 401)
            finally:
                daemon.terminate()
                daemon.wait(timeout=20)


if __name__ == "__main__":
    unittest.main()
