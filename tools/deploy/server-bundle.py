#!/usr/bin/env python3
"""Assemble the prebuilt headless server bundle and its manifest (#876). No third-party modules.

  server-bundle.py assemble [--platform linux-x64|win-x64] --version X.Y.Z --sha SHA --node NODE
                            --daemon-dir DIR --out OUT

writes, into OUT:

  orca-server-X.Y.Z-PLATFORM.tar.xz (linux-x64) or .zip (win-x64)   the bundle
  orca-server-X.Y.Z-PLATFORM.manifest.json                         its SHA-256 manifest (signed)

The bundle holds one top-level directory, orca-server-X.Y.Z-PLATFORM/, with:

  orca-daemon.mjs           the CLI, daemon and ACP facade, bundled (build-daemon.js --server)
  native-io-worker.js       the host-resources worker the daemon starts beside itself
  claude-pre-tool-hook.mjs  ORCA's Claude tool-call hook, run by the agent beside the daemon (#704)
  scripted-agent/main.js    the scripted agent `orca demo` starts beside itself
  runtime/bin/node          the pinned Node runtime the release workflow built and tested with
                            (runtime/node.exe in the Windows bundle, #1238)
  runtime/LICENSE           Node's licence
  workflows/, templates/    the shipped workflows and templates (${ORCA_RELEASE}/...)
  release-compatibility.json, package.json, LICENSE, orca-server.json

The archive is deterministic for its inputs: sorted entries, one fixed mtime (the source
commit's), uid/gid 0, and only 0644/0755 modes. The Windows zip is deflated with the same
order, time (to the zip format's two seconds) and modes, recorded as Unix modes. Only regular files and directories go in;
tools/deploy/orca-release.py refuses anything else on the way out.

Signing is not done here: release-server-bundle.yml signs the manifest keylessly
(Sigstore/cosign over GitHub OIDC), and orca-release.py `stage --bundle` verifies that
signature against the workflow identity it pins before it reads the archive.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import time
import zipfile

SCHEMA = "orca-server-bundle/1"
ENTRY = "orca-daemon.mjs"
# Each platform's archive format and where its Node runtime lies in the bundle.
PLATFORMS = {
    "linux-x64": {"extension": ".tar.xz", "node": "runtime/bin/node"},
    "win-x64": {"extension": ".zip", "node": "runtime/node.exe"},
}
PLATFORM = "linux-x64"
NODE = PLATFORMS[PLATFORM]["node"]
REPO = Path(__file__).resolve().parents[2]


def names(version, platform=PLATFORM):
    stem = f"orca-server-{version}-{platform}"
    return stem, stem + PLATFORMS[platform]["extension"], stem + ".manifest.json"


def node_licence(node, platform):
    """Node's LICENSE: beside bin/ in the Linux tarball, beside node.exe in the Windows zip."""
    return node.resolve().parent / "LICENSE" if platform == "win-x64" else node.resolve().parent.parent / "LICENSE"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def collect(version, sha, node, daemon_dir, node_version, platform=PLATFORM):
    """(archive path, source path or bytes, executable) for every file, sorted."""
    files = {}

    def add(target, source, executable=False):
        if target in files:
            raise RuntimeError(f"duplicate bundle path {target}")
        files[target] = (source, executable)

    add(ENTRY, daemon_dir / "orca-daemon.mjs")
    add("native-io-worker.js", daemon_dir / "native-io-worker.js")
    add("claude-pre-tool-hook.mjs", daemon_dir / "claude-pre-tool-hook.mjs")
    add("scripted-agent/main.js", daemon_dir / "scripted-agent" / "main.js")
    runtime = PLATFORMS[platform]["node"]
    add(runtime, node, True)
    licence = node_licence(node, platform)
    if not licence.is_file():
        raise RuntimeError(f"Node's LICENSE is not beside its runtime ({licence})")
    add("runtime/LICENSE", licence)
    for tree, pattern in (("workflows", "*.yaml"), ("templates", "*.md")):
        found = sorted(path for path in (REPO / tree).rglob(pattern) if path.is_file())
        if not found:
            raise RuntimeError(f"no shipped {tree}")
        for path in found:
            add(path.relative_to(REPO).as_posix(), path)
    add("release-compatibility.json", REPO / "release-compatibility.json")
    add("LICENSE", REPO / "LICENSE")
    # The two `.js` programs beside the entry are ESM whatever lies above the release directory.
    add("package.json", json.dumps({"name": "orca-server", "version": version, "private": True,
                                    "type": "module"}, indent=2).encode() + b"\n")
    add("orca-server.json", json.dumps({"schema": SCHEMA, "version": version, "sourceSha": sha,
                                        "platform": platform, "entry": ENTRY, "node": runtime,
                                        "nodeVersion": node_version}, indent=2).encode() + b"\n")
    for target, (source, _) in files.items():
        if isinstance(source, Path) and not source.is_file():
            raise RuntimeError(f"missing bundle input {source} (for {target})")
    return sorted(files.items())


