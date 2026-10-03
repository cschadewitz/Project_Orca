#!/usr/bin/env python3
"""Validate synthetic delivery-v1 fixtures only; never verify or execute a candidate."""

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import re
import sys
from xml.parsers.expat import ExpatError


MANIFEST = "native-mac-artifact.json"
SHA256 = r"[0-9a-f]{64}"
SEMVER = (
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
FIXTURE_ONLY = "production-candidate verification is unsupported; this command validates fixtures only"


class InvalidFixture(ValueError):
    """An input violates the fixture subset of the documented delivery contract."""


def require(condition, message):
    if not condition:
        raise InvalidFixture(message)


def object_fields(value, fields, label):
    require(isinstance(value, dict), f"{label}: expected object")
    expected = set(fields.split())
    require(set(value) == expected, f"{label}: expected fields {', '.join(sorted(expected))}")


def string(value, label):
    require(isinstance(value, str) and bool(value.strip()), f"{label}: expected non-empty string")
    require(value == value.strip() and not any(ord(c) < 32 or ord(c) == 127 for c in value),
            f"{label}: whitespace/control characters are not allowed")
    require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value), f"{label}: invalid Unicode scalar")
    return value


def matching(value, pattern, label):
    string(value, label)
    require(re.fullmatch(pattern, value) is not None, f"{label}: invalid value")


def integer(value, minimum, label):
    require(type(value) is int and value >= minimum, f"{label}: expected integer >= {minimum}")


def schema(value, label):
    require(type(value) is int and value == 1, f"{label}: unsupported schemaVersion (expected integer 1)")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def invalid_constant(value):
    raise InvalidFixture(f"invalid JSON constant: {value}")


def parse_json(data, label):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=invalid_constant)
    except InvalidFixture:
        raise
    except ValueError as exc:
        raise InvalidFixture(f"{label}: invalid UTF-8 JSON") from exc


def relative_path(value):
    string(value, "path")
    require(not any(c in value for c in "\\:"), f"unsafe path: {value}")
    require(all(part not in ("", ".", "..") for part in value.split("/")), f"unsafe path: {value}")
    return value


def safe_file(root, name):
    """Resolve every component before reading; internal links may not alias listed paths.

    Roots are caller-selected, private static fixture directories. This is not a
    race-resistant reader for a tree another process can mutate concurrently.
    """
    relative_path(name)
    path = (root / name).resolve(strict=True)
    require(path != root and root in path.parents, f"path escapes fixture root: {name}")
    require(path.is_file(), f"not a regular file: {name}")
    return path


