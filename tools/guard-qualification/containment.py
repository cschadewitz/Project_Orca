"""Supervisor side of preventive disposable containment (Linux).

launch_contained() starts the reviewed preflight in fresh user, mount, PID, net,
IPC, UTS and cgroup namespaces with an exact environment and no inherited
descriptors, validates its measured report against the spec and against this
supervisor's own namespace identities read from outside, and only then releases
it to exec the candidate. Any failure refuses before candidate code is loaded;
there is no fallback to an uncontained launch. Tracing is not part of this
boundary, and process groups or rlimits are not treated as containment.

Not provided here (remaining obligations, see the gap matrix): seccomp syscall
filtering, cgroup memory/pids limits, and a disposable VM boundary against the
kernel itself. The trusted substrate is the host kernel, util-linux `unshare`,
this Python interpreter and the preflight script bytes (bound by spec digest).
"""
import hashlib
import json
import os
import select
import shutil
import sys

from bounds import PREFLIGHT_SECONDS
from identity import canonical
from reasons import Refusal, require

PYTHON = os.path.realpath(sys.executable)
PREFLIGHT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'contained_preflight.py')
NAMESPACES = ('cgroup', 'ipc', 'mnt', 'net', 'pid', 'user', 'uts')
UNSHARE_FLAGS = ('--user', '--map-root-user', '--mount', '--pid', '--net', '--ipc', '--uts', '--cgroup',
                 '--fork', '--kill-child')
SPEC_KEYS = frozenset(('version', 'workspace', 'snapshot', 'runtimeDirs', 'env', 'argv', 'hostNamespaces',
                       'denyPaths', 'allowedFds'))
ENV_KEYS = frozenset(('PATH', 'HOME', 'LANG', 'TZ', 'NODE_OPTIONS_FORBIDDEN'))
DEFAULT_DENY = ('/root', '/home', '/run', '/var/run', '/tmp', '/mnt', '/etc', '/var', '/srv', '/media',
                '/opt/claude-code', '/opt/env-runner', '/old_root', '/nix', '/proc/1/root/root')


def host_namespaces():
    return {ns: os.stat('/proc/self/ns/' + ns).st_ino for ns in NAMESPACES}


def make_spec(*, workspace, snapshot, runtime_dirs, argv, env, deny_paths=None):
    spec = {'version': 1, 'workspace': workspace, 'snapshot': snapshot, 'runtimeDirs': list(runtime_dirs),
            'env': dict(env), 'argv': list(argv), 'hostNamespaces': host_namespaces(),
            'denyPaths': list(DEFAULT_DENY if deny_paths is None else deny_paths), 'allowedFds': [0, 1, 2]}
    validate_spec(spec)
    return spec


def validate_spec(spec):
    require(type(spec) is dict and set(spec) == SPEC_KEYS and spec['version'] == 1, 'containment_spec_invalid')
    paths = [spec['workspace'], *spec['runtimeDirs']] + ([spec['snapshot']] if spec['snapshot'] else [])
    require(all(type(p) is str and os.path.isabs(p) and os.path.normpath(p) == p and '\0' not in p
                for p in paths), 'containment_spec_invalid')
    require(all(p not in ('/', '/proc', '/sys', '/dev') for p in spec['runtimeDirs']),
            'containment_spec_invalid')
    require(type(spec['env']) is dict and set(spec['env']) <= ENV_KEYS and
            all(type(v) is str for v in spec['env'].values()), 'containment_env')
    require(type(spec['argv']) is list and spec['argv'] and all(type(a) is str for a in spec['argv'])
            and os.path.isabs(spec['argv'][0]), 'containment_spec_invalid')
    require(spec['allowedFds'] == [0, 1, 2], 'containment_fd_inherited')
    require(set(spec['hostNamespaces']) == set(NAMESPACES), 'containment_spec_invalid')
    for deny in spec['denyPaths']:
        require(not any(deny == r or deny.startswith(r + '/') for r in spec['runtimeDirs']),
                'containment_spec_invalid')


def spec_digest(spec):
    with open(PREFLIGHT, 'rb') as handle:
        preflight = hashlib.sha256(handle.read()).hexdigest()
    return hashlib.sha256(canonical({'spec': spec, 'preflightSha256': preflight,
                                     'unshare': list(UNSHARE_FLAGS)})).hexdigest()


def _read_report(fd, deadline_seconds):
    # One newline-terminated record; the unshare parent also holds the write end,
    # so EOF is not a delimiter.
    data = b''
    while b'\n' not in data and len(data) <= 4096:
        ready, _, _ = select.select([fd], [], [], deadline_seconds)
        require(ready, 'containment_preflight_failed')
        chunk = os.read(fd, 4096)
        require(chunk, 'containment_preflight_failed')
        data += chunk
    require(data.endswith(b'\n') and data.count(b'\n') == 1 and len(data) <= 4096,
            'containment_preflight_failed')
    try:
        return json.loads(data)
    except ValueError:
        raise Refusal('containment_preflight_failed') from None


def _contained_init_pid(owned):
    """Host PID of the namespace init: the only child of our unreaped unshare process."""
    pid = owned.popen.pid
    children = set()
    for task in os.listdir('/proc/%d/task' % pid):
        with open('/proc/%d/task/%s/children' % (pid, task), 'rb') as handle:
            children.update(int(x) for x in handle.read().split())
    require(len(children) == 1, 'containment_startup_failed')
    child = children.pop()
    with open('/proc/%d/stat' % child, 'rb') as handle:
        ppid = int(handle.read().rsplit(b')', 1)[1].split()[1])
    require(ppid == pid, 'containment_startup_failed')
    return child


def launch_contained(ledger, spec, *, stdout, stderr):
    """Start the candidate inside the verified boundary. Returns the owned unshare process."""
    validate_spec(spec)
    unshare = shutil.which('unshare', path='/usr/bin:/bin')
    require(unshare is not None, 'containment_unavailable')
    report_r, report_w = ledger.pipe()
    release_r, release_w = ledger.pipe()
    argv = [unshare, *UNSHARE_FLAGS, '--', PYTHON, '-I', '-S', PREFLIGHT,
            json.dumps(spec, sort_keys=True), str(report_w.fd), str(release_r.fd)]
    owned = ledger.spawn(argv, env=dict(spec['env']), cwd='/', pass_fds=(report_w.fd, release_r.fd),
                         stdout=stdout, stderr=stderr)
    report_w.close()
    release_r.close()
    report = _read_report(report_r.fd, PREFLIGHT_SECONDS)
    require(type(report) is dict and report.get('record') == 'containment-preflight', 'containment_preflight_failed')
    if report.get('status') != 'ready':
        reason = report.get('reason')
        raise Refusal(reason if type(reason) is str and reason.startswith('containment_') else
                      'containment_preflight_failed')
    observed = report.get('namespaces')
    require(type(observed) is dict and set(observed) == set(spec['hostNamespaces']), 'containment_preflight_failed')
    init = _contained_init_pid(owned)
    for ns, host_ino in spec['hostNamespaces'].items():
        outside = os.stat('/proc/%d/ns/%s' % (init, ns)).st_ino
        require(outside == observed[ns] and outside != host_ino, 'containment_namespace_shared')
    os.write(release_w.fd, b'G')
    release_w.close()
    report_r.close()
    return owned
