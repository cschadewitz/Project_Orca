"""Copy frozen synthetic bytes into a new directory; do not package or execute code."""

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil


SOURCE = Path(__file__).resolve().parent / "fixtures/valid"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_fixture(destination, producer_output=None, daemon=None):
    """Optionally bind an isolated producer result to the frozen synthetic fixture.

    This only constructs test input. The shared validator is the acceptance check.
    """
    if (producer_output is None) != (daemon is None):
        raise ValueError("producer output and daemon must be supplied together")
    if producer_output is not None:
        producer_output = Path(producer_output)
        identity_bytes = (producer_output / "orca-build.json").read_bytes()
        receipt = json.loads((producer_output / "fixture-provenance.json").read_bytes())
        if (not isinstance(receipt, dict) or receipt.get("kind") != "fixture"
                or receipt.get("identitySha256") != sha(identity_bytes)):
            raise ValueError("invalid fixture producer receipt")
        identity = json.loads(identity_bytes)
        daemon_bytes = Path(daemon).read_bytes()
        version = identity.get("releaseVersion") if isinstance(identity, dict) else None
        if not isinstance(version, str) or re.fullmatch(r"[0-9A-Za-z.+-]+", version) is None:
            raise ValueError("unsafe fixture version filename")
        if (receipt.get("sourceCommit") != identity.get("sourceCommit")
                or sha(daemon_bytes) != identity.get("daemon", {}).get("sha256")):
            raise ValueError("fixture producer source or daemon mismatch")

    # copytree refuses to overwrite an existing directory. Checksums are frozen,
    # not regenerated: changing a template must fail until deliberately reviewed.
    shutil.copytree(SOURCE, destination)
    destination = Path(destination)
    resources = destination / "ORCA.app/Contents/Resources"
    (resources / "daemon/orca-daemon.mjs.txt").rename(resources / "daemon/orca-daemon.mjs")
    if producer_output is None:
        return

    (resources / "orca-build.json").write_bytes(identity_bytes)
    (resources / "daemon/orca-daemon.mjs").write_bytes(daemon_bytes)
    plist_path = destination / "ORCA.app/Contents/Info.plist"
    plist = plistlib.loads(plist_path.read_bytes())
    for key, value in (("CFBundleIdentifier", identity["bundleId"]),
                       ("CFBundleShortVersionString", identity["bundleShortVersion"]),
                       ("CFBundleVersion", identity["bundleVersion"])):
        plist[key] = value
    plist_path.write_bytes(plistlib.dumps(plist))

    delivery = destination / "delivery"
    manifest_path = delivery / "native-mac-artifact.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["identity"] = identity
    manifest["identitySha256"] = sha(identity_bytes)
    for record in manifest["artifacts"]:
        old_path = delivery / record["path"]
        record["path"] = f"ORCA-{identity['releaseVersion']}-mac-arm64.{record['format']}"
        old_path.rename(delivery / record["path"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    paths = [record["path"] for record in manifest["artifacts"] + manifest["evidence"]]
    paths.append(manifest_path.name)
    (delivery / "SHA256SUMS").write_text("".join(
        f"{sha((delivery / path).read_bytes())}  {path}\n" for path in sorted(paths)), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new directory for synthetic fixture bytes")
    parser.add_argument("--producer-output", type=Path, help="fixture-only identity output directory")
    parser.add_argument("--daemon", type=Path, help="the staged daemon bytes used by the producer")
    args = parser.parse_args()
    write_fixture(args.destination, args.producer_output, args.daemon)
