#!/usr/bin/env python3
"""Unqualified emitted-layout evidence. Only creates/removes its own TemporaryDirectory."""
import contextlib
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
PACKAGES = ('core', 'store', 'agents', 'engine', 'cli')


def install(target):
    """Physical copies; no source aliases, source loader or symlink back to checkout."""
    modules = target / 'node_modules'
    for name in PACKAGES:
        source = REPO / 'packages' / name
        dest = modules / '@orca' / name
        dest.mkdir(parents=True)
        shutil.copy2(source / 'package.json', dest / 'package.json')
        shutil.copytree(source / 'dist', dest / 'dist')
    copied = {}

    def external(name, start):
        cursor = start
        while not (cursor / 'node_modules' / name / 'package.json').exists():
            if cursor.parent == cursor:
                raise RuntimeError('Missing dependency: ' + name)
            cursor = cursor.parent
        source = (cursor / 'node_modules' / name).resolve()
        if name in copied:
            if copied[name] != source:
                raise RuntimeError('Dependency version collision: ' + name)
            return
        copied[name] = source
        shutil.copytree(source, modules / name, ignore=shutil.ignore_patterns('node_modules'))
        manifest = json.loads((source / 'package.json').read_text())
        for dependency in manifest.get('dependencies', {}):
            external(dependency, source)
    for name in ('core', 'store', 'agents'):
        source = REPO / 'packages' / name
        for dep in json.loads((source / 'package.json').read_text()).get('dependencies', {}):
            if not dep.startswith('@orca/'):
                external(dep, source)
    shutil.copy2(Path(__file__).with_name('child.mjs'), target / 'child.mjs')
    for p in target.rglob('*'):
        if p.is_symlink():
            raise RuntimeError('Installed alias: ' + str(p))
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(target.rglob('*')) if p.is_file()}


def observe(trace, base):
    """External syscall evidence, never child reports or fence receipts."""
    lines = trace.read_text().splitlines()
    calibration = [line for line in lines if 'pread64(' in line and str(base / 'observer-calibration') + '>' in line]
    resources = [line for line in lines if 'pread64(' in line and '/orca-owned-service-' in line]
    if len(calibration) != 1 or ', 4, 0) = 4' not in calibration[0]:
        raise RuntimeError('Observer calibration missing or unexpected')
    if resources:
        raise RuntimeError('Unexpected service resource read')
    return {'calibrationReads': len(calibration), 'serviceReads': len(resources)}


class OwnedCleanupError(RuntimeError):
    """Unsettled owned children: preserve their disposable directory for inspection."""


@contextlib.contextmanager
def proof_directory():
    directory = tempfile.mkdtemp(prefix='orca-installed-proof-')
    safe_to_remove = True
    try:
        yield directory
    except OwnedCleanupError:
        safe_to_remove = False
        raise
    finally:
        if safe_to_remove:
            shutil.rmtree(directory)


def require_exitkill(tracer):
    help_text = subprocess.run([tracer, '--help'], capture_output=True, text=True,
                               timeout=5, check=True).stdout
    if '--kill-on-exit' not in help_text:
        raise RuntimeError('strace --kill-on-exit required; refusing to launch tracees')


def run_traced(args, **kwargs):
    """Own one group and reap adopted tracees before returning or raising.

    Used only by this standalone, sequential harness. Subreaper state is process-local,
    restored after settlement; no system configuration or unrelated processes change.
    """
    timeout = kwargs.pop('timeout', 30)
    libc = ctypes.CDLL(None, use_errno=True)
    previous = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(previous), 0, 0, 0) != 0:  # PR_GET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'get child subreaper')
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'set child subreaper')
    process = None
    try:
        process = subprocess.Popen(args, start_new_session=True, **kwargs)
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        finally:
            try:
                # Only the group we created, including the original tracer. EXITKILL
                # additionally covers traced descendants that changed process groups.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired as error:
                    raise OwnedCleanupError('Tracer did not settle; disposal unsafe') from error
                # This standalone sequential supervisor launches no other children.
                # Reap its adopted tracees too, including ones that changed groups.
                deadline = time.monotonic() + 5
                while True:
                    try:
                        pid, _ = os.waitpid(-1, os.WNOHANG)
                    except ChildProcessError:
                        break
                    if pid == 0:
                        if time.monotonic() >= deadline:
                            raise OwnedCleanupError('Owned tracees did not settle; disposal unsafe')
                        time.sleep(0.01)
            except BaseException as error:
                raise OwnedCleanupError('Owned cleanup incomplete; disposal unsafe') from error
            finally:
                for stream in (process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()

    finally:
        if libc.prctl(36, previous.value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'restore child subreaper')


def main():
    if not shutil.which('strace'):
        raise RuntimeError('strace required; missing observation is not a pass')
    require_exitkill(shutil.which('strace'))
    spec = importlib.util.spec_from_file_location('release', REPO / 'tools/deploy/orca-release.py')
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    reports = []
    for scenario in ('baseline', 'changed-image', 'lifetime-loss', 'root-replacement'):
        with proof_directory() as directory:
            base = Path(directory)
            installed = base / 'installed'
            installed.mkdir()
            inventory = install(installed)
            (base / 'inventory.json').write_text(json.dumps(inventory))
            trace = base / 'trace'
            with release.typed_lifetime_lock(base / 'lifetime.lock', exclusive=True) as lifetime:
                # Independent competing open: actual kernel exclusion, no PID/age claim.
                other = os.open(base / 'lifetime.lock', os.O_RDWR)
                try:
                    try:
                        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        pass
                    else:
                        raise RuntimeError('Exclusive lifetime exclusion missing')
                finally:
                    os.close(other)
                env = {'PATH': os.environ['PATH'], 'HOME': str(base), 'TMPDIR': str(base)}
                result = run_traced(['strace', '--kill-on-exit', '-f', '-qq', '-yy', '-s', '128', '-e', 'trace=pread64', '-o', str(trace),
                                         shutil.which('node'), str(installed / 'child.mjs'), str(base), str(lifetime.descriptor), scenario],
                                        pass_fds=(lifetime.descriptor,), cwd=installed, env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
                if result.returncode:
                    raise RuntimeError(result.stderr[-4000:])
                observed = observe(trace, base)
                reports.append({'producer': json.loads(result.stdout), 'observer': observed,
                                'installedFiles': len(inventory),
                                'installedManifest': {str(Path(p).relative_to(installed)): digest for p, digest in inventory.items()},
                                'exclusiveCompetition': 'blocked'})
    print(json.dumps({'qualification': 'unqualified', 'activation': 'off', 'scenarios': reports,
                      'limits': ['same-UID trusted test observer and producer', 'test-created original inventory',
                                 'no protected approval, live callback, permit or qualified source',
                                 'no fleet inventory or exclusion of pre-existing writers',
                                 'copied module subset, not a packaged application or production installer',
                                 'raw calibration is not owned service execution']}, indent=2))


if __name__ == '__main__':
    main()
