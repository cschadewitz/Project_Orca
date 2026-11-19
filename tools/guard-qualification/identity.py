"""Exact qualification identity tuple and drift checks.

A qualification statement is bound to one exact tuple. Every field is required,
every field is compared, and any difference is drift that invalidates the tuple.
The reviewed tuple is data to compare against; it never grants anything, and a
tuple that matches is still only correspondence (authority stays 'none').

Measurements of on-disk executables and files are pathname snapshots. They are
not loaded-code identity; loaded modules are bound by bound-loader.mjs instead.
"""
import hashlib
import json
import os
import platform
import re
import subprocess

from reasons import Refusal, require

SUPPORTED_LANE = 'controlled-owned-read-connected'
SUPPORTED_EXECUTION_PATHS = frozenset(('orca-owned-file-read-service',))
LANE_PHASES = ('bootstrap', 'save', 'human-read', 'rule-read')

# Routes that are explicitly outside the one supported lane. Qualification of
# the lane says nothing about any of these.
UNSUPPORTED_ROUTES = (
    'acp-native-shell', 'acp-terminal', 'provider-built-in-tools', 'provider-cached-native-approval',
    'native-allow-always', 'remembered-native-denial', 'shell-descendants', 'subagents',
    'independent-mcp-servers', 'custom-sessions', 'remote-ssh-execution', 'acp-fs-write-text-file',
    'acp-fs-read-text-file-unowned', 'claude-provider', 'codex-provider', 'gemini-provider',
    'pi-provider', 'windows-host', 'macos-host', 'pending-intent-replay', 'judge-delegated-review',
    'product-ui-permission-flows', 'other-tools-schemas-or-codecs', 'other-profiles',
)

_HEX40 = re.compile(r'[0-9a-f]{40}')
_HEX64 = re.compile(r'[0-9a-f]{64}')
_TEXT = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+:/@-]{0,127}')
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')
NAMESPACES = ('cgroup', 'ipc', 'mnt', 'net', 'pid', 'user', 'uts')
# Host kernel interfaces the boundary depends on, stated in the tuple so a host that
# lacks one cannot match. /proc/<pid>/task/<tid>/children (CONFIG_PROC_CHILDREN) is
# deliberately not required: descendants are found by scanning /proc/<pid>/stat.
HOST_REQUIREMENTS = ('mount-setattr', 'pidfd', 'proc-pid-stat', 'unprivileged-user-namespaces')

# Leaf validators keyed by dotted path; '*' marks a map of named outputs.
SCHEMA = {
    'version': lambda v: type(v) is int and v == 1,
    'lane': lambda v: v == SUPPORTED_LANE,
    'source': {'commit': _HEX40, 'tree': _HEX40, 'clean': lambda v: v is True},
    'build': {'inputsSha256': _HEX64, 'inputCount': lambda v: type(v) is int and 0 < v <= 4096,
              'lockfileSha256': _HEX64, 'builderSha256': _HEX64,
              'outputs': ('*', {'bytes': lambda v: type(v) is int and 0 <= v <= 256 * 1024 * 1024,
                                'sha256': _HEX64})},
    'provider': {'name': _TEXT, 'version': _TEXT},
    'bridge': {'name': _TEXT, 'version': _TEXT},
    'tool': {'name': _TEXT, 'schemaSha256': _HEX64, 'codec': _TEXT,
             'codecVersion': lambda v: type(v) is int and 0 < v < 1000},
    'executionPath': lambda v: v in SUPPORTED_EXECUTION_PATHS,
    'host': {'os': lambda v: v == 'linux', 'arch': _TEXT, 'kernelRelease': _TEXT, 'hostIdSha256': _HEX64,
             'requirements': lambda v: v == list(HOST_REQUIREMENTS)},
    'runtime': {'node': {'version': _TEXT, 'exeSha256': _HEX64},
                'python': {'version': _TEXT, 'exeSha256': _HEX64}},
    'loader': {'manifestSha256': _HEX64, 'moduleCount': lambda v: type(v) is int and 0 < v <= 32,
               'loaderSha256': _HEX64},
    'profile': {'id': _TEXT, 'sha256': _HEX64},
    'containment': {'mechanism': _TEXT, 'specSha256': _HEX64,
                    'namespaces': lambda v: type(v) is list and v == sorted(set(v)) and
                    set(v) >= {'ipc', 'mnt', 'net', 'pid', 'user', 'uts'} and set(v) <= set(NAMESPACES)},
}


