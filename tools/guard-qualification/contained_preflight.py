"""Preventive containment preflight. Runs as PID 1 inside fresh namespaces, before
any candidate code is loaded, and execs the candidate only after the supervisor
has validated this process's report and released it.

Invoked by containment.py through `unshare` with `python3 -I -S`. It imports only
standard-library modules. On any failure it writes a single allowlisted code and
exits without executing the candidate.

Steps: make every mount private, mount a staging tmpfs over /tmp inside this
private mount namespace (nothing is created on the host), build an allowlisted
root there (runtime directories bound recursively and made read-only, nosuid and
nodev recursively with mount_setattr(AT_RECURSIVE); the reviewed snapshot copied
into its own tmpfs and checked against the reviewed digests, then made
read-only; the disposable workspace read-write; minimal /dev; fresh read-only
/proc), pivot_root into it and detach the old root, then verify the resulting
state independently of the setup calls, including /proc/self/mountinfo: every
mount except /workspace must be read-only and nosuid, and every mount point must
be one the spec allows. Then drop every capability (bounding set, ambient,
effective/permitted/inheritable) with no_new_privs, report, wait for the
supervisor's release byte, and exec with the exact environment.
"""
import ctypes
import errno
import hashlib
import json
import os
import platform
import re
import select
import stat
import sys

MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
MNT_DETACH = 2
PR_SET_NO_NEW_PRIVS, PR_CAPBSET_DROP, PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL = 38, 24, 47, 4
SYS_PIVOT_ROOT = {'x86_64': 155, 'aarch64': 41}
SYS_CAPSET = {'x86_64': 126, 'aarch64': 91}
SYS_MOUNT_SETATTR = {'x86_64': 442, 'aarch64': 442}
AT_RECURSIVE = 0x8000
MOUNT_ATTR_RDONLY, MOUNT_ATTR_NOSUID, MOUNT_ATTR_NODEV = 0x1, 0x2, 0x4
NEW_ROOT = '/tmp'  # a tmpfs mounted over /tmp inside this private mount namespace
RELEASE_SECONDS = 5
CHUNK = 1 << 16

libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)


class MountAttr(ctypes.Structure):
    _fields_ = [('attr_set', ctypes.c_uint64), ('attr_clr', ctypes.c_uint64),
                ('propagation', ctypes.c_uint64), ('userns_fd', ctypes.c_uint64)]


class Fail(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Fail(code)


def mount(source, target, fstype, flags, data=None):
    if libc.mount(source and source.encode(), target.encode(), fstype and fstype.encode(), flags,
                  data and ctypes.c_char_p(data.encode())) != 0:
        raise Fail('containment_startup_failed')


def setattr_mount(target, attrs, recursive):
    """Add mount attributes with mount_setattr(2); AT_RECURSIVE covers every nested mount."""
    attr = MountAttr(attrs, 0, 0, 0)
    flags = AT_RECURSIVE if recursive else 0
    need(libc.syscall(SYS_MOUNT_SETATTR[platform.machine()], -100, target.encode(), flags,
                      ctypes.byref(attr), ctypes.sizeof(attr)) == 0, 'containment_startup_failed')


def ro_bind(source, target, is_dir=True, attrs=MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV):
    if is_dir:
        os.makedirs(target, mode=0o755, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
        os.close(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC, 0o600))
    mount(source, target, None, MS_BIND | MS_REC)
    setattr_mount(target, attrs, recursive=True)


def copy_snapshot(src_fd, dst, digests, limit):
    """Copy regular files and directories only, hashing what is copied; the copy must equal the reviewed set."""
    copied, total = set(), [0]

    def walk(dir_fd, rel):
        with os.scandir(dir_fd) as entries:
            names = sorted(entry.name for entry in entries)
        found = False
        for name in names:
            path = name if not rel else rel + '/' + name
            info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
                try:
                    os.mkdir(dst + '/' + path, 0o755)
                    need(walk(child, path), 'containment_snapshot_mismatch')  # no unreviewed empty directories
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                need(path in digests and len(copied) < len(digests), 'containment_snapshot_mismatch')
                copy_file(dir_fd, name, dst + '/' + path, digests[path], limit, total)
                copied.add(path)
            else:
                raise Fail('containment_snapshot_mismatch')
            found = True
        return found

    walk(src_fd, '')
    need(copied == set(digests), 'containment_snapshot_mismatch')


def copy_file(dir_fd, name, target, expected, limit, total):
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    try:
        info = os.fstat(source)
        need(stat.S_ISREG(info.st_mode), 'containment_snapshot_mismatch')
        mode = 0o755 if info.st_mode & 0o100 else 0o644
        out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
        try:
            digest = hashlib.sha256()
            while True:
                chunk = os.read(source, CHUNK)
                if not chunk:
                    break
                total[0] += len(chunk)
                need(total[0] <= limit, 'containment_snapshot_mismatch')
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(out, view):]
            os.fchmod(out, mode)
        finally:
            os.close(out)
        need(digest.hexdigest() == expected, 'containment_snapshot_mismatch')
    finally:
        os.close(source)


