"""Four finite native startup telemetry probes, under trusted stable Linux mounts.

Supervisor observations only. Never a service-file identity substitute or authority.
The cgroup mount root is retained opaque; it is never used as a pathname.
"""
import ctypes
import os
from pathlib import Path
import re
import select
import stat

from controlled_contract import require

KIND = 'trusted-kernel-runtime-query-v1'
# Exact spelling and one sequential read request observed in the reviewed image.
QUERIES = {'/proc/self/cgroup': (1023, '/proc', 'proc', 0x9fa0),
           '/sys/fs/cgroup//memory.max': (31, '/sys/fs/cgroup', 'cgroup2', 0x63677270),
           '/sys/fs/cgroup//memory.high': (31, '/sys/fs/cgroup', 'cgroup2', 0x63677270),
           '/proc/meminfo': (4095, '/proc', 'proc', 0x9fa0)}


def fs_type(number):
    # Linux statfs begins with a native long; reserve more than the Linux struct.
    buffer = ctypes.create_string_buffer(256)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(number, ctypes.byref(buffer)) != 0:
        raise OSError(ctypes.get_errno(), 'held query fstatfs')
    return ctypes.cast(buffer, ctypes.POINTER(ctypes.c_long))[0]


def ident(number):
    s = os.fstat(number)
    return [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid]


def mount_fields(raw):
    result = []
    for line in raw.splitlines():
        fields = line.split()
        separator = fields.index('-')
        require(separator >= 6 and len(fields) == separator + 4, 'incomplete kernel mountinfo')
        # Decode only the kernel's four mountinfo escapes, retaining root opaque.
        def decode(value):
            return re.sub(r'\\(040|011|012|134)', lambda m: chr(int(m[1], 8)), value)
        result.append({'id': int(fields[0]), 'device': fields[2], 'root': decode(fields[3]),
                       'target': decode(fields[4]), 'type': fields[separator + 1]})
    return result


def check_mount(raw, path, mount_id, device, expected):
    _, target, kind, _ = QUERIES[expected]
    mounts = mount_fields(raw)
    selected = [m for m in mounts if m['target'] == target]
    require(len(selected) == 1, 'missing/stacked approved query mount: ' + expected)
    selected = selected[0]
    covering = [m for m in mounts if path == m['target'] or path.startswith(m['target'].rstrip('/') + '/')]
    require(max(covering, key=lambda m: len(m['target'])) == selected,
            'unexpected covering/bind query mount: ' + expected)
    require(selected['id'] == mount_id and selected['device'] == device and selected['type'] == kind,
            'query mount/held filesystem differs: ' + expected)
    require(kind != 'proc' or selected['root'] == '/', 'procfs mount is a redirected subtree')
    return selected


def open_exact(path):
    """Walk the supervisor/owned-leader root without following any path symlink."""
    require(path.startswith('/') and all(p not in ('', '.', '..') for p in path.split('/')[1:]),
            'redirected/noncanonical observed query target')
    number = os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        parts = path.split('/')[1:]
        for i, part in enumerate(parts):
            flags = os.O_CLOEXEC | os.O_NOFOLLOW
            flags |= os.O_RDONLY if i == len(parts) - 1 else os.O_PATH | os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=number)
            os.close(number)
            number = child
        return number
    except BaseException:
        os.close(number)
        raise


def namespaces(prefix):
    return {name: os.readlink(prefix + '/ns/' + name) for name in sorted(os.listdir(prefix + '/ns'))}


def process_identity(pid):
    # The caller also pins /proc/PID and a pidfd, and repeats this observation.
    raw = Path(f'/proc/{pid}/stat').read_text()
    fields = raw[raw.rindex(')') + 2:].split()
    status = Path(f'/proc/{pid}/status').read_text()
    def field(name):
        return re.search(r'^' + name + r':\s+(.+)$', status, re.MULTILINE)[1]
    return {'pid': int(raw.split(' ', 1)[0]), 'starttime': int(fields[19]),
            'ppid': int(fields[1]), 'pgrp': int(fields[2]), 'session': int(fields[3]),
            'tgid': int(field('Tgid')), 'tracer': int(field('TracerPid')),
            'uids': list(map(int, field('Uid').split()))}


def check_process(actual, expected, tracer, supervisor):
    require(actual == expected and actual['starttime'] > 0 and actual['pid'] == actual['tgid'],
            'owned leader identity/starttime changed or reused')
    require(actual['ppid'] == actual['tracer'] == tracer['pid'] and
            actual['pgrp'] == actual['session'] == tracer['pid'] and
            tracer['ppid'] == supervisor and all(uid == os.getuid() for uid in actual['uids']),
            'leader is not the independently owned traced process')


