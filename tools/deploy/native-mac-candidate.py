#!/usr/bin/env python3
"""Native signed-candidate adapter for the single delivery-v1 validator.

Policy is a separately authenticated executor input, never downloaded candidate data.
No signing, notary submission, app launch, installation, publication or access changes.
"""

import hashlib
import base64
import importlib.util
import os
from pathlib import Path
import platform
import plistlib
import re
import selectors
import stat
import subprocess
import sys
import time


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


delivery = module("orca_candidate_delivery", Path(__file__).with_name("native-mac-verify.py"))
containment = module("orca_native_containment", Path(__file__).resolve().parents[1] / "packaged-mac/native-containment.py")
require = delivery.require
MAX_METADATA = 1024 * 1024
MAX_OUTPUT = 16 * 1024
MAX_COMMANDS = 2048
MACHO = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xce",
         b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}


class NativeRunner:
    """Serial absolute commands with bounded streams, duration, count and environment."""

    def __init__(self, scratch):
        self.deadline = time.monotonic() + 600
        self.count = 0
        self.environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C",
                            "HOME": str(scratch), "TMPDIR": str(scratch)}

    def run(self, command, args, cleanup=False):
        require(command in ("/usr/bin/codesign", "/usr/bin/xcrun", "/usr/bin/hdiutil", "/usr/bin/ditto",
                            "/usr/bin/lipo", "/usr/bin/sw_vers", "/usr/bin/syspolicy_check", "/usr/sbin/spctl"),
                "native command unavailable")
        self.count += 1
        remaining = 30 if cleanup else min(30, self.deadline - time.monotonic())
        require((cleanup or self.count <= MAX_COMMANDS) and remaining > 0, "native command budget exhausted")
        return self.execute(command, args, remaining)

    def execute(self, command, args, timeout):
        # Separate streams are capped while the process is running, not after communicate().
        with subprocess.Popen([command, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=self.environment, cwd=self.environment["TMPDIR"]) as child:
            buffers = [bytearray(), bytearray()]
            deadline = time.monotonic() + timeout
            try:
                with selectors.DefaultSelector() as selector:
                    for index, stream in enumerate((child.stdout, child.stderr)):
                        os.set_blocking(stream.fileno(), False)
                        selector.register(stream, selectors.EVENT_READ, index)
                    while selector.get_map():
                        remaining = deadline - time.monotonic()
                        require(remaining > 0, "native command timeout")
                        for key, _ in selector.select(min(remaining, 0.1)):
                            data = os.read(key.fileobj.fileno(), 4096)
                            if not data:
                                selector.unregister(key.fileobj)
                                continue
                            buffers[key.data].extend(data)
                            require(len(buffers[key.data]) <= MAX_OUTPUT, "native command output limit")
                remaining = deadline - time.monotonic()
                require(remaining > 0, "native command timeout")
                require(child.wait(timeout=remaining) == 0, "native command failed")
            finally:
                if child.poll() is None:
                    child.kill()  # Only this owned direct tool child, never an app or device.
                    child.wait(timeout=5)
            return tuple(bytes(value) for value in buffers)


def validate_policy(policy):
    delivery.object_fields(policy, "manifestSha256 identity identitySha256 minimumMacOS signing notarization code", "trusted policy")
    delivery.validate_identity(policy["identity"])
    for key in ("manifestSha256", "identitySha256"):
        delivery.matching(policy[key], delivery.SHA256, "trusted policy." + key)
    delivery.matching(policy["minimumMacOS"], r"[0-9]+(?:\.[0-9]+)*", "trusted policy.minimumMacOS")
    delivery.object_fields(policy["signing"], "teamId certificateSha256 authority", "trusted signing")
    require(policy["signing"]["teamId"] == "Q2FP9UY5T4", "trusted publisher mismatch")
    delivery.matching(policy["signing"]["certificateSha256"], delivery.SHA256, "trusted certificate")
    delivery.string(policy["signing"]["authority"], "trusted authority")
    require(policy["signing"]["authority"].startswith("Developer ID Application: "), "Developer ID Application required")
    # Reuse v1 declaration validation; these records are pinned custodian receipts.
    delivery.validate_declarations({"signing": {**policy["signing"], "hardenedRuntime": True,
        "verification": "passed", "reportPath": "evidence/signing.txt"}, "notarization": policy["notarization"],
        "stapling": {target: {"status": "passed", "reportPath": "evidence/staple.txt"}
                     for target in ("appInDmg", "appInZip", "dmg")}})
    code = policy["code"]
    require(isinstance(code, dict) and "ORCA.app" in code and 1 <= len(code) <= MAX_COMMANDS // 12,
            "trusted code policy required/limit")
    for path, record in code.items():
        delivery.relative_path(path)
        require(path == "ORCA.app" or path.startswith("ORCA.app/"), "trusted code path outside app")
        delivery.object_fields(record, "identifier entitlements hardenedRuntime", "trusted code record")
        delivery.string(record["identifier"], "trusted code identifier")
        require(isinstance(record["entitlements"], dict) and type(record["hardenedRuntime"]) is bool,
                "trusted entitlement/runtime policy")
    require(code["ORCA.app"]["identifier"] == "com.schadewitz.orca"
            and code["ORCA.app"]["hardenedRuntime"] is True, "trusted root code identity/runtime")


def pin_manifest(directory, policy):
    """Anchor metadata before native operations or candidate resource reads."""
    validate_policy(policy)
    root = Path(directory).resolve(strict=True)
    require(stat.S_ISDIR(root.lstat().st_mode), "candidate directory required")
    data = containment.read_bounded(root / delivery.MANIFEST, MAX_METADATA)
    require(hashlib.sha256(data).hexdigest() == policy["manifestSha256"], "trusted manifest digest mismatch")
    manifest = delivery.parse_json(data, delivery.MANIFEST)
    require(isinstance(manifest, dict) and manifest.get("kind") == "candidate", "candidate kind required")
    for field in ("identity", "identitySha256", "minimumMacOS", "notarization"):
        require(manifest.get(field) == policy[field], "trusted " + field + " mismatch")
    require(isinstance(manifest.get("signing"), dict), "candidate signing required")
    for field, value in policy["signing"].items():
        require(manifest["signing"].get(field) == value, "trusted signing mismatch")
    # Bounds precede the shared validator's reads. No symlinks in the download set.
    require(isinstance(manifest.get("evidence"), list) and len(manifest["evidence"]) <= 64, "candidate evidence count limit")
    require(isinstance(manifest.get("artifacts"), list) and len(manifest["artifacts"]) == 2, "candidate artifact pair required")
    bounded = [("SHA256SUMS", MAX_METADATA)]
    bounded += [(record.get("path"), containment.Limits().archive_bytes) for record in manifest["artifacts"] if isinstance(record, dict)]
    bounded += [(record.get("path"), MAX_METADATA) for record in manifest["evidence"] if isinstance(record, dict)]
    for name, limit in bounded:
        delivery.relative_path(name)
        path = root
        for part in name.split("/"):
            path = path / part
            require(not path.is_symlink(), "candidate download symlink unsupported")
        containment.regular(path, limit)
    checked = delivery.validate_delivery(root, "candidate")
    require(checked == manifest, "candidate metadata changed")
    return root, manifest


def fields(data):
    result = {}
    for line in data.decode("utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            result.setdefault(key, []).append(value)
    return result


def verify_signature(path, record, signing, scratch, runner, dmg=False):
    developer_id = ('anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists '
                    'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
                    'and certificate leaf[subject.OU] = "Q2FP9UY5T4"')
    runner.run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "--test-requirement", developer_id, str(path)])
    _, report = runner.run("/usr/bin/codesign", ["--display", "--verbose=4", str(path)])
    values = fields(report)
    require(values.get("TeamIdentifier") == [signing["teamId"]]
            and values.get("Authority", [None])[0] == signing["authority"], "native publisher mismatch")
    require(len(values.get("Timestamp", [])) == 1 and values["Timestamp"][0] not in ("none", ""), "secure timestamp missing")
    if not dmg:
        require(values.get("Identifier") == [record["identifier"]], "native code identifier mismatch")
        directories = values.get("CodeDirectory", [])
        require(len(directories) == 1, "native CodeDirectory unavailable")
        match = re.search(r"\bflags=(0x[0-9a-fA-F]+)\b", directories[0])
        require(match is not None and bool(int(match[1], 16) & 0x10000) == record["hardenedRuntime"],
                "native hardened runtime mismatch")
        out, _ = runner.run("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", str(path)])
        containment.archive.bound_binary_plist(out)
        entitlements = plistlib.loads(out) if out else {}
        # JSON comparison prevents bool/int equality from hiding an entitlement change.
        import json
        require(json.dumps(entitlements, sort_keys=True) == json.dumps(record["entitlements"], sort_keys=True),
                "native entitlement mismatch")
    prefix = scratch / "certificate-"
    # Remove only our previous display outputs; no keychain or credential lookup.
    for file in scratch.glob("certificate-*"):
        file.unlink()
    runner.run("/usr/bin/codesign", ["--display", "--extract-certificates", str(prefix), str(path)])
    with os.scandir(scratch) as files:
        count = 0
        for file in files:
            if file.name.startswith("certificate-"):
                count += 1
                require(count <= 16 and re.fullmatch(r"certificate-(?:[0-9]|1[0-5])", file.name), "native certificate chain limit")
                containment.regular(Path(file.path), 64 * 1024)
    leaf = containment.read_bounded(Path(str(prefix) + "0"), 64 * 1024)
    require(hashlib.sha256(leaf).hexdigest() == signing["certificateSha256"], "native leaf certificate mismatch")