def write_tar(archive, stem, directories, entries, mtime):
    def info(name, size=0, directory=False, executable=False):
        member = tarfile.TarInfo(f"{stem}/{name}" if name else stem)
        member.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
        member.mode = 0o755 if directory or executable else 0o644
        member.size = size
        member.mtime = mtime
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        return member

    # xz through the stdlib: the host that unpacks this has Python 3 and nothing else.
    with tarfile.open(archive, "w:xz", format=tarfile.PAX_FORMAT, preset=9) as tar:
        tar.addfile(info("", directory=True))
        for directory in directories:
            tar.addfile(info(directory, directory=True))
        for target, (source, executable) in entries:
            data = source if isinstance(source, bytes) else source.read_bytes()
            tar.addfile(info(target, len(data), executable=executable), io.BytesIO(data))


def write_zip(archive, stem, directories, entries, mtime):
    # A zip holds local time from 1980 on, in two-second steps; the source commit's UTC time is it.
    stamp = time.gmtime(max(mtime, 315532800))[:6]

    def info(name, directory=False, executable=False):
        member = zipfile.ZipInfo(f"{stem}/{name}/" if directory and name else f"{stem}/" if directory else f"{stem}/{name}",
                                 stamp)
        member.create_system = 3  # Unix, so the modes below are what a reader sees
        mode = 0o40755 if directory else (0o100755 if executable else 0o100644)
        member.external_attr = (mode << 16) | (0x10 if directory else 0)
        member.compress_type = zipfile.ZIP_STORED if directory else zipfile.ZIP_DEFLATED
        return member

    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(info("", directory=True), b"")
        for directory in directories:
            bundle.writestr(info(directory, directory=True), b"")
        for target, (source, executable) in entries:
            data = source if isinstance(source, bytes) else source.read_bytes()
            bundle.writestr(info(target, executable=executable), data, compresslevel=9)


def assemble(version, sha, node, daemon_dir, out, mtime, node_version, platform=PLATFORM):
    if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", version):
        raise RuntimeError("version must be semver")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("sha must be a 40-hex commit")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", node_version):
        raise RuntimeError("node version must look like vX.Y.Z")
    if platform not in PLATFORMS:
        raise RuntimeError(f"platform must be one of {', '.join(PLATFORMS)}")
    stem, archive_name, manifest_name = names(version, platform)
    out.mkdir(parents=True, exist_ok=True)
    archive = out / archive_name
    entries = collect(version, sha, node, daemon_dir, node_version, platform)
    directories = sorted({"/".join(target.split("/")[:i]) for target, _ in entries
                          for i in range(1, target.count("/") + 1)})

    (write_zip if platform == "win-x64" else write_tar)(archive, stem, directories, entries, mtime)
    compatibility = json.loads((REPO / "release-compatibility.json").read_text())
    manifest = {
        "schema": SCHEMA,
        "name": "orca-server",
        "version": version,
        "sourceSha": sha,
        "platform": platform,
        "archive": {"name": archive_name, "sha256": sha256(archive), "size": archive.stat().st_size},
        "root": stem,
        "entry": ENTRY,
        "node": {"path": PLATFORMS[platform]["node"], "version": node_version},
        "compatibility": compatibility,
    }
    (out / manifest_name).write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    build = sub.add_parser("assemble")
    build.add_argument("--platform", choices=sorted(PLATFORMS), default=PLATFORM)
    build.add_argument("--version", required=True)
    build.add_argument("--sha", required=True)
    build.add_argument("--node", required=True, type=Path)
    build.add_argument("--node-version", required=True)
    build.add_argument("--daemon-dir", required=True, type=Path)
    build.add_argument("--out", required=True, type=Path)
    build.add_argument("--mtime", type=int, default=int(os.environ.get("SOURCE_DATE_EPOCH", "0")))
    options = parser.parse_args()
    manifest = assemble(options.version, options.sha, options.node, options.daemon_dir,
                        options.out, options.mtime, options.node_version, options.platform)
    print(json.dumps(manifest["archive"]))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"server-bundle: {error}", file=sys.stderr)
        sys.exit(1)
