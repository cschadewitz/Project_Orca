#!/usr/bin/env python3
"""Install a complete feed snapshot on the HTTPS host, then atomically select its channel.
Run through SSH by the final release job, never by a desktop client.
"""
import argparse
import os
from pathlib import Path
import re
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("version")
parser.add_argument("archive")
args = parser.parse_args()
if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", args.version):
    raise SystemExit("Invalid release version")
root = Path(args.root).resolve()
root.mkdir(parents=True, exist_ok=True)
stage = Path(tempfile.mkdtemp(prefix=".incoming-", dir=root))
with tarfile.open(args.archive) as archive:
    for member in archive:
        if member.isdir():
            continue
        name = member.name[2:] if member.name.startswith("./") else member.name
        if not member.isfile() or Path(name).name != name or name.startswith("."):
            raise SystemExit("Unexpected feed archive member")
        with archive.extractfile(member) as source:
            (stage / name).write_bytes(source.read())
channel = "prerelease" if "-" in args.version else "latest"
for arch in ("x64", "arm64"):
    if not (stage / f"{channel}-{arch}.yml").is_file():
        raise SystemExit("Incomplete feed")
release = root / args.version
if release.exists():
    raise SystemExit("Immutable feed snapshot already exists")
os.rename(stage, release)
link = root / ("prerelease" if "-" in args.version else "stable")
if channel == "latest" and link.exists():
    previous = link.resolve().name
    if re.fullmatch(r"\d+\.\d+\.\d+", previous) and tuple(map(int, previous.split("."))) >= tuple(map(int, args.version.split("."))):
        raise SystemExit("Stable feed must move forward; snapshot retained without activation")
temporary = root / (link.name + ".next")
temporary.unlink(missing_ok=True)
temporary.symlink_to(release.name, target_is_directory=True)
os.replace(temporary, link)
Path(args.archive).unlink()
