"""Copy frozen synthetic bytes into a new directory; do not package or execute code."""

import argparse
from pathlib import Path
import shutil


SOURCE = Path(__file__).resolve().parent / "fixtures/valid"


def write_fixture(destination):
    # copytree refuses to overwrite an existing directory. Checksums are frozen,
    # not regenerated: changing a template must fail until deliberately reviewed.
    shutil.copytree(SOURCE, destination)
    resources = Path(destination) / "ORCA.app/Contents/Resources"
    (resources / "daemon/orca-daemon.mjs.txt").rename(resources / "daemon/orca-daemon.mjs")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new directory for synthetic fixture bytes")
    args = parser.parse_args()
    write_fixture(args.destination)
