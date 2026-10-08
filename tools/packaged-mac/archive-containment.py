#!/usr/bin/env python3
"""Bounded, read-only delivery-v1 fixture ZIP containment; no native acceptance."""

import argparse
from dataclasses import dataclass
import hashlib
import importlib.util
from pathlib import Path
import plistlib
import stat
import struct
import sys
import unicodedata
from xml.parsers.expat import ExpatError
import zipfile
import zlib


# Reuse the single delivery-v1 parser/identity contract, without changing its CLI
# or invoking its separate-tree validator (which cannot establish containment).
_spec = importlib.util.spec_from_file_location(
    "orca_delivery_v1", Path(__file__).resolve().parents[1] / "deploy/native-mac-verify.py")
delivery = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(delivery)
require = delivery.require
InvalidArchive = delivery.InvalidFixture
APP = "ORCA.app"
IDENTITY = APP + "/Contents/Resources/orca-build.json"
PLIST = APP + "/Contents/Info.plist"
UNRUN = "Signatures, notarization, tickets, Gatekeeper, TCC, arm64 execution and DMG containment remain unrun."


@dataclass(frozen=True)
class Limits:
    """Fixed CLI ceilings; injectable smaller limits for synthetic boundary tests."""

    archive_bytes: int = 2 * 1024**3
    central_bytes: int = 16 * 1024**2
    members: int = 50000
    member_bytes: int = 512 * 1024**2
    total_bytes: int = 4 * 1024**3
    ratio: int = 1000
    metadata_bytes: int = 1024**2
    path_bytes: int = 4096
    path_depth: int = 64
    nodes: int = 100000
    symlinks: int = 2048
    link_bytes: int = 4096
    link_hops: int = 40


def expectations(manifest, build_id, source_commit):
    """Validate existing v1 shape; declarations are not native verification."""
    require(isinstance(manifest, dict), "manifest: expected object")
    require(manifest.get("kind") != "candidate", delivery.FIXTURE_ONLY)
    require(manifest.get("kind") == "fixture", "manifest.kind: expected fixture")
    delivery.schema(manifest.get("schemaVersion"), "manifest")
    delivery.object_fields(manifest, "schemaVersion kind identity identitySha256 artifacts minimumMacOS "
                           "signing notarization stapling evidence", "manifest")
    delivery.validate_identity(manifest["identity"])
    delivery.matching(manifest["identitySha256"], delivery.SHA256, "identitySha256")
    delivery.matching(manifest["minimumMacOS"], r"[0-9]+(?:\.[0-9]+)*", "minimumMacOS")
    identity = manifest["identity"]
    require(identity["buildId"] == build_id, "selected buildId mismatch")
    require(identity["sourceCommit"] == source_commit, "selected sourceCommit mismatch")
    references = delivery.validate_declarations(manifest)
    artifacts, evidence = manifest["artifacts"], manifest["evidence"]
    require(isinstance(artifacts, list) and len(artifacts) == 2,
            "artifacts: require exactly one DMG and one ZIP")
    require(isinstance(evidence, list), "evidence: expected array")
    names, formats, evidence_names = {delivery.MANIFEST, "SHA256SUMS"}, set(), set()
    selected = None
    for records, artifact in ((artifacts, True), (evidence, False)):
        for record in records:
            delivery.object_fields(record, "format path sha256 bytes" if artifact else "path sha256 bytes", "file record")
            name = delivery.relative_path(record["path"])
            require(name not in names, f"duplicate file path: {name}")
            names.add(name)
            delivery.matching(record["sha256"], delivery.SHA256, name + ".sha256")
            delivery.integer(record["bytes"], 1, name + ".bytes")
            if artifact:
                fmt = record["format"]
                require(isinstance(fmt, str) and fmt in ("dmg", "zip") and fmt not in formats,
                        "artifacts: require exactly one DMG and one ZIP")
                formats.add(fmt)
                require(name == f"ORCA-{identity['releaseVersion']}-mac-arm64.{fmt}",
                        f"artifact filename/version mismatch: {name}")
                if fmt == "zip":
                    selected = record
            else:
                require(name.startswith("evidence/"), "evidence path must be under evidence/")
                evidence_names.add(name)
    require(set(references) <= evidence_names, "evidence: referenced report is not listed")
    return selected