def canonical(value):
    """Strict canonical JSON bytes: sorted keys, no floats, ASCII only."""
    def check(item):
        if type(item) is float:
            raise Refusal('identity_malformed')
        if type(item) is dict:
            for key, sub in item.items():
                require(type(key) is str, 'identity_malformed')
                check(sub)
        elif type(item) is list:
            for sub in item:
                check(sub)
        else:
            require(item is None or type(item) in (str, int, bool), 'identity_malformed')
    check(value)
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                      allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _walk(schema, value, path, missing, invalid):
    if type(schema) is tuple:  # ('*', leaf-schema): non-empty map of named outputs
        if type(value) is not dict or not value:
            (missing if value is None else invalid).append(path)
            return
        for name, item in value.items():
            if type(name) is not str or not _NAME.fullmatch(name):
                invalid.append(path)
                continue
            _walk(schema[1], item, path + '.' + name, missing, invalid)
        return
    if type(schema) is dict:
        if type(value) is not dict:
            (missing if value is None else invalid).append(path)
            return
        if set(value) - set(schema):
            raise Refusal('identity_unknown_field')
        for key, sub in schema.items():
            _walk(sub, value.get(key), path + '.' + key if path else key, missing, invalid)
        return
    if value is None:
        missing.append(path)
    elif not (schema(value) if callable(schema) else type(value) is str and schema.fullmatch(value)):
        invalid.append(path)


def validate(identity):
    """Return the identity digest, or refuse incomplete/malformed tuples."""
    require(type(identity) is dict, 'identity_malformed')
    missing, invalid = [], []
    _walk(SCHEMA, identity, '', missing, invalid)
    require(not invalid, 'identity_malformed')
    require(not missing, 'identity_incomplete')
    return digest(identity)


def drift(reviewed, measured):
    """Return the sorted list of drifted field paths (private detail)."""
    out = []

    def walk(a, b, path):
        if type(a) is dict and type(b) is dict:
            for key in sorted(set(a) | set(b)):
                walk(a.get(key), b.get(key), path + '.' + key if path else key)
        elif a != b or type(a) is not type(b):
            out.append(path)
    walk(reviewed, measured, '')
    return out


def require_exact(reviewed, measured):
    """Refuse unless both tuples are complete and identical. Never grants authority."""
    reviewed_digest = validate(reviewed)
    measured_digest = validate(measured)
    require(not drift(reviewed, measured) and reviewed_digest == measured_digest, 'identity_drift')
    return {'record': 'identity-correspondence', 'sha256': measured_digest, 'authority': 'none',
            'productionEligible': False, 'observationAuthorized': False}


def require_supported_route(route):
    require(route in SUPPORTED_EXECUTION_PATHS and route not in UNSUPPORTED_ROUTES, 'route_unsupported')


# Measurement helpers. Each returns only bounded, typed values.

_GIT_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_ATTR_NOSYSTEM': '1', 'HOME': '/nonexistent', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'}
# Command-line configuration overrides repository configuration, so the
# repository cannot make these measurements run its own commands. Content is
# hashed here from raw bytes; Git's clean/smudge filters are never invoked.
_GIT_SAFE = ('-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
             '-c', 'core.attributesFile=/dev/null', '-c', 'core.splitIndex=false', '-c', 'diff.external=',
             '-c', 'core.sshCommand=false', '-c', 'protocol.allow=never')
_MODES = {'100644': 0, '100755': 1, '120000': 2}


