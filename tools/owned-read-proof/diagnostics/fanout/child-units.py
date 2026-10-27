"""DIAGNOSTIC ONLY (#706 fan-out investigation): exact cost of one child currentness check.

Starts the real image's connected child under strace (observer flags minus
--always-show-pid), never sends a command, and counts syscalls between consecutive
/proc/self/fdinfo/<lifetime> opens. At startup the child runs its own check, then the
producer's physical check, then bootstrap.assertCurrent, before blocking on the FIFO.

usage: [ORCA_DIAG_CANDIDATE=1] python3 -I child-units.py <image-dir> <out-dir>
"""
import fcntl
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from controlled_supervisor import prepare, prepare_connected  # noqa: E402
from controlled_connected import ConnectedDesignation  # noqa: E402
from controlled_timestamps import OPTION  # noqa: E402

if os.environ.get('ORCA_DIAG_CANDIDATE') == '1':
    import controlled_supervisor
    controlled_supervisor.assert_image_sources = (
        lambda image: json.loads((Path(image) / 'controlled-build.json').read_text()))

image, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='orca-connected-observation-'))


def lane(name, designation=None):
    base = root / name
    base.mkdir(mode=0o700)
    lifetime = os.open(base / 'lifetime.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    command, send = os.pipe()
    receive, ack = os.pipe()
    names = ['bootstrap'] if name == 'bootstrap' else ['save', 'human-read', 'rule-read']
    phases = [{'name': n, 'token': secrets.token_hex(32)} for n in names]
    if name == 'bootstrap':
        prepare(base, image, lifetime, command, ack, phases)
    else:
        prepare_connected(base, image, lifetime, command, ack, phases, designation)
    return base, lifetime, command, send, receive, ack


lane('bootstrap')
receipt = root / 'bootstrap-association.json'
receipt.write_bytes(json.dumps({'record': 'diagnostic-synthetic-receipt-not-authority', 'pad': 'x' * 1100}).encode())
receipt.chmod(0o400)
designation = ConnectedDesignation(bootstrap_base=root / 'bootstrap', evidence_path=receipt,
                                   evidence_ref='diagnostic-synthetic:' + secrets.token_hex(32), image=image,
                                   assert_bootstrap_closed=lambda: None)
base, lifetime, command, send, receive, ack = lane('connected', designation)
trace = out / 'child-startup.trace'
argv = ['strace', OPTION, '-f', '-q', '-v', '-x', '-s', '131072', '-o', str(trace), shutil.which('node'),
        str(image / 'controlled-child.mjs'), str(base), 'connected', str(lifetime), str(command), str(ack)]
process = subprocess.Popen(argv, pass_fds=(lifetime, command, ack), cwd=image,
                           env={'PATH': os.environ['PATH'], 'HOME': str(base), 'TMPDIR': str(base)},
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(6)
os.close(send)  # EOF on the command FIFO ends the child.
process.communicate(timeout=30)
lines = trace.read_text().splitlines()
opens = [i for i, line in enumerate(lines) if f'/proc/self/fdinfo/{lifetime}"' in line and 'openat(' in line]
print('fdinfo opens at startup:', len(opens))


def segment(first, last):
    calls, sizes = {}, {}
    for line in lines[first:last]:
        match = re.match(r'\d+\s+\d+\.\d+\s+(\w+)\(', line)
        if match:
            calls[match[1]] = calls.get(match[1], 0) + 1
            sizes[match[1]] = sizes.get(match[1], 0) + len(line) + 1
    return calls, sizes


for k in range(len(opens) - 1):
    calls, sizes = segment(opens[k], opens[k + 1])
    print(f'between check {k} and {k + 1}:', calls, 'bytes', sum(sizes.values()))
statx = [len(line) + 1 for line in lines if re.match(r'\d+\s+\d+\.\d+\s+statx\(', line)]
print('statx line bytes: n=%d mean=%.0f' % (len(statx), sum(statx) / len(statx)))
