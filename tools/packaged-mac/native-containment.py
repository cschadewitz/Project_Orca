#!/usr/bin/env python3
"""Bounded native extraction into private scratch; no installation or app execution.

Inputs and scratch must be trusted, static and exclusively owned by the executor.
This adapter does not provide a hostile-concurrent-writer filesystem sandbox.
"""

from contextlib import contextmanager
import hashlib
import importlib.util
import os
from pathlib import Path
import plistlib
import shutil
import stat
import struct
import sys
import tempfile


spec = importlib.util.spec_from_file_location("orca_zip_containment", Path(__file__).with_name("archive-containment.py"))
archive = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = archive
spec.loader.exec_module(archive)
require = archive.require
Limits = archive.Limits
APP = archive.APP


def regular(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit, "native regular file/byte limit")
    return info


def read_bounded(path, limit):
    regular(path, limit)
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, "native metadata byte limit")
    return data


def read_asar_package(app):
    """Read only bounded packed package.json using the locked ASAR pickle layout."""
    path = app / "Contents/Resources/app.asar"
    info = regular(path, Limits().member_bytes)
    with path.open("rb") as stream:
        prefix = stream.read(16)
        require(len(prefix) == 16, "ASAR truncated header")
        size_payload, header_size, header_payload, json_size = struct.unpack("<4I", prefix)
        require(size_payload == 4 and header_payload == header_size - 4
                and 8 <= header_size <= 16 * 1024**2 and 0 < json_size <= header_size - 8
                and header_size - 8 - json_size <= 3 and 8 + header_size <= info.st_size, "ASAR header limit/layout")
        header = archive.delivery.parse_json(stream.read(json_size), "ASAR header")
        padding = stream.read(header_size - 8 - json_size)
        require(not any(padding), "ASAR header padding")
        require(isinstance(header, dict) and isinstance(header.get("files"), dict), "ASAR header files object required")
        record = header["files"].get("package.json", {})
        require(isinstance(record, dict) and "link" not in record and not record.get("unpacked")
                and type(record.get("size")) is int and 0 < record["size"] <= Limits().metadata_bytes,
                "ASAR packed package required/limit")
        offset = record.get("offset")
        require(isinstance(offset, str) and offset.isascii() and offset.isdecimal() and len(offset) <= 16,
                "ASAR package offset")
        position = 8 + header_size + int(offset)
        require(position + record["size"] <= info.st_size, "ASAR package boundary")
        stream.seek(position)
        data = stream.read(record["size"])
        require(len(data) == record["size"], "ASAR package truncated")
    return archive.delivery.parse_json(data, "ASAR package.json")


def inventory_tree(root, limits=Limits()):
    """Lstat every node, bound hashes, and resolve links without following them."""
    require(root.name == APP and stat.S_ISDIR(root.lstat().st_mode), "native app root")
    nodes, records, targets, spellings = {}, {}, {}, {}
    pending, total, link_count = [(root, APP)], 0, 0
    while pending:
        path, name = pending.pop()
        archive.delivery.relative_path(name)
        require(len(name.encode("utf-8")) <= limits.path_bytes and len(name.split("/")) <= limits.path_depth,
                "native path byte/depth limit")
        folded = archive.canonical(name)
        require(folded not in spellings, "native case/normalization collision")
        spellings[folded] = name
        info = path.lstat()
        require(info.st_mode & 0o7000 == 0, "native special permission bits unsupported")
        require(len(records) < limits.nodes, "native node limit")
        if stat.S_ISDIR(info.st_mode):
            kind, record = "directory", {"kind": "directory"}
            # Do not let a wide directory allocate an unbounded scandir list.
            with os.scandir(path) as children:
                for child in children:
                    require(len(pending) + len(records) < limits.nodes, "native node limit")
                    pending.append((Path(child.path), name + "/" + child.name))
        elif stat.S_ISREG(info.st_mode):
            require(info.st_nlink == 1, "native hardlink unsupported")
            require(info.st_size <= limits.member_bytes, "native member byte limit")
            digest, size = hashlib.sha256(), 0
            with path.open("rb") as stream:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    total += len(chunk)
                    require(size <= limits.member_bytes and total <= limits.total_bytes, "native total byte limit")
                    digest.update(chunk)
            require(size == info.st_size, "native file changed during read")
            kind = "file"
            record = {"kind": kind, "sha256": digest.hexdigest(), "bytes": size, "mode": info.st_mode & 0o777}
        elif stat.S_ISLNK(info.st_mode):
            link_count += 1
            require(link_count <= limits.symlinks and info.st_size <= limits.link_bytes, "native symlink limit")
            target = os.readlink(path)
            archive.delivery.string(target, "native symlink target")
            require(not any(c in target for c in "\\:") and not target.startswith("/") and all(target.split("/")),
                    "native unsafe symlink target")
            kind, record = "link", {"kind": "link", "target": target}
            targets[name] = target
        else:
            require(False, "native special node unsupported")
        nodes[name], records[name] = kind, record
    for name in targets:
        archive.resolve_link(name, targets, nodes, limits)
    return records