def code_inventory(app, inventory, runner):
    selected = {"ORCA.app"}
    for name, record in inventory.items():
        path = app.joinpath(*name.split("/")[1:])
        if record["kind"] == "directory" and name.endswith((".app", ".framework", ".xpc", ".appex", ".bundle")):
            selected.add(name)
        elif record["kind"] == "file":
            with path.open("rb") as stream:
                magic = stream.read(4)
            if magic in MACHO:
                archs, _ = runner.run("/usr/bin/lipo", ["-archs", str(path)])
                require(archs.strip() == b"arm64", "native executable architecture mismatch")
                selected.add(name)
            else:
                require(not name.endswith((".node", ".dylib")), "native code magic mismatch")
    require("ORCA.app/Contents/MacOS/ORCA" in selected, "native main executable missing")
    return selected


def verify_app_image(app, manifest, policy, scratch, runner, saved_root=False):
    """The same whole-image acceptance for container copies and fixed-path saved pairs."""
    inventory = containment.inventory_tree(app, saved_root=saved_root)
    require(code_inventory(app, inventory, runner) == set(policy["code"]), "native code policy coverage mismatch")
    delivery.validate_app(app, manifest)
    app_plist = plistlib.loads(containment.read_bounded(app / "Contents/Info.plist", MAX_METADATA))
    require(app_plist.get("CFBundleExecutable") == "ORCA", "native plist executable mismatch")
    package = containment.read_asar_package(app)
    require(isinstance(package, dict) and package.get("version") == manifest["identity"]["appVersion"],
            "native packaged app version mismatch")
    electron_plist = plistlib.loads(containment.read_bounded(
        app / "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist", MAX_METADATA))
    require(isinstance(electron_plist, dict) and electron_plist.get("CFBundleVersion") == manifest["identity"]["toolchain"]["electron"],
            "native packaged Electron version mismatch")
    for path, record in sorted(policy["code"].items()):
        verify_signature(app.joinpath(*path.split("/")[1:]), record, policy["signing"], scratch, runner)
    runner.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", str(app)])
    runner.run("/usr/bin/xcrun", ["stapler", "validate", str(app)])
    runner.run("/usr/bin/syspolicy_check", ["distribution", str(app)])
    require(containment.inventory_tree(app, saved_root=saved_root) == inventory, "native validation changed app bytes")
    return {"identityBase64": base64.b64encode(containment.read_bounded(
                app / "Contents/Resources/orca-build.json", MAX_METADATA)).decode("ascii"),
            "daemonSha256": delivery.file_digest(app / "Contents/Resources/daemon/orca-daemon.mjs")[0]}


