"""orca-release.py auto-update (#878): the server channel, the opt-in configuration, deferral,
rollback policy, pruning and the timer, with no live service, feed, credential or store. The
last test serves a real feed Worker (feed-local.js) over local HTTPS with a server-only token."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("orca-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
REPO = Path(__file__).resolve().parents[2]
SHA = "a" * 40
TOKEN = "t" * 43


def channel_text(version, files, sha=SHA):
    """A channel file as feed-server.js writes it, for `files` {name: bytes}."""
    names = dict(zip(("archive", "manifest", "signature"), release.bundle_names(version)[1:]))
    lines = [f"version: {version}", "platform: linux-x64", f"sourceSha: {sha}"]
    for kind, name in names.items():
        body = files[name]
        lines += [f"{kind}: {name}", f"{kind}Sha256: {hashlib.sha256(body).hexdigest()}", f"{kind}Size: {len(body)}"]
    return "".join(line + "\n" for line in lines)


def bundle_files(version):
    return {name: f"{name} bytes".encode() for name in release.bundle_names(version)[1:]}


class ChannelAndConfigTests(unittest.TestCase):
    def test_reads_exactly_what_feed_server_js_writes(self):
        files = bundle_files("0.8.1")
        text = channel_text("0.8.1", files)
        value = release.parse_server_channel(text)
        self.assertEqual(value["version"], "0.8.1")
        self.assertEqual(value["archiveSize"], len(files["orca-server-0.8.1-linux-x64.tar.xz"]))
        # The JavaScript reader agrees on the same bytes.
        script = ("import { parseServerChannel } from './tools/deploy/feed-server.js';"
                  "process.stdout.write(JSON.stringify(parseServerChannel(process.argv[1])));")
        node = subprocess.run(["node", "--input-type=module", "-e", script, text], cwd=REPO,
                              capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(node.stdout), value)

    def test_refuses_anything_else(self):
        good = channel_text("0.8.1", bundle_files("0.8.1"))
        for bad in (good[:-1], good + "extra: 1\n", good.replace("platform: linux-x64", "platform: linux-arm64"),
                    good.replace("version: 0.8.1", "version: 0.8.1-beta.1"),
                    good.replace(f"sourceSha: {SHA}", "sourceSha: main"),
                    good.replace("archive: orca-server-0.8.1", "archive: orca-server-0.8.2"),
                    good.replace("archiveSize: ", "archiveSize: 0"),
                    "\n".join(reversed(good.splitlines())) + "\n"):
            with self.subTest(bad=bad[:40]), self.assertRaises(RuntimeError):
                release.parse_server_channel(bad)
        huge = good.replace(f"archiveSize: {len(b'orca-server-0.8.1-linux-x64.tar.xz bytes')}",
                            f"archiveSize: {release.BUNDLE_MAX_BYTES + 1}")
        with self.assertRaisesRegex(RuntimeError, "size limit"):
            release.parse_server_channel(huge)

    def test_configuration_is_opt_in_and_checked(self):
        with self.assertRaisesRegex(RuntimeError, "Automatic updates are off"):
            release.auto_update_config({})
        base = {"feed": "https://feed.example", "tokenFile": "/etc/orca/feed-token"}
        config = release.auto_update_config({"autoUpdate": base})
        self.assertEqual((config["interval"], config["maxDeferralHours"], config["quietHours"]), ("1h", 72, None))
        for bad in ({"feed": "http://feed.example"}, {"feed": "https://u@feed.example"}, {"tokenFile": "token"},
                    {"interval": "1s"}, {"maxDeferralHours": 0}, {"maxDeferralHours": True},
                    {"quietHours": "25:00-03:00"}, {"quietHours": "02:00-02:00"}, {"settleSeconds": -1},
                    {"ring": "preview"}):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                release.auto_update_config({"autoUpdate": {**base, **bad}})

    def test_quiet_hours_wrap_past_midnight(self):
        at = lambda h, m: time.struct_time((2026, 11, 22, h, m, 0, 6, 326, -1))
        self.assertTrue(release.in_quiet_hours("22:00-06:00", at(23, 30)))
        self.assertTrue(release.in_quiet_hours("22:00-06:00", at(5, 59)))
        self.assertFalse(release.in_quiet_hours("22:00-06:00", at(6, 0)))
        self.assertTrue(release.in_quiet_hours("09:00-17:00", at(9, 0)))
        self.assertFalse(release.in_quiet_hours("09:00-17:00", at(17, 0)))
        self.assertFalse(release.in_quiet_hours(None, at(12, 0)))

    def test_token_file_must_be_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "feed-token"
            path.write_text(TOKEN + "\n")
            path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "mode 600"):
                release.read_feed_token(path)
            path.chmod(0o600)
            self.assertEqual(release.read_feed_token(path), TOKEN)
            path.write_text("not a token")
            with self.assertRaisesRegex(RuntimeError, "does not hold a feed token"):
                release.read_feed_token(path)
            with self.assertRaisesRegex(RuntimeError, "missing"):
                release.read_feed_token(Path(temporary) / "absent")


class AutoUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.token = self.root / "feed-token"
        self.token.write_text(TOKEN)
        self.token.chmod(0o600)
        self.config = {"root": str(self.root), "launchAudit": "all-cli-acp-and-daemon-launches-migrated",
                       "cwd": str(self.root), "cliConfig": str(self.root / "orca.yaml"),
                       "acpConfig": str(self.root / "kepler.yaml"), "daemonConfig": str(self.root / "orca.yaml"),
                       "url": "http://127.0.0.1:6722", "service": "orca", "repository": "owner/repo",
                       "autoUpdate": {"feed": "https://feed.test", "tokenFile": str(self.token),
                                      "maxDeferralHours": 2, "settleSeconds": 0}}
        self.manifest = self.root / "deployment.json"
        self.manifest.write_text(json.dumps(self.config))
        self.deployment = release.Deployment(self.manifest)
        self.older = self.make_release("0.7.9")
        self.old = self.make_release("0.8.0")
        release.select(self.root, self.old)
        self.calls = []
        self.deployment.inspect_processes = lambda: 42
        self.deployment.systemctl = lambda *args: self.calls.append(args)
        self.deployment.health = lambda path: self.calls.append(("health", path.name))
        self.deployment.barrier = lambda action, token: self.calls.append((action,))
        self.files = bundle_files("0.8.1")
        self.offer = channel_text("0.8.1", self.files)
        self.requests = []
        patcher = patch.object(release, "feed_get", self.feed_get)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.deployment.stage_bundle = self.stage_bundle
        self.now = 1_800_000_000

    def make_release(self, version, epoch="v1", sha=SHA, bundle=False):
        path = self.root / "releases" / ("v" + version)
        path.mkdir(parents=True)
        record = {"version": version, "node": sys.executable, "sha": sha,
                  "compatibility": {"storeEpoch": epoch, "protocol": {"major": 1, "minor": 8},
                                    "capabilities": ["runs.control"]}}
        if bundle:
            (path / "runtime" / "bin").mkdir(parents=True)
            (path / release.BUNDLE_NODE).write_text("node")
            (path / release.BUNDLE_ENTRY).write_text("entry")
            record.update(source="bundle", node=release.BUNDLE_NODE, entry=release.BUNDLE_ENTRY)
        release.write_json(path / ".orca-release.json", record)
        return path

    def feed_get(self, url, token, limit, target=None):
        self.assertEqual(token, TOKEN)
        self.requests.append(url)
        name = url.removeprefix("https://feed.test/server/")
        if name == "latest-linux-x64.yml":
            return None if self.offer is None else self.offer.encode()
        body = self.files[name]
        Path(target).write_bytes(body)
        return True

    def stage_bundle(self, source):
        # The real one verifies the signature; here: the downloads match the channel file.
        for name, body in self.files.items():
            self.assertEqual((Path(source) / name).read_bytes(), body)
        self.staged = getattr(self, "staged", 0) + 1
        return self.make_release("0.8.1", getattr(self, "epoch", "v1"), bundle=True).resolve()

    def run_check(self, now=None):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return self.deployment.auto_update(clock=lambda: self.now if now is None else now)

    def status(self):
        return json.loads((self.root / "auto-update.json").read_text())

    def current(self):
        return (self.root / "current").resolve().name

    def test_updates_to_the_offered_version_and_keeps_two_releases(self):
        self.assertEqual(self.run_check(), (True, "updated"))
        self.assertEqual(self.current(), "v0.8.1")
        self.assertEqual(sorted(p.name for p in (self.root / "releases").iterdir()), ["v0.8.0", "v0.8.1"])
        self.assertEqual(self.requests[0], "https://feed.test/server/latest-linux-x64.yml")
        # Closed admission, then the hello and the settled re-check, then admission reopens.
        names = [c[0] for c in self.calls]
        self.assertLess(names.index("prepare"), names.index("stop"))
        self.assertEqual([c for c in self.calls if c[0] == "health"][-2:], [("health", "v0.8.1")] * 2)
        self.assertEqual(names[-1], "resume")
        self.assertEqual(self.status()["outcome"], "updated")
        self.assertEqual(self.run_check(), (True, "current"))

    def test_nothing_offered_or_nothing_newer_changes_nothing(self):
        self.offer = None
        self.assertEqual(self.run_check(), (True, "none"))
        self.offer = channel_text("0.8.0", bundle_files("0.8.0"))
        self.assertEqual(self.run_check(), (True, "current"))
        self.offer = channel_text("0.7.9", bundle_files("0.7.9"))
        self.assertEqual(self.run_check(), (True, "current"))
        self.assertEqual(self.current(), "v0.8.0")
        self.assertEqual(self.calls, [])

    def test_busy_work_defers_without_cancelling_then_activates_once_idle(self):
        busy = True
        def barrier(action, token):
            self.calls.append((action,))
            if action == "prepare" and busy:
                raise RuntimeError("Daemon busy: runs.start")
        self.deployment.barrier = barrier
        self.assertEqual(self.run_check(), (True, "deferred"))
        self.assertEqual(self.current(), "v0.8.0")
        self.assertFalse(any(c[0] == "stop" for c in self.calls))
        self.assertEqual(self.status()["deferredSince"], {"0.8.1": self.now})
        # Staged once; later checks reuse it.
        self.assertEqual(self.run_check(self.now + 3600), (True, "deferred"))
        self.assertEqual(self.staged, 1)
        self.assertEqual(self.status()["deferredSince"], {"0.8.1": self.now})
        # Past the limit it is reported (nonzero), still without cancelling anything.
        self.assertEqual(self.run_check(self.now + 3 * 3600), (False, "overdue"))
        self.assertFalse(any(c[0] == "stop" for c in self.calls))
        busy = False
        self.assertEqual(self.run_check(self.now + 4 * 3600), (True, "updated"))
        self.assertEqual(self.current(), "v0.8.1")

    def test_open_cli_work_and_quiet_hours_defer(self):
        def held(*_):
            raise RuntimeError("Unmanaged ORCA process blocks activation: pid 7")
        self.deployment.inspect_processes = held
        self.assertEqual(self.run_check(), (True, "deferred"))
        self.deployment.inspect_processes = lambda: 42
        now = time.localtime(self.now)
        start = f"{now.tm_hour:02d}:{now.tm_min:02d}"
        end = f"{(now.tm_hour + 1) % 24:02d}:{now.tm_min:02d}"
        self.config["autoUpdate"]["quietHours"] = f"{start}-{end}"
        self.deployment.config = self.config
        self.assertEqual(self.run_check(), (True, "deferred"))
        self.assertIn("quiet hours", self.status()["detail"])
        self.assertFalse(any(c[0] in ("prepare", "stop") for c in self.calls))

    def test_a_broken_build_is_rolled_back_before_admission_reopens(self):
        settled = 0
        def health(path):
            nonlocal settled
            if path.name == "v0.8.1":
                settled += 1
                if settled == 2:
                    raise RuntimeError("daemon exited after its first hello")
            self.calls.append(("health", path.name))
        self.deployment.health = health
        self.assertEqual(self.run_check(), (False, "rolled-back"))
        self.assertEqual(self.current(), "v0.8.0")
        self.assertFalse(self.deployment.pending.exists())
        self.assertEqual([c[0] for c in self.calls][-1], "resume")
        self.assertIn("0.8.0 serves again", self.status()["detail"])
        # The failed release is not pruned; the older ones are kept.
        self.assertTrue((self.root / "releases" / "v0.7.9").exists())

    def test_a_failure_after_admission_reopened_is_not_rolled_back(self):
        def barrier(action, token):
            self.calls.append((action,))
            if action == "resume":
                raise RuntimeError("connection reset")
        self.deployment.barrier = barrier
        self.assertEqual(self.run_check(), (False, "failed-not-rolled-back"))
        self.assertEqual(self.current(), "v0.8.1")
        self.assertTrue(self.deployment.pending.exists())
        self.assertEqual([c[0] for c in self.calls][-2:], ["resume", "prepare"])
        self.assertIn("admission closed again", self.status()["detail"])
        # The journal blocks the next check, launches and updates until recovery.
        self.assertEqual(self.run_check(), (False, "blocked"))
        with self.assertRaisesRegex(RuntimeError, "pending"):
            self.deployment.launch("cli", ["run"])

    def test_a_store_format_change_is_never_activated_unattended(self):
        self.epoch = "v2"
        self.assertEqual(self.run_check(), (False, "refused"))
        self.assertEqual(self.current(), "v0.8.0")
        self.assertFalse(any(c[0] in ("prepare", "stop") for c in self.calls))

    def test_downloads_that_do_not_match_the_channel_file_are_never_staged(self):
        self.files = {**self.files, "orca-server-0.8.1-linux-x64.tar.xz": b"tampered"}
        self.assertEqual(self.run_check(), (False, "failed"))
        self.assertIn("does not match its channel file", self.status()["detail"])
        self.assertFalse(hasattr(self, "staged"))
        self.assertEqual(sorted(p.name for p in (self.root / "releases").iterdir()), ["v0.7.9", "v0.8.0"])

    def test_an_existing_release_of_another_commit_is_not_reused(self):
        self.make_release("0.8.1", sha="b" * 40, bundle=True)
        self.assertEqual(self.run_check(), (False, "failed"))
        self.assertIn("not the bundle the feed offers", self.status()["detail"])
        self.assertEqual(self.current(), "v0.8.0")

    def test_a_manual_update_holding_the_lock_defers_the_timer(self):
        args = ["orca-release.py", "--deployment", str(self.manifest), "auto-update"]
        with release.lock(self.root / "update.lock"), patch.object(sys, "argv", args), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            release.main()
        self.assertIn("auto-update deferred: Busy: update.lock", out.getvalue())
        self.assertFalse((self.root / "auto-update.json").exists())

    def test_install_timer_writes_and_starts_the_user_units(self):
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.root / "config")}):
            timer = self.deployment.install_timer()
        service = timer.with_suffix(".service").read_text()
        self.assertIn(f"--deployment {self.manifest} auto-update", service)
        self.assertIn("Type=oneshot", service)
        self.assertIn("OnUnitActiveSec=1h", timer.read_text())
        self.assertEqual(self.calls, [("daemon-reload",), ("enable", "--now", "orca-auto-update.timer")])


@unittest.skipUnless(shutil.which("node") and shutil.which("openssl"), "needs node and openssl")
class LiveFeedTests(unittest.TestCase):
    """The real Worker (feed-local.js) serves the server channel to a server-only token."""
    def test_reads_and_downloads_the_offer_from_the_worker(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            bucket = base / "bucket"
            files = bundle_files("0.8.1")
            snapshot = bucket / "server" / "0.8.1"
            snapshot.mkdir(parents=True)
            for name, body in files.items():
                (snapshot / name).write_bytes(body)
            (snapshot / "latest-linux-x64.yml").write_text(channel_text("0.8.1", files))
            (snapshot / "complete.json").write_text(json.dumps({"format": 1, "version": "0.8.1", "platform": "linux-x64"}))
            (bucket / "rings.json").write_text(json.dumps({"format": 1, "rings": {}, "server": {"preview": {"version": "0.8.1"}}}))
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
                            "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", str(base / "key.pem"),
                            "-out", str(base / "cert.pem")], check=True, capture_output=True)
            tokens = {hashlib.sha256(TOKEN.encode()).hexdigest(): {"ring": "preview", "channel": "server"}}
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            server = subprocess.Popen(["node", "tools/deploy/feed-local.js", "serve", str(bucket), str(port),
                                       str(base / "cert.pem"), str(base / "key.pem"), json.dumps(tokens)],
                                      cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.addCleanup(server.wait)
            self.addCleanup(server.terminate)
            server.stdout.readline()  # serving
            feed = f"https://127.0.0.1:{port}"
            with patch.dict(os.environ, {"SSL_CERT_FILE": str(base / "cert.pem")}):
                for _ in range(50):
                    try:
                        text = release.feed_get(f"{feed}/server/latest-linux-x64.yml", TOKEN, release.SERVER_CHANNEL_MAX)
                        break
                    except RuntimeError:
                        time.sleep(0.1)
                channel = release.parse_server_channel(text.decode("ascii"))
                self.assertEqual(channel["version"], "0.8.1")
                target = base / "archive"
                release.feed_get(f"{feed}/server/{channel['archive']}", TOKEN, channel["archiveSize"], target)
                self.assertEqual(release.file_sha256(target), channel["archiveSha256"])
                # A server-only token never reads the desktop channel; a wrong token is refused.
                self.assertIsNone(release.feed_get(f"{feed}/latest-x64.yml", TOKEN, 4096))
                with self.assertRaisesRegex(RuntimeError, "refused this server's token"):
                    release.feed_get(f"{feed}/server/latest-linux-x64.yml", "u" * 43, 4096)


if __name__ == "__main__":
    unittest.main()