def _git(repo, *args):
    try:
        result = subprocess.run(['git', *_GIT_SAFE, '-C', repo, *args], env=_GIT_ENV, capture_output=True,
                                timeout=60, check=False, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        raise Refusal('source_unavailable') from None
    require(len(result.stdout) <= 64 * 1024 * 1024, 'source_unavailable')
    return result


def _git_ok(repo, *args):
    result = _git(repo, *args)
    require(result.returncode == 0, 'source_unavailable')
    return result.stdout


def _worktree_matches(repo, mode, sha, path):
    """Hash the working file's raw bytes as a Git blob; no filters, no symlink following."""
    full = os.path.join(repo, path)
    try:
        if mode == '120000':
            data = os.fsencode(os.readlink(full))
        else:
            fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if (info.st_mode & 0o170000) != 0o100000 or bool(info.st_mode & 0o111) != (mode == '100755'):
                    return False
                chunks, total = [], 0
                while True:
                    chunk = os.read(fd, 1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 256 * 1024 * 1024:
                        return False
                    chunks.append(chunk)
                data = b''.join(chunks)
            finally:
                os.close(fd)
    except OSError:
        return False
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest() == sha


def measure_source(repo):
    """Commit, tree and whether the worktree equals HEAD byte for byte (fail closed)."""
    commit = _git_ok(repo, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
    tree = _git_ok(repo, 'rev-parse', '--verify', 'HEAD^{tree}').decode().strip()
    require(_HEX40.fullmatch(commit) and _HEX40.fullmatch(tree), 'source_unavailable')
    clean = _git_ok(repo, 'rev-parse', '--show-object-format').strip() == b'sha1'
    # Index flags: anything but plain 'H' (skip-worktree 'S', assume-unchanged lowercase, ...) is dirty.
    tags = [entry[:2] for entry in _git_ok(repo, 'ls-files', '-z', '-v').split(b'\0') if entry]
    clean = clean and all(tag == b'H ' for tag in tags)
    # Index equals HEAD's tree (compares objects only; no worktree access).
    clean = clean and _git(repo, 'diff-index', '--cached', '--quiet', '--no-ext-diff', 'HEAD', '--').returncode == 0
    staged = [entry for entry in _git_ok(repo, 'ls-files', '-z', '--stage').split(b'\0') if entry]
    for entry in staged:
        meta, path = entry.split(b'\t', 1)
        mode, sha, stage = meta.decode().split()
        if not clean:
            break
        clean = stage == '0' and mode in _MODES and _worktree_matches(repo, mode, sha, os.fsdecode(path))
    clean = clean and _git_ok(repo, 'ls-files', '-z', '--others', '--exclude-standard') == b''
    return {'commit': commit, 'tree': tree, 'clean': bool(clean)}


def file_digest(path, limit=256 * 1024 * 1024):
    """Pathname snapshot digest through a non-following descriptor; not loaded identity."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        raise Refusal('identity_malformed') from None
    try:
        info = os.fstat(fd)
        require(info.st_size <= limit and (info.st_mode & 0o170000) == 0o100000, 'identity_malformed')
        value, total = hashlib.sha256(), 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            require(total <= limit, 'identity_malformed')
            value.update(chunk)
        require(total == info.st_size, 'identity_drift')
        return {'bytes': total, 'sha256': value.hexdigest()}
    finally:
        os.close(fd)


def measure_host():
    uname = platform.uname()
    try:
        with open('/etc/machine-id', 'rb') as handle:
            machine = handle.read(256).strip()
    except OSError:
        raise Refusal('identity_incomplete') from None
    require(re.fullmatch(rb'[0-9a-f]{32}', machine) is not None, 'identity_incomplete')
    return {'os': uname.system.lower(), 'arch': uname.machine, 'kernelRelease': uname.release,
            'hostIdSha256': hashlib.sha256(b'orca-host-id-v1\0' + machine).hexdigest(),
            'requirements': _host_requirements()}


def _host_requirements():
    """Probe what can be probed without privilege; refuse rather than report a missing interface."""
    require(hasattr(os, 'pidfd_open') and hasattr(os, 'P_PIDFD'), 'pidfd_unavailable')
    try:
        require(any(name.isdigit() for name in os.listdir('/proc')), 'procfs_unavailable')
        with open('/proc/self/stat', 'rb') as handle:
            fields = handle.read().rsplit(b')', 1)[1].split()
        require(int(fields[1]) == os.getppid(), 'procfs_unavailable')
    except (OSError, IndexError, ValueError):
        raise Refusal('procfs_unavailable') from None
    try:
        with open('/proc/sys/user/max_user_namespaces', 'rb') as handle:
            require(int(handle.read()) > 0, 'containment_unavailable')
    except (OSError, ValueError):
        raise Refusal('containment_unavailable') from None
    release = tuple(int(x) for x in re.findall(r'\d+', platform.release())[:2])
    require(len(release) == 2 and release >= (5, 12), 'containment_unavailable')  # mount_setattr(2)
    return list(HOST_REQUIREMENTS)
