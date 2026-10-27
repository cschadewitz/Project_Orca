"""DIAGNOSTIC ONLY driver for the #706 fan-out investigation. Never evidence, never authority.

Runs the real built image's child for the bootstrap lane and then the connected lane, using
the observer's own prepare()/prepare_connected() plans, a real flock and command/ack pipes,
a synthetic 1167-byte receipt and a synthetic ConnectedDesignation whose closure returns
None. It is NOT the observer: no replay, no semantic authentication, no bootstrap closure.

usage: python3 -I drive.py <image-dir> <out-dir> <mode> [bootstrap|connected ...]

modes:
  plain           untraced timing
  census          untraced, with census-preload.mjs (ORCA_CENSUS_LIGHT / ORCA_CENSUS_SEQ)
  strace-c        syscall counts (strace -f -c)
  strace-full     full trace with the observer's flags minus --always-show-pid
  strace-limited  strace-full plus prlimit --fsize=256MiB, --kill-on-exit, 60 s deadline

ORCA_DIAG_CANDIDATE=1 replaces assert_image_sources inside THIS process only, so an
unreviewed candidate image can be measured. The real observer always refuses such images.
"""
import fcntl
import json
import os
import secrets
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OBSERVER = HERE.parents[1]
sys.path.insert(0, str(OBSERVER))
from controlled_supervisor import prepare, prepare_connected  # noqa: E402
from controlled_connected import ConnectedDesignation  # noqa: E402
from controlled_timestamps import OPTION  # noqa: E402

if os.environ.get('ORCA_DIAG_CANDIDATE') == '1':
    import controlled_supervisor
    controlled_supervisor.assert_image_sources = (
        lambda image: json.loads((Path(image) / 'controlled-build.json').read_text()))

image, outdir, mode = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
assert mode in {'plain', 'census', 'strace-c', 'strace-full', 'strace-limited'}, mode
lanes = sys.argv[4:] or ['bootstrap', 'connected']
outdir.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='orca-connected-observation-'))
node = shutil.which('node')
TRACE = ['-f', '-q', '-v', '-x', '-s', '131072']
results = {'root': str(root), 'node': node, 'mode': mode}


def remaining(started, default):
    if mode != 'strace-limited':
        return default
    return max(0.1, 60 - (time.monotonic_ns() - started) / 1e9)


def run_lane(lane, designation=None):
    base = root / lane
    base.mkdir(mode=0o700)
    lifetime = os.open(base / 'lifetime.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    command, send = os.pipe()
    receive, ack = os.pipe()
    names = ['bootstrap'] if lane == 'bootstrap' else ['save', 'human-read', 'rule-read']
    phases = [{'name': name, 'token': secrets.token_hex(32)} for name in names]
    if lane == 'bootstrap':
        prepare(base, image, lifetime, command, ack, phases)
    else:
        prepare_connected(base, image, lifetime, command, ack, phases, designation)
    argv = [node] + (['--import', str(HERE / 'census-preload.mjs')] if mode == 'census' else [])
    argv += [str(image / 'controlled-child.mjs'), str(base), lane, str(lifetime), str(command), str(ack)]
    trace = str(outdir / f'{lane}.trace')
    if mode == 'strace-c':
        argv = ['strace', '-f', '-c', '-o', str(outdir / f'{lane}-strace-c.txt')] + argv
    elif mode == 'strace-full':
        argv = ['strace', OPTION, *TRACE, '-o', trace] + argv
    elif mode == 'strace-limited':
        argv = ['prlimit', '--fsize=268435456:268435456', '--core=0:0',
                'strace', '--kill-on-exit', OPTION, *TRACE, '-o', trace] + argv
    env = {'PATH': os.environ['PATH'], 'HOME': str(base), 'TMPDIR': str(base),
           'ORCA_CENSUS_OUT': str(outdir / f'{lane}-census.json'),
           'ORCA_CENSUS_LIGHT': os.environ.get('ORCA_CENSUS_LIGHT', '0'),
           'ORCA_CENSUS_SEQ': os.environ.get('ORCA_CENSUS_SEQ', '0')}
    started = time.monotonic_ns()
    process = subprocess.Popen(argv, pass_fds=(lifetime, command, ack), cwd=image, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.close(command)
    os.close(ack)
    timeline, error = [], None
    try:
        for phase in phases:
            os.write(send, f"orca-phase:{phase['name']}:{phase['token']}\n".encode())
            begun = time.monotonic_ns()
            expected = f"orca-done:{phase['name']}:{phase['token']}\n".encode()
            with selectors.DefaultSelector() as selector:
                selector.register(receive, selectors.EVENT_READ)
                if not selector.select(remaining(started, 120)):
                    raise RuntimeError('ack timeout')
            received = os.read(receive, len(expected))
            if received != expected:
                raise RuntimeError(f'ack mismatch {received!r}')
            timeline.append({'phase': phase['name'], 'seconds': (time.monotonic_ns() - begun) / 1e9})
    except BaseException as caught:  # diagnostic: record, then reap
        error = repr(caught)
    finally:
        os.close(send)
    try:
        out, err = process.communicate(timeout=remaining(started, 180))
    except subprocess.TimeoutExpired:
        process.kill()
        out, err = process.communicate()
        error = (error or '') + ' 60 s process deadline exceeded'
    os.close(receive)
    os.close(lifetime)
    results[lane] = {'returncode': process.returncode, 'elapsed': (time.monotonic_ns() - started) / 1e9,
                     'phases': timeline, 'error': error, 'stderr': err.decode()[-3000:],
                     'stdoutKind': out.decode()[:80]}


run_lane('bootstrap')
if 'connected' in lanes:
    receipt = root / 'bootstrap-association.json'
    receipt.write_bytes(json.dumps({'record': 'diagnostic-synthetic-receipt-not-authority',
                                    'pad': 'x' * 1100}).encode())
    receipt.chmod(0o400)
    designation = ConnectedDesignation(bootstrap_base=root / 'bootstrap', evidence_path=receipt,
                                       evidence_ref='diagnostic-synthetic:' + secrets.token_hex(32),
                                       image=image, assert_bootstrap_closed=lambda: None)
    run_lane('connected', designation)
(outdir / 'driver.json').write_text(json.dumps(results, indent=1))
print(json.dumps({lane: (value if not isinstance(value, dict) else
                         {k: v for k, v in value.items() if k != 'stderr'})
                  for lane, value in results.items()}, indent=1))
