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
    'host': {'os': lambda v: v == 'linux', 'arch': _TEXT, 'kernelRelease': _TEXT, 'hostIdSha256': _HEX64},
    'runtime': {'node': {'version': _TEXT, 'exeSha256': _HEX64},
                'python': {'version': _TEXT, 'exeSha256': _HEX64}},
    'loader': {'manifestSha256': _HEX64, 'moduleCount': lambda v: type(v) is int and 0 < v <= 32,
               'loaderSha256': _HEX64},
    'profile': {'id': _TEXT, 'sha256': _HEX64},
    'containment': {'mechanism': _TEXT, 'specSha256': _HEX64,
                    'namespaces': lambda v: type(v) is list and v == sorted(set(v)) and
                    set(v) >= {'ipc', 'mnt', 'net', 'pid', 'user', 'uts'} and set(v) <= set(NAMESPACES)},
    'session': {'authorizationSha256': _HEX64, 'sessionIdSha256': _HEX64},
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

_GIT_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'HOME': '/nonexistent',
            'GIT_OPTIONAL_LOCKS': '0'}


def _git(repo, *args):
    try:
        result = subprocess.run(['git', '-C', repo, *args], env=_GIT_ENV, capture_output=True,
                                timeout=30, check=False, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        raise Refusal('source_unavailable') from None
    require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, 'source_unavailable')
    return result.stdout


def measure_source(repo):
    commit = _git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
    tree = _git(repo, 'rev-parse', '--verify', 'HEAD^{tree}').decode().strip()
    status = _git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no')
    require(_HEX40.fullmatch(commit) and _HEX40.fullmatch(tree), 'source_unavailable')
    return {'commit': commit, 'tree': tree, 'clean': status == b''}


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
            machine = handle.read(256)
    except OSError:
        machine = b''
    return {'os': uname.system.lower(), 'arch': uname.machine, 'kernelRelease': uname.release,
            'hostIdSha256': hashlib.sha256(b'orca-host-id-v1\0' + machine.strip()).hexdigest()}