def build_root(spec, workspace_fd, snapshot_fd):
    mount(None, '/', None, MS_REC | MS_PRIVATE)
    # Staging tmpfs over /tmp exists only in this private mount namespace.
    mount('tmpfs', NEW_ROOT, 'tmpfs', MS_NOSUID | MS_NODEV, 'size=1m,mode=0755')
    for directory in spec['runtimeDirs']:
        ro_bind(directory, NEW_ROOT + directory)
    for name in ('bin', 'lib', 'lib64', 'sbin'):
        if os.path.islink('/' + name) and os.readlink('/' + name) == 'usr/' + name:
            os.symlink('usr/' + name, NEW_ROOT + '/' + name)
    for device in ('null', 'zero', 'urandom'):
        ro_bind('/dev/' + device, NEW_ROOT + '/dev/' + device, is_dir=False,
                attrs=MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID)
    os.makedirs(NEW_ROOT + '/workspace', mode=0o755)
    mount('/proc/self/fd/%d' % workspace_fd, NEW_ROOT + '/workspace', None, MS_BIND)
    setattr_mount(NEW_ROOT + '/workspace', MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV, recursive=False)
    if snapshot_fd is not None:
        os.makedirs(NEW_ROOT + '/snapshot', mode=0o755)
        mount('tmpfs', NEW_ROOT + '/snapshot', 'tmpfs', MS_NOSUID | MS_NODEV,
              'size=%d,mode=0755' % spec['snapshotByteLimit'])
        copy_snapshot(snapshot_fd, NEW_ROOT + '/snapshot', spec['snapshotDigests'], spec['snapshotByteLimit'])
        setattr_mount(NEW_ROOT + '/snapshot', MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV,
                      recursive=True)
    os.makedirs(NEW_ROOT + '/proc', mode=0o555)
    mount('proc', NEW_ROOT + '/proc', 'proc', MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)
    os.makedirs(NEW_ROOT + '/.old', mode=0o700)
    need(libc.syscall(SYS_PIVOT_ROOT[platform.machine()], NEW_ROOT.encode(),
                      (NEW_ROOT + '/.old').encode()) == 0, 'containment_startup_failed')
    os.chdir('/')
    need(libc.umount2(b'/.old', MNT_DETACH) == 0, 'containment_startup_failed')
    os.rmdir('/.old')
    setattr_mount('/', MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV, recursive=False)
    os.chdir('/workspace')


def _unescape(field):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), field)


def verify_mounts(spec):
    """Every mount except /workspace read-only and nosuid; every mount point one the spec allows."""
    fixed = {'/', '/workspace', '/proc', '/dev/null', '/dev/zero', '/dev/urandom'}
    if spec['snapshot'] is not None:
        fixed.add('/snapshot')
    with open('/proc/self/mountinfo', 'rb') as handle:
        lines = handle.read().decode('utf-8', 'surrogateescape').splitlines()
    need(lines, 'containment_mount_unexpected')
    seen = set()
    for line in lines:
        fields = line.split(' ')
        need(len(fields) >= 10, 'containment_mount_unexpected')
        point, options = _unescape(fields[4]), set(fields[5].split(','))
        seen.add(point)
        need(point in fixed or any(point == r or point.startswith(r + '/') for r in spec['runtimeDirs']),
             'containment_mount_unexpected')
        if point == '/workspace':
            need({'rw', 'nosuid', 'nodev'} <= options, 'containment_workspace')
        else:
            need({'ro', 'nosuid'} <= options and 'rw' not in options, 'containment_root_writable')
    need(fixed <= seen, 'containment_mount_unexpected')


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
    verify_mounts(spec)
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
