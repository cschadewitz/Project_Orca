#!/usr/bin/env python3
"""Closed JSON interface to the existing native verifier. No catalog or trust defaults."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile

spec = importlib.util.spec_from_file_location("orca_runtime_candidate", Path(__file__).with_name("native-mac-candidate.py"))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
delivery, containment, require = candidate.delivery, candidate.containment, candidate.require


def inspect_image(path, manifest_bytes, policy, parent, runner=None):
    require(sys.platform == "darwin" and platform.machine() == "arm64", "native executor required")
    candidate.validate_policy(policy)
    require(hashlib.sha256(manifest_bytes).hexdigest() == policy["manifestSha256"], "trusted manifest mismatch")
    manifest = delivery.parse_json(manifest_bytes, "trusted manifest")
    require(manifest.get("kind") == "candidate", "candidate identity required")
    for field in ("identity", "identitySha256", "minimumMacOS", "notarization"):
        require(manifest.get(field) == policy[field], "trusted image policy mismatch")
    for field, value in policy["signing"].items():
        require(manifest.get("signing", {}).get(field) == value, "trusted signing mismatch")
    app = Path(path)
    require(app.is_absolute() and app.resolve(strict=True) == app and not app.is_symlink(), "fixed image path required")
    with tempfile.TemporaryDirectory(prefix="orca-image-", dir=parent) as temporary:
        scratch = Path(temporary)
        proof = candidate.verify_app_image(app, manifest, policy, scratch,
                                          runner or candidate.NativeRunner(scratch), saved_root=True)
    return {"outcome": "verified", "manifestSha256": policy["manifestSha256"], **proof}


def main():
    try:
        data = sys.stdin.buffer.read(2 * 1024**2 + 1)
        require(len(data) <= 2 * 1024**2, "request limit")
        request = delivery.parse_json(data, "request")
        delivery.object_fields(request, "operation path manifestBase64 policy scratchParent", "request")
        parent = Path(request["scratchParent"])
        info = parent.lstat()
        require(parent.is_absolute() and parent.resolve(strict=True) == parent and stat.S_ISDIR(info.st_mode)
                and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "private scratch required")
        if request["operation"] == "candidate":
            result = candidate.verify_candidate(request["path"], request["policy"], parent)
            result = {"outcome": "verified", "manifestSha256": result["manifestSha256"], "copies": result["copies"]}
        else:
            require(request["operation"] == "image", "operation unsupported")
            manifest = base64.b64decode(request["manifestBase64"], validate=True)
            require(len(manifest) <= 64 * 1024, "manifest limit")
            result = inspect_image(request["path"], manifest, request["policy"], parent)
    except Exception:
        result = {"outcome": "refused"}
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
