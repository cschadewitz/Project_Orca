#!/usr/bin/env python3
"""Flatten downloaded assets without collisions and prove both Windows feeds are complete."""
import base64
import hashlib
from pathlib import Path
import re
import sys


def verify(root, version):
    for directory in list(root.iterdir()):
        if directory.is_dir():
            for source in directory.rglob("*"):
                if source.is_file():
                    target = root / source.name
                    if target.exists():
                        raise RuntimeError(f"Release asset collision: {source.name}")
                    source.rename(target)
            import shutil
            shutil.rmtree(directory)
    channel = "prerelease" if "-" in version else "latest"
    for arch in ("x64", "arm64"):
        text = (root / f"{channel}-{arch}.yml").read_text()
        # electron-builder 26 emits path + sha512 in addition to files[]. Fail closed
        # if a builder upgrade changes that format; never guess which payload is signed.
        path = re.search(r"^path: (.+)$", text, re.M)
        checksum = re.search(r"^sha512: (.+)$", text, re.M)
        declared = re.search(r"^version: (.+)$", text, re.M)
        if not path or not checksum or not declared or declared[1].strip("\"'") != version:
            raise RuntimeError(f"Invalid update metadata for {arch}")
        name = path[1].strip("\"'")
        if Path(name).name != name or not name.endswith(f"-win-{arch}.exe"):
            raise RuntimeError("Unexpected installer architecture/path")
        asset = root / name
        digest = base64.b64encode(hashlib.sha512(asset.read_bytes()).digest()).decode()
        if digest != checksum[1].strip("\"'") or not (root / (name + ".blockmap")).is_file():
            raise RuntimeError(f"Incomplete or corrupt installer: {name}")


if __name__ == "__main__":
    verify(Path(sys.argv[1]), sys.argv[2])
