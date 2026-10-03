"""Portable, isolated delivery-v1 tests; all bytes and publisher claims are synthetic."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from make_fixture import write_fixture


HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parents[1] / "native-mac-verify.py"
spec = importlib.util.spec_from_file_location("native_mac_verify", SCRIPT)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.reset()

    def reset(self):
        self.fixture = self.base / "fixture"
        if self.fixture.exists():
            shutil.rmtree(self.fixture)
        write_fixture(self.fixture)
        self.root = self.fixture / "delivery"
        self.app = self.fixture / "ORCA.app"
        self.identity_path = self.app / "Contents/Resources/orca-build.json"
        self.plist_path = self.app / "Contents/Info.plist"
        self.manifest_path = self.root / verify.MANIFEST
        self.sums_path = self.root / "SHA256SUMS"
        self.manifest = json.loads(self.manifest_path.read_bytes())

    def save(self):
        """Repair only the manifest checksum, so each mutation reaches its target check."""
        self.manifest_path.write_text(json.dumps(self.manifest, indent=2) + "\n", encoding="utf-8")
        self.bind_manifest()

    def bind_manifest(self):
        lines = self.sums_path.read_text().splitlines()
        self.sums_path.write_text("".join(
            f"{sha(self.manifest_path.read_bytes())}  {verify.MANIFEST}\n"
            if line.endswith("  " + verify.MANIFEST) else line + "\n" for line in lines))

    def bind_identity(self):
        self.identity_path.write_text(json.dumps(self.manifest["identity"], indent=2) + "\n")
        self.manifest["identitySha256"] = sha(self.identity_path.read_bytes())
        self.save()

    def check(self):
        verify.validate_fixture(self.root, self.app)

    def fails(self, message):
        with self.assertRaisesRegex(verify.InvalidFixture, message):
            self.check()

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              capture_output=True, text=True, timeout=10)

    def test_checked_in_fixture_and_read_only_cli(self):
        before = {p.relative_to(self.fixture): p.read_bytes() for p in self.fixture.rglob("*") if p.is_file()}
        self.check()
        result = self.cli("--mode", "fixture", "--fixture-app", self.app, self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS (fixture only)", result.stdout)
        self.assertIn("No signatures, notarization", result.stdout)
        self.assertEqual(before, {p.relative_to(self.fixture): p.read_bytes()
                                  for p in self.fixture.rglob("*") if p.is_file()})

    def test_candidate_mode_rejected_even_without_files(self):
        result = self.cli("--mode", "candidate")
        self.assertEqual(result.returncode, 2)
        self.assertIn(verify.FIXTURE_ONLY, result.stderr)
        self.assertNotIn("PASS", result.stdout)

    def test_fixture_cannot_be_used_in_candidate_mode(self):
        result = self.cli("--mode", "candidate", "--fixture-app", self.app, self.root)
        self.assertEqual(result.returncode, 2)
        self.assertIn(verify.FIXTURE_ONLY, result.stderr)

    def test_candidate_cannot_be_used_in_fixture_mode(self):
        self.manifest["kind"] = "candidate"
        self.save()
        self.fails("production-candidate verification is unsupported")
        result = self.cli("--mode", "fixture", "--fixture-app", self.app, self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn(verify.FIXTURE_ONLY, result.stderr)

    def test_cli_requires_explicit_mode_and_app(self):
        for args in [(self.root,), ("--mode", "fixture", self.root), ("--mode", "fixture")]:
            with self.subTest(args=args):
                result = self.cli(*args)
                self.assertEqual(result.returncode, 2)
                self.assertNotIn("PASS", result.stdout)

    def test_incomplete_documented_negative_fixture(self):
        for field in ("identity", "identitySha256", "minimumMacOS", "signing", "notarization", "stapling"):
            self.manifest[field] = None
        self.manifest["artifacts"] = []
        self.manifest["evidence"] = []
        self.save()
        self.fails("identity: expected object")

    def test_every_documented_field_is_required(self):
        def fields(value, prefix=()):
            if isinstance(value, dict):
                for key, child in value.items():
                    yield prefix + (key,)
                    yield from fields(child, prefix + (key,))
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    yield from fields(child, prefix + (index,))
        paths = list(fields(self.manifest))
        for path in paths:
            with self.subTest(path=path):
                self.reset()
                parent = self.manifest
                for key in path[:-1]:
                    parent = parent[key]
                del parent[path[-1]]
                self.save()
                self.fails("expected|require|unsupported")

    def test_invalid_structure_and_identity_fields(self):
        cases = [
            ("schemaVersion", 2), ("schemaVersion", True), ("schemaVersion", 1.0),
            ("kind", "unknown"), ("identity", None), ("identity.schemaVersion", 2),
            ("identity.schemaVersion", True), ("identity.schemaVersion", 1.0),
            ("identity.releaseVersion", "v1.2.3"), ("identity.releaseVersion", "1.2"),
            ("identity.releaseVersion", "01.2.3"), ("identity.releaseVersion", "1.2.3-01"),
            ("identity.bundleId", "another.bundle"), ("identity.platform", "linux"),
            ("identity.arch", "x64"), ("identity.sourceCommit", "main"),
            ("identity.sourceCommit", "A" * 40), ("identity.buildId", "gha:run:1:mac-arm64"),
            ("identity.builtAt", "2000-02-30T00:00:00Z"),
            ("identity.builtAt", "2000-01-01T00:00:00+01:00"),
            ("identity.builtAt", "2000-01-01"), ("identity.appVersion", "1.0.0"),
            ("identity.bundleShortVersion", ""), ("identity.bundleVersion", 7),
            ("identity.daemon.path", "../daemon.mjs"), ("identity.daemon.version", "1.0.0"),
            ("identity.daemon.sha256", "ABC"), ("identity.protocol.major", -1),
            ("identity.protocol.minor", True), ("identity.protocol.minor", 9.0),
            ("identity.storeEpoch", ""), ("identity.toolchain.node", "^24.0.0"),
            ("identity.toolchain.xcode", "latest"), ("identity.toolchain.pnpm", "12.x"),
            ("identity.toolchain.macos", None), ("identitySha256", "A" * 64),
            ("minimumMacOS", None), ("minimumMacOS", ""), ("minimumMacOS", "TBD"),
            ("signing.teamId", ""), ("signing.authority", "ad-hoc"),
            ("signing.certificateSha256", "not-a-digest"), ("signing.hardenedRuntime", 1),
            ("signing.verification", "failed"), ("notarization.app.submissionId", "not-a-uuid"),
            ("notarization.dmg.status", "Rejected"), ("notarization.app.status", "TimedOut"),
            ("notarization.app.submittedSha256", "A" * 64),
            ("stapling.appInZip.status", "missing"), ("stapling.dmg.status", False),
            ("evidence", {}), ("artifacts", {}),
        ]
        for dotted, value in cases:
            with self.subTest(field=dotted, value=value):
                self.reset()
                keys = dotted.split(".")
                parent = self.manifest
                for key in keys[:-1]:
                    parent = parent[key]
                parent[keys[-1]] = value
                self.save()
                self.fails("expected|invalid|mismatch|unsupported|ad-hoc|require")

    def test_unknown_fields_and_zip_container_staple(self):
        for obj in ((), ("identity",), ("stapling",)):
            with self.subTest(obj=obj):
                self.reset()
                parent = self.manifest
                for key in obj:
                    parent = parent[key]
                parent["zip"] = {"status": "passed"}
                self.save()
                self.fails("expected fields")

    def test_duplicate_json_keys_at_both_levels_and_in_app(self):
        for source, key in (("manifest", "kind"), ("manifest", "major"), ("app", "bundleVersion")):
            with self.subTest(source=source, key=key):
                self.reset()
                path = self.manifest_path if source == "manifest" else self.identity_path
                data = path.read_text().replace(f'"{key}":', f'"{key}": null, "{key}":', 1)
                path.write_text(data)
                if source == "app":
                    self.manifest["identitySha256"] = sha(path.read_bytes())
                    self.save()
                self.fails("duplicate JSON key")

    def test_malformed_json_utf8_and_non_json_constants(self):
        for data in (b"{", b"\xff", b"[]", b'{"kind":"fixture","schemaVersion":NaN}'):
            with self.subTest(data=data):
                self.manifest_path.write_bytes(data)
                self.fails("invalid|expected object")

    def test_missing_or_duplicate_formats(self):
        for change in ("missing", "duplicate", "extra", "wrong-format"):
            with self.subTest(change=change):
                self.reset()
                if change == "missing":
                    self.manifest["artifacts"].pop()
                elif change == "extra":
                    self.manifest["artifacts"].append(copy.deepcopy(self.manifest["artifacts"][0]))
                elif change == "duplicate":
                    self.manifest["artifacts"][1]["format"] = "dmg"
                else:
                    self.manifest["artifacts"][1]["format"] = "exe"
                self.save()
                self.fails("exactly one DMG and one ZIP")

    def test_filename_version_and_architecture_consistency(self):
        for name in ("ORCA-1.0.0-mac-arm64.dmg", "ORCA-0.0.0-fixture.1-mac-x64.dmg", "subdir/file.dmg"):
            with self.subTest(name=name):
                self.manifest["artifacts"][0]["path"] = name
                self.save()
                self.fails("artifact filename/version mismatch")

    def test_duplicate_paths_within_and_across_arrays(self):
        for target, source in (("artifacts", "artifacts"), ("evidence", "evidence"), ("evidence", "artifacts")):
            with self.subTest(target=target, source=source):
                self.reset()
                self.manifest[target][1]["path"] = self.manifest[source][0]["path"]
                self.save()
                self.fails("duplicate file path")

    def test_path_syntax_and_evidence_reference_containment(self):
        bad = ["../outside", "/absolute", "evidence/../outside", "evidence//file", "./evidence/file",
               "evidence/./file", "C:/outside", "evidence\\file", "evidence/file\n", "evidence/", "",
               "evidence/\ud800"]
        for name in bad:
            for area in ("artifact", "evidence", "reference"):
                with self.subTest(name=name, area=area):
                    self.reset()
                    if area == "reference":
                        self.manifest["signing"]["reportPath"] = name
                    else:
                        self.manifest["artifacts" if area == "artifact" else "evidence"][0]["path"] = name
                    self.save()
                    self.fails("path|characters|string|Unicode")

    def test_reference_must_be_listed_and_under_evidence(self):
        for path in ("evidence/unlisted.txt", self.manifest["artifacts"][0]["path"]):
            with self.subTest(path=path):
                self.manifest["signing"]["reportPath"] = path
                self.save()
                self.fails("referenced report is not listed|under evidence")

    def test_nonpositive_boolean_and_fractional_sizes(self):
        for size in (0, -1, True, 1.5, "123"):
            for records in ("artifacts", "evidence"):
                with self.subTest(size=size, records=records):
                    self.reset()
                    self.manifest[records][0]["bytes"] = size
                    self.save()
                    self.fails("expected integer")

    def test_modified_artifact_and_evidence_bytes(self):
        for records in ("artifacts", "evidence"):
            for resized in (False, True):
                with self.subTest(records=records, resized=resized):
                    self.reset()
                    path = self.root / self.manifest[records][0]["path"]
                    data = path.read_bytes()
                    path.write_bytes(data + b"extra" if resized else b"!" + data[1:])
                    self.fails("file size mismatch" if resized else "file digest mismatch")

    def test_submission_digest_is_not_final_digest(self):
        self.assertNotEqual(self.manifest["notarization"]["dmg"]["submittedSha256"],
                            self.manifest["artifacts"][0]["sha256"])
        self.check()
        self.manifest["artifacts"][0]["sha256"] = self.manifest["notarization"]["dmg"]["submittedSha256"]
        self.save()
        self.fails("file digest mismatch")

    def test_missing_files_and_nonregular_files(self):
        names = [verify.MANIFEST, "SHA256SUMS", self.manifest["artifacts"][0]["path"],
                 self.manifest["evidence"][0]["path"]]
        for name in names:
            for directory in (False, True):
                with self.subTest(name=name, directory=directory):
                    self.reset()
                    path = self.root / name
                    path.unlink()
                    if directory:
                        path.mkdir()
                        self.fails("not a regular file")
                    else:
                        with self.assertRaises(OSError):
                            self.check()

    def test_symlink_escapes_for_all_read_boundaries(self):
        names = [verify.MANIFEST, "SHA256SUMS", self.manifest["artifacts"][0]["path"],
                 self.manifest["evidence"][0]["path"], "evidence", "app-identity", "app-daemon", "app-plist"]
        app_paths = {"app-identity": "Contents/Resources/orca-build.json",
                     "app-daemon": "Contents/Resources/daemon/orca-daemon.mjs", "app-plist": "Contents/Info.plist"}
        for name in names:
            with self.subTest(name=name):
                self.reset()
                path = self.app / app_paths[name] if name in app_paths else self.root / name
                outside = self.base / ("outside-" + name.replace("/", "-"))
                path.rename(outside)
                path.symlink_to(outside, target_is_directory=outside.is_dir())
                self.fails("path escapes fixture root")

    def test_internal_symlink_alias_cannot_duplicate_a_record(self):
        first, second = self.manifest["evidence"][:2]
        target = self.root / second["path"]
        target.unlink()
        target.symlink_to(Path(first["path"]).name)
        self.fails("duplicate resolved file path")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO test needs POSIX")
    def test_fifo_rejected_without_opening_it(self):
        path = self.root / self.manifest["artifacts"][0]["path"]
        path.unlink()
        os.mkfifo(path)
        result = self.cli("--mode", "fixture", "--fixture-app", self.app, self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not a regular file", result.stderr)

    def test_checksum_format_coverage_order_duplicates_and_hashes(self):
        original = self.sums_path.read_text()
        lines = original.splitlines(keepends=True)
        cases = [
            (original.rstrip("\n"), "final newline"),
            (original.replace("  ", " ", 1), "two spaces"),
            (original.replace("\n", "\r\n"), "characters"),
            (original[:64].upper() + original[64:], "lowercase digest"),
            ("".join(reversed(lines)), "sorted"),
            (lines[0] + original, "duplicate path"),
            ("".join(lines[1:]), "coverage"),
            ("".join(line for line in lines if not line.endswith("  " + verify.MANIFEST + "\n")), "coverage"),
            (original + "0" * 64 + "  z-extra.txt\n", "coverage"),
            (original.replace(lines[0][:64], "0" * 64), "digest mismatch"),
            ("0" * 64 + "  ../outside\n", "unsafe path"),
            ("0" * 64 + "  SHA256SUMS\n", "coverage"),
        ]
        for content, message in cases:
            with self.subTest(message=message):
                self.sums_path.write_bytes(content.encode())
                self.fails(message)

    def test_checksum_binds_exact_manifest_bytes(self):
        self.manifest_path.write_bytes(self.manifest_path.read_bytes() + b" ")
        self.fails("SHA256SUMS: digest mismatch")

    def test_identity_hash_uses_exact_bytes_not_reserialized_json(self):
        self.identity_path.write_bytes(self.identity_path.read_bytes() + b" \n")
        self.fails("identitySha256: byte digest mismatch")
        self.manifest["identitySha256"] = sha(self.identity_path.read_bytes())
        self.save()
        self.check()

    def test_identity_protocol_and_source_must_match_separate_app_bytes(self):
        for field, value in (("protocol", {"major": 1, "minor": 10}), ("sourceCommit", "f" * 40),
                             ("bundleVersion", "7.2")):
            with self.subTest(field=field):
                self.reset()
                self.manifest["identity"][field] = value
                self.save()
                self.fails("manifest identity mismatch")

    def test_protocol_has_no_permanent_baseline_pin(self):
        self.manifest["identity"]["protocol"] = {"major": 17, "minor": 0}
        self.bind_identity()
        self.check()

    def test_modified_daemon(self):
        (self.app / "Contents/Resources/daemon/orca-daemon.mjs").write_bytes(b"modified fixture\n")
        self.fails("fixture daemon: digest mismatch")

    def test_plist_fields_compared_verbatim(self):
        plist = plistlib.loads(self.plist_path.read_bytes())
        for key, value in (("CFBundleIdentifier", "wrong.bundle"), ("CFBundleShortVersionString", "0.0"),
                           ("CFBundleVersion", "7.2"), ("CFBundleVersion", 7), ("LSMinimumSystemVersion", "0.1")):
            with self.subTest(key=key, value=value):
                changed = {**plist, key: value}
                self.plist_path.write_bytes(plistlib.dumps(changed))
                self.fails("verbatim mismatch")

    def test_bundle_version_mapping_is_not_guessed(self):
        self.manifest["identity"]["bundleVersion"] = "opaque-fixture-0007"
        self.manifest["identity"]["bundleShortVersion"] = "different-fixture-value"
        self.bind_identity()
        plist = plistlib.loads(self.plist_path.read_bytes())
        plist["CFBundleVersion"] = "opaque-fixture-0007"
        plist["CFBundleShortVersionString"] = "different-fixture-value"
        self.plist_path.write_bytes(plistlib.dumps(plist))
        self.check()

    def test_cli_io_failure_has_no_traceback_or_pass(self):
        result = self.cli("--mode", "fixture", "--fixture-app", self.app, self.base / "missing")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL (fixture only)", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("PASS", result.stdout)

    def test_malformed_plist_fails_cleanly(self):
        for content in (b"not a plist", b"<?xml version='1.0'?><plist><dict>", b"bplist00broken"):
            with self.subTest(content=content):
                self.plist_path.write_bytes(content)
                result = self.cli("--mode", "fixture", "--fixture-app", self.app, self.root)
                self.assertEqual(result.returncode, 1)
                self.assertIn("invalid plist", result.stderr)
                self.assertNotIn("Traceback", result.stderr)

    def test_unknown_schema_has_explicit_diagnostic(self):
        self.manifest["schemaVersion"] = 999
        self.save()
        self.fails("unsupported schemaVersion")

    def test_symlink_loop_fails_cleanly(self):
        path = self.root / self.manifest["artifacts"][0]["path"]
        path.unlink()
        path.symlink_to(path.name)
        result = self.cli("--mode", "fixture", "--fixture-app", self.app, self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL (fixture only)", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_materialization_does_not_overwrite_a_destination(self):
        with self.assertRaises(FileExistsError):
            write_fixture(self.fixture)
        self.check()


if __name__ == "__main__":
    unittest.main()
