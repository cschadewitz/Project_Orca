"""Preventive containment preflight. Runs as PID 1 inside fresh namespaces, before
any candidate code is loaded, and execs the candidate only after the supervisor
has validated this process's report and released it.

Invoked by containment.py through `unshare` with `python3 -I -S`. It imports only
standard-library modules. On any failure it writes a single allowlisted code and
exits without executing the candidate.

Steps: build an allowlisted read-only root on tmpfs (runtime directories and the
reviewed snapshot read-only, the disposable workspace read-write, minimal /dev,
fresh /proc), pivot_root into it and detach the old root, verify the resulting
state independently of the setup calls, drop every capability (bounding set,
ambient, effective/permitted/inheritable) with no_new_privs, report, wait for
the supervisor's release byte, then exec with the exact environment.
"""
import ctypes
import errno
import json
import os
import platform
import select
import sys

MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
MNT_DETACH = 2
PR_SET_NO_NEW_PRIVS, PR_CAPBSET_DROP, PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL = 38, 24, 47, 4
SYS_PIVOT_ROOT = {'x86_64': 155, 'aarch64': 41}
SYS_CAPSET = {'x86_64': 126, 'aarch64': 91}
NEW_ROOT = '/tmp/.orca-contained-root'
RELEASE_SECONDS = 5

libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)


class Fail(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Fail(code)


def mount(source, target, fstype, flags, data=None):
    if libc.mount(source and source.encode(), target.encode(), fstype and fstype.encode(), flags,
                  data and ctypes.c_char_p(data.encode())) != 0:
        raise Fail('containment_startup_failed')


def ro_bind(source, target, is_dir=True):
    if is_dir:
        os.makedirs(target, mode=0o755, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
        os.close(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC, 0o600))
    mount(source, target, None, MS_BIND | MS_REC)
    mount(None, target, None, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV)


def build_root(spec, workspace_fd, snapshot_fd):
    mount(None, '/', None, MS_REC | MS_PRIVATE)
    os.makedirs(NEW_ROOT, mode=0o700, exist_ok=True)
    mount('tmpfs', NEW_ROOT, 'tmpfs', MS_NOSUID | MS_NODEV, 'size=1m,mode=0755')
    for directory in spec['runtimeDirs']:
        ro_bind(directory, NEW_ROOT + directory)
    for name in ('bin', 'lib', 'lib64', 'sbin'):
        if os.path.islink('/' + name) and os.readlink('/' + name) == 'usr/' + name:
            os.symlink('usr/' + name, NEW_ROOT + '/' + name)
    for device in ('null', 'zero', 'urandom'):
        ro_bind('/dev/' + device, NEW_ROOT + '/dev/' + device, is_dir=False)
        mount(None, NEW_ROOT + '/dev/' + device, None, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID)
    os.makedirs(NEW_ROOT + '/workspace', mode=0o755)
    mount('/proc/self/fd/%d' % workspace_fd, NEW_ROOT + '/workspace', None, MS_BIND)
    mount(None, NEW_ROOT + '/workspace', None, MS_REMOUNT | MS_BIND | MS_NOSUID | MS_NODEV)
    if snapshot_fd is not None:
        os.makedirs(NEW_ROOT + '/snapshot', mode=0o755)
        mount('/proc/self/fd/%d' % snapshot_fd, NEW_ROOT + '/snapshot', None, MS_BIND)
        mount(None, NEW_ROOT + '/snapshot', None, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV)
    os.makedirs(NEW_ROOT + '/proc', mode=0o555)
    mount('proc', NEW_ROOT + '/proc', 'proc', MS_NOSUID | MS_NODEV | MS_NOEXEC)
    os.makedirs(NEW_ROOT + '/.old', mode=0o700)
    need(libc.syscall(SYS_PIVOT_ROOT[platform.machine()], NEW_ROOT.encode(),
                      (NEW_ROOT + '/.old').encode()) == 0, 'containment_startup_failed')
    os.chdir('/')
    need(libc.umount2(b'/.old', MNT_DETACH) == 0, 'containment_startup_failed')
    os.rmdir('/.old')
    mount(None, '/', None, MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV)
    os.chdir('/workspace')


def drop_capabilities():
    need(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0, 'containment_startup_failed')
    with open('/proc/sys/kernel/cap_last_cap', 'rb') as handle:
        last = int(handle.read())
    for cap in range(last + 1):
        need(libc.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) == 0, 'containment_startup_failed')
    need(libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) == 0, 'containment_startup_failed')
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
    data = (ctypes.c_uint32 * 6)()
    need(libc.syscall(SYS_CAPSET[platform.machine()], header, data) == 0, 'containment_startup_failed')