def preflight(stream, size, limits):
    """Bound the central directory before ZipFile allocates/parses it."""
    require(22 <= size <= limits.archive_bytes, "archive byte limit or truncated ZIP")
    stream.seek(max(0, size - 65557))
    tail = stream.read(65557)
    pos = tail.rfind(b"PK\x05\x06")
    require(pos >= 0 and pos + 22 <= len(tail), "missing/truncated ZIP end record")
    _, disk, cd_disk, disk_count, count, cd_size, offset, comment = struct.unpack_from("<4s4H2IH", tail, pos)
    require(pos + 22 + comment == len(tail), "trailing or truncated ZIP bytes")
    require(disk == cd_disk == 0 and disk_count == count, "split ZIP is unsupported")
    require(count != 65535 and cd_size != 0xffffffff and offset != 0xffffffff,
            "ZIP64 is outside bounded ZIP subset")
    require(0 < count <= limits.members, "ZIP member count limit")
    require(cd_size <= limits.central_bytes, "ZIP central directory byte limit")
    require(offset + cd_size == size - len(tail) + pos, "ZIP central directory boundary mismatch")
    stream.seek(0)
    return count, offset


def canonical(name):
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", name).casefold())


def check_extra(data, info):
    """Reject competing Unicode path names in either local or central metadata."""
    while data:
        require(len(data) >= 4, "truncated ZIP extra field")
        tag, size = struct.unpack_from("<HH", data)
        require(size <= len(data) - 4, "truncated ZIP extra payload")
        payload, data = data[4:4 + size], data[4 + size:]
        require(tag != 1, "ZIP64 is outside bounded ZIP subset")
        if tag == 0x7075:  # Info-ZIP Unicode Path extra field.
            encoded = info.orig_filename.encode("utf-8" if info.flag_bits & 0x800 else "cp437")
            require(len(payload) >= 5 and payload[0] == 1
                    and struct.unpack_from("<I", payload, 1)[0] == zlib.crc32(encoded)
                    and payload[5:].decode("utf-8") == info.orig_filename,
                    "ambiguous Unicode path extra field")


def check_local_headers(stream, entries, central_offset):
    """Bind local names/flags/methods and ranges to the bounded central index."""
    ranges = []
    for info in entries.values():
        require(0 <= info.header_offset < central_offset, "invalid local header offset")
        stream.seek(info.header_offset)
        header = stream.read(30)
        require(len(header) == 30 and header[:4] == b"PK\x03\x04", "invalid/truncated local header")
        flags, method = struct.unpack_from("<HH", header, 6)
        crc, compressed, uncompressed, name_size, extra_size = struct.unpack_from("<IIIHH", header, 14)
        end = info.header_offset + 30 + name_size + extra_size + info.compress_size
        require(end <= central_offset, "overlapping ZIP member data")
        require(flags == info.flag_bits and method == info.compress_type, "local/central flags or method mismatch")
        encoded = info.orig_filename.encode("utf-8" if flags & 0x800 else "cp437")
        require(name_size == len(encoded) and stream.read(name_size) == encoded, "local/central member names differ")
        check_extra(stream.read(extra_size), info)
        if not flags & 8:  # Streaming writers use a post-payload data descriptor.
            require((crc, compressed, uncompressed) == (info.CRC, info.compress_size, info.file_size),
                    "local/central CRC or size mismatch")
        else:
            stream.seek(end)
            first = stream.read(4)
            descriptor = stream.read(12) if first == b"PK\x07\x08" else first + stream.read(8)
            end += 16 if first == b"PK\x07\x08" else 12
            require(len(descriptor) == 12 and end <= central_offset
                    and struct.unpack("<III", descriptor) == (info.CRC, info.compress_size, info.file_size),
                    "invalid ZIP data descriptor")
        ranges.append((info.header_offset, end))
    ranges.sort()
    require(all(a[1] <= b[0] for a, b in zip(ranges, ranges[1:])), "overlapping ZIP member ranges")


