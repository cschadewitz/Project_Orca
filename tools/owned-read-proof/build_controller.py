"""Reproducible public-source zipapp builder; never needed on the target host.

Fixed committed inputs only. The archive is built from bounded immutable snapshots
that equal the requested Git blobs, not from later workspace reads or ambient
dependencies. The commit/manifest identify build inputs, not an observation issuer.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import zipfile


REPO = Path(__file__).resolve().parents[2]
INPUTS = (
    ('tools/owned-read-proof/controller_main.py', '__main__.py'),
    ('tools/owned-read-proof/controller_cli.py', 'orca_controller_cli.py'),
    ('tools/owned-read-proof/packet_exporter.py', 'packet_exporter.py'),
    ('tools/owned-read-proof/packet_receiver.py', 'packet_receiver.py'),
    ('tools/owned-read-proof/build_controller.py', None),
)
INPUT_BYTE_LIMIT = 1048576  # Defensive public build-input ceiling, not an observer/journal allowance.


def _git(*args):
    # These command-local switches neither mutate config nor permit a partial
    # clone to fetch missing blobs. Unsupported Git versions fail closed.
    return subprocess.run(['git', '--no-replace-objects', '--no-lazy-fetch', *args],
                          cwd=REPO, check=True, capture_output=True, timeout=5).stdout


def build(output, source_commit):
    if (type(source_commit) is not str or len(source_commit) != 40 or
            any(c not in '0123456789abcdef' for c in source_commit)):
        raise ValueError('commit')
    if _git('rev-parse', source_commit + '^{commit}').strip().decode('ascii') != source_commit:
        raise ValueError('commit')
    snapshots, inputs = {}, []
    for relative, entry in INPUTS:
        path = REPO / relative
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= INPUT_BYTE_LIMIT:
            raise ValueError('input')
        with path.open('rb') as stream:
            local = stream.read(INPUT_BYTE_LIMIT + 1)
        raw_size = _git('cat-file', '-s', source_commit + ':' + relative).strip()
        if not 0 < len(raw_size) <= 7 or not raw_size.isdigit():
            raise ValueError('input')
        size = int(raw_size)
        if not 0 < size <= INPUT_BYTE_LIMIT or len(local) != size:
            raise ValueError('input')
        committed = _git('cat-file', 'blob', source_commit + ':' + relative)
        if local != committed:
            raise ValueError('uncommitted input')
        inputs.append({'path': relative, 'entry': entry, 'bytes': size,
                       'sha256': hashlib.sha256(committed).hexdigest()})
        if entry is not None:
            snapshots[entry] = committed
    manifest = {'format': 'orca-nonsecret-controller-zipapp-v1',
                'source_commit': source_commit, 'inputs': inputs}
    snapshots['SOURCE.json'] = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')
    if len(snapshots['SOURCE.json']) > 65536:
        raise ValueError('manifest')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in snapshots.items():
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system, info.external_attr = 3, 0o100644 << 16
            archive.writestr(info, data)
    payload = buffer.getvalue()
    number = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    failure = None
    try:
        offset = 0
        while offset < len(payload):
            count = os.write(number, payload[offset:offset + 65536])
            if type(count) is not int or not 0 < count <= min(65536, len(payload) - offset):
                raise RuntimeError('write')
            offset += count
        os.fsync(number)
    except BaseException as error:
        failure = error
    try:
        os.close(number)
    except BaseException as error:
        if failure is None:
            failure = error
    if failure is not None:
        raise failure
    return {'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(), 'source_commit': source_commit}


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, 'controller build arguments unavailable\n')


def main():
    parser = _Parser(prog='build-controller', description='Build the reviewed nonsecret controller from exact committed inputs.')
    parser.add_argument('--output', required=True)
    parser.add_argument('--source-commit', required=True)
    args = parser.parse_args()
    try:
        result = build(args.output, args.source_commit)
    except BaseException:
        sys.stderr.write('controller build unavailable; preserve partial output without retry\n')
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
