"""Server bundle assembly and `stage --bundle` verification (#876). No network, no live
service: cosign is a stub that records its arguments, and the validation that runs the
release (demo, configs, temporary daemon hello) is replaced by a recorder. The real thing runs
in release-server-bundle.yml's clean-host check."""
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load("release", "orca-release.py")
bundle = load("server_bundle", "server-bundle.py")
SHA = "a" * 40


class ServerBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.tmp = Path(self.temporary.name)
        daemon = self.tmp / "daemon"
        (daemon / "scripted-agent").mkdir(parents=True)
        (daemon / "orca-daemon.mjs").write_text("// daemon\n")
        (daemon / "native-io-worker.js").write_text("// worker\n")
        (daemon / "scripted-agent" / "main.js").write_text("// agent\n")
        runtime = self.tmp / "node-runtime"
        (runtime / "bin").mkdir(parents=True)
        (runtime / "bin" / "node").write_text("#!/bin/sh\n")
        (runtime / "LICENSE").write_text("node licence\n")
        self.files = self.tmp / "out"
        self.manifest = bundle.assemble("0.8.0", SHA, runtime / "bin" / "node", daemon, self.files, 1700000000, "v24.1.0")
        (self.files / "orca-server-0.8.0-linux-x64.manifest.json.sigstore.json").write_text("{}")
        root = self.tmp / "srv"
        root.mkdir()
        config = {"root": str(root), "launchAudit": "all-cli-acp-and-daemon-launches-migrated",
                  "cwd": str(root), "cliConfig": str(root / "orca.yaml"), "acpConfig": str(root / "kepler.yaml"),
                  "daemonConfig": str(root / "orca.yaml"), "url": "http://127.0.0.1:6722", "service": "orca",
                  "repository": "owner/repo"}
        (root / "deployment.json").write_text(json.dumps(config))
        self.deployment = release.Deployment(root / "deployment.json")
        self.cosign_log = self.tmp / "cosign.log"
        self.cosign_exit = 0
        self.validated = []

        def cosign(_self):
            script = self.tmp / "cosign"
            script.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" > {self.cosign_log}\n"
                              f"echo 'error: none of the expected identities matched' >&2\nexit {self.cosign_exit}\n")
            script.chmod(0o755)
            return script

        def validate(_self, stage, target, record, env, demo_env):
            self.validated.append((stage, record, demo_env.get("ORCA_RELEASE")))
            release.write_json(stage / ".orca-release.json", record)
            os.rename(stage, target)
            return target

        for name, value in (("cosign", cosign), ("validate_stage", validate)):
            patcher = patch.object(release.Deployment, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (("system", lambda: "Linux"), ("machine", lambda: "x86_64")):
            patcher = patch.object(release.platform, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def archive(self):
        return self.files / "orca-server-0.8.0-linux-x64.tar.xz"

    def test_assembly_is_deterministic_and_complete(self):
        first = self.manifest["archive"]["sha256"]
        again = bundle.assemble("0.8.0", SHA, self.tmp / "node-runtime" / "bin" / "node", self.tmp / "daemon",
                                self.tmp / "again", 1700000000, "v24.1.0")
        self.assertEqual(again["archive"]["sha256"], first)
        with tarfile.open(self.archive()) as tar:
            members = {member.name: member for member in tar.getmembers()}
        stem = "orca-server-0.8.0-linux-x64/"
        for name in ("orca-daemon.mjs", "native-io-worker.js", "scripted-agent/main.js", "runtime/bin/node",
                     "runtime/LICENSE", "workflows/ai-sdlc.yaml", "release-compatibility.json", "package.json",
                     "orca-server.json", "LICENSE"):
            self.assertIn(stem + name, members)
        self.assertEqual(members[stem + "runtime/bin/node"].mode, 0o755)
        self.assertEqual(members[stem + "orca-daemon.mjs"].mode, 0o644)
        self.assertTrue(all(m.uid == 0 and m.mtime == 1700000000 for m in members.values()))
        self.assertTrue(any(name.startswith(stem + "templates/") for name in members))
        self.assertEqual(self.manifest["compatibility"],
                         json.loads((Path(__file__).parents[2] / "release-compatibility.json").read_text()))

    def test_stages_a_verified_bundle_with_relative_runtime(self):
        staged = self.deployment.stage_bundle(str(self.files))
        self.assertEqual(staged.name, "v0.8.0")
        args = self.cosign_log.read_text().splitlines()
        self.assertEqual(args[0], "verify-blob")
        self.assertTrue(args[1].endswith("orca-server-0.8.0-linux-x64.manifest.json"))
        pairs = dict(zip(args[2::2], args[3::2]))
        self.assertEqual(pairs["--certificate-identity"],
                         "https://github.com/cschadewitz/Project_Orca/.github/workflows/release-server-bundle.yml@refs/heads/main")
        self.assertEqual(pairs["--certificate-oidc-issuer"], "https://token.actions.githubusercontent.com")
        self.assertEqual(pairs["--certificate-github-workflow-repository"], "cschadewitz/Project_Orca")
        self.assertEqual(pairs["--certificate-github-workflow-ref"], "refs/heads/main")
        self.assertEqual(pairs["--certificate-github-workflow-trigger"], "workflow_dispatch")
        self.assertTrue(pairs["--bundle"].endswith(".manifest.json.sigstore.json"))
        (stage, record, demo_release), = self.validated
        self.assertEqual(demo_release, str(stage))
        self.assertEqual((record["node"], record["entry"], record["sha"]), ("runtime/bin/node", "orca-daemon.mjs", SHA))
        meta = release.metadata(staged)
        self.assertEqual(meta["node"], str(staged / "runtime/bin/node"))
        self.assertEqual(meta["entry"], str(staged / "orca-daemon.mjs"))
        self.assertEqual((staged / "workflows" / "ai-sdlc.yaml").read_bytes(),
                         (Path(__file__).parents[2] / "workflows" / "ai-sdlc.yaml").read_bytes())
        self.assertTrue(os.access(staged / "runtime/bin/node", os.X_OK))
        self.assertEqual([p.name for p in (self.deployment.root / "releases").iterdir()], ["v0.8.0"])

    def refused(self, message):
        with self.assertRaisesRegex(RuntimeError, message):
            self.deployment.stage_bundle(str(self.files))
        self.assertEqual(self.validated, [])
        staging = [p for p in (self.deployment.root / "releases").iterdir()]
        # Nothing unpacked: only the empty, visibly named failed stage remains.
        self.assertEqual(len(staging), 1)
        self.assertIn(".staging-", staging[0].name)
        self.assertEqual(list(staging[0].iterdir()), [])

    def test_a_signature_from_anyone_else_is_refused_before_unpacking(self):
        self.cosign_exit = 1
        self.refused("Bundle signature refused: error: none of the expected identities matched")

    def test_a_tampered_archive_is_refused_before_unpacking(self):
        data = bytearray(self.archive().read_bytes())
        data[len(data) // 2] ^= 1
        self.archive().write_bytes(bytes(data))
        self.refused("does not match its signed manifest digest")

    def test_a_manifest_for_another_version_is_refused(self):
        path = self.files / "orca-server-0.8.0-linux-x64.manifest.json"
        manifest = json.loads(path.read_text())
        manifest["version"] = "0.8.1"
        path.write_text(json.dumps(manifest))
        self.refused("manifest version")

    def test_unsafe_archive_entries_are_refused(self):
        for name, kind in (("orca-server-0.8.0-linux-x64/../escape", tarfile.REGTYPE),
                           ("orca-server-0.8.0-linux-x64/link", tarfile.SYMTYPE),
                           ("elsewhere/file", tarfile.REGTYPE)):
            target = self.tmp / "unsafe.tar.xz"
            with tarfile.open(target, "w:xz") as tar:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind == tarfile.SYMTYPE:
                    member.linkname = "/etc/passwd"
                tar.addfile(member, io.BytesIO(b""))
            with self.assertRaisesRegex(RuntimeError, "Bundle entry refused"):
                release.unpack_bundle(target, "orca-server-0.8.0-linux-x64", self.tmp / "unpacked")

    def fetch_fixture(self, body, prerelease=False, digests=None):
        names = [p.name for p in sorted(self.files.iterdir())]
        ordered = [n for suffix in (".tar.xz", ".manifest.json", ".sigstore.json") for n in names if n.endswith(suffix)]
        real = {name: release.file_sha256(self.files / name) for name in ordered}
        record = "<!-- orca-server-run: 7 " + " ".join("sha256:" + real[n] for n in ordered) + " -->"
        api = {"tag_name": "v0.8.0", "draft": False, "prerelease": prerelease,
               "body": body.replace("RECORD", record),
               "assets": [{"name": n, "browser_download_url": "https://example.invalid/" + n,
                           "digest": "sha256:" + (digests or real)[n]} for n in ordered]}
        fetched = []

        def download(url, target, limit, accept=None):
            if url.startswith("https://api.github.com/"):
                Path(target).write_text(json.dumps(api))
            else:
                fetched.append(url.rsplit("/", 1)[1])
                Path(target).write_bytes((self.files / url.rsplit("/", 1)[1]).read_bytes())
        patcher = patch.object(release, "download", download)
        patcher.start()
        self.addCleanup(patcher.stop)
        return fetched

    def test_downloads_a_published_bundle_once_its_record_is_there(self):
        fetched = self.fetch_fixture("Notes.\n\nRECORD")
        self.assertEqual(self.deployment.stage_bundle("v0.8.0").name, "v0.8.0")
        self.assertEqual(len(fetched), 3)

    def test_a_bundle_without_its_record_is_not_ready(self):
        for body in ("Notes.", "RECORD RECORD"):
            with self.subTest(body=body):
                fetched = self.fetch_fixture(body)
                with self.assertRaisesRegex(RuntimeError, "no complete server bundle yet"):
                    self.deployment.stage_bundle("v0.8.0")
                self.assertEqual(fetched, [])

    def test_assets_that_are_not_the_recorded_ones_are_not_fetched(self):
        fetched = self.fetch_fixture("RECORD", digests={n.name: "0" * 64 for n in self.files.iterdir()})
        with self.assertRaisesRegex(RuntimeError, "not the recorded one"):
            self.deployment.stage_bundle("v0.8.0")
        self.assertEqual(fetched, [])

    def test_a_prerelease_flag_must_match_the_version(self):
        self.fetch_fixture("RECORD", prerelease=True)
        with self.assertRaisesRegex(RuntimeError, "not a published release of that version"):
            self.deployment.stage_bundle("v0.8.0")

    def test_an_existing_release_is_never_overwritten(self):
        (self.deployment.root / "releases" / "v0.8.0").mkdir()
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            self.deployment.stage_bundle(str(self.files))
        self.assertFalse(self.cosign_log.exists())

    def test_versions_are_releases_or_candidates_never_dry_runs(self):
        for text in ("0.8.0-dryrun.12", "latest", "v0.8"):
            with self.assertRaisesRegex(RuntimeError, "release version"):
                self.deployment.stage_bundle(text)
        self.assertEqual(release.bundle_version("v0.8.0-rc.1"), "0.8.0-rc.1")

    def test_a_release_candidate_sorts_before_its_release(self):
        order = ["0.7.0", "0.8.0-rc.1", "0.8.0-rc.2", "0.8.0-rc.10", "0.8.0", "0.8.1", "0.10.0"]
        self.assertEqual(sorted(reversed(order), key=release.version_key), order)

    def test_source_stage_records_still_resolve(self):
        path = self.deployment.root / "releases" / "v0.7.0"
        path.mkdir()
        release.write_json(path / ".orca-release.json", {"version": "0.7.0", "node": sys.executable,
                                                          "compatibility": {}})
        meta = release.metadata(path)
        self.assertEqual(meta["node"], sys.executable)
        self.assertEqual(meta["entry"], str(path / "packages/cli/dist/main.js"))


class CosignPinTests(unittest.TestCase):
    def test_a_cached_cosign_with_another_digest_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = {"root": str(root), "launchAudit": "all-cli-acp-and-daemon-launches-migrated", "cwd": str(root),
                      "cliConfig": str(root / "a.yaml"), "acpConfig": str(root / "b.yaml"),
                      "daemonConfig": str(root / "a.yaml"), "url": "http://127.0.0.1:6722", "service": "orca"}
            (root / "deployment.json").write_text(json.dumps(config))
            deployment = release.Deployment(root / "deployment.json")
            machine = platform.machine()
            if machine not in release.COSIGN_SHA256:
                self.skipTest("no pinned cosign for this machine")
            (root / "tools").mkdir()
            (root / "tools" / f"cosign-{release.COSIGN_VERSION}-{machine}").write_text("not cosign")
            with self.assertRaisesRegex(RuntimeError, "does not match the pinned cosign digest"):
                deployment.cosign()


if __name__ == "__main__":
    unittest.main()