def verify_candidate(directory, policy, parent, runner=None):
    require(sys.platform == "darwin" and platform.machine() == "arm64", "native arm64 macOS executor required")
    root, manifest = pin_manifest(directory, policy)
    runner = runner or NativeRunner(parent)
    out, _ = runner.run("/usr/bin/sw_vers", ["-productVersion"])
    require(re.fullmatch(rb"[0-9]+(?:\.[0-9]+)*\n?", out) is not None and int(out.split(b".")[0]) >= 14,
            "macOS 14+ validation tooling required; supported OS policy is separate")
    artifacts = {record["format"]: root / record["path"] for record in manifest["artifacts"]}
    with containment.contained_apps(artifacts["dmg"], artifacts["zip"], manifest, parent, runner) as (dmg_app, zip_app, scratch, inventory):
        verify_signature(artifacts["dmg"], None, policy["signing"], scratch, runner, dmg=True)
        runner.run("/usr/bin/xcrun", ["stapler", "validate", str(artifacts["dmg"])])
        runner.run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", str(artifacts["dmg"])])
        copies = [{"format": format, **verify_app_image(app, manifest, policy, scratch, runner)}
                  for format, app in (("dmg", dmg_app), ("zip", zip_app))]
        require(all(containment.inventory_tree(app) == inventory for app in (dmg_app, zip_app)),
                "native validation changed container copies")
        # Rehash final containers and pinned metadata after extraction and verification.
        pin_manifest(root, policy)
    return {"kind": "candidate", "buildId": manifest["identity"]["buildId"],
            "sourceCommit": manifest["identity"]["sourceCommit"], "identitySha256": manifest["identitySha256"],
            "manifestSha256": policy["manifestSha256"], "copies": copies}


def candidate_main(directory, policy_path, parent):
    try:
        policy = delivery.parse_json(containment.read_bounded(policy_path, MAX_METADATA), "trusted policy")
        result = verify_candidate(directory, policy, parent)
    except Exception:
        # Native output/errors may contain private paths; only closed outcome reaches logs.
        print("FAIL (native candidate): policy, containment or native verification refused; no acceptance.", file=sys.stderr)
        return 1
    print("PASS (native candidate source/signature/container checks): " + result["buildId"] + "; " + result["sourceCommit"]
          + ". Packaged execution, delivery access and physical acceptance remain not run.")
    return 0
