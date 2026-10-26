"""DRAFT finite Linux bootstrap replay. No production or connected capability.

Only supervisor-retained originals are inputs. Timing waits assume cooperative
Node threads; this is not an arbitrary-memory verifier. No private/resource file
may be mapped. Every decoded event remains in the replay and trace digest.
"""
import base64
from collections import Counter
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from controlled_contract import BOUNDARY_PASSIVE, require, wire
from verify import SUPPORTED as CANDIDATE_SUPPORTED, FD_FIRST, fd, identity, string
from kernel_runtime_queries import QUERIES as NATIVE_QUERIES, retained_contract
from controlled_timestamps import timestamped_events

LIMIT = 256 * 1024 * 1024
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
# link is decoded below only as private exclusive publication; kill only as the
# original leader's zero-signal liveness probe. Candidate vocabulary is untouched.
SUPPORTED = CANDIDATE_SUPPORTED | {'link', 'kill'}
FORBIDDEN = {'io_uring_setup', 'fcntl64', 'ftruncate', 'umask', 'tgkill'}
FILE_OPS = {'read', 'pread64', 'write', 'writev', 'readv', 'lseek', 'fsync', 'fdatasync', 'getdents64'}
STAT_CALLS = {'statx', 'fstat', 'newfstatat', 'stat', 'lstat'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(path):
    if path == '/':
        return True
    return (path.startswith('/') and all(p not in ('', '.', '..') for p in path.split('/')[1:])
            and '\0' not in path and not path.startswith(('/proc/self/fd/', '/proc/thread-self/fd/', '/dev/fd/')))


def positive_result(value):
    require(re.fullmatch(r'\d+', value) is not None, 'missing complete syscall result')
    return int(value)


def physical_fields(call, args):
    text = ', '.join(args)
    if call == 'statx':
        fields = dict(re.findall(r'\b(stx_(?:ino|dev_major|dev_minor|uid|gid|size|nlink))=(\d+)', text))
        require(len(fields) == 7, 'incomplete statx physical fields')
        kind = re.search(r'stx_mode=(S_IF\w+)\|((?:(?:S_ISVTX|S_ISUID|S_ISGID)\|)*[0-7]+)', text)
        require(kind is not None, 'missing statx mode')
        values = [int(fields['stx_' + k]) for k in ('dev_major', 'dev_minor', 'ino', 'uid', 'gid', 'size', 'nlink')]
    else:
        fields = dict(re.findall(r'\b(st_(?:ino|uid|gid|size|nlink))=(\d+)', text))
        device = re.search(r'st_dev=makedev\((0x[0-9a-f]+|\d+), (0x[0-9a-f]+|\d+)\)', text)
        kind = re.search(r'st_mode=(S_IF\w+)\|((?:(?:S_ISVTX|S_ISUID|S_ISGID)\|)*[0-7]+)', text)
        if kind and kind[1] == 'S_IFCHR' and 'st_size' not in fields:
            fields['st_size'] = '0'  # strace's character-device decoder omits size.
        require(len(fields) == 5 and device is not None and kind is not None, 'incomplete stat physical fields')
        values = [int(v, 16 if v.startswith('0x') else 10) for v in device.groups()]
        values += [int(fields['st_' + k]) for k in ('ino', 'uid', 'gid', 'size', 'nlink')]
    types = {'S_IFREG': stat.S_IFREG, 'S_IFDIR': stat.S_IFDIR, 'S_IFIFO': stat.S_IFIFO,
             'S_IFCHR': stat.S_IFCHR, 'S_IFSOCK': stat.S_IFSOCK}
    require(kind[1] in types, 'unknown physical type')
    parts = kind[2].split('|')
    mode = types[kind[1]] | int(parts[-1], 8)
    for bit in parts[:-1]:
        mode |= {'S_ISVTX': stat.S_ISVTX, 'S_ISUID': stat.S_ISUID, 'S_ISGID': stat.S_ISGID}[bit]
    return tuple(values[:3]), mode, values[3], values[4], values[5], values[6]


@dataclass(eq=False)
class Object:
    family: str
    mode: int
    names: set = field(default_factory=set)
    data: bytes = b''
    physical: tuple | None = None
    uid: int = field(default_factory=os.getuid)
    gid: int = field(default_factory=os.getgid)
    writes: int = 0
    writer_closed: bool = False
    synced: bool = False
    published: bool = False
    directory_synced: bool = False
    stats: set = field(default_factory=set)
    creation_completion: int | None = None
    last_write_completion: int | None = None
    data_sync_entry: int | None = None
    data_sync_completion: int | None = None
    writer_close_entry: int | None = None
    writer_close_completion: int | None = None
    publication_entry: int | None = None
    publication_completion: int | None = None
    publication_method: str | None = None
    publication_parent: object | None = field(default=None, repr=False)
    publication_path: str | None = None
    publication_temporary_path: str | None = None
    directory_sync_entry: int | None = None
    directory_sync_completion: int | None = None
    temporary_cleanup_entry: int | None = None
    temporary_cleanup_completion: int | None = None
    durable_publication_completion: int | None = None


@dataclass
class Handle:
    obj: Object
    flags: set
    position: int = 0
    directory_seen: set = field(default_factory=set)
    directory_eof: bool = False
    query_bytes: bytes = b''
    query_eof: bool = False
    physical_bound: bool = False
    native_read: bool = False


class Replay:
    def __init__(self, original):
        self.original = original
        self.base = original['base']
        self.leader = original['leaderPid']
        self.umask = original['inheritedUmask']
        require(self.umask in {0o022, 0o077}, 'unreviewed inherited umask')
        self.paths, self.handles, self.inodes = {}, {}, {}
        self.query_objects = {}
        self.native_queries = (retained_contract(original['kernelRuntimeQueries'], self.leader)
                               if 'kernelRuntimeQueries' in original else {})
        self.native_completed = []
        self.javascript_opened = False
        self.objects, self.resources, self.marks, self.waits = [], [], [], []
        self.threads, self.settled = {self.leader}, set()
        self.used_paths = set()
        self.inherited_cloexec = set()
        self.open_intervals, self.descriptor_intervals = [], []
        self.pending_intervals = []
        self.total_written, self.counts = 0, Counter()
        self.execs = 0
        self.entry_times = {}
        self.initial = original['immutable']
        for path, value in original['directories'].items():
            self.add_original(path, value, b'', 'original-directory')
        for path, value in self.initial.items():
            self.add_original(path, value['identity'], bytes.fromhex(value['hex']), value['family'])
        for number, value in original['descriptors'].items():
            number = int(number)
            family = value['family']
            obj = Object(family, value['identity'][2])
            dev, ino, _, obj.uid, obj.gid = value['identity']
            obj.physical = (os.major(dev), os.minor(dev), ino)
            if family == 'lifetime':
                require(obj.physical in self.inodes, 'missing original lifetime file')
                obj = self.inodes[obj.physical]
            self.handles[number] = Handle(obj, set(value['flags']))
            self.objects.append(obj)
        self.command = original['commandFd']
        self.ack = original['ackFd']
        self.lifetime = original['lifetimeFd']
        require(len({self.command, self.ack, self.lifetime}) == 3, 'aliased inherited control descriptors')
        require(original['lane'] == 'bootstrap', 'connected replay is not implemented')
        require(len(original['phases']) == 1 and original['phases'][0]['name'] == 'bootstrap', 'wrong bootstrap phase plan')
        require(re.fullmatch(r'[0-9a-f]{64}', original['phases'][0]['token']) is not None, 'bad retained token')
        require(original['phases'][0]['token'] not in original['usedTokens'], 'replayed retained token')

    def add_original(self, path, value, data, family):
        dev, ino, mode, uid, gid = value
        obj = Object(family, mode, {path}, data, (os.major(dev), os.minor(dev), ino), uid, gid)
        previous = self.inodes.get(obj.physical)
        # Explicit runtime aliases retained before launch may name the same inode.
        if previous is not None:
            require(family == previous.family == 'runtime' and previous.data == data,
                    'unplanned original physical alias')
            previous.names.add(path)
            self.paths[path] = previous
            return
        self.paths[path] = obj
        self.objects.append(obj)
        self.inodes[obj.physical] = obj
        self.used_paths.add(path)

    def family(self, path):
        require(canonical(path), 'noncanonical/descriptor alias path: ' + path)
        if path in self.paths and path in self.original['directories'] | self.initial:
            return self.paths[path].family
        relative = path.removeprefix(self.base + '/')
        require(relative != path, 'unretained external path: ' + path)
        pid = str(self.leader)
        specs = [
            ('control-record', r'control/(?:intent|enrolled)\.json'),
            ('sidecar', r'workspace/orca\.permissions\.json'),
            ('sidecar-temp', r'workspace/orca\.permissions\.json\.' + pid + r'\.tmp'),
            ('credentials', r'credentials\.json'),
            ('credentials-temp', r'credentials\.json\.' + pid + r'\.[0-9a-f]{8}\.tmp'),
            ('lease', r'workspace/\.orca/leases/run%3Acontrolled\.json'),
            ('lease-temp', r'workspace/\.orca/leases/run%3Acontrolled\.json\.' + pid + r'\.[a-z0-9]{1,32}\.tmp'),
            ('protected', r'workspace/\.orca/private-execution/(?:\.execution-key|controlled\.inputs\.json|(?:' + UUID + r'|capture%3Asynthetic-read%3A' + UUID + r'%3Aaction|synthetic-read%3A' + UUID + r'%3Aevidence)\.payload\.json)'),
            ('resource-directory', r'orca-owned-service-[A-Za-z0-9]{6}'),
            ('resource', r'orca-owned-service-[A-Za-z0-9]{6}/fixture'),
            ('state-directory', r'workspace/\.orca/(?:private-execution|leases|runs)'),
        ]
        for family, pattern in specs:
            if re.fullmatch(pattern, relative):
                return family
        suffix = re.fullmatch(r'(.+)\.(' + UUID + r')\.tmp', path)
        if suffix and self.family(suffix[1]) == 'protected':
            return 'protected-temp'
        lock = re.fullmatch(r'(.+)\.lock', path)
        if lock:
            if lock[1].endswith('.mutation'):
                require(self.family(lock[1][:-9]) == 'lease', 'unknown lease lock')
            else:
                require(self.family(lock[1]) in {'sidecar', 'credentials'}, 'unknown writer lock')
            return 'lock-directory'
        token = re.fullmatch(r'(.+)/owner\.' + pid + r'\.(' + UUID + r')\.json', path)
        if token:
            require(self.family(token[1]) == 'lock-directory', 'unknown token directory')
            return 'lock-token'
        raise RuntimeError('unclassified private path: ' + path)

    def path(self, value):
        path = string(value).decode('utf-8')
        if path in self.original['queries']:
            return path
        require(canonical(path), 'noncanonical/descriptor path alias: ' + path)
        return path

    def bind(self, obj, call, args):
        physical, mode, uid, gid, size, links = physical_fields(call, args)
        if obj.family == 'runtime-query':
            require(physical[2] > 0, 'query has no positive physical inode')
        require((mode, uid, gid) == (obj.mode, obj.uid, obj.gid), 'changed mode/owner physical binding')
        if obj.physical is None:
            require(physical not in self.inodes or self.inodes[physical] is obj, 'unexpected physical alias')
            obj.physical = physical
            self.inodes[physical] = obj
        require(obj.physical == physical, 'changed inode/descriptor binding')
        require(not hasattr(obj, 'directory_inode') or obj.directory_inode == physical[2],
                'directory-entry inode differs from descriptor identity')
        if obj.family == 'trusted-kernel-runtime-query':
            observation = self.native_queries[next(iter(obj.names))]
            require((size, links) == (observation['size'], observation['links']),
                    'changed native query stat size/links')
        elif stat.S_ISREG(mode):
            require(size == len(obj.data) and links == len(obj.names), 'changed file size/link lineage')
            obj.stats.add(links)
        if obj.family == 'resource':
            require(call == 'statx', 'unsupported resource timestamp decoder')
            times = {}
            for name in ('mtime', 'ctime', 'btime'):
                match = re.search(r'stx_' + name + r'=\{tv_sec=(\d+), tv_nsec=(\d+)\}', ', '.join(args))
                require(match is not None and int(match[2]) < 10**9, 'missing/invalid resource timestamp')
                times[name] = int(match[1]) * 10**9 + int(match[2])
            require(not hasattr(obj, 'birth_ns') or obj.birth_ns == times['btime'], 'changed resource birth identity')
            obj.birth_ns = times['btime']
            obj.resource_stamps = getattr(obj, 'resource_stamps', set()) | {(
                os.makedev(*physical[:2]), physical[2], mode, uid, gid, links, size, times['mtime'], times['ctime'])}

    def bytes(self, encoded, expected, obj):
        if encoded.endswith('"...'):
            require(obj.family in {'image', 'runtime'}, 'truncated mutable/resource bytes')
            prefix = string(encoded[:-3])
            require(expected.startswith(prefix) and len(prefix) == 131072,
                    'abbreviated original read prefix differs')
        else:
            require(string(encoded) == expected, 'syscall bytes differ from reconstructed original/content')

    def publication_sequence_completion(self, obj):
        """Additive causal index, unavailable until this exact file settles.

        Indices are raw zero-based completion lines, never wall-clock estimates.
        A link's temporary unlink completes after the qualifying parent fsync;
        rename removes the temporary alias atomically before its parent fsync.
        """
        if not (obj.published and obj.writer_closed and obj.synced and obj.directory_synced):
            return None
        values = [obj.creation_completion, obj.data_sync_entry, obj.data_sync_completion,
                  obj.writer_close_entry, obj.writer_close_completion, obj.publication_entry,
                  obj.publication_completion, obj.directory_sync_entry, obj.directory_sync_completion,
                  obj.temporary_cleanup_entry, obj.temporary_cleanup_completion]
        if any(value is None for value in values):
            return None
        if (getattr(obj, 'creation_entry', None) not in self.entry_times or
                any(value not in self.entry_times for value in values)):
            return None
        last_data = obj.creation_completion if obj.last_write_completion is None else obj.last_write_completion
        if not (obj.creation_completion <= last_data < obj.data_sync_entry <= obj.data_sync_completion < obj.writer_close_entry <=
                obj.writer_close_completion < obj.publication_entry <= obj.publication_completion <
                obj.directory_sync_entry <= obj.directory_sync_completion):
            return None
        if obj.publication_method == 'link':
            if not obj.directory_sync_completion < obj.temporary_cleanup_entry <= obj.temporary_cleanup_completion:
                return None
        elif obj.publication_method == 'rename':
            if (obj.temporary_cleanup_entry, obj.temporary_cleanup_completion) != (
                    obj.publication_entry, obj.publication_completion):
                return None
        else:
            return None
        if (obj.publication_parent is None or obj.publication_parent.physical is None or
                self.paths.get(obj.publication_path) is not obj or obj.names != {obj.publication_path}):
            return None
        return max(obj.directory_sync_completion, obj.temporary_cleanup_completion)

    def durable_publication(self, obj):
        # A complete syscall sequence alone is not a physical publication proof.
        # Write-only payloads acquire their final physical binding in run().
        obj.durable_publication_completion = (self.publication_sequence_completion(obj)
                                               if obj.physical is not None else None)

    def epoll_bindings(self, epoll):
        watches = getattr(epoll, 'watches', {})
        bindings = getattr(epoll, 'watch_handles', {})
        require(set(bindings) == set(watches), 'missing epoll watched-handle binding')
        for number, watched in watches.items():
            require(self.handles.get(number) is bindings[number] and bindings[number].obj is watched,
                    'epoll watched descriptor closed/reused')
        return bindings

    def invalidate_watched_close(self, obj):
        # The supported lane has no dup/descriptor transfer. Do not retain event
        # data once the last supported handle for the watched object disappears.
        if any(handle.obj is obj for handle in self.handles.values()):
            return
        for handle in self.handles.values():
            epoll = handle.obj
            if epoll.family != 'epoll':
                continue
            for number, watched in list(epoll.watches.items()):
                if watched is obj:
                    del epoll.watches[number]
                    epoll.registered_data.pop(number, None)
                    epoll.watch_handles.pop(number, None)

    def wait(self, record):
        _, call, args, _, _, _ = record
        if call == 'futex':
            if args[1] == 'FUTEX_WAIT_PRIVATE':
                return len(args) == 4 and re.fullmatch(r'\d+', args[2]) is not None and args[3] == 'NULL'
            if args[1] == 'FUTEX_WAIT_BITSET_PRIVATE|FUTEX_CLOCK_REALTIME':
                return len(args) == 5 and re.fullmatch(r'\d+', args[2]) is not None and args[3:] == ['NULL', 'FUTEX_BITSET_MATCH_ANY']
            return False
        if call == 'epoll_pwait':
            handle = self.handles.get(fd(args[0]))
            require(handle is not None and handle.obj.family == 'epoll', 'unretained epoll wait')
            require(len(args) == 6 and args[2] == '1024' and
                    (args[3] == '-1' or args[3].isdigit() and int(args[3]) <= 60000) and
                    args[4:] == ['NULL', '8'], 'unknown epoll wait shape')
            require(bool(getattr(handle.obj, 'watches', {})) and all(
                watched.family in {'pipe', 'eventfd'} for watched in handle.obj.watches.values()),
                'epoll wait on unverified registrations')
            self.epoll_bindings(handle.obj)
            count = positive_result(record[3])
            require(count <= 1024, 'epoll wait result exceeds bounded result array')
            returned = args[1]
            require(returned.startswith('[') and returned.endswith(']'), 'incomplete epoll result array')
            entries = list(re.finditer(r'\{events=(EPOLLIN), data=(0x[0-9a-f]+|\d+)\}', returned[1:-1]))
            require(', '.join(e[0] for e in entries) == returned[1:-1] and len(entries) == count,
                    'unknown epoll result shape/count')
            registered = getattr(handle.obj, 'registered_data', {})
            require(set(registered) == set(handle.obj.watches), 'missing epoll registration data')
            for entry in entries:
                require(fd(entry[2]) in registered.values(), 'epoll result data not registered')
            return True
        return False

    def run(self, text):
        require(len(text.encode()) <= LIMIT, 'trace exceeds 256 MiB bound')
        records, self.entry_times = timestamped_events(text, self.original)
        if self.native_queries:
            anchor = self.original['kernelRuntimeQueries']['traceAnchorLine']
            leader_records = [r for r in records if r[0] == self.leader]
            require(leader_records and leader_records[0][1] == 'execve' and leader_records[0][5] <= anchor and
                    leader_records[-1][1] == 'settled' and leader_records[-1][4] > anchor,
                    'independent process observation is outside traced leader lifetime')
        for record in records:
            try:
                self.check_intervals(record)
                self.event(record)
            except (RuntimeError, KeyError, ValueError, IndexError) as error:
                raise RuntimeError(f'line {record[4]} {record[1]}: {error}') from error
        require(self.execs == 1 and self.threads == self.settled, 'incomplete process settlement')
        require(len(self.marks) == 2, 'missing bootstrap command/ack')
        if self.native_queries:
            require(self.native_completed == list(NATIVE_QUERIES) and self.javascript_opened and
                    self.original['kernelRuntimeQueries']['traceAnchorLine'] < self.marks[0][5],
                    'native observations not correlated before phase release')
        wait_entries = {r[4] for r in self.waits}
        mark_entries = {r[4] for r in self.marks}
        for record in records:
            if record[4] in mark_entries or record[1] in BOUNDARY_PASSIVE or record[4] in wait_entries:
                continue
            require(not any(record[4] <= m[5] and record[5] >= m[4] for m in self.marks),
                    'effect crosses phase boundary interval')
        require(len(self.resources) == 1, 'missing/ambiguous service resource')
        obj = self.resources[0]
        require(obj.names == set() and obj.physical is not None and obj.stats >= {0, 1} and
                not any(h.obj is obj for h in self.handles.values()), 'unsettled resource lineage')
        require(obj.data == bytes.fromhex(self.original['inputHex']), 'resource content differs')
        require(len(getattr(obj, 'reads', [])) == 1, 'bootstrap must have exactly one actual service read')
        for a, b in self.open_intervals:
            require(not (a <= obj.unlink_completion and b >= obj.creation_entry), 'ambiguous open intersects named resource lifetime')
        for a, b, target in self.descriptor_intervals:
            if target is obj:
                require(a == b, 'ambiguous resource descriptor interval')
        require(not any(stat.S_ISREG(h.obj.mode) and h.obj.family not in {'lifetime'}
                        for h in self.handles.values()), 'unclosed regular file descriptor')
        # Independently compare every final named state file with replayed bytes and
        # its observed physical identity; no child semanticRefs list selects files.
        for path, item in self.paths.items():
            if item.family in {'runtime-query', 'root-query'}:
                continue
            info = Path(path).stat() if item.family == 'runtime' else Path(path).lstat()
            if item.physical is None:
                # A write-only immutable payload may never be reread by the child.
                # Its successful exclusive-create -> synced-close -> link ->
                # directory-sync -> temp-unlink lineage is replayed above. Bind
                # the surviving name by our OWN readonly descriptor observation,
                # never a producer JSON inode. Other missing identities refuse.
                require(item.family == 'protected-temp' and item.published and item.synced and
                        item.directory_synced and item.writer_closed and len(item.names) == 1,
                        'missing physical observation without immutable publication lineage')
                require(self.publication_sequence_completion(item) is not None,
                        'missing completion-ordered durable publication observation')
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    held = os.fstat(descriptor)
                    physical = (os.major(held.st_dev), os.minor(held.st_dev), held.st_ino)
                    require(physical not in self.inodes, 'published file aliases another physical object')
                    require((held.st_mode, held.st_uid, held.st_gid, held.st_nlink, held.st_size) ==
                            (item.mode, item.uid, item.gid, 1, len(item.data)), 'published physical bounds differ')
                    data = b''
                    while len(data) <= 65536:
                        chunk = os.read(descriptor, 65537 - len(data))
                        if not chunk:
                            break
                        data += chunk
                    named = Path(path).lstat()
                    require(data == item.data and identity(path) ==
                            [held.st_dev, held.st_ino, held.st_mode, held.st_uid, held.st_gid] and
                            (named.st_mtime_ns, named.st_ctime_ns, named.st_size) ==
                            (held.st_mtime_ns, held.st_ctime_ns, held.st_size), 'published descriptor/name bytes changed')
                    item.physical = physical
                    self.inodes[physical] = item
                finally:
                    os.close(descriptor)
            require((os.major(info.st_dev), os.minor(info.st_dev), info.st_ino) == item.physical,
                    'final named inode differs/missing physical observation: ' + path)
            if stat.S_ISREG(item.mode):
                require(Path(path).read_bytes() == item.data, 'final named file bytes differ')
            if item.published:
                self.durable_publication(item)
        return {'record': 'controlled-bootstrap-kernel-evidence', 'authority': 'none',
                'traceSha256': sha(text.encode()), 'traceBytes': len(text.encode()),
                'settledThreads': len(self.settled), 'serviceReads': 1,
                'resourcePhysical': list(obj.physical), 'resultHex': obj.reads[0].hex(),
                'waitIntervalsRetained': len(self.waits), 'syscalls': dict(self.counts)}

    def event(self, record):
        pid, call, args, result, entered, completed = record
        self.counts[call] += 1
        require(call in SUPPORTED, 'unsupported syscall')
        require(pid in self.threads and pid not in self.settled, 'unknown/settled process')
        if call == 'execve':
            self.execs += 1
            require(pid == self.leader and self.execs == 1 and string(args[0]).decode() == self.original['node'] and
                    args[1] == '[' + ', '.join(json.dumps(v) for v in self.original['argv']) + ']' and result == '0', 'changed exec')
            return
        require(self.execs == 1, 'event before original exec')
        if call == 'settled':
            self.settled.add(pid)
            return
        if call in {'clone', 'clone3'}:
            require('CLONE_NEW' not in ','.join(args), 'namespace-changing clone')
            if result.startswith(('-1 ENOSYS ', '-1 EAGAIN ')):
                return
            require(all(flag in ','.join(args) for flag in ('CLONE_THREAD', 'CLONE_FILES', 'CLONE_VM', 'CLONE_SIGHAND')),
                    'unsupported process clone')
            child = positive_result(result)
            require(child not in self.threads, 'duplicate thread')
            self.threads.add(child)
            return
        if call == 'io_uring_setup' and result.startswith(('-1 EPERM ', '-1 ENOSYS ')):
            return
        require(call not in FORBIDDEN, 'unsupported process/descriptor mutation')
        if call == 'kill':
            require(args == [str(self.leader), '0'] and result == '0', 'not original zero-signal liveness probe')
            return
        if call == 'futex':
            # Non-boundary WAKE is normal Node synchronization. Mutating/unknown
            # PI/WAKE_OP commands never inherit a syscall-name exception.
            require(args[1] in {'FUTEX_WAKE_PRIVATE', 'FUTEX_WAIT_PRIVATE',
                    'FUTEX_WAIT_BITSET_PRIVATE|FUTEX_CLOCK_REALTIME', 'FUTEX_WAIT_BITSET|FUTEX_CLOCK_REALTIME'},
                    'unknown/mutating futex opcode')
            if entered != completed and self.wait(record):
                self.waits.append(record)
            return
        if call in {'epoll_create1', 'eventfd2', 'pipe2'}:
            if result.startswith('-1 '):
                raise RuntimeError('unexpected descriptor factory failure')
            numbers = [fd(v) for v in args[0].strip('[]').split(', ')] if call == 'pipe2' else [positive_result(result)]
            if call == 'pipe2':
                require(result == '0' and len(numbers) == 2 and args[1] in {'O_CLOEXEC', 'O_NONBLOCK|O_CLOEXEC'}, 'unknown pipe flags')
            elif call == 'epoll_create1':
                require(args == ['EPOLL_CLOEXEC'], 'unknown epoll creation flags')
            else:
                require(args == ['0', 'EFD_CLOEXEC|EFD_NONBLOCK'], 'unknown eventfd creation flags')
            family = {'pipe2': 'pipe', 'epoll_create1': 'epoll', 'eventfd2': 'eventfd'}[call]
            for number in numbers:
                require(number not in self.handles, 'descriptor factory replacement')
                obj = Object(family, stat.S_IFIFO | 0o600)
                obj.watches = {}
                obj.registered_data = {}
                obj.watch_handles = {}
                self.handles[number] = Handle(obj, set())
            return
        if call == 'openat':
            require(args[0] == 'AT_FDCWD', 'relative descriptor open')
            path = self.path(args[1])
            if path in self.original['absentProbes']:
                require(args[2:] == ['O_RDONLY|O_CLOEXEC'] and result.startswith('-1 ENOENT '),
                        'original absent probe changed or acquired a descriptor')
                return
            family = self.family(path) if path not in self.original['queries'] else 'runtime-query'
            if path in NATIVE_QUERIES:
                require(path in getattr(self, 'native_queries', {}),
                        'missing trusted-kernel-runtime-query provenance: ' + path)
                require(pid == self.leader and not self.javascript_opened and entered == completed and
                        self.native_completed == list(NATIVE_QUERIES)[:len(self.native_completed)] and
                        len(self.native_completed) < len(NATIVE_QUERIES) and
                        path == list(NATIVE_QUERIES)[len(self.native_completed)] and
                        not any(h.obj.family == 'trusted-kernel-runtime-query' for h in self.handles.values()) and
                        args[2:] == ['O_RDONLY|O_CLOEXEC'] and result.isdigit(),
                        'native query outside exact original-leader startup sequence')
                family = 'trusted-kernel-runtime-query'
            if path in getattr(self, 'initial', {}) and self.initial[path]['family'] == 'image':
                if getattr(self, 'native_queries', {}):
                    require(self.native_completed == list(NATIVE_QUERIES), 'JavaScript entry before native query settlement')
                self.javascript_opened = True
            if entered != completed:
                self.open_intervals.append((entered, completed))
            if result.startswith('-1 '):
                require(result.startswith('-1 ENOENT ') and path not in self.paths, 'unexpected failed open')
                return
            number, flags = positive_result(result), set(args[2].split('|'))
            require(number not in self.handles, 'open replaces unclosed descriptor')
            if flags & {'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_APPEND', 'O_TRUNC'}:
                require(path not in self.used_paths and family in {'control-record', 'sidecar-temp', 'credentials-temp',
                        'lease-temp', 'protected-temp', 'lock-token', 'resource'}, 'unknown/nonfresh private writer')
                exclusive = family not in {'credentials-temp', 'lease-temp'}
                expected = {'O_WRONLY', 'O_CREAT', 'O_CLOEXEC'} | ({'O_EXCL'} if exclusive else set())
                if family == 'control-record':
                    expected.add('O_NOFOLLOW')
                else:
                    expected.add('O_TRUNC')
                mode = '0400' if family == 'resource' else '0666' if family in {'lease-temp', 'lock-token'} else '0600'
                require(flags == expected and len(args) == 4 and args[3] == mode, 'private writer flags/mode differ')
                parent = self.paths.get(str(Path(path).parent))
                require(parent is not None and stat.S_ISDIR(parent.mode), 'writer outside retained/created directory')
                obj = Object(family, stat.S_IFREG | (int(mode, 8) & ~self.umask), {path})
                obj.creation_entry = entered
                obj.creation_completion = completed
                self.paths[path] = obj
                self.objects.append(obj)
                self.used_paths.add(path)
                if family == 'resource':
                    require(pid == self.leader and not self.resources, 'extra/thread-created resource')
                    require(entered in self.entry_times, 'resource create lacks original entry timestamp')
                    obj.creation_record = record
                    obj.creation_path = path
                    self.resources.append(obj)
            else:
                require(flags in ({'O_RDONLY', 'O_CLOEXEC'}, {'O_RDONLY'},
                        {'O_RDONLY', 'O_NONBLOCK', 'O_NOFOLLOW', 'O_CLOEXEC'}, {'O_RDONLY', 'O_NOFOLLOW', 'O_CLOEXEC'},
                        {'O_RDONLY', 'O_NOFOLLOW', 'O_CLOEXEC', 'O_DIRECTORY'},
                        {'O_RDONLY', 'O_NONBLOCK', 'O_CLOEXEC', 'O_DIRECTORY'}), 'unknown readonly flags')
                obj = self.paths.get(path)
                if family == 'trusted-kernel-runtime-query':
                    value = self.native_queries[path]['identity']
                    dev, ino, mode, uid, gid = value
                    physical = (os.major(dev), os.minor(dev), ino)
                    require(physical not in self.inodes, 'native query physical alias')
                    obj = Object(family, mode, {path}, physical=physical, uid=uid, gid=gid)
                    self.inodes[physical] = obj
                    self.objects.append(obj)
                if obj is None and family == 'runtime-query':
                    require(self.query_flags(path, flags), 'query readonly flags differ from exact role')
                    if path == f'/proc/self/fdinfo/{self.lifetime}':
                        require(pid == self.leader, 'source lifetime query opened by unexpected thread')
                    meta = self.original['queryMetadata'][path]
                    require(stat.S_ISREG(meta[0]), 'query original is not regular')
                    obj = self.query_objects.get(path)
                    if obj is None:
                        obj = Object(family, meta[0], {path}, uid=meta[1], gid=meta[2])
                        self.query_objects[path] = obj
                require(obj is not None, 'open without original/create lineage')
                if stat.S_ISREG(obj.mode) and obj.family not in {
                        'runtime', 'image', 'original-file', 'lifetime', 'enrollment-witness', 'runtime-query',
                        'trusted-kernel-runtime-query'}:
                    require(obj.writer_closed, 'private readonly open before writer settlement')
                if obj.family == 'resource':
                    require(pid == self.leader and obj.writer_closed and
                            flags == {'O_RDONLY', 'O_NONBLOCK', 'O_NOFOLLOW', 'O_CLOEXEC'}, 'resource readonly reopen lineage')
                    require(not hasattr(obj, 'reader'), 'second resource readonly reopen')
                    obj.reader = number
            if self.resources and self.resources[0].names:
                require(obj is self.resources[0], 'unrelated open during named-resource lifetime')
            self.handles[number] = Handle(obj, flags)
            return
        if call in {'mkdir', 'unlink', 'rmdir', 'rename', 'link', 'chmod'}:
            path = self.path(args[0])
            family = self.family(path)
            obj = self.paths.get(path)
            if result.startswith('-1 '):
                require((call == 'mkdir' and obj is not None and result.startswith('-1 EEXIST ')) or
                        (call == 'unlink' and obj is not None and stat.S_ISDIR(obj.mode) and result.startswith('-1 EISDIR ')),
                        'unexpected failed namespace effect')
                return
            require(result == '0', 'unknown namespace result')
            if call == 'mkdir':
                require(obj is None and family in {'state-directory', 'lock-directory', 'resource-directory'}, 'unknown/repeated mkdir')
                require(args[1] == ('0700' if family == 'resource-directory' or path.endswith('/private-execution') else '0777'), 'mkdir mode')
                require(str(Path(path).parent) in self.paths, 'mkdir parent absent')
                obj = Object(family, stat.S_IFDIR | (int(args[1], 8) & ~self.umask), {path})
                self.paths[path] = obj
                self.objects.append(obj)
            elif call == 'chmod':
                require(obj is not None and family == obj.family == 'credentials-temp' and args[1] == '0600', 'unplanned chmod')
            elif call in {'link', 'rename'}:
                target = self.path(args[1])
                target_family = self.family(target)
                allowed = {('protected-temp', 'protected'), ('lease-temp', 'lease')} if call == 'link' else {
                    ('sidecar-temp', 'sidecar'), ('credentials-temp', 'credentials'), ('lease-temp', 'lease')}
                require(obj is not None and (obj.family, target_family) in allowed and obj.writer_closed,
                        'unsupported publication lineage')
                require(family == obj.family and not obj.published, 'publication source is not the original unpublished temporary')
                require(str(Path(path).parent) == str(Path(target).parent), 'cross-parent publication')
                if call == 'link':
                    require(target not in self.paths and (obj.family != 'protected-temp' or obj.synced), 'nonexclusive/unsynced publication')
                if target in self.paths:
                    previous = self.paths[target]
                    require(previous.family == obj.family or target_family in {'credentials', 'sidecar', 'lease'}, 'publication replaces another family')
                    previous.names.remove(target)
                    previous.durable_publication_completion = None
                self.paths[target] = obj
                obj.names.add(target)
                obj.published = True
                obj.publication_entry, obj.publication_completion = entered, completed
                obj.publication_method = call
                obj.publication_parent = self.paths.get(str(Path(target).parent))
                obj.publication_path, obj.publication_temporary_path = target, path
                if call == 'rename':
                    del self.paths[path]
                    obj.names.remove(path)
                    obj.temporary_cleanup_entry, obj.temporary_cleanup_completion = entered, completed
                self.durable_publication(obj)
            elif call == 'unlink':
                require(obj is not None and family in {'enrollment-witness', 'protected-temp', 'lease-temp', 'lock-token', 'resource'},
                        'unplanned unlink')
                if obj.family in {'protected-temp', 'lease-temp'}:
                    require(obj.published and obj.writer_closed and (obj.family != 'protected-temp' or obj.directory_synced),
                            'temporary removed before complete publication')
                if obj.family == 'resource':
                    require(pid == self.leader and hasattr(obj, 'reader') and obj.writer_closed, 'resource unlink before readonly open')
                    obj.unlink_completion = completed
                del self.paths[path]
                obj.names.remove(path)
                if obj.published and path == obj.publication_temporary_path:
                    obj.temporary_cleanup_entry, obj.temporary_cleanup_completion = entered, completed
                    self.durable_publication(obj)
            else:
                require(obj is not None and obj.family in {'lock-directory', 'resource-directory'} and
                        not any(p.startswith(path + '/') for p in self.paths), 'rmdir before empty/private settlement')
                del self.paths[path]
                obj.names.remove(path)
            return
        if call in STAT_CALLS:
            if result.startswith('-1 '):
                require(result.startswith('-1 ENOENT '), 'failed metadata observation')
                require(not args[0].isdigit(), 'failed descriptor metadata cannot establish physical identity')
                index = 0 if call in {'stat', 'lstat'} else 1
                path = self.path(args[index])
                require(path not in self.paths and path not in self.original['queries'], 'ENOENT contradicts retained/live target')
                if path not in self.original['absentProbes']:
                    require(path in self.initial or self.family(path), 'ENOENT target lacks original/planned lineage')
                return
            require(result == '0', 'unknown metadata result')
            if re.fullmatch(r'\d+', args[0]):
                if call != 'fstat':
                    require(args[1] == '\"\"' and 'AT_EMPTY_PATH' in args[2], 'unmodeled descriptor-relative stat')
                obj = self.handles.get(fd(args[0]))
                require(obj is not None, 'stat unknown descriptor')
                if obj.obj.family == 'trusted-kernel-runtime-query':
                    require(pid == self.leader and entered == completed, 'native query stat thread/interval')
                self.bind(obj.obj, call, args)
                obj.physical_bound = True
            else:
                index = 0 if call in {'stat', 'lstat'} else 1
                path = self.path(args[index])
                obj = self.paths.get(path)
                require(obj is not None, 'metadata lacks retained/created lineage: ' + path)
                self.bind(obj, call, args)
            return
        if call == 'epoll_ctl':
            epoll = self.handles.get(fd(args[0]))
            target = self.handles.get(fd(args[2]))
            if (epoll is not None and epoll.obj.family == 'epoll' and target is not None and
                    fd(args[2]) in {1, 2} and target.obj.family == 'stdio' and
                    stat.S_ISFIFO(target.obj.mode) and args[1] == 'EPOLL_CTL_DEL' and
                    fd(args[2]) not in epoll.obj.watches and result.startswith('-1 ENOENT ')):
                return  # Node's unsuccessful teardown of an unregistered retained output pipe.
            require(epoll is not None and epoll.obj.family == 'epoll' and target is not None and
                    target.obj.family in {'pipe', 'eventfd'}, 'unverified epoll registration')
            require(result == '0' and args[1] in {'EPOLL_CTL_ADD', 'EPOLL_CTL_DEL', 'EPOLL_CTL_MOD'}, 'epoll control failure/op')
            if args[1] == 'EPOLL_CTL_DEL':
                require(fd(args[2]) in epoll.obj.watches, 'epoll delete absent registration')
                del epoll.obj.watches[fd(args[2])]
                del epoll.obj.registered_data[fd(args[2])]
                del epoll.obj.watch_handles[fd(args[2])]
            else:
                require((args[1] == 'EPOLL_CTL_ADD' and fd(args[2]) not in epoll.obj.watches) or
                        (args[1] == 'EPOLL_CTL_MOD' and fd(args[2]) in epoll.obj.watches),
                        'epoll ADD existing/MOD absent member')
                registration = re.fullmatch(r'\{events=EPOLLIN, data=(0x[0-9a-f]+|\d+)\}', args[3])
                require(registration is not None, 'unknown epoll registration shape')
                data = fd(registration[1])
                require(data < 2**64 and all(number == fd(args[2]) or value != data
                        for number, value in epoll.obj.registered_data.items()), 'ambiguous epoll registration data')
                epoll.obj.watches[fd(args[2])] = target.obj
                epoll.obj.registered_data[fd(args[2])] = data
                epoll.obj.watch_handles[fd(args[2])] = target
            return
        if call == 'epoll_pwait':
            verified = self.wait(record)
            if entered != completed and verified:
                self.waits.append(record)
            return
        if call == 'mmap':
            if args[4] == '-1':
                require('MAP_ANONYMOUS' in args[3], 'unknown anonymous mapping')
            else:
                handle = self.handles.get(fd(args[4]))
                require(handle is not None and handle.obj.family == 'runtime' and 'MAP_PRIVATE' in args[3],
                        'resource/private/unretained file mapping')
            return
        if call == 'prctl':
            require(args[0] == 'PR_SET_NAME' and result == '0', 'unsupported process control')
            return
        if call == 'access':
            require(args == ['"/etc/ld.so.preload"', 'R_OK'] and
                    '/etc/ld.so.preload' in self.original['absentProbes'] and
                    result.startswith('-1 ENOENT '), 'unretained access probe')
            return
        if call == 'readlink':
            path = self.path(args[0])
            require(path in self.original['readlinks'] and len(args) == 3 and
                    args[2].isdigit() and 1 <= int(args[2]) <= 8192, 'unretained/unbounded readlink')
            target = self.original['readlinks'][path]
            if target is None:
                require(result.startswith('-1 EINVAL '), 'original nonsymlink readlink changed')
            else:
                data = target.encode()
                require(string(args[1]) == data and result == str(len(data)) and len(data) < int(args[2]),
                        'original readlink target/count differs')
            return
        if call == 'prlimit64':
            require(len(args) == 4 and args[:1] == ['0'] and args[1] in {
                    'RLIMIT_STACK', 'RLIMIT_DATA', 'RLIMIT_AS', 'RLIMIT_NOFILE'} and
                    args[2] == 'NULL' and result == '0' and
                    re.fullmatch(r'\{rlim_cur=(?:RLIM64_INFINITY|\d+(?:\*1024)?), rlim_max=(?:RLIM64_INFINITY|\d+(?:\*1024)?)\}', args[3]),
                    'unsupported process limit mutation/query')
            return
        if call == 'getcwd':
            expected = str(Path(self.original['argv'][1]).parent).encode()
            require(len(args) == 2 and string(args[0]) == expected and args[1].isdigit() and
                    len(expected) + 1 <= int(args[1]) <= 65536 and result == str(len(expected) + 1),
                    'changed original cwd/result')
            return
        number = None
        if call in FD_FIRST | {'close'} and args and re.fullmatch(r'(0x[0-9a-f]+|\d+)', args[0]):
            number = fd(args[0])
        handle = self.handles.get(number)
        if number is not None:
            if (handle is None and call == 'fcntl' and args[1:] in
                    (['F_GETFD'], ['F_SETFD', 'FD_CLOEXEC']) and result.startswith('-1 EBADF ')):
                return  # Failed startup query creates neither a handle nor an alias.
            require(handle is not None, 'unknown descriptor effect')
            obj = handle.obj
            if obj.family == 'trusted-kernel-runtime-query':
                require(pid == self.leader and entered == completed and call in {'read', 'close', 'fstat', 'newfstatat', 'statx'},
                        'native query thread/interval/descriptor effect')
            if entered != completed:
                self.descriptor_intervals.append((entered, completed, obj))
            if number in {self.command, self.ack} and call in {'read', 'write'}:
                ack = len(self.marks) == 1
                expected = wire(self.original['phases'][0], ack)
                require(len(self.marks) < 2 and pid == self.leader and call == ('write' if ack else 'read') and
                        number == (self.ack if ack else self.command) and args[2] == str(len(expected)) and
                        result == str(len(expected)) and string(args[1]) == expected, 'control command/ack differs')
                require(not self.marks or entered > self.marks[0][5], 'overlapping command/ack')
                self.marks.append(record)
                return
            if call == 'fcntl':
                if stat.S_ISDIR(obj.mode) and obj.physical is not None:
                    if args[1:] == ['F_SETFD', 'FD_CLOEXEC'] and result == '0':
                        return
                    flags_result = re.fullmatch(r'0x[0-9a-f]+ \(flags (.*)\)', result)
                    require(args[1:] == ['F_GETFL'] and flags_result is not None and
                            set(flags_result[1].split('|')) == (handle.flags - {'O_CLOEXEC'}) | {'O_LARGEFILE'},
                            'unplanned directory descriptor control')
                    return
                if number in {self.lifetime, self.command, self.ack}:
                    require(args[1:] == ['F_SETFD', 'FD_CLOEXEC'] and result == '0' and not self.marks,
                            'unplanned inherited descriptor flag transition')
                    require(number not in self.inherited_cloexec, 'repeated inherited descriptor flag transition')
                    self.inherited_cloexec.add(number)
                else:
                    require(obj.family in {'stdio', 'pipe', 'eventfd', 'epoll'} and args[1] in {'F_GETFL', 'F_SETFD', 'F_SETFL'},
                            'private/resource descriptor control')
                return
            if call == 'ioctl':
                require(obj.family in {'stdio', 'pipe'} and args[1] in {'TCGETS', 'FIONBIO'}, 'unknown ioctl/alias control')
                return
            if call == 'close':
                require(result == '0' and number not in {self.lifetime, self.command, self.ack}, 'unplanned inherited/failed close')
                require(not handle.directory_seen or handle.directory_eof, 'directory handle closed before complete enumeration')
                if obj.family == 'trusted-kernel-runtime-query':
                    require(pid == self.leader and handle.native_read,
                            'native query closed by nonleader or without exact single read')
                    self.native_completed.append(next(iter(obj.names)))
                if obj.family == 'runtime-query' and next(iter(obj.names)) == f'/proc/self/fdinfo/{self.lifetime}':
                    require(pid == self.leader and handle.physical_bound and handle.query_eof,
                            'source lifetime query closed before bound EOF')
                    self.check_fdinfo(handle.query_bytes)
                if 'O_WRONLY' in handle.flags:
                    obj.writer_closed = True
                    obj.writer_close_entry, obj.writer_close_completion = entered, completed
                    self.durable_publication(obj)
                del self.handles[number]
                self.invalidate_watched_close(obj)
                return
            if call in FILE_OPS:
                if obj.family == 'trusted-kernel-runtime-query':
                    path = next(iter(obj.names))
                    request = NATIVE_QUERIES[path][0]
                    require(pid == self.leader and call == 'read' and not handle.native_read and args[2:] == [str(request)] and
                            handle.flags == {'O_RDONLY', 'O_CLOEXEC'}, 'native query is not exact single sequential read')
                    data, count = string(args[1]), positive_result(result)
                    require(0 < count == len(data) < request and b'\0' not in data and
                            data.isascii(), 'native query incomplete/excess decoded bytes')
                    handle.query_bytes = data
                    handle.native_read = True  # does NOT claim a traced EOF
                    return
                if obj.family == 'runtime-query':
                    require(handle.physical_bound, 'query read lacks per-open physical bind')
                    path = next(iter(obj.names))
                    require(call == 'read' and self.query_flags(path, handle.flags),
                            'writable/positional query operation')
                    count = positive_result(result)
                    data = string(args[1])
                    limit = self.original['queries'][next(iter(obj.names))]
                    if path == f'/proc/self/fdinfo/{self.lifetime}':
                        require(pid == self.leader and not handle.query_eof and
                                int(args[2]) == 4097 - handle.position,
                                'source lifetime query does not follow bounded sentinel sequence')
                        if count == 0:
                            handle.query_eof = True
                    require(count == len(data) and count <= int(args[2]) <= 65536 and
                            handle.position + count <= limit, 'query bytes/count bound')
                    handle.position += count
                    handle.query_bytes += data
                    return
                if obj.family in {'pipe', 'eventfd', 'stdio'}:
                    require(call in {'read', 'write', 'writev'} and (result.startswith('-1 EAGAIN ') or
                            result.isdigit() and int(result) <= 65536), 'unbounded internal/query I/O')
                    return
                require(number not in {self.lifetime, self.command, self.ack}, 'unplanned control/lifetime I/O')
                if call in {'read', 'pread64'}:
                    require('O_RDONLY' in handle.flags, 'read on writer')
                    count = positive_result(result)
                    offset = positive_result(args[3]) if call == 'pread64' else handle.position
                    require(count <= int(args[2]), 'read larger than requested')
                    expected = obj.data[offset:offset + int(args[2])]
                    require(count == len(expected), 'read count differs from original bytes')
                    self.bytes(args[1], expected, obj)
                    if call == 'read':
                        handle.position += count
                    if obj.family == 'resource':
                        require(call == 'pread64' and pid == self.leader and not obj.names and hasattr(obj, 'reader') and
                                number == obj.reader and args[2:] == [str(self.original['length']), str(self.original['offset'])],
                                'noncanonical resource read')
                        require(len(self.marks) == 1, 'resource read outside bootstrap phase')
                        obj.reads = getattr(obj, 'reads', []) + [expected]
                        obj.effect_entries = getattr(obj, 'effect_entries', []) + [entered]
                elif call == 'write':
                    require('O_WRONLY' in handle.flags and not obj.writer_closed and obj.names, 'write without original writer')
                    data = string(args[1])
                    require(args[2] == result == str(len(data)), 'partial/truncated write')
                    obj.data += data
                    obj.synced = False  # A prior fsync cannot settle later appended bytes.
                    obj.last_write_completion = completed
                    obj.data_sync_entry = obj.data_sync_completion = None
                    obj.durable_publication_completion = None
                    obj.writes += 1
                    self.total_written += len(data)
                    require(len(obj.data) <= 65536 and self.total_written <= 16 * 1024 * 1024, 'mutable byte bound exceeded')
                elif call in {'fsync', 'fdatasync'}:
                    require(result == '0', 'failed sync')
                    obj.synced = True
                    if stat.S_ISDIR(obj.mode):
                        for item in self.objects:
                            if (call == 'fsync' and obj.physical is not None and item.published and
                                    item.publication_parent is obj and item.publication_completion < entered and
                                    item.directory_sync_completion is None):
                                item.directory_synced = True
                                item.directory_sync_entry, item.directory_sync_completion = entered, completed
                                self.durable_publication(item)
                    elif 'O_WRONLY' in handle.flags:
                        obj.data_sync_entry, obj.data_sync_completion = entered, completed
                        self.durable_publication(obj)
                elif call == 'getdents64':
                    require(stat.S_ISDIR(obj.mode) and len(obj.names) == 1 and
                            next(iter(obj.names)).startswith(self.base + '/') and result.isdigit() and
                            args[2].isdigit() and 0 <= int(result) <= int(args[2]) <= 65536,
                            'unbounded/unretained directory enumeration')
                    self.directory_entries(handle, args[1], int(result))
                elif call == 'lseek':
                    require(obj.family == 'runtime' and args[2] in {'SEEK_SET', 'SEEK_CUR', 'SEEK_END'}, 'unmodeled positional effect')
                    position = int(args[1]) + {'SEEK_SET': 0, 'SEEK_CUR': handle.position, 'SEEK_END': len(obj.data)}[args[2]]
                    require(0 <= position <= len(obj.data) and result == str(position), 'runtime seek bounds/result')
                    handle.position = position
                else:
                    raise RuntimeError('unmodeled vector/descriptor file effect')
                return
        # Only these explicitly reviewed non-file/process-namespace syscalls have
        # no descriptor/path action in this replay. Unknown supported effects are
        # not silently inherited from the candidate vocabulary.
        require(call in {'arch_prctl', 'brk', 'capget', 'exit', 'exit_group',
                'getegid', 'geteuid', 'getgid', 'getpid', 'getppid', 'getrandom', 'gettid', 'getuid',
                'madvise', 'mprotect', 'munmap', 'mremap', 'rseq', 'rt_sigaction',
                'rt_sigprocmask', 'rt_sigreturn', 'sched_getaffinity', 'sched_getparam',
                'sched_getscheduler', 'sched_yield', 'set_robust_list', 'set_tid_address',
                'uname', 'clock_gettime', 'clock_nanosleep', 'nanosleep', 'gettimeofday'},
                'unclassified supported syscall effect')

    def directory_entries(self, handle, encoded, count):
        require(encoded.startswith('[') and encoded.endswith(']'), 'truncated directory entries')
        body = encoded[1:-1]
        pattern = r'\{d_ino=(\d+), d_off=(\d+), d_reclen=(\d+), d_type=(DT_DIR|DT_REG), d_name=("(?:[^"\\]|\\.)*")\}'
        entries = list(re.finditer(pattern, body))
        require(', '.join(e[0] for e in entries) == body and
                sum(int(e[3]) for e in entries) == count, 'unknown directory entry fields/count')
        parent = next(iter(handle.obj.names))
        if count == 0:
            expected = {'.', '..'} | {Path(p).name for p in self.paths if str(Path(p).parent) == parent}
            require(handle.directory_seen == expected, 'directory EOF omits retained/created entries')
            handle.directory_eof = True
        for entry in entries:
            name = string(entry[5]).decode()
            require(name and '/' not in name and name not in handle.directory_seen,
                    'repeated/noncanonical directory entry')
            path = parent if name == '.' else str(Path(parent).parent) if name == '..' else parent + '/' + name
            item = self.paths.get(path)
            require(item is not None and stat.S_IFMT(item.mode) ==
                    (stat.S_IFDIR if entry[4] == 'DT_DIR' else stat.S_IFREG), 'directory entry lacks original/create lineage')
            inode = int(entry[1])
            require(item.physical is None or item.physical[2] == inode, 'directory entry inode alias')
            require(not hasattr(item, 'directory_inode') or item.directory_inode == inode, 'changed directory-entry inode')
            item.directory_inode = inode
            handle.directory_seen.add(name)

    def query_flags(self, path, flags):
        if path == f'/proc/self/fdinfo/{self.lifetime}':
            return flags == {'O_RDONLY', 'O_NOFOLLOW', 'O_CLOEXEC'}
        return flags in ({'O_RDONLY', 'O_CLOEXEC'}, {'O_RDONLY'})

    def check_fdinfo(self, data):
        text = data.decode('ascii')
        lifetime = self.handles.get(self.lifetime)
        require(lifetime is not None and lifetime.obj.family == 'lifetime', 'missing original lifetime descriptor')
        device_major, device_minor, inode = lifetime.obj.physical
        expected = (rf'lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE {self.original["supervisorPid"]} '
                    rf'{device_major:02x}:{device_minor:02x}:{inode} 0 EOF')
        require(re.search(rf'^ino:\s+{inode}$', text, re.MULTILINE) and
                re.search('^' + expected + '$', text, re.MULTILINE), 'fdinfo lacks original supervisor flock/inode')
        flags = re.search(r'^flags:\s+([0-7]+)$', text, re.MULTILINE)
        require(flags is not None and int(flags[1], 8) & os.O_ACCMODE == os.O_RDWR and
                int(flags[1], 8) & os.O_CLOEXEC, 'fdinfo original lifetime flags differ')

    def check_intervals(self, record):
        """No shared-table entry-order inference across overlapping mutations.

        Track FD numbers even after close, plus current object aliases and exact
        namespace paths. Unrelated read-only operations may overlap. Persistent
        epoll waits remain visible and conflict with close/registration changes.
        """
        pid, call, args, result, entered, completed = record
        entities, paths = set(), set()
        mutating = call in {'close', 'fcntl', 'ioctl', 'write', 'writev', 'read', 'readv',
                           'lseek', 'epoll_ctl', 'mkdir', 'rmdir', 'unlink', 'link', 'rename', 'chmod'}
        watch_change = call in {'close', 'openat', 'pipe2', 'eventfd2', 'epoll_create1'}
        object_mutating = call in {'write', 'writev', 'mkdir', 'rmdir', 'unlink', 'link', 'rename', 'chmod'}
        path_mutating = call in {'mkdir', 'rmdir', 'unlink', 'link', 'rename', 'chmod'}
        if result.startswith('-1 '):
            object_mutating = path_mutating = False
        def descriptor(value):
            number = fd(value)
            entities.add(('fd', number))
            if number in self.handles:
                entities.add(('object', id(self.handles[number].obj)))
            if call in {'close', 'openat', 'pipe2', 'eventfd2', 'epoll_create1'}:
                entities.add(('epoll-watch-fd', number))
                if number in self.handles:
                    entities.add(('epoll-watch-object', id(self.handles[number].obj)))
                    entities.add(('epoll-watch-handle', id(self.handles[number])))
                    if call == 'close':
                        watched = self.handles[number].obj
                        for current in self.handles.values():
                            epoll = current.obj
                            if epoll.family == 'epoll' and any(obj is watched for obj in epoll.watches.values()):
                                entities.add(('epoll-watch-registration', id(epoll)))
        if call in FD_FIRST | {'close'} and args and re.fullmatch(r'(0x[0-9a-f]+|\d+)', args[0]):
            descriptor(args[0])
        if call == 'epoll_ctl':
            descriptor(args[2])
        if call == 'epoll_pwait' and fd(args[0]) in self.handles:
            epoll = self.handles[fd(args[0])].obj
            if epoll.family == 'epoll':
                bindings = self.epoll_bindings(epoll)
                entities.add(('epoll-watch-registration', id(epoll)))
                for number, watched in epoll.watches.items():
                    # Notifications may read/write during waits. Only close or
                    # handle acquisition/reuse shares these dependency markers.
                    entities.add(('epoll-watch-fd', number))
                    entities.add(('epoll-watch-object', id(watched)))
                    entities.add(('epoll-watch-handle', id(bindings[number])))
        if call == 'mmap' and args[4] != '-1':
            descriptor(args[4])
        if call == 'openat':
            paths.add(self.path(args[1]))
            path_mutating = not result.startswith('-1 ') and bool(
                set(args[2].split('|')) & {'O_CREAT', 'O_TRUNC'})
            object_mutating = path_mutating
            if result.isdigit():
                descriptor(result)
                mutating = True  # Descriptor acquisition, including readonly opens.
        elif call in {'pipe2', 'eventfd2', 'epoll_create1'} and not result.startswith('-1 '):
            for value in args[0].strip('[]').split(', ') if call == 'pipe2' else [result]:
                descriptor(value)
            mutating = True
        elif call in {'mkdir', 'rmdir', 'unlink', 'link', 'rename', 'chmod', 'stat', 'lstat', 'readlink', 'access'}:
            paths.add(self.path(args[0]))
            if call in {'link', 'rename'}:
                paths.add(self.path(args[1]))
        elif call in {'statx', 'newfstatat'} and not args[0].isdigit():
            paths.add(self.path(args[1]))
        for path in paths:
            if path in self.paths:
                entities.add(('object', id(self.paths[path])))
            if call in {'link', 'rename', 'unlink', 'mkdir', 'rmdir'}:
                parent = self.paths.get(str(Path(path).parent))
                if parent is not None:
                    require(stat.S_ISDIR(parent.mode), 'namespace mutation parent is not a directory')
                    entities.add(('object', id(parent)))
        self.pending_intervals = [p for p in self.pending_intervals if p[1] >= entered]
        for start, end, other_pid, other_mutating, other_object_mutating, other_path_mutating, other_entities, other_paths, other_watch_change in self.pending_intervals:
            related_paths = any(a == b or a.startswith(b + '/') or b.startswith(a + '/')
                                for a in paths for b in other_paths)
            shared = entities & other_entities
            conflict = ((mutating or other_mutating) and any(k[0] == 'fd' for k in shared) or
                        (object_mutating or other_object_mutating) and any(k[0] == 'object' for k in shared) or
                        (watch_change or other_watch_change) and any(k[0].startswith('epoll-watch-') for k in shared) or
                        (path_mutating or other_path_mutating) and related_paths)
            require(not (pid != other_pid and conflict), 'ambiguous shared descriptor/path interval')
        if completed > entered and (entities or paths):
            self.pending_intervals.append((entered, completed, pid, mutating, object_mutating,
                                           path_mutating, entities, paths, watch_change))
