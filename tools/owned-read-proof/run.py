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
import uuid
from verify import retain, identity

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
                # Do not poll/wait before this decision. An unreaped group leader
                # pins its PID/PGID, even if it exited just after communicate timed
                # out. After communicate reaps it, the numeric group may be reused:
                # never signal it then; required EXITKILL settles its tracees.
                if process.returncode is None:
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
    for scenario in ('baseline', 'changed-image', 'lifetime-loss', 'root-replacement',
                     'wrong-offset', 'wrong-descriptor', 'service-read', 'extra-process'):
        with proof_directory() as directory:
            base = Path(directory)
            installed = base / 'installed'
            installed.mkdir()
            inventory = install(installed)
            (base / 'inventory.json').write_text(json.dumps(inventory))
            config = base / 'workspace'
            store = config / '.orca'
            for path in (config, store, store / 'workspace-identity', base / 'control', base / 'releases'):
                path.mkdir(mode=0o700)
            (store / 'workspace-identity/id').write_text(str(uuid.uuid4()) + '\n')
            (store / 'workspace-identity/id').chmod(0o600)
            (base / 'input').write_bytes(b'disposable candidate bytes')
            (base / 'input').chmod(0o400)
            def directory(path):
                dev, ino, *_ = identity(path)
                return {'path': str(path), 'device': dev, 'inode': ino}
            value = {'control': directory(base / 'control'), 'releases': directory(base / 'releases'),
                     'workspaceIdentity': {'path': str(store / 'workspace-identity/id'),
                         'device': identity(store / 'workspace-identity/id')[0],
                         'inode': identity(store / 'workspace-identity/id')[1],
                         'digest': hashlib.sha256((store / 'workspace-identity/id').read_bytes().hex().encode()).hexdigest(),
                         'directory': directory(store / 'workspace-identity')},
                     'roles': [{'role': role, 'path': str(path), 'directory': directory(parent), 'target': str(config)}
                         for role, path, parent in (('config', config, config),
                             ('sidecar', config / 'orca.permissions.json', config), ('store', store, store))],
                     'targets': [directory(config)]}
            binding_ref = hashlib.sha256(json.dumps(value, separators=(',', ':')).encode()).hexdigest()
            binding = {**value, 'rootBindingRef': binding_ref}
            (base / 'binding.json').write_text(json.dumps(binding))
            witness = base / 'control/never-typed'
            witness.write_text(hashlib.sha256((store / 'workspace-identity/id').read_bytes()).hexdigest()
                               + '\n' + binding_ref + '\n')
            witness.chmod(0o600)
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
                node, tracer = shutil.which('node'), shutil.which('strace')
                plan = retain(base, installed, lifetime.descriptor, node, tracer, scenario)
                plan['rootBinding'] = binding
                (base / 'plan.json').write_text(json.dumps(plan))
                env = {'PATH': os.environ['PATH'], 'HOME': str(base), 'TMPDIR': str(base)}
                result = run_traced([tracer, '--kill-on-exit', '-f', '-q', '-v', '-x', '-s', '8192', '-e', 'raw=read,readv', '-o', str(trace),
                                         shutil.which('node'), str(installed / 'child.mjs'), str(base), str(lifetime.descriptor), scenario],
                                        pass_fds=(lifetime.descriptor,), cwd=installed, env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
                if result.returncode:
                    raise RuntimeError(result.stderr[-4000:])
                # Separate verifier receives the supervisor's retained original via stdin.
                # No producer result or producer-controlled plan file is a verifier input.
                verification = subprocess.run([shutil.which('python3'), '-B', str(Path(__file__).with_name('verify.py'))],
                    input=json.dumps({'trace': str(trace), 'plan': plan}), text=True,
                    pass_fds=(lifetime.descriptor,), capture_output=True, timeout=plan['verifierTimeoutSeconds'])
                if scenario == 'baseline':
                    if verification.returncode:
                        raise RuntimeError(verification.stderr[-4000:])
                    observed = json.loads(verification.stdout)
                else:
                    expected = {'changed-image': 'changed image', 'root-replacement': 'changed root/lifetime',
                                'lifetime-loss': 'lifetime descriptor closed', 'wrong-offset': 'calibration offset/length',
                                'wrong-descriptor': 'wrong descriptor positional', 'service-read': 'unexpected service read',
                                'extra-process': 'unexpected process'}[scenario]
                    if verification.returncode == 0 or expected not in verification.stderr:
                        raise RuntimeError('Negative control did not fail for expected reason: ' + verification.stderr[-2000:])
                    observed = {'record': 'candidate-negative-control', 'rejected': True,
                                'reason': verification.stderr.splitlines()[-1]}
                reports.append({'producer': json.loads(result.stdout), 'observer': observed,
                                'retainedBeforeLaunch': plan, 'installedFiles': len(inventory),
                                'installedManifest': {str(Path(p).relative_to(installed)): digest for p, digest in inventory.items()},
                                'exclusiveCompetition': 'blocked'})
    print(json.dumps({'record': 'candidate-evidence-only', 'qualification': 'unqualified', 'activation': 'off', 'scenarios': reports,
                      'limits': ['same-UID trusted test observer and producer', 'test-created original inventory',
                                 'no protected approval, live callback, permit or qualified source',
                                 'no fleet inventory or exclusion of pre-existing writers',
                                 'copied module subset, not a packaged application or production installer',
                                 'raw calibration is not owned service execution']}, indent=2))


if __name__ == '__main__':
    main()