def verify(spec, allowed_fds):
    """Measure the resulting state; never trust that setup calls did what they said."""
    observed = {}
    for ns in spec['hostNamespaces']:
        observed[ns] = os.stat('/proc/self/ns/' + ns).st_ino
        need(observed[ns] != spec['hostNamespaces'][ns], 'containment_namespace_shared')
    need(os.getpid() == 1, 'containment_namespace_shared')
    need(sorted(os.listdir('/sys/class/net')) == ['lo'] if os.path.isdir('/sys/class/net') else True,
         'containment_network')
    with open('/proc/self/net/dev', 'rb') as handle:
        interfaces = [line.split(b':')[0].strip() for line in handle.read().splitlines()[2:]]
    need(interfaces == [b'lo'], 'containment_network')
    need(_fds_ok(allowed_fds), 'containment_fd_inherited')
    for path in spec['denyPaths']:
        need(not os.path.lexists(path), 'containment_path_visible')
    try:
        os.close(os.open('/.orca-write-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        raise Fail('containment_root_writable')
    except OSError as error:
        need(error.errno in (errno.EROFS, errno.EACCES), 'containment_root_writable')
    need(os.getcwd() == '/workspace' and not os.listdir('/workspace'), 'containment_workspace')
    probe = os.open('/workspace/.orca-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    os.close(probe)
    os.unlink('/workspace/.orca-probe')
    with open('/proc/self/status', 'rb') as handle:
        caps = {line.split(b':')[0]: int(line.split()[1], 16) for line in handle.read().splitlines()
                if line.startswith(b'Cap')}
    need(all(value == 0 for value in caps.values()), 'containment_startup_failed')
    with open('/proc/self/status', 'rb') as handle:
        need(b'NoNewPrivs:\t1' in handle.read(), 'containment_startup_failed')
    return {'namespaces': observed, 'interfaces': ['lo'], 'pid': 1}


def _fds_ok(allowed):
    current = set()
    for name in os.listdir('/proc/self/fd'):
        fd = int(name)
        try:
            os.fstat(fd)
        except OSError:
            continue  # the listing descriptor itself, already closed
        current.add(fd)
    return current <= allowed


def main():
    spec_json, report_fd, release_fd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    try:
        spec = json.loads(spec_json)
        workspace_fd = os.open(spec['workspace'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        snapshot_fd = None
        if spec['snapshot'] is not None:
            snapshot_fd = os.open(spec['snapshot'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        build_root(spec, workspace_fd, snapshot_fd)
        os.close(workspace_fd)
        if snapshot_fd is not None:
            os.close(snapshot_fd)
        drop_capabilities()
        allowed = set(spec['allowedFds']) | {report_fd, release_fd}
        need(_fds_ok(allowed), 'containment_fd_inherited')
        for key in list(os.environ):
            need(os.environ[key] == spec['env'].get(key), 'containment_env')
        report = verify(spec, allowed)
        report.update(record='containment-preflight', status='ready')
        os.write(report_fd, json.dumps(report, sort_keys=True).encode() + b'\n')
        os.close(report_fd)
        ready, _, _ = select.select([release_fd], [], [], RELEASE_SECONDS)
        need(ready and os.read(release_fd, 2) == b'G', 'containment_preflight_failed')
        os.close(release_fd)
        need(_fds_ok(set(spec['allowedFds'])), 'containment_fd_inherited')
        os.execve(spec['argv'][0], spec['argv'], spec['env'])
    except Fail as failure:
        code = failure.args[0]
    except BaseException:
        code = 'containment_preflight_failed'
    try:
        os.write(report_fd, json.dumps({'record': 'containment-preflight', 'status': 'refused',
                                        'reason': code}).encode() + b'\n')
    except OSError:
        pass
    os._exit(97)


if __name__ == '__main__':
    main()