def index_members(archive, limits):
    entries, nodes, spellings = {}, {}, {}
    total, links = 0, 0
    for info in archive.infolist():
        raw = info.orig_filename
        check_extra(info.extra, info)
        require(raw == info.filename and "\x00" not in raw, "NUL/truncated member name")
        require(len(raw.encode("utf-8")) <= limits.path_bytes, "member path byte limit")
        name = raw[:-1] if raw.endswith("/") else raw
        delivery.relative_path(name)
        require(len(name.split("/")) <= limits.path_depth, "member path depth limit")
        require(name.split("/")[0] in (APP, "__MACOSX"), "wrong app root: expected root ORCA.app")
        require(name not in entries, f"duplicate member: {name}")
        require(not info.flag_bits & (1 | 64), "encrypted ZIP is unsupported")
        require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                "unsupported ZIP compression")
        mode = stat.S_IFMT(info.external_attr >> 16) if info.create_system == 3 else 0
        kind = "directory" if info.is_dir() else "file"
        if mode == stat.S_IFLNK:
            require(not info.is_dir() and name.startswith(APP + "/"), "invalid symlink member")
            kind = "link"
        else:
            require(mode in (0, stat.S_IFREG, stat.S_IFDIR), "unsupported member type")
            require(mode != stat.S_IFDIR or info.is_dir(), "directory mode/name mismatch")
            require(mode != stat.S_IFREG or not info.is_dir(), "file mode/name mismatch")
        require(info.file_size <= limits.member_bytes, "member decompression byte limit")
        require(info.file_size <= max(1, info.compress_size) * limits.ratio, "member compression ratio limit")
        total += info.file_size
        require(total <= limits.total_bytes, "total decompression byte limit")
        if kind == "directory":
            require(info.file_size == 0, "directory has payload")
        if kind == "link":
            links += 1
            require(links <= limits.symlinks, "symlink count limit")
            require(info.file_size <= limits.link_bytes, "symlink byte limit")
        if name in (IDENTITY, PLIST):
            require(info.file_size <= limits.metadata_bytes, "metadata byte limit")
        entries[name] = info
        parts = name.split("/")
        for i in range(1, len(parts) + 1):
            prefix = "/".join(parts[:i])
            folded = canonical(prefix)
            require(folded not in spellings or spellings[folded] == prefix,
                    f"case/normalization ambiguity: {prefix}")
            spellings[folded] = prefix
            intended = kind if i == len(parts) else "directory"
            require(prefix not in nodes or nodes[prefix] == intended,
                    f"file/link ancestor or directory collision: {prefix}")
            nodes[prefix] = intended
            require(len(nodes) <= limits.nodes, "implicit directory/node limit")
    require(nodes.get(APP) == "directory", "missing root ORCA.app directory")
    return entries, nodes


def resolve_link(name, targets, nodes, limits):
    """Resolve relative links component by component, including linked ancestors."""
    pending, stack, hops = name.split("/"), [], 0
    while pending:
        require(len(stack) + len(pending) <= limits.path_depth, "resolved symlink path depth limit")
        part = pending.pop(0)
        if part == ".":
            continue
        if part == "..":
            require(len(stack) > 1, f"symlink escapes app: {name}")
            stack.pop()
            continue
        current = "/".join(stack + [part])
        require(current in nodes, f"dangling symlink target: {name}")
        if nodes[current] == "link":
            hops += 1
            require(hops <= limits.link_hops, f"symlink cycle/hop limit: {name}")
            pending = targets[current].split("/") + pending
        else:
            require(not pending or nodes[current] == "directory", f"non-directory symlink ancestor: {name}")
            stack.append(part)
    resolved = "/".join(stack)
    require(resolved == APP or resolved.startswith(APP + "/"), f"symlink escapes app: {name}")
    return resolved


