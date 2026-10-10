"""Controlled native ports and synthetic bytes; never signed or physical acceptance."""

import copy
from dataclasses import replace
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location("candidate_test_adapter", ROOT / "tools/deploy/native-mac-candidate.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
native = candidate.containment
SOURCE = Path(__file__).with_name("fixtures") / "valid"
sha = lambda data: hashlib.sha256(data).hexdigest()


class ControlledRunner:
    def __init__(self, app, policy):
        self.app, self.policy, self.calls = app, policy, []
        self.bad = None

    def run(self, command, args, cleanup=False):
        self.calls.append((command, args, cleanup))
        if self.bad == "detach" and args[0] == "detach":
            raise ValueError("controlled detach failure")
        if command.endswith("sw_vers"):
            return b"14.0\n", b""
        if command.endswith("hdiutil"):
            if args[0] == "imageinfo":
                return plistlib.dumps({"Size Information": {"Uncompressed Bytes": 1024 * 1024}}), b""
            if args[0] == "attach":
                mount = Path(args[args.index("-mountpoint") + 1])
                shutil.copytree(self.app, mount / "ORCA.app", symlinks=True)
                if self.bad == "layout":
                    (mount / "Other.app").mkdir()
                return plistlib.dumps({"system-entities": [{"mount-point": str(mount)}]}), b""
        if command.endswith("ditto"):
            source, dest = map(Path, args[-2:])
            if args[0] == "-x":
                shutil.copytree(self.app, dest / "ORCA.app", symlinks=True)
                if self.bad == "copy":
                    (dest / "ORCA.app/Contents/MacOS/ORCA").write_bytes(b"changed")
            else:
                shutil.copytree(source, dest, symlinks=True)
        if command.endswith("lipo"):
            return (b"x86_64\n" if self.bad == "arch" else b"arm64\n"), b""
        if command.endswith("codesign") and "--display" in args:
            if "--extract-certificates" in args:
                prefix = args[args.index("--extract-certificates") + 1]
                Path(prefix + "0").write_bytes(b"wrong certificate" if self.bad == "certificate" else b"controlled certificate")
            elif "--entitlements" in args:
                return plistlib.dumps({"unexpected": True}) if self.bad == "entitlements" else b"", b""
            else:
                path = Path(args[-1])
                name = ("ORCA.app/Contents" + str(path).split("/Contents", 1)[1]
                        if "/Contents" in str(path) else "ORCA.app" if (path / "Contents/Info.plist").is_file() else None)
                identifier = self.policy["code"].get(name, {}).get("identifier", "disk-image")
                team = "BADTEAM" if self.bad == "team" else "Q2FP9UY5T4"
                return b"", (f"Identifier={identifier}\nTeamIdentifier={team}\n"
                              f"Authority={self.policy['signing']['authority']}\nTimestamp=controlled\n"
                              "CodeDirectory=v=20500 size=1 flags=0x10000(runtime) hashes=1\n").encode()
        if self.bad == "ticket" and command.endswith("xcrun"):
            raise ValueError("controlled missing ticket")
        return b"", b""


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="orca-candidate-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "delivery"
        self.root.mkdir()
        self.parent = self.base / "scratch"
        self.parent.mkdir(mode=0o700)
        self.app = self.base / "ORCA.app"
        shutil.copytree(SOURCE / "ORCA.app", self.app)
        daemon = self.app / "Contents/Resources/daemon/orca-daemon.mjs.txt"
        daemon.rename(daemon.with_suffix(""))
        (self.app / "Contents/MacOS").mkdir()
        executable = self.app / "Contents/MacOS/ORCA"
        executable.write_bytes(b"\xcf\xfa\xed\xfe" + b"\x00" * 28)
        executable.chmod(0o755)
        self.manifest = json.loads((SOURCE / "delivery/native-mac-artifact.json").read_bytes())
        self.manifest["kind"] = "candidate"
        plist_path = self.app / "Contents/Info.plist"
        app_plist = plistlib.loads(plist_path.read_bytes())
        app_plist["CFBundleExecutable"] = "ORCA"
        plist_path.write_bytes(plistlib.dumps(app_plist))
        self.manifest["signing"].update(teamId="Q2FP9UY5T4", authority="Developer ID Application: Controlled Fixture (Q2FP9UY5T4)",
                                        certificateSha256=sha(b"controlled certificate"))
        electron = self.app / "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"
        electron.parent.mkdir(parents=True)
        electron.write_bytes(plistlib.dumps({"CFBundleVersion": self.manifest["identity"]["toolchain"]["electron"]}))
        self.package(self.manifest["identity"]["appVersion"])
        for record in self.manifest["evidence"]:
            path = self.root / record["path"]
            path.parent.mkdir(exist_ok=True)
            path.write_bytes((SOURCE / "delivery" / record["path"]).read_bytes())
        self.write_zip()
        dmg = next(record for record in self.manifest["artifacts"] if record["format"] == "dmg")
        (self.root / dmg["path"]).write_bytes(b"Controlled DMG stub; no native image")
        self.policy = {"identity": self.manifest["identity"], "identitySha256": self.manifest["identitySha256"],
                       "minimumMacOS": self.manifest["minimumMacOS"], "signing": {key: self.manifest["signing"][key]
                       for key in ("teamId", "authority", "certificateSha256")}, "notarization": self.manifest["notarization"],
                       "code": {path: {"identifier": identifier, "hardenedRuntime": True, "entitlements": {}}
                                for path, identifier in (("ORCA.app", "com.schadewitz.orca"),
                                                         ("ORCA.app/Contents/Frameworks/Electron Framework.framework", "controlled.framework"),
                                                         ("ORCA.app/Contents/MacOS/ORCA", "com.schadewitz.orca"))}}
        self.save()

    def package(self, version):
        data = json.dumps({"version": version}).encode()
        header = json.dumps({"files": {"package.json": {"size": len(data), "offset": "0"}}}).encode()
        payload = struct.pack("<I", len(header)) + header
        payload += b"\x00" * (-len(payload) % 4)
        pickle = struct.pack("<I", len(payload)) + payload
        (self.app / "Contents/Resources/app.asar").write_bytes(struct.pack("<II", 4, len(pickle)) + pickle + data)

    def write_zip(self):
        record = next(record for record in self.manifest["artifacts"] if record["format"] == "zip")
        with zipfile.ZipFile(self.root / record["path"], "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in self.app.rglob("*"):
                if path.is_file():
                    info = zipfile.ZipInfo("ORCA.app/" + path.relative_to(self.app).as_posix())
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | (path.stat().st_mode & 0o777)) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, path.read_bytes())

    def save(self):
        for record in self.manifest["artifacts"] + self.manifest["evidence"]:
            data = (self.root / record["path"]).read_bytes()
            record.update(sha256=sha(data), bytes=len(data))
        manifest = (json.dumps(self.manifest, indent=2) + "\n").encode()
        (self.root / candidate.delivery.MANIFEST).write_bytes(manifest)
        paths = [candidate.delivery.MANIFEST] + [r["path"] for r in self.manifest["artifacts"] + self.manifest["evidence"]]
        (self.root / "SHA256SUMS").write_text("".join(f"{sha((self.root / path).read_bytes())}  {path}\n" for path in sorted(paths)))
        self.policy["manifestSha256"] = sha(manifest)

    def check(self, runner=None):
        with patch.object(candidate.sys, "platform", "darwin"), patch.object(candidate.platform, "machine", return_value="arm64"):
            return candidate.verify_candidate(self.root, self.policy, self.parent, runner or ControlledRunner(self.app, self.policy))

    def test_controlled_ports_exercise_both_containers_and_final_native_checks(self):
        runner = ControlledRunner(self.app, self.policy)
        result = self.check(runner)
        self.assertEqual(result["kind"], "candidate")
        self.assertEqual(len([call for call in runner.calls if call[0].endswith("syspolicy_check")]), 2)
        self.assertEqual(len([call for call in runner.calls if call[1][:2] == ["stapler", "validate"]]), 3)
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assertFalse(any("--sign" in call[1] or "submit" in call[1] for call in runner.calls))
        self.assertEqual({copy["format"] for copy in result["copies"]}, {"dmg", "zip"})
        self.assertTrue(all(copy["daemonSha256"] == self.manifest["identity"]["daemon"]["sha256"] for copy in result["copies"]))

    def test_fixed_saved_image_reuses_signature_identity_and_containment_checks(self):
        spec = importlib.util.spec_from_file_location("runtime_test_adapter", ROOT / "tools/deploy/native-mac-runtime.py")
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        saved = self.base / "binary"
        shutil.copytree(self.app, saved)
        runner = ControlledRunner(saved, self.policy)
        manifest = (self.root / candidate.delivery.MANIFEST).read_bytes()
        with patch.object(runtime.sys, "platform", "darwin"), patch.object(runtime.platform, "machine", return_value="arm64"):
            result = runtime.inspect_image(saved, manifest, self.policy, self.parent, runner)
            self.assertEqual(result["outcome"], "verified")
            self.assertEqual(result["manifestSha256"], sha(manifest))
            self.assertEqual(result["daemonSha256"], self.manifest["identity"]["daemon"]["sha256"])
            self.assertEqual(list(self.parent.iterdir()), [])
            for bad in ("certificate", "team", "entitlements", "ticket"):
                runner.bad = bad
                with self.subTest(bad=bad), self.assertRaises(ValueError):
                    runtime.inspect_image(saved, manifest, self.policy, self.parent, runner)
            runner.bad = None
            (saved / "Contents/Resources/daemon/orca-daemon.mjs").write_bytes(b"changed daemon")
            with self.assertRaises(ValueError):
                runtime.inspect_image(saved, manifest, self.policy, self.parent, runner)

    def test_runtime_json_interface_refuses_non_native_and_malformed_without_paths(self):
        if sys.platform == "darwin":
            self.skipTest("non-native interface case requires non-Darwin executor")
        for request in ({"operation": "image", "path": str(self.app), "manifestBase64": "!", "policy": self.policy,
                         "scratchParent": str(self.parent)}, {"unexpected": str(self.base)}):
            result = subprocess.run([sys.executable, "-B", str(ROOT / "tools/deploy/native-mac-runtime.py")],
                                    input=json.dumps(request), capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout), {"outcome": "refused"})
            self.assertEqual(result.stderr, "")

    def test_independent_manifest_pin_refuses_recomputed_download_checksums(self):
        pin = self.policy["manifestSha256"]
        self.manifest["identity"]["sourceCommit"] = "f" * 40
        self.save()
        self.policy["manifestSha256"] = pin
        with self.assertRaisesRegex(ValueError, "trusted manifest digest"):
            candidate.pin_manifest(self.root, self.policy)

    def test_pinned_identity_os_notary_and_certificate_are_independent_requirements(self):
        for field, value in (("identitySha256", "f" * 64), ("minimumMacOS", "15.0")):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.policy)
                changed[field] = value
                with self.assertRaisesRegex(ValueError, "trusted .* mismatch"):
                    candidate.pin_manifest(self.root, changed)
        for field in ("identity", "minimumMacOS", "signing", "notarization", "code"):
            changed = copy.deepcopy(self.policy)
            del changed[field]
            with self.assertRaisesRegex(ValueError, "expected fields"):
                candidate.validate_policy(changed)

    def test_fixture_kind_and_candidate_symlink_refuse_before_native_operations(self):
        self.manifest["kind"] = "fixture"
        self.save()
        with self.assertRaisesRegex(ValueError, "candidate kind"):
            candidate.pin_manifest(self.root, self.policy)

        self.manifest["kind"] = "candidate"
        self.save()
        record = self.manifest["artifacts"][0]
        path = self.root / record["path"]
        path.rename(self.base / "alias")
        path.symlink_to(self.base / "alias")
        with self.assertRaisesRegex(ValueError, "symlink"):
            candidate.pin_manifest(self.root, self.policy)

    def test_real_candidate_cli_refuses_non_native_executor_without_path_disclosure(self):
        if sys.platform == "darwin":
            self.skipTest("non-native CLI case requires non-Darwin executor")
        policy = self.base / "trusted-policy.json"
        policy.write_text(json.dumps(self.policy))
        result = subprocess.run([sys.executable, "-B", str(ROOT / "tools/deploy/native-mac-verify.py"),
            "--mode", "candidate", "--trusted-policy", str(policy), "--scratch-parent", str(self.parent),
            str(self.base / "nonexistent-delivery")], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL (native candidate)", result.stderr)
        self.assertNotIn(str(self.base), result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("PASS", result.stdout)

    def test_native_negatives_never_return_candidate_pass(self):
        for bad in ("copy", "layout", "arch", "certificate", "team", "entitlements", "ticket"):
            with self.subTest(bad=bad):
                runner = ControlledRunner(self.app, self.policy)
                runner.bad = bad
                with self.assertRaises(ValueError):
                    self.check(runner)
                self.assertEqual(list(self.parent.iterdir()), [])

    def test_missing_code_policy_and_wrong_packaged_version_refuse(self):
        del self.policy["code"]["ORCA.app/Contents/MacOS/ORCA"]
        with self.assertRaisesRegex(ValueError, "policy coverage"):
            self.check()
        self.policy["code"]["ORCA.app/Contents/MacOS/ORCA"] = {"identifier": "com.schadewitz.orca", "hardenedRuntime": True, "entitlements": {}}
        self.package("99.0.0")
        self.write_zip()
        self.save()
        with self.assertRaisesRegex(ValueError, "packaged app version"):
            self.check()

    def test_detach_failure_preserves_scratch_and_refuses_success(self):
        runner = ControlledRunner(self.app, self.policy)
        runner.bad = "detach"
        with self.assertRaisesRegex(ValueError, "detach"):
            self.check(runner)
        retained = list(self.parent.iterdir())
        self.assertEqual(len(retained), 1)
        self.assertTrue((retained[0] / "mount/ORCA.app").exists())
        self.assertEqual(len([call for call in runner.calls if call[1][0] == "detach"]), 1)

    def test_tree_bounds_aliases_special_nodes_and_symlink_cycles(self):
        with self.assertRaisesRegex(ValueError, "node limit"):
            native.inventory_tree(self.app, replace(native.Limits(), nodes=1))
        (self.app / "cycle").symlink_to("cycle")
        with self.assertRaisesRegex(ValueError, "cycle/hop"):
            native.inventory_tree(self.app)

        (self.app / "cycle").unlink()
        os.link(self.app / "Contents/MacOS/ORCA", self.app / "hardlink")
        with self.assertRaisesRegex(ValueError, "hardlink"):
            native.inventory_tree(self.app)

    def test_detach_zero_exit_with_mount_still_present_refuses_and_retains(self):
        runner = ControlledRunner(self.app, self.policy)
        with patch.object(native.os.path, "ismount", return_value=True):
            with self.assertRaisesRegex(ValueError, "detach remains unconfirmed"):
                self.check(runner)
        self.assertEqual(len(list(self.parent.iterdir())), 1)
        self.assertEqual(len([call for call in runner.calls if call[1][0] == "detach"]), 1)

    def test_logical_image_size_and_private_scratch_limits(self):
        for size in (None, True, 0, native.Limits().total_bytes + 1):
            with self.assertRaisesRegex(ValueError, "logical size"):
                native.check_image_info(plistlib.dumps({"Size Information": {} if size is None else {"Uncompressed Bytes": size}}), native.Limits())
        self.parent.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private scratch"):
            self.check()

    def test_asar_header_cannot_allocate_or_read_outside_its_boundary(self):
        path = self.app / "Contents/Resources/app.asar"
        path.write_bytes(struct.pack("<4I", 4, 0xffffffff, 0xfffffffb, 1) + b"{}")
        with self.assertRaisesRegex(ValueError, "ASAR header"):
            native.read_asar_package(self.app)

    def test_real_bounded_runner_owns_only_a_disposable_tool_child(self):
        runner = candidate.NativeRunner(self.parent)
        self.assertEqual(runner.execute(sys.executable, ["-c", "print('controlled child')"], 2)[0], b"controlled child\n")
        for program, message in (("print('x'*20000)", "output limit"), ("import time; time.sleep(2)", "timeout")):
            with self.assertRaisesRegex(ValueError, message):
                runner.execute(sys.executable, ["-c", program], 0.1)
        with self.assertRaisesRegex(ValueError, "command unavailable"):
            runner.run("/bin/sh", ["-c", "true"])


if __name__ == "__main__":
    unittest.main()
