"""Bounded disposable bootstrap supervisor. Connected commands are unavailable.

Retains original file bytes/identities before launch, keeps the actual flock and
pipe endpoints through independent replay, and preserves raw traces on failure.
No report, digest or command-line flag constructs a connected capability here.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from run import require_exitkill, run_traced
from verify import identity
from controlled_replay import Replay, LIMIT
from controlled_semantics import authenticate_bootstrap

REPO = Path(__file__).resolve().parents[2]
SOURCE = '6f208db363ec5091b42e2e2590fc10c7dbeb025d'
QUERY_PATHS = ('/proc/self/maps', '/proc/self/cgroup', '/proc/meminfo',
               '/sys/fs/cgroup//memory.max', '/sys/fs/cgroup//memory.high')


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stamp(path):
    s = Path(path).lstat()
    return list(map(str, [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink,
                         s.st_size, s.st_mtime_ns, s.st_ctime_ns]))


def fd_identity(number):
    s = os.fstat(number)
    return [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid]


def immutable(path, family, follow=False):
    p = Path(path)
    s = p.stat() if follow else p.lstat()
    data = p.read_bytes() if stat.S_ISREG(s.st_mode) else b''
    return {'identity': [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid],
            'hex': data.hex(), 'sha256': digest(data), 'family': family}


def directory(path):
    s = path.lstat()
    return {'path': str(path), 'device': s.st_dev, 'inode': s.st_ino}


def prepare(base, image, lifetime, command, ack, phases):
    for name in ('workspace', 'workspace/.orca', 'workspace/.orca/workspace-identity', 'control', 'releases'):
        (base / name).mkdir(mode=0o700)
    ident = base / 'workspace/.orca/workspace-identity/id'
    ident.write_text(str(uuid.uuid4()) + '\n')
    ident.chmod(0o600)
    w, store = base / 'workspace', base / 'workspace/.orca'
    value = {'control': directory(base / 'control'), 'releases': directory(base / 'releases'),
             'workspaceIdentity': {'path': str(ident), 'device': ident.stat().st_dev,
                 'inode': ident.stat().st_ino, 'digest': digest(ident.read_bytes().hex().encode()),
                 'directory': directory(ident.parent)},
             'roles': [{'role': role, 'path': str(p), 'directory': directory(parent), 'target': str(w)}
                 for role, p, parent in [('config', w, w), ('sidecar', w / 'orca.permissions.json', w), ('store', store, store)]],
             'targets': [directory(w)]}
    witness = base / 'control/never-typed'
    witness.write_text(digest(ident.read_bytes()) + '\n' + digest(encoded(value).encode()) + '\n')
    witness.chmod(0o600)
    def association(p):
        return {'identity': identity(p), 'sha256': digest(p.read_bytes())}
    inventory = {str(p): {**association(p), 'stamp': stamp(p)} for p in sorted(image.iterdir())}
    roots = {str(p): identity(p) for p in [base, w, store, ident.parent, base / 'control', base / 'releases']}
    plan = {'version': 1, 'lane': 'bootstrap', 'inputHex': b'disposable candidate bytes'.hex(),
            'offset': 2, 'length': 4, 'phases': phases,
            'lifetime': {'path': str(base / 'lifetime.lock'), 'identity': fd_identity(lifetime)},
            'commandIdentity': fd_identity(command), 'ackIdentity': fd_identity(ack), 'roots': roots,
            'originalFiles': {str(ident): association(ident)},
            'enrollmentWitness': {'path': str(witness), **association(witness)}, 'inventory': inventory}
    p = base / 'controlled-plan.json'
    p.write_text(encoded(plan))
    p.chmod(0o600)
    return plan


def runtime_originals(node):
    # Fixed loader/config/query paths, plus the exact loader-resolved shared
    # libraries of this retained Node binary. No external package-root exemption.
    result = subprocess.run(['ldd', node], capture_output=True, text=True, check=True, timeout=5)
    paths = set(re.findall(r'(/[^\s()]+)', result.stdout))
    paths |= {node, '/etc/ld.so.cache', '/etc/ssl/openssl.cnf', '/etc/localtime',
              '/sys/devices/system/cpu/online', '/dev/null'}
    return {p: immutable(p, 'runtime', follow=True) for p in sorted(paths)}


def assert_image_sources(image):
    build = json.loads((image / 'controlled-build.json').read_text())
    assert build['entry'] == 'controlled-child.mjs' and build['profileRef'] == 'orca-owned-file-read-v1'
    for name, field in [('controlled-child.mjs', 'childSha256'), ('controlled-producer.mjs', 'producerSha256')]:
        assert digest((image / name).read_bytes()) == build[field]
    assert (image / 'controlled-child.mjs').read_bytes() == (REPO / 'tools/owned-read-proof/controlled-child.mjs').read_bytes()
    for name, expected in build['sources'].items():
        assert digest((REPO / name).read_bytes()) == expected
        # Repository inputs must match the reviewed producer commit. Dependency
        # bytes remain pinned build inputs, not an independent trust designation.
        if not name.startswith('node_modules/'):
            original = subprocess.run(['git', 'show', SOURCE + ':' + name], cwd=REPO,
                                      capture_output=True, check=True, timeout=5).stdout
            assert digest(original) == expected
    return build


def bootstrap():
    root = Path(tempfile.mkdtemp(prefix='orca-controlled-replay-'))
    image = root / 'image'
    subprocess.run(['node', str(REPO / 'tools/owned-read-proof/build-controlled.mjs'), str(image)],
                   cwd=REPO, capture_output=True, text=True, check=True, timeout=30)
    assert_image_sources(image)
    base = root / 'bootstrap'
    base.mkdir(mode=0o700)
    lock = base / 'lifetime.lock'
    lifetime = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lifetime, fcntl.LOCK_EX | fcntl.LOCK_NB)
    other = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise RuntimeError('independent lifetime exclusion missing')
    finally:
        os.close(other)
    command, send = os.pipe()
    receive, ack = os.pipe()
    out_read, out_write = os.pipe()
    err_read, err_write = os.pipe()
    phases = [{'name': 'bootstrap', 'token': secrets.token_hex(32)}]
    used_tokens = set()
    plan = prepare(base, image, lifetime, command, ack, phases)
    node, tracer = shutil.which('node'), shutil.which('strace')
    require_exitkill(tracer)
    argv = [node, str(image / 'controlled-child.mjs'), str(base), 'bootstrap', str(lifetime), str(command), str(ack)]
    originals = {p: immutable(p, 'image') for p in plan['inventory']}
    originals.update(runtime_originals(node))
    originals.update({p: immutable(p, 'original-file') for p in plan['originalFiles']})
    originals[str(base / 'controlled-plan.json')] = immutable(base / 'controlled-plan.json', 'original-file')
    originals[plan['enrollmentWitness']['path']] = immutable(plan['enrollmentWitness']['path'], 'enrollment-witness')
    originals[str(lock)] = immutable(lock, 'lifetime')
    dirs = dict(plan['roots'])
    for path in list(originals) + [str(image), str(root)]:
        p = Path(path)
        for parent in [p] + list(p.parents):
            if parent.is_dir() and not parent.is_symlink():
                dirs[str(parent)] = identity(parent)
    queries = {p: 65536 for p in QUERY_PATHS}
    queries[f'/proc/self/fdinfo/{lifetime}'] = 4096
    query_metadata = {p: [Path(p).stat().st_mode, Path(p).stat().st_uid, Path(p).stat().st_gid]
                      for p in queries}
    probes = ['/proc/version_signature', '/sys/devices/system/cpu/cpu0/tsc_freq_khz',
              str(image / 'package.json'), str(root / 'package.json'), '/tmp/package.json']
    assert all(not Path(p).exists() and not Path(p).is_symlink() for p in probes), 'probe is not originally absent'
    original = {'base': str(base), 'lane': 'bootstrap', 'node': node, 'argv': argv,
                'inheritedUmask': int(re.search(r'^Umask:\s+([0-7]+)$',
                    Path('/proc/self/status').read_text(), re.MULTILINE)[1], 8),
                'commandFd': command, 'ackFd': ack, 'lifetimeFd': lifetime,
                'immutable': originals, 'directories': dirs, 'queries': queries, 'absentProbes': probes,
                'queryMetadata': query_metadata,
                'phases': phases, 'usedTokens': list(used_tokens),
                'inputHex': plan['inputHex'], 'offset': 2, 'length': 4,
                'descriptors': {str(n): {'identity': fd_identity(source_fd), 'family': family, 'flags': flags}
                    for n, source_fd, family, flags in [(0, 0, 'stdio', ['O_RDONLY']),
                         (1, out_write, 'stdio', ['O_WRONLY']), (2, err_write, 'stdio', ['O_WRONLY']),
                         (lifetime, lifetime, 'lifetime', ['O_RDWR']),
                         (command, command, 'command', ['O_RDONLY']), (ack, ack, 'ack', ['O_WRONLY'])]}}
    # Original observer/runtime inputs are held outside the child base and are not
    # accepted from any producer report or child-writable plan file.
    retained = root / 'supervisor-originals.json'
    retained.write_text(encoded(original))
    retained.chmod(0o600)
    trace = base / 'trace'
    trace.touch(mode=0o600)
    log, errors = [], []
    started = time.monotonic()
    original['startedWallTime'] = time.time()
    def control():
        try:
            deadline = started + 60
            while True:
                with trace.open() as f:
                    first = f.readline()
                match = re.match(r'(\d+)\s+execve\(', first)
                if match:
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError('initial kernel exec not observed')
                time.sleep(.01)
            original['leaderPid'] = int(match[1])
            # The exact retained leader is established before releasing the command.
            retained.write_text(encoded(original))
            for phase in phases:
                assert phase['token'] not in used_tokens
                used_tokens.add(phase['token'])
                data = f"orca-phase:{phase['name']}:{phase['token']}\n".encode()
                assert os.write(send, data) == len(data)
                log.append({'event': 'sent', **phase})
                expected = f"orca-done:{phase['name']}:{phase['token']}\n".encode()
                with selectors.DefaultSelector() as selector:
                    selector.register(receive, selectors.EVENT_READ)
                    assert selector.select(max(0, deadline - time.monotonic())), 'ack timeout'
                assert os.read(receive, len(expected)) == expected, 'partial/changed ack'
                log.append({'event': 'received', **phase})
        except BaseException as error:
            errors.append(repr(error))
        finally:
            os.close(send)
    worker = threading.Thread(target=control, daemon=True)
    worker.start()
    report = {'record': 'controlled-bootstrap-attempt', 'authority': 'none', 'root': str(root),
              'sourceHead': SOURCE, 'connectedCommandsReleased': False}
    try:
        result = run_traced(['prlimit', '--fsize=268435456:268435456', '--core=0:0', tracer,
                    '--kill-on-exit', '-f', '-q', '-v', '-x', '-s', '131072', '-o', str(trace), *argv],
                    pass_fds=(lifetime, command, ack), cwd=image,
                    env={'PATH': os.environ['PATH'], 'HOME': str(base), 'TMPDIR': str(base)},
                    stdout=out_write, stderr=err_write, text=True, timeout=60)
        original['finishedWallTime'] = time.time()
        os.close(out_write)
        os.close(err_write)
        out_write = err_write = None
        producer_out = os.read(out_read, 65537)
        producer_err = os.read(err_read, 65537)
        assert len(producer_out) <= 65536 and len(producer_err) <= 65536, 'bounded producer output exceeded'
        report.update(elapsedSeconds=time.monotonic() - started, traceBytes=trace.stat().st_size,
                      returncode=result.returncode, producerStderr=producer_err.decode()[-4000:])
        worker.join(timeout=1)
        assert not worker.is_alive() and not errors, errors
        assert result.returncode == 0 and trace.stat().st_size <= LIMIT
        assert log == [{'event': event, **phase} for phase in phases for event in ('sent', 'received')]
        for p, expected in plan['inventory'].items():
            assert identity(p) == expected['identity'] and stamp(p) == expected['stamp']
            assert digest(Path(p).read_bytes()) == expected['sha256']
        assert fd_identity(lifetime) == plan['lifetime']['identity'] == identity(lock)
        assert re.search(r'FLOCK\s+ADVISORY\s+WRITE ', Path(f'/proc/self/fdinfo/{lifetime}').read_text())
        replay = Replay(original)
        report['kernel'] = replay.run(trace.read_text())
        report['semantic'] = authenticate_bootstrap(replay)
        # Semantic authentication/canonical bootstrap correlation is still required;
        # a kernel-only report cannot authorize any connected command.
        report['qualification'] = 'unavailable-effect-audit-and-source-review-pending'
    except BaseException as error:
        report['refusal'] = type(error).__name__ + ': ' + str(error)
    finally:
        for number in (out_read, err_read, out_write, err_write):
            if number is not None:
                os.close(number)
        os.close(command)
        os.close(ack)
        worker.join(timeout=1)
        if not worker.is_alive():
            os.close(receive)
        os.close(lifetime)
        report['phaseLog'] = log
        (root / 'attempt.json').write_text(encoded(report))
        (root / 'attempt.json').chmod(0o600)
    print(encoded(report), flush=True)
    return report


if __name__ == '__main__':
    result = bootstrap()
    # Exit 2 means partial evidence only; it must never look like a qualified gate.
    sys.exit(1 if 'refusal' in result else 2)