def file_digest(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def validate_identity(identity):
    object_fields(identity, "schemaVersion releaseVersion bundleId platform arch sourceCommit buildId "
                  "builtAt appVersion bundleShortVersion bundleVersion daemon protocol storeEpoch toolchain", "identity")
    schema(identity["schemaVersion"], "identity")
    matching(identity["releaseVersion"], SEMVER, "identity.releaseVersion")
    require(identity["bundleId"] == "dev.orca.desktop", "identity.bundleId: expected dev.orca.desktop (v1)")
    require(identity["platform"] == "darwin", "identity.platform: expected darwin")
    require(identity["arch"] == "arm64", "identity.arch: expected arm64")
    matching(identity["sourceCommit"], r"[0-9a-f]{40}", "identity.sourceCommit")
    matching(identity["buildId"], r"gha:[0-9]+:[0-9]+:mac-arm64", "identity.buildId")
    matching(identity["builtAt"], r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
             r"(?:\.[0-9]+)?(?:Z|\+00:00)", "identity.builtAt")
    try:
        datetime.fromisoformat(identity["builtAt"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidFixture("identity.builtAt: invalid UTC timestamp") from exc
    require(identity["appVersion"] == identity["releaseVersion"], "identity.appVersion: releaseVersion mismatch")
    # D5 is unresolved: these are opaque strings, never SemVer-derived values.
    for key in ("bundleShortVersion", "bundleVersion", "storeEpoch"):
        string(identity[key], f"identity.{key}")
    daemon = identity["daemon"]
    object_fields(daemon, "path sha256 version", "identity.daemon")
    require(daemon["path"] == "daemon/orca-daemon.mjs", "identity.daemon.path: unexpected resource path")
    matching(daemon["sha256"], SHA256, "identity.daemon.sha256")
    require(daemon["version"] == identity["releaseVersion"], "identity.daemon.version: releaseVersion mismatch")
    object_fields(identity["protocol"], "major minor", "identity.protocol")
    for key in ("major", "minor"):
        integer(identity["protocol"][key], 0, f"identity.protocol.{key}")
    object_fields(identity["toolchain"], "electron electronBuilder node pnpm xcode macos", "identity.toolchain")
    for key, version in identity["toolchain"].items():
        matching(version, r"[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z.-]+)?", f"identity.toolchain.{key}")


def validate_declarations(manifest):
    """Check synthetic signing/notary structure, never the truth of these claims."""
    signing = manifest["signing"]
    object_fields(signing, "teamId certificateSha256 authority hardenedRuntime verification reportPath", "signing")
    string(signing["teamId"], "signing.teamId")
    string(signing["authority"], "signing.authority")
    require(signing["authority"].lower() not in ("adhoc", "ad-hoc", "ad hoc", "-"), "signing: ad-hoc authority")
    matching(signing["certificateSha256"], SHA256, "signing.certificateSha256")
    require(signing["hardenedRuntime"] is True, "signing.hardenedRuntime: expected true")
    require(signing["verification"] == "passed", "signing.verification: expected passed")
    references = [signing["reportPath"]]
    object_fields(manifest["notarization"], "app dmg", "notarization")
    for target, record in manifest["notarization"].items():
        label = f"notarization.{target}"
        object_fields(record, "submissionId submittedSha256 status logPath", label)
        matching(record["submissionId"], r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", label + ".submissionId")
        matching(record["submittedSha256"], SHA256, label + ".submittedSha256")
        require(record["status"] == "Accepted", label + ".status: expected Accepted")
        references.append(record["logPath"])
    object_fields(manifest["stapling"], "appInDmg appInZip dmg", "stapling")
    for target, record in manifest["stapling"].items():
        label = f"stapling.{target}"
        object_fields(record, "status reportPath", label)
        require(record["status"] == "passed", label + ".status: expected passed")
        references.append(record["reportPath"])
    for path in references:
        relative_path(path)
        require(path.startswith("evidence/"), f"report must be under evidence/: {path}")
    return references


def validate_app(app, manifest):
    # This separately supplied synthetic tree is NOT extracted from either stub.
    identity_bytes = safe_file(app, "Contents/Resources/orca-build.json").read_bytes()
    require(hashlib.sha256(identity_bytes).hexdigest() == manifest["identitySha256"], "identitySha256: byte digest mismatch")
    sealed = parse_json(identity_bytes, "fixture app identity")
    validate_identity(sealed)  # Also prevents bool/float equality hiding type differences.
    require(sealed == manifest["identity"], "fixture app identity: manifest identity mismatch")
    daemon = safe_file(app, "Contents/Resources/" + sealed["daemon"]["path"])
    require(file_digest(daemon)[0] == sealed["daemon"]["sha256"], "fixture daemon: digest mismatch")
    plist_bytes = safe_file(app, "Contents/Info.plist").read_bytes()
    try:
        plist = plistlib.loads(plist_bytes)
    except (ValueError, plistlib.InvalidFileException, ExpatError) as exc:
        raise InvalidFixture("fixture Info.plist: invalid plist") from exc
    require(isinstance(plist, dict), "fixture Info.plist: expected dictionary")
    for key, expected in (
        ("CFBundleIdentifier", sealed["bundleId"]),
        ("CFBundleShortVersionString", sealed["bundleShortVersion"]),
        ("CFBundleVersion", sealed["bundleVersion"]),
        ("LSMinimumSystemVersion", manifest["minimumMacOS"]),
    ):
        require(type(plist.get(key)) is str and plist[key] == expected, f"fixture Info.plist.{key}: verbatim mismatch")


def validate_sums(data, expected):
    try:
        text = data.decode("utf-8")
    except UnicodeError as exc:
        raise InvalidFixture("SHA256SUMS: invalid UTF-8") from exc
    entries = {}
    require(text.endswith("\n"), "SHA256SUMS: missing final newline")
    for line in text[:-1].split("\n"):
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match is not None, "SHA256SUMS: expected lowercase digest, two spaces, filename, LF")
        digest, path = match.groups()
        relative_path(path)
        require(path not in entries, f"SHA256SUMS: duplicate path: {path}")
        entries[path] = digest
    require(list(entries) == sorted(entries), "SHA256SUMS: filenames must be sorted")
    require(set(entries) == set(expected), "SHA256SUMS: coverage must be exactly artifacts, manifest and evidence")
    for path, digest in expected.items():
        require(entries[path] == digest, f"SHA256SUMS: digest mismatch: {path}")


def validate_fixture(directory, fixture_app):
    """Read a v1 fixture set and a synthetic app tree, without writes or subprocesses."""
    root = Path(directory).resolve(strict=True)
    require(root.is_dir(), "fixture directory: expected directory")
    manifest_path = safe_file(root, MANIFEST)
    manifest_bytes = manifest_path.read_bytes()
    manifest = parse_json(manifest_bytes, MANIFEST)
    require(isinstance(manifest, dict), "manifest: expected object")
    require(manifest.get("kind") != "candidate", FIXTURE_ONLY)
    require(manifest.get("kind") == "fixture", "manifest.kind: expected fixture")
    schema(manifest.get("schemaVersion"), "manifest")
    object_fields(manifest, "schemaVersion kind identity identitySha256 artifacts minimumMacOS signing "
                  "notarization stapling evidence", "manifest")
    validate_identity(manifest["identity"])
    matching(manifest["identitySha256"], SHA256, "identitySha256")
    matching(manifest["minimumMacOS"], r"[0-9]+(?:\.[0-9]+)*", "minimumMacOS")
    references = validate_declarations(manifest)
    artifacts, evidence = manifest["artifacts"], manifest["evidence"]
    require(isinstance(artifacts, list) and len(artifacts) == 2, "artifacts: require exactly one DMG and one ZIP")
    require(isinstance(evidence, list), "evidence: expected array")
    expected = {MANIFEST: hashlib.sha256(manifest_bytes).hexdigest()}
    sums_path = safe_file(root, "SHA256SUMS")
    resolved_paths = {manifest_path, sums_path}
    require(len(resolved_paths) == 2, "duplicate resolved manifest/SHA256SUMS paths")
    formats, evidence_paths = set(), set()
    for records, is_artifact in ((artifacts, True), (evidence, False)):
        for record in records:
            object_fields(record, "format path sha256 bytes" if is_artifact else "path sha256 bytes", "file record")
            name = relative_path(record["path"])
            require(name not in expected and name != "SHA256SUMS", f"duplicate file path: {name}")
            if is_artifact:
                fmt = record["format"]
                require(isinstance(fmt, str) and fmt in ("dmg", "zip") and fmt not in formats,
                        "artifacts: require exactly one DMG and one ZIP")
                formats.add(fmt)
                version = manifest["identity"]["releaseVersion"]
                require(name == f"ORCA-{version}-mac-arm64.{fmt}", f"artifact filename/version mismatch: {name}")
            else:
                require(name.startswith("evidence/"), f"evidence path must be under evidence/: {name}")
                evidence_paths.add(name)
            matching(record["sha256"], SHA256, f"{name}.sha256")
            integer(record["bytes"], 1, f"{name}.bytes")
            path = safe_file(root, name)
            require(path not in resolved_paths, f"duplicate resolved file path: {name}")
            resolved_paths.add(path)
            digest, size = file_digest(path)
            require(size == record["bytes"], f"file size mismatch: {name}")
            require(digest == record["sha256"], f"file digest mismatch: {name}")
            expected[name] = digest
    require(set(references) <= evidence_paths, "evidence: referenced report is not listed")
    validate_sums(sums_path.read_bytes(), expected)
    validate_app(Path(fixture_app).resolve(strict=True), manifest)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--mode", required=True, choices=("fixture", "candidate"),
                        help="candidate is explicitly unsupported")
    parser.add_argument("--fixture-app", type=Path, help="separate synthetic ORCA.app tree (never launched)")
    parser.add_argument("directory", nargs="?", type=Path, help="directory containing the fixture manifest and SHA256SUMS")
    args = parser.parse_args(argv)
    if args.mode == "candidate":
        parser.error(FIXTURE_ONLY)
    if args.directory is None or args.fixture_app is None:
        parser.error("fixture mode requires directory and --fixture-app")
    try:
        validate_fixture(args.directory, args.fixture_app)
    except (InvalidFixture, OSError, RuntimeError, RecursionError) as exc:
        print(f"FAIL (fixture only): {exc}", file=sys.stderr)
        return 1
    print("PASS (fixture only): v1 structure, references, byte integrity and synthetic app identity. "
          "No signatures, notarization, archive contents, macOS execution or production readiness verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
