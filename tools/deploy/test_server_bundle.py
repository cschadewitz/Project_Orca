"""Server bundle assembly and `stage --bundle` verification (#876). No network, no live
service: cosign is a stub that records its arguments, and the validation that runs the
release (demo, configs, temporary daemon hello) is replaced by a recorder. The real thing runs
in release-server-bundle.yml's clean-host check."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import tarfile
import tempfile
import types
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
        (daemon / "claude-pre-tool-hook.mjs").write_text("// hook\n")
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
        for name in ("orca-daemon.mjs", "native-io-worker.js", "claude-pre-tool-hook.mjs", "scripted-agent/main.js", "runtime/bin/node",
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
        # The durable receipt: the exact signed files this release was verified from (#878).
        receipt = {}
        for kind, name in zip(("archive", "manifest", "signature"), release.bundle_names("0.8.0")[1:]):
            body = (self.files / name).read_bytes()
            receipt[kind + "Sha256"] = hashlib.sha256(body).hexdigest()
            receipt[kind + "Size"] = len(body)
        self.assertEqual(record["bundle"], receipt)
        self.assertEqual(record["bundle"]["archiveSha256"], self.manifest["archive"]["sha256"])
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

    def test_fetch_only_verifies_without_a_deployment(self):
        # The update feed's publication (#877): the same fetch and verification, no staging.
        self.fetch_fixture("RECORD")
        out = self.tmp / "fetched"
        with patch.object(release.BundleSource, "cosign", release.Deployment.cosign), \
                patch("sys.stdout", new_callable=io.StringIO) as printed:
            release.fetch_only(["--cache", str(self.tmp / "cache"), "0.8.0", str(out)])
        self.assertEqual(json.loads(printed.getvalue())["archive"], self.manifest["archive"])
        self.assertEqual(sorted(p.name for p in out.iterdir()), sorted(p.name for p in self.files.iterdir()))
        self.assertIn(release.BUNDLE_SIGNER, self.cosign_log.read_text().splitlines())
        with self.assertRaises(FileExistsError):
            release.fetch_only(["--cache", str(self.tmp / "cache"), "0.8.0", str(out)])
        self.cosign_exit = 1
        with patch.object(release.BundleSource, "cosign", release.Deployment.cosign), \
                self.assertRaisesRegex(RuntimeError, "signature refused"):
            release.fetch_only(["--cache", str(self.tmp / "cache"), "0.8.0", str(self.tmp / "again")])

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

    def test_a_manifest_naming_another_runtime_or_entry_is_refused_before_unpacking(self):
        path = self.files / "orca-server-0.8.0-linux-x64.manifest.json"
        manifest = json.loads(path.read_text())
        manifest["entry"] = "../../usr/bin/evil.mjs"
        path.write_text(json.dumps(manifest))
        self.refused("unexpected runtime or entry")

    def test_bundle_records_run_only_the_fixed_runtime_and_entry(self):
        path = self.deployment.root / "releases" / "v0.8.0"
        (path / "runtime" / "bin").mkdir(parents=True)
        (path / "runtime" / "bin" / "node").write_text("")
        (path / "orca-daemon.mjs").write_text("")
        for node, entry in (("runtime/bin/node", "packages/cli/dist/main.js"), (sys.executable, "orca-daemon.mjs"),
                            ("runtime/bin/node", "../orca-daemon.mjs")):
            release.write_json(path / ".orca-release.json", {"version": "0.8.0", "source": "bundle", "node": node,
                                                              "entry": entry, "compatibility": {}})
            with self.assertRaisesRegex(RuntimeError, "unexpected runtime or entry"):
                release.metadata(path)
        (path / "orca-daemon.mjs").unlink()
        (path / "orca-daemon.mjs").symlink_to("/etc/passwd")
        release.write_json(path / ".orca-release.json", {"version": "0.8.0", "source": "bundle", "node": "runtime/bin/node",
                                                          "entry": "orca-daemon.mjs", "compatibility": {}})
        with self.assertRaisesRegex(RuntimeError, "is a link"):
            release.metadata(path)

    def test_source_records_keep_the_source_layout_only(self):
        path = self.deployment.root / "releases" / "v0.7.1"
        path.mkdir()
        for record in ({"node": "runtime/bin/node"}, {"node": sys.executable, "entry": "orca-daemon.mjs"}):
            release.write_json(path / ".orca-release.json", {"version": "0.7.1", "compatibility": {}, **record})
            with self.assertRaisesRegex(RuntimeError, "unexpected runtime or entry"):
                release.metadata(path)

    def test_source_stage_records_still_resolve(self):
        path = self.deployment.root / "releases" / "v0.7.0"
        path.mkdir()
        release.write_json(path / ".orca-release.json", {"version": "0.7.0", "node": sys.executable,
                                                          "compatibility": {}})
        meta = release.metadata(path)
        self.assertEqual(meta["node"], sys.executable)
        self.assertEqual(meta["entry"], str(path / "packages/cli/dist/main.js"))

    # The Orrery rename bridge (v0.8.1): a release after the rename is signed by the renamed
    # repository and named after the new product. Either is accepted, each exactly.
    # rename-keep-start: these tests pin both names on purpose

    def accepting(self, repository):
        """A cosign stub that accepts only REPOSITORY's identity and logs every call."""
        log = self.tmp / "cosign-calls.log"

        def cosign(_self):
            script = self.tmp / "cosign-bridge"
            script.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {log}\n"
                              f"case \"$*\" in *'--certificate-github-workflow-repository {repository} '*) exit 0;; esac\n"
                              "echo 'error: none of the expected identities matched' >&2\nexit 1\n")
            script.chmod(0o755)
            return script
        patcher = patch.object(release.Deployment, "cosign", cosign)
        patcher.start()
        self.addCleanup(patcher.stop)
        return log

    def renamed_bundle(self, product="orrery"):
        """The bundle as the tree on PRODUCT's side of the rename builds it: PRODUCT-server-*."""
        path = Path(__file__).with_name("server-bundle.py")
        module = types.ModuleType("server_bundle_" + product)
        module.__file__ = str(path)
        source = path.read_text().replace("orrery-", "orca-").replace("orca-", product + "-")
        exec(compile(source, str(path), "exec"), module.__dict__)
        (self.tmp / "daemon" / f"{product}-daemon.mjs").write_text("// daemon\n")
        out = self.tmp / product
        module.assemble("0.8.0", SHA, self.tmp / "node-runtime" / "bin" / "node", self.tmp / "daemon", out,
                        1700000000, "v24.1.0")
        (out / f"{product}-server-0.8.0-linux-x64.manifest.json.sigstore.json").write_text("{}")
        return out

    def test_bridge_accepts_a_bundle_signed_by_either_repository(self):
        self.assertEqual(set(release.BUNDLE_REPOSITORIES), {"cschadewitz/Project_Orca", "cschadewitz/Orrery"})
        self.assertEqual(release.BUNDLE_REPOSITORIES[0], release.BUNDLE_REPOSITORY)
        for index, repository in enumerate(release.BUNDLE_REPOSITORIES):
            with self.subTest(repository=repository):
                shutil.rmtree(self.deployment.root / "releases" / "v0.8.0", ignore_errors=True)
                log = self.accepting(repository)
                log.unlink(missing_ok=True)
                self.assertEqual(self.deployment.stage_bundle(str(self.files)).name, "v0.8.0")
                calls = log.read_text().splitlines()
                # Each repository is tried with its own exact identity, in order, until one verifies.
                self.assertEqual(len(calls), index + 1)
                for call, tried in zip(calls, release.BUNDLE_REPOSITORIES):
                    self.assertIn(f"--certificate-identity https://github.com/{tried}/.github/workflows/"
                                  "release-server-bundle.yml@refs/heads/main", call)
                    self.assertIn(f"--certificate-github-workflow-repository {tried} ", call)

    def test_bridge_still_refuses_any_other_repository(self):
        log = self.accepting("someone/Orrery")
        self.refused("Bundle signature refused")
        self.assertEqual(len(log.read_text().splitlines()), len(release.BUNDLE_REPOSITORIES))

    def test_bridge_stages_a_bundle_under_either_product_name(self):
        self.accepting("cschadewitz/Orrery")
        for product in ("orca", "orrery"):
            with self.subTest(product=product):
                shutil.rmtree(self.deployment.root / "releases" / "v0.8.0", ignore_errors=True)
                self.validated.clear()
                staged = self.deployment.stage_bundle(str(self.renamed_bundle(product)))
                (stage, record, demo_release), = self.validated
                self.assertEqual(record["entry"], f"{product}-daemon.mjs")
                self.assertEqual(release.metadata(staged)["entry"], str(staged / f"{product}-daemon.mjs"))
                self.assertEqual(record["bundle"]["archiveSha256"],
                                 release.file_sha256(self.tmp / product / f"{product}-server-0.8.0-linux-x64.tar.xz"))

    def test_bridge_refuses_a_bundle_that_mixes_the_names(self):
        out = self.renamed_bundle()
        path = out / "orrery-server-0.8.0-linux-x64.manifest.json"
        manifest = json.loads(path.read_text())
        manifest["entry"] = "orca-daemon.mjs"
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "unexpected runtime or entry"):
            self.deployment.stage_bundle(str(out))

    def test_bridge_fetches_from_the_other_repository_when_the_first_has_no_release(self):
        self.files = self.renamed_bundle()
        fetched = self.fetch_fixture("RECORD")
        fixture = release.download
        asked = []

        def download(url, target, limit, accept=None):
            asked.append(url)
            if url.startswith(f"https://api.github.com/repos/{release.BUNDLE_REPOSITORIES[0]}/"):
                raise release.urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            return fixture(url, target, limit, accept)
        self.accepting(release.BUNDLE_REPOSITORIES[1])
        with patch.object(release, "download", download):
            self.assertEqual(self.deployment.stage_bundle("v0.8.0").name, "v0.8.0")
        self.assertEqual([url for url in asked if url.startswith("https://api.github.com/")],
                         [f"https://api.github.com/repos/{r}/releases/tags/v0.8.0" for r in release.BUNDLE_REPOSITORIES])
        self.assertEqual(sorted(fetched), sorted(p.name for p in self.files.iterdir()))

    def test_bridge_sets_the_daemon_environment_under_both_prefixes(self):
        env = release.both_env_names({"ORCA_RELEASE": "r", "ORRERY_ADMISSION_FILE": "a", "HOME": "h"},
                                     ["ORCA_RELEASE", "ORRERY_ADMISSION_FILE", "ORCA_DEPLOYMENT_RING"])
        self.assertEqual(env, {"ORCA_RELEASE": "r", "ORRERY_RELEASE": "r", "ORRERY_ADMISSION_FILE": "a",
                               "ORCA_ADMISSION_FILE": "a", "HOME": "h"})

    def test_bridge_reads_a_variable_set_under_either_prefix(self):
        for name in ("ORCA_DAEMON_TOKEN", "ORRERY_DAEMON_TOKEN"):
            other = "ORRERY_DAEMON_TOKEN" if name == "ORCA_DAEMON_TOKEN" else "ORCA_DAEMON_TOKEN"
            self.assertEqual(release.environment_value(name, {other: "legacy"}), "legacy")
            self.assertEqual(release.environment_value(name, {name: "new", other: "legacy"}), "new")
            self.assertIsNone(release.environment_value(name, {"HOME": "h"}))

    def test_bridge_reads_either_hello_version_field(self):
        meta = {"version": "0.8.0", "compatibility": {"protocol": 3, "capabilities": []}}
        for field in ("orcaVersion", "orreryVersion"):
            release.verify_hello({field: "0.8.0", "protocol": 3, "methods": ["maintenance"]}, meta)
        with self.assertRaisesRegex(RuntimeError, "Unexpected daemon version"):
            release.verify_hello({"protocol": 3, "methods": ["maintenance"]}, meta)

    def test_bridge_reads_a_server_channel_under_either_product_name(self):
        for product in ("orca", "orrery"):
            names = release.bundle_names("0.8.0", product)[1:]
            lines = ["version: 0.8.0", "platform: linux-x64", "sourceSha: " + SHA]
            for kind, name in zip(("archive", "manifest", "signature"), names):
                lines += [f"{kind}: {name}", f"{kind}Sha256: " + "b" * 64, f"{kind}Size: 10"]
            self.assertEqual(release.parse_server_channel("\n".join(lines) + "\n")["archive"], names[0])
    # rename-keep-end


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
