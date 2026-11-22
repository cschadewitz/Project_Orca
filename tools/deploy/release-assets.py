#!/usr/bin/env python3
"""Flatten downloaded assets without collisions and prove the Windows feeds are complete.

Usage: release-assets.py DIR VERSION [ARCHES]. ARCHES is a space-separated subset of
"x64 arm64" (the default, both); the desktop feed passes only the architectures it serves.
"""
import base64
import hashlib
from pathlib import Path
import sys


ARCHES = ("x64", "arm64")


def parse_arches(text):
    arches = text.split()
    if not arches or len(set(arches)) != len(arches) or any(a not in ARCHES for a in arches):
        raise RuntimeError(f"Invalid architectures: {text!r}")
    return tuple(a for a in ARCHES if a in arches)


def verify(root, version, arches=ARCHES):
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
    for arch in arches:
        check_metadata(root, (root / f"{channel}-{arch}.yml").read_text(), version, arch)


# The exact subset electron-builder 26 writes for an NSIS channel file. Anything else (a new
# key, a second installer, a nested value) fails closed rather than being guessed at.
TOP_KEYS = {"version", "files", "path", "sha512", "releaseDate"}
ENTRY_KEYS = {"url", "sha512", "size", "blockMapSize", "isAdminRightsRequired"}


def scalar(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    if not value or any(c in value for c in "\n#{}[]&*!|>") or value.startswith("- "):
        raise RuntimeError("Unexpected update metadata value")
    return value


def field(line, allowed, target):
    key, sep, value = line.partition(": ")
    if not sep or key not in allowed or key in target:
        raise RuntimeError(f"Unexpected update metadata key: {key}")
    target[key] = scalar(value)


def parse_metadata(text):
    top, files, entry, in_files = {}, None, None, False
    for raw in text.splitlines():
        if not raw.strip():
            continue
        if raw.startswith("  - ") and in_files:
            entry = {}
            files.append(entry)
            field(raw[4:], ENTRY_KEYS, entry)
        elif raw.startswith("    ") and not raw.startswith("     ") and entry is not None:
            field(raw[4:], ENTRY_KEYS, entry)
        elif not raw.startswith(" "):
            entry, in_files = None, False
            if raw == "files:":
                if "files" in top:
                    raise RuntimeError("Unexpected update metadata key: files")
                files = top["files"] = []
                in_files = True
            else:
                field(raw, TOP_KEYS - {"files"}, top)
        else:
            raise RuntimeError("Unexpected update metadata layout")
    return top


def check_metadata(root, text, version, arch):
    """The installer the updater will fetch is files[0]; the legacy path/sha512 must agree."""
    meta = parse_metadata(text)
    if meta.get("version") != version:
        raise RuntimeError(f"Invalid update metadata for {arch}")
    files = meta.get("files")
    if not files or len(files) != 1:
        raise RuntimeError(f"Update metadata for {arch} must name exactly one installer")
    entry = files[0]
    name = entry.get("url", "")
    if Path(name).name != name or name != f"ORCA-{version}-win-{arch}.exe":
        raise RuntimeError("Unexpected installer architecture/path")
    if meta.get("path") != name or meta.get("sha512") != entry.get("sha512"):
        raise RuntimeError(f"Legacy update metadata for {arch} disagrees with files[]")
    for key in ("size", "blockMapSize"):
        if key in entry and not entry[key].isdigit():
            raise RuntimeError(f"Invalid {key} in update metadata for {arch}")
    # ORCA's NSIS installer is per-user. The updater uses this flag to run its elevation
    # helper, so anything but absent/false means the metadata does not describe our build.
    if entry.get("isAdminRightsRequired", "false") != "false":
        raise RuntimeError(f"Per-user installer metadata for {arch} must not require admin rights")
    asset = root / name
    if not asset.is_file():
        raise RuntimeError(f"Missing installer: {name}")
    data = asset.read_bytes()
    digest = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if "size" not in entry or int(entry["size"]) != len(data) or digest != entry["sha512"]:
        raise RuntimeError(f"Incomplete or corrupt installer: {name}")
    if not (root / (name + ".blockmap")).is_file():
        raise RuntimeError(f"Incomplete or corrupt installer: {name}")

if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: release-assets.py DIR VERSION [ARCHES]")
    verify(Path(sys.argv[1]), sys.argv[2], parse_arches(sys.argv[3]) if len(sys.argv) == 4 else ARCHES)
