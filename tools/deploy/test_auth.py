"""Supervisor authentication against an isolated HTTP fixture, with no live credentials."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("orca-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class SupervisorAuthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="orca-supervisor-auth-")
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / "local-client.token"
        self.file.write_text("old-token\n")
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def response(self, value):
        return io.BytesIO(json.dumps(value).encode())

    def test_bearer_header_and_one_reload_after_auth_invalid(self):
        seen = []
        def open_request(request, timeout):
            seen.append(request)
            if len(seen) == 1:
                self.file.write_text("new-token\n")
                raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {},
                    self.response({"ok": False, "error": {"code": "AUTH_INVALID"}}))
            return self.response({"ok": True, "result": {"ready": True, "active": []}})
        with patch.object(release.urllib.request, "build_opener") as factory:
            factory.return_value.open.side_effect = open_request
            result = release.rpc("http://127.0.0.1:6722", "maintenance",
                                 {"action": "prepare", "token": "admission-only"}, token_file=self.file)
        self.assertTrue(result["ready"])
        self.assertEqual([request.get_header("Authorization") for request in seen],
                         ["Bearer old-token", "Bearer new-token"])
        self.assertEqual(seen[0].data, seen[1].data)
        self.assertNotIn("old-token", seen[0].full_url)

    def test_environment_precedence_and_no_reload_of_explicit_token(self):
        with patch.dict(os.environ, {"ORCA_DAEMON_TOKEN": "explicit-token"}):
            with patch.object(release.urllib.request, "build_opener") as factory:
                factory.return_value.open.return_value = self.response({"ok": False, "error": {"code": "AUTH_INVALID"}})
                with self.assertRaisesRegex(RuntimeError, "AUTH_INVALID"):
                    release.rpc("http://127.0.0.1:6722", "maintenance", {}, token_file=self.file)
                factory.return_value.open.assert_called_once()
                self.assertEqual(factory.return_value.open.call_args.args[0].get_header("Authorization"), "Bearer explicit-token")

    def test_refusal_has_at_most_two_calls_and_does_not_echo_response_secrets(self):
        with patch.object(release.urllib.request, "build_opener") as factory:
            factory.return_value.open.side_effect = lambda *args, **kwargs: self.response({
                "ok": False, "error": {"code": "AUTH_INVALID", "message": "fixture-secret"}})
            with self.assertRaisesRegex(RuntimeError, "^Daemon refused hello: AUTH_INVALID$"):
                release.rpc("http://127.0.0.1:6722", "hello", {}, token_file=self.file)
            self.assertEqual(factory.return_value.open.call_count, 2)

    def test_staging_uses_only_its_fixture_token_not_operator_environment(self):
        with patch.dict(os.environ, {"ORCA_DAEMON_TOKEN": "operator-token", "ORCA_DAEMON_TOKEN_FILE": "/unused/operator"}):
            with patch.object(release.urllib.request, "build_opener") as factory:
                factory.return_value.open.return_value = self.response({"ok": True, "result": {}})
                release.rpc("http://127.0.0.1:6722", "hello", {}, token_file=self.file, use_environment=False)
                self.assertEqual(factory.return_value.open.call_args.args[0].get_header("Authorization"), "Bearer old-token")

    def test_missing_local_token_preserves_explicit_legacy_daemon_compatibility(self):
        self.file.unlink()
        with patch.object(release.urllib.request, "build_opener") as factory:
            factory.return_value.open.return_value = self.response({"ok": True, "result": {}})
            release.rpc("http://127.0.0.1:6722", "hello", {}, token_file=self.file)
            self.assertIsNone(factory.return_value.open.call_args.args[0].get_header("Authorization"))

    def test_health_and_maintenance_use_the_same_daemon_config_token_file(self):
        root = Path(self.directory.name)
        config = {"root": str(root), "launchAudit": "all-cli-acp-and-daemon-launches-migrated",
                  "cwd": str(root), "cliConfig": str(root / "cli.yaml"),
                  "acpConfig": str(root / "acp.yaml"), "daemonConfig": str(root / "daemon" / "orca.yaml"),
                  "url": "http://127.0.0.1:6722", "service": "fixture"}
        manifest = root / "deployment.json"
        manifest.write_text(json.dumps(config))
        deployment = release.Deployment(manifest)
        deployment.systemctl = lambda *args: "42"
        meta = {"version": "fixture", "compatibility": {"protocol": {"major": 1, "minor": 9}, "capabilities": []}}
        with patch.object(release, "metadata", return_value=meta), patch.object(release, "rpc") as rpc:
            rpc.side_effect = [{"orcaVersion": "fixture", "processId": 42,
                                "protocol": {"major": 1, "minor": 9}, "methods": ["maintenance"]},
                               {"ready": True, "active": []}]
            deployment.health(root)
            deployment.barrier("prepare", "admission-token")
            expected = str(root / "daemon" / "auth" / "local-client.token")
            self.assertEqual([call.kwargs["token_file"] for call in rpc.call_args_list], [expected, expected])
            self.assertEqual(rpc.call_args_list[1].args[2], {"action": "prepare", "token": "admission-token"})

    def test_remote_plaintext_credentials_are_refused_before_network(self):
        with patch.object(release.urllib.request, "build_opener") as factory:
            with self.assertRaisesRegex(RuntimeError, "require HTTPS"):
                release.rpc("http://orca.example", "hello", {}, token_file=self.file)
            factory.return_value.open.assert_not_called()

    def test_redirects_are_refused(self):
        with self.assertRaisesRegex(RuntimeError, "redirects are refused"):
            release.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.example")


if __name__ == "__main__":
    unittest.main()
