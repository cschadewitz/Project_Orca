#!/usr/bin/env python3
"""Assemble the prebuilt headless server bundle and its manifest (#876). No third-party modules.

  server-bundle.py assemble --version X.Y.Z --sha SHA --node NODE --daemon-dir DIR --out OUT

writes, into OUT:

  orca-server-X.Y.Z-linux-x64.tar.xz            the bundle
  orca-server-X.Y.Z-linux-x64.manifest.json     its SHA-256 manifest (the file that is signed)

The bundle holds one top-level directory, orca-server-X.Y.Z-linux-x64/, with:

  orca-daemon.mjs           the CLI, daemon and ACP facade, bundled (build-daemon.js --server)
  native-io-worker.js       the host-resources worker the daemon starts beside itself
  claude-pre-tool-hook.mjs  ORCA's Claude tool-call hook, run by the agent beside the daemon (#704)
  scripted-agent/main.js    the scripted agent `orca demo` starts beside itself
  runtime/bin/node          the pinned Node runtime the release workflow built and tested with
  runtime/LICENSE           Node's licence
  workflows/, templates/    the shipped workflows and templates (${ORCA_RELEASE}/...)
  release-compatibility.json, package.json, LICENSE, orca-server.json

The archive is deterministic for its inputs: sorted entries, one fixed mtime (the source
commit's), uid/gid 0, and only 0644/0755 modes. Only regular files and directories go in;
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

SCHEMA = "orca-server-bundle/1"
PLATFORM = "linux-x64"
ENTRY = "orca-daemon.mjs"
NODE = "runtime/bin/node"
REPO = Path(__file__).resolve().parents[2]


def names(version):
    stem = f"orca-server-{version}-{PLATFORM}"
    return stem, stem + ".tar.xz", stem + ".manifest.json"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def collect(version, sha, node, daemon_dir, node_version):
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
    add(NODE, node, True)
    licence = node.resolve().parent.parent / "LICENSE"
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
                                        "platform": PLATFORM, "entry": ENTRY, "node": NODE,
                                        "nodeVersion": node_version}, indent=2).encode() + b"\n")
    for target, (source, _) in files.items():
        if isinstance(source, Path) and not source.is_file():
            raise RuntimeError(f"missing bundle input {source} (for {target})")
    return sorted(files.items())


def assemble(version, sha, node, daemon_dir, out, mtime, node_version):
    if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", version):
        raise RuntimeError("version must be semver")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("sha must be a 40-hex commit")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", node_version):
        raise RuntimeError("node version must look like vX.Y.Z")
    stem, archive_name, manifest_name = names(version)
    out.mkdir(parents=True, exist_ok=True)
    archive = out / archive_name
    entries = collect(version, sha, node, daemon_dir, node_version)
    directories = sorted({"/".join(target.split("/")[:i]) for target, _ in entries
                          for i in range(1, target.count("/") + 1)})

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
    compatibility = json.loads((REPO / "release-compatibility.json").read_text())
    manifest = {
        "schema": SCHEMA,
        "name": "orca-server",
        "version": version,
        "sourceSha": sha,
        "platform": PLATFORM,
        "archive": {"name": archive_name, "sha256": sha256(archive), "size": archive.stat().st_size},
        "root": stem,
        "entry": ENTRY,
        "node": {"path": NODE, "version": node_version},
        "compatibility": compatibility,
    }
    (out / manifest_name).write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    build = sub.add_parser("assemble")
    build.add_argument("--version", required=True)
    build.add_argument("--sha", required=True)
    build.add_argument("--node", required=True, type=Path)
    build.add_argument("--node-version", required=True)
    build.add_argument("--daemon-dir", required=True, type=Path)
    build.add_argument("--out", required=True, type=Path)
    build.add_argument("--mtime", type=int, default=int(os.environ.get("SOURCE_DATE_EPOCH", "0")))
    options = parser.parse_args()
    manifest = assemble(options.version, options.sha, options.node, options.daemon_dir,
                        options.out, options.mtime, options.node_version)
    print(json.dumps(manifest["archive"]))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"server-bundle: {error}", file=sys.stderr)
        sys.exit(1)
