"""Real compiled-daemon N/N+1 activation and failed-health recovery in /tmp.
Synthetic versions, local compiled code, and a subprocess supervisor (not systemd).
"""
import importlib.util
import json
import os
from pathlib import Path
import select as select_io
import shutil
import socket
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("orca-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
REPO = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get("ORCA_INTEGRATION_NODE"), "Set ORCA_INTEGRATION_NODE after building")
class CompiledDeployment(unittest.TestCase):
    def test_upgrade_and_failed_health_recovery(self):
        with tempfile.TemporaryDirectory(prefix="orca-upgrade-integration-") as temporary:
            root = Path(temporary)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            for name, store in (("orca.yaml", ".orca"), ("kepler.yaml", ".orca-kepler")):
                (root / name).write_text(f"version: 1\nstoreDir: {store}\nworkflows: []\ntemplates: []\n")
            (root / ".orca-kepler").mkdir()
            (root / ".orca-kepler" / "operator-sentinel").write_text("preserve")
            (root / "credentials").write_text("not-a-real-secret")
            config = {"root": str(root), "repository": "unused/isolated",
                      "cwd": str(root), "cliConfig": str(root / "orca.yaml"),
                      "daemonConfig": str(root / "orca.yaml"), "acpConfig": str(root / "kepler.yaml"),
                      "url": f"http://127.0.0.1:{port}", "service": "test-orca",
                      "launchAudit": "all-cli-acp-and-daemon-launches-migrated"}
            manifest = root / "deployment.json"
            manifest.write_text(json.dumps(config))
            deployment = release.Deployment(manifest)
            versions = []
            for version in ("0.6.0", "0.6.1", "0.6.2"):
                checkout = root / "releases" / ("v" + version)
                (checkout / "packages/cli").mkdir(parents=True)
                shutil.copytree(REPO / "packages/cli/dist", checkout / "packages/cli/dist")
                (checkout / "packages/cli/node_modules").symlink_to(REPO / "packages/cli/node_modules")
                (checkout / "package.json").write_text(json.dumps({"version": version, "type": "module"}))
                release.write_json(checkout / ".orca-release.json", {"version": version,
                    "node": os.environ["ORCA_INTEGRATION_NODE"],
                    "compatibility": json.loads((REPO / "release-compatibility.json").read_text())})
                versions.append(checkout)
            service = None
            def supervise(*args):
                nonlocal service
                if args[0] == "show":
                    return str(service.pid if service and service.poll() is None else 0)
                if args[0] == "stop":
                    if service and service.poll() is None:
                        service.terminate()
                        service.wait(timeout=15)
                if args[0] == "start":
                    service = subprocess.Popen(["python3", "-B", str(Path(__file__).with_name("orca-release.py")),
                                                "--deployment", str(manifest), "daemon"],
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return ""
            deployment.systemctl = supervise
            try:
                release.select(root, versions[0])
                supervise("start")
                deployment.health(versions[0])
                # A real idle ACP facade still owns the shared launch lock. Kepler may
                # submit work at any time until it closes this process.
                acp = subprocess.Popen(["python3", "-B", str(Path(__file__).with_name("orca-release.py")),
                                        "--deployment", str(manifest), "acp"], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                try:
                    acp.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                        "protocolVersion": 1, "clientCapabilities": {},
                        "clientInfo": {"name": "upgrade-test", "version": "1"}}}) + "\n")
                    acp.stdin.flush()
                    self.assertTrue(select_io.select([acp.stdout], [], [], 5)[0], "ACP handshake timed out")
                    answer = json.loads(acp.stdout.readline())
                    self.assertIn("result", answer)
                    with self.assertRaisesRegex(RuntimeError, "Busy"):
                        deployment.activate(versions[1])
                finally:
                    acp.stdin.close()
                    acp.wait(timeout=10)
                    acp.stdout.close()
                (root / ".orca").mkdir(exist_ok=True)
                (root / ".orca/operator-sentinel").write_text("preserve-cli")
                deployment.activate(versions[1])
                self.assertEqual((root / "current").resolve(), versions[1])
                deployment.health(versions[1])
                cli_version = subprocess.check_output(["python3", "-B", str(Path(__file__).with_name("orca-release.py")),
                                                       "--deployment", str(manifest), "cli", "--version"], text=True)
                self.assertEqual(cli_version.strip(), "0.6.1")
                original_health = deployment.health
                def failed_candidate(checkout):
                    original_health(checkout)
                    if checkout == versions[2]:
                        raise RuntimeError("injected post-start health failure")
                deployment.health = failed_candidate
                with self.assertRaisesRegex(RuntimeError, "restored and healthy"):
                    deployment.activate(versions[2])
                self.assertEqual((root / "current").resolve(), versions[1])
                original_health(versions[1])
                self.assertEqual((root / ".orca/operator-sentinel").read_text(), "preserve-cli")
                self.assertEqual((root / ".orca-kepler/operator-sentinel").read_text(), "preserve")
                self.assertEqual((root / "credentials").read_text(), "not-a-real-secret")
                self.assertFalse(deployment.pending.exists())
            finally:
                supervise("stop")


if __name__ == "__main__":
    unittest.main()
