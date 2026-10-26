#!/usr/bin/env python3
"""Unqualified emitted-layout evidence. Only creates/removes its own TemporaryDirectory."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

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


def main():
    if not shutil.which('strace'):
        raise RuntimeError('strace required; missing observation is not a pass')
    spec = importlib.util.spec_from_file_location('release', REPO / 'tools/deploy/orca-release.py')
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    reports = []
    for scenario in ('baseline', 'changed-image', 'lifetime-loss', 'root-replacement'):
        with tempfile.TemporaryDirectory(prefix='orca-installed-proof-') as directory:
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
                result = subprocess.run(['strace', '-f', '-qq', '-yy', '-s', '128', '-e', 'trace=pread64', '-o', str(trace),
                                         shutil.which('node'), str(installed / 'child.mjs'), str(base), str(lifetime.descriptor), scenario],
                                        pass_fds=(lifetime.descriptor,), cwd=installed, env=env,
                                        capture_output=True, text=True, timeout=30)
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