def inspect_candidate_zip(path, manifest, limits=Limits()):
    regular(path, limits.archive_bytes)
    # Candidate extraction requires explicit Unix permissions, never guessed defaults.
    import zipfile
    with path.open("rb") as stream:
        result = archive.inspect_zip(stream, path.stat().st_size, manifest, limits, inventory=True)["inventory"]
        with zipfile.ZipFile(stream) as entries:
            for info in entries.infolist():
                require(info.create_system == 3 and (info.external_attr >> 16) & 0o7000 == 0,
                        "candidate ZIP Unix permissions required/special permission bits")
        return result


def check_dmg_layout(mount, limits):
    """Only builder's bounded presentation files and the one app are admitted."""
    allowed = {APP, "Applications", ".background", ".VolumeIcon.icns", ".DS_Store"}
    with os.scandir(mount) as entries:
        names = set()
        for entry in entries:
            require(entry.name in allowed and entry.name not in names, "unexpected DMG root member")
            names.add(entry.name)
            path, mode = Path(entry.path), entry.stat(follow_symlinks=False).st_mode
            if entry.name == APP:
                require(stat.S_ISDIR(mode), "DMG app must be a real directory")
            elif entry.name == "Applications":
                require(stat.S_ISLNK(mode) and os.readlink(path) == "/Applications", "DMG Applications alias")
            elif entry.name == ".background":
                require(stat.S_ISDIR(mode), "DMG background must be a real directory")
                with os.scandir(path) as backgrounds:
                    for count, background in enumerate(backgrounds):
                        require(count < 8, "DMG background count limit")
                        regular(Path(background.path), limits.metadata_bytes)
            else:
                regular(path, limits.metadata_bytes)
    require(APP in names, "DMG missing app")


def check_image_info(data, limits):
    archive.bound_binary_plist(data)
    info = plistlib.loads(data)
    # Total Bytes can describe compressed backing storage; bound expanded image size.
    sizes = info.get("Size Information") if isinstance(info, dict) else None
    size = sizes.get("Uncompressed Bytes") if isinstance(sizes, dict) else None
    require(type(size) is int and 0 < size <= limits.total_bytes, "DMG logical size unavailable/limit")


@contextmanager
def contained_apps(dmg, zip_path, manifest, parent, runner, limits=Limits()):
    """A detach failure retains scratch and refuses success; never force-unmount."""
    parent = Path(parent)
    info = parent.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "private scratch parent required")
    expected_zip = inspect_candidate_zip(zip_path, manifest, limits)
    regular(dmg, limits.archive_bytes)
    check_image_info(runner.run("/usr/bin/hdiutil", ["imageinfo", "-plist", str(dmg)])[0], limits)
    scratch = Path(tempfile.mkdtemp(prefix="orca-contained-", dir=parent))
    mount = scratch / "mount"
    mount.mkdir()
    attachment_possible = False
    detached = True
    detach_attempted = False
    try:
        # Set uncertainty before invoking: a timeout can still have attached an image.
        attachment_possible, detached = True, False
        out, _ = runner.run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen",
                                                "-mountpoint", str(mount), "-plist", str(dmg)])
        archive.bound_binary_plist(out)
        attachment = plistlib.loads(out)
        require(isinstance(attachment, dict), "DMG attachment metadata unavailable")
        entities = attachment.get("system-entities")
        require(isinstance(entities, list) and len(entities) <= 16 and all(isinstance(entity, dict) for entity in entities),
                "DMG attachment entity limit/shape")
        mounted = [entity.get("mount-point") for entity in entities if "mount-point" in entity]
        require(mounted == [str(mount)], "DMG mount topology mismatch")
        check_dmg_layout(mount, limits)
        mounted_inventory = inventory_tree(mount / APP, limits)
        for kind in ("dmg", "zip"):
            (scratch / kind).mkdir()
        runner.run("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", str(mount / APP), str(scratch / "dmg" / APP)])
        require(inventory_tree(scratch / "dmg" / APP, limits) == mounted_inventory, "DMG copy equivalence mismatch")
        detach_attempted = True
        runner.run("/usr/bin/hdiutil", ["detach", str(mount)], cleanup=True)
        require(not os.path.ismount(mount), "DMG detach remains unconfirmed")
        detached = True
        # ZIP was fully indexed/hashed/link-checked before handing it to native ditto.
        runner.run("/usr/bin/ditto", ["-x", "-k", "--rsrc", "--extattr", "--acl", str(zip_path), str(scratch / "zip")])
        zip_inventory = inventory_tree(scratch / "zip" / APP, limits)
        require(zip_inventory == expected_zip, "ZIP extraction equivalence mismatch")
        require(zip_inventory == mounted_inventory, "DMG/ZIP app equivalence mismatch")
        yield scratch / "dmg" / APP, scratch / "zip" / APP, scratch, zip_inventory
    finally:
        if attachment_possible and not detached:
            # Mountpoint is our exact fresh directory, never a device discovered elsewhere.
            if not detach_attempted:
                runner.run("/usr/bin/hdiutil", ["detach", str(mount)], cleanup=True)
                require(not os.path.ismount(mount), "DMG detach remains unconfirmed")
                detached = True
        if detached:
            shutil.rmtree(scratch)