class KernelRuntimeQueries:
    """Retain real descriptors throughout the owned attempt and independent replay."""
    def __init__(self):
        self.fds = []
        self.value = {'kind': KIND, 'mountinfo': Path('/proc/self/mountinfo').read_text(),
                      'namespaces': namespaces('/proc/self'), 'queries': {}}
        self.tracer = None
        self.pidfd = self.procfd = None
        s = os.stat('/')
        self.root = [s.st_dev, s.st_ino]
        # Global probes can be held prelaunch. Process-relative self is bound only
        # after the original leader is independently observed, never to our inode.
        for path in QUERIES:
            if path != '/proc/self/cgroup':
                self.retain(path, path.replace('//', '/'))

    def retain(self, path, resolved):
        number = open_exact(resolved)
        self.fds.append(number)
        actual = ident(number)
        kind = fs_type(number)
        require(kind == QUERIES[path][3] and stat.S_ISREG(actual[2]),
                'wrong held query filesystem/type: ' + path)
        fdinfo = Path(f'/proc/self/fdinfo/{number}').read_text()
        mount_id = int(re.search(r'^mnt_id:\s+(\d+)$', fdinfo, re.MULTILINE)[1])
        device = f'{os.major(actual[0])}:{os.minor(actual[0])}'
        mount = check_mount(self.value['mountinfo'], resolved, mount_id, device, path)
        held = os.fstat(number)
        self.value['queries'][path] = {'resolved': resolved, 'identity': actual,
                'size': held.st_size, 'links': held.st_nlink,
                'fsType': kind, 'mount': mount, 'heldFd': number}

    def own_tracer(self, process):
        self.tracer = process_identity(process.pid)

    def bind_leader(self, pid, node, argv):
        require(self.tracer is not None, 'missing independently launched tracer')
        self.pidfd = os.pidfd_open(pid)
        self.fds.append(self.pidfd)
        self.procfd = os.open(f'/proc/{pid}', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self.fds.append(self.procfd)
        expected = process_identity(pid)
        self.value.update(leader=expected, tracer=self.tracer, supervisor=os.getpid())
        self.validate_leader(node, argv)
        self.retain('/proc/self/cgroup', f'/proc/{pid}/cgroup')
        self.validate_leader(node, argv)

    def validate_leader(self, node, argv):
        pid = self.value['leader']['pid']
        poll = select.poll()
        poll.register(self.pidfd, select.POLLIN)
        require(not poll.poll(0), 'owned leader exited before phase release')
        actual = process_identity(pid)
        check_process(actual, self.value['leader'], self.tracer, os.getpid())
        require(process_identity(self.tracer['pid']) == self.tracer, 'owned tracer identity changed')
        require(os.readlink(f'/proc/{pid}/exe') == os.path.realpath(node) and
                Path(f'/proc/{pid}/cmdline').read_bytes() == b'\0'.join(v.encode() for v in argv) + b'\0',
                'owned leader executable/argv differs')
        require(ident(self.procfd) == list(map(lambda k: getattr(os.stat(f'/proc/{pid}'), k),
                ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid'))), 'owned proc directory changed')
        require(namespaces(f'/proc/{pid}') == self.value['namespaces'] and
                Path(f'/proc/{pid}/mountinfo').read_text() == self.value['mountinfo'],
                'changed owned leader namespace/mountinfo')
        root = os.stat(f'/proc/{pid}/root')
        require([root.st_dev, root.st_ino] == self.root, 'changed owned leader root')
        self.validate_mounts()

    def validate_mounts(self):
        require(namespaces('/proc/self') == self.value['namespaces'] and
                Path('/proc/self/mountinfo').read_text() == self.value['mountinfo'],
                'changed supervisor namespace/mountinfo')
        for path, value in self.value['queries'].items():
            require(ident(value['heldFd']) == value['identity'] and fs_type(value['heldFd']) == value['fsType'],
                    'changed held query provenance: ' + path)
            # /proc/PID goes away after settlement; its pinned descriptor remains
            # the process-relative physical evidence. Re-resolve while live only.
            if path == '/proc/self/cgroup' and self.pidfd is not None:
                poll = select.poll()
                poll.register(self.pidfd, select.POLLIN)
                if poll.poll(0):
                    continue
            other = open_exact(value['resolved'])
            try:
                require(ident(other) == value['identity'] and fs_type(other) == value['fsType'],
                        'redirected query path: ' + path)
            finally:
                os.close(other)

    def close(self):
        for number in reversed(self.fds):
            os.close(number)
        self.fds = []


def retained_contract(value, leader):
    """Validate supervisor-retained structure; producer JSON is never input here."""
    require(value is not None and value['kind'] == KIND and value['leader']['pid'] == leader,
            'missing trusted-kernel-runtime-query provenance')
    require(set(value['queries']) == set(QUERIES), 'missing exact native query observations')
    check_process(value['leader'], value['leader'], value['tracer'], value['supervisor'])
    for path, item in value['queries'].items():
        resolved = f'/proc/{leader}/cgroup' if path == '/proc/self/cgroup' else path.replace('//', '/')
        require(item['resolved'] == resolved, 'redirected retained query target')
        dev, ino, mode, _, _ = item['identity']
        require(ino > 0 and stat.S_ISREG(mode) and item['fsType'] == QUERIES[path][3],
                'wrong retained query filesystem/identity')
        require(item['mount'] == check_mount(value['mountinfo'], resolved, item['mount']['id'],
                f'{os.major(dev)}:{os.minor(dev)}', path), 'changed retained mount observation')
    require(value['verifiedBeforeRelease'] is True and value['traceAnchorLine'] > 0,
            'missing independent pre-release process observation')
    return value['queries']