def bound_binary_plist(data):
    """Prevent binary object tables/overlapping objects amplifying a small input."""
    if not data.startswith(b"bplist00"):
        return
    require(len(data) >= 40, "truncated binary plist")
    offset_size, ref_size, count, top, table = struct.unpack(">6xBBQQQ", data[-32:])
    require(offset_size in (1, 2, 4, 8) and ref_size in (1, 2, 4, 8)
            and 0 < count <= len(data) and top < count and 8 <= table <= len(data) - 32
            and count * offset_size <= len(data) - 32 - table, "invalid binary plist object table")
    offsets = sorted(int.from_bytes(data[table + i * offset_size:table + (i + 1) * offset_size], "big")
                     for i in range(count))
    require(len(set(offsets)) == count and offsets[0] >= 8 and offsets[-1] < table,
            "overlapping binary plist objects")
    for start, end in zip(offsets, offsets[1:] + [table]):
        token, cursor = data[start], start + 1
        high, low = token & 0xf0, token & 0x0f
        if high in (0x40, 0x50, 0x60, 0xa0, 0xd0):
            length = low
            if low == 15:
                require(cursor < end and 0x10 <= data[cursor] <= 0x13, "invalid binary plist length")
                width = 1 << (data[cursor] & 3)
                cursor += 1
                require(cursor + width <= end, "truncated binary plist length")
                length = int.from_bytes(data[cursor:cursor + width], "big")
                cursor += width
            width = {0x40: 1, 0x50: 1, 0x60: 2, 0xa0: ref_size, 0xd0: 2 * ref_size}[high]
            payload = length * width
        elif high == 0x10:
            payload = 1 << low
        elif high == 0x80:
            payload = 1 + low
        else:
            require(token in (0, 8, 9, 15, 0x22, 0x23, 0x33), "unsupported binary plist object")
            payload = {0x22: 4, 0x23: 8, 0x33: 8}.get(token, 0)
        require(cursor + payload <= end, "overlapping/truncated binary plist object payload")


def inspect_zip(stream, size, manifest, limits):
    count, offset = preflight(stream, size, limits)
    with zipfile.ZipFile(stream) as archive:
        require(len(archive.infolist()) == count and archive.start_dir == offset,
                "ZIP member count or prepended data mismatch")
        entries, nodes = index_members(archive, limits)
        check_local_headers(stream, entries, offset)
        daemon = APP + "/Contents/Resources/" + manifest["identity"]["daemon"]["path"]
        for name in (IDENTITY, PLIST, daemon):
            require(name in entries and nodes[name] == "file", f"missing/nonregular required member: {name}")
        targets, metadata, digests = {}, {}, {}
        actual_total = 0
        for name, info in entries.items():
            digest, chunks, actual = hashlib.sha256(), [], 0
            capture = name in (IDENTITY, PLIST) or nodes[name] == "link"
            with archive.open(info) as member:
                while True:
                    chunk = member.read(64 * 1024)
                    if not chunk:
                        break
                    actual += len(chunk)
                    actual_total += len(chunk)
                    require(actual <= min(info.file_size, limits.member_bytes)
                            and actual_total <= limits.total_bytes, "actual decompression byte limit")
                    digest.update(chunk)
                    if capture:
                        chunks.append(chunk)
            require(actual == info.file_size, f"member size mismatch: {name}")
            digests[name] = digest.hexdigest()
            if capture:
                data = b"".join(chunks)
                if nodes[name] == "link":
                    target = data.decode("utf-8")
                    delivery.string(target, "symlink target")
                    require(not any(c in target for c in "\\:") and not target.startswith("/")
                            and all(target.split("/")), f"unsafe symlink target: {name}")
                    targets[name] = target
                else:
                    metadata[name] = data
        for name in targets:
            resolve_link(name, targets, nodes, limits)
        # Critical resources must be actual members, with real directory ancestors;
        # framework aliases are permitted, but cannot substitute these resources.
        require(digests[IDENTITY] == manifest["identitySha256"], "identitySha256: byte digest mismatch")
        sealed = delivery.parse_json(metadata[IDENTITY], "archived identity")
        delivery.validate_identity(sealed)
        require(sealed == manifest["identity"], "archived identity: manifest identity mismatch")
        require(digests[daemon] == sealed["daemon"]["sha256"], "archived daemon: digest mismatch")
        bound_binary_plist(metadata[PLIST])
        try:
            plist = plistlib.loads(metadata[PLIST])
        except (ValueError, plistlib.InvalidFileException, ExpatError) as exc:
            raise InvalidArchive("archived Info.plist: invalid plist") from exc
        require(isinstance(plist, dict), "archived Info.plist: expected dictionary")
        for key, expected in (("CFBundleIdentifier", sealed["bundleId"]),
                              ("CFBundleShortVersionString", sealed["bundleShortVersion"]),
                              ("CFBundleVersion", sealed["bundleVersion"]),
                              ("LSMinimumSystemVersion", manifest["minimumMacOS"])):
            require(type(plist.get(key)) is str and plist[key] == expected,
                    f"archived Info.plist.{key}: verbatim mismatch")
    return {"appRoot": APP, "members": count, "uncompressedBytes": actual_total}


def validate_archive(directory, build_id, source_commit, limits=Limits()):
    """Observe static caller-owned fixture inputs; no extraction or subprocesses."""
    root = Path(directory).resolve(strict=True)
    require(root.is_dir(), "fixture directory: expected directory")
    manifest_path = delivery.safe_file(root, delivery.MANIFEST)
    with manifest_path.open("rb") as stream:
        data = stream.read(limits.metadata_bytes + 1)
    require(len(data) <= limits.metadata_bytes, "manifest byte limit")
    manifest = delivery.parse_json(data, delivery.MANIFEST)
    selected = expectations(manifest, build_id, source_commit)
    path = delivery.safe_file(root, selected["path"])
    # Hash and inspect the same open file. Inputs must remain private and static;
    # this does not defend against a concurrent writer mutating an open inode.
    with path.open("rb") as stream:
        size = stream.seek(0, 2)
        require(size == selected["bytes"], "archive file size mismatch")
        require(size <= limits.archive_bytes, "archive byte limit")
        stream.seek(0)
        digest, read_bytes = hashlib.sha256(), 0
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            read_bytes += len(chunk)
            require(read_bytes <= limits.archive_bytes, "archive byte limit")
            digest.update(chunk)
        require(read_bytes == size, "archive changed size during read")
        require(digest.hexdigest() == selected["sha256"], "archive file digest mismatch")
        result = inspect_zip(stream, size, manifest, limits)
    return {**result, "kind": "fixture", "buildId": build_id, "sourceCommit": source_commit,
            "archiveSha256": selected["sha256"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--mode", required=True, choices=("fixture", "candidate"))
    parser.add_argument("--build-id", help="explicit expected delivery-v1 buildId")
    parser.add_argument("--source-commit", help="explicit expected full sourceCommit")
    parser.add_argument("directory", nargs="?", type=Path)
    args = parser.parse_args(argv)
    if args.mode == "candidate":
        parser.error(delivery.FIXTURE_ONLY)
    if args.directory is None or args.build_id is None or args.source_commit is None:
        parser.error("fixture mode requires directory, --build-id and --source-commit")
    try:
        result = validate_archive(args.directory, args.build_id, args.source_commit)
    except (InvalidArchive, OSError, RuntimeError, RecursionError, UnicodeError,
            zipfile.BadZipFile, NotImplementedError, EOFError, zlib.error) as exc:
        print(f"FAIL (fixture ZIP containment only): {exc}", file=sys.stderr)
        return 1
    print(f"PASS (fixture ZIP containment only): {result['appRoot']}; "
          f"buildId={result['buildId']}; sourceCommit={result['sourceCommit']}; "
          f"archiveSha256={result['archiveSha256']}; members={result['members']}; "
          f"uncompressedBytes={result['uncompressedBytes']}. {UNRUN}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
