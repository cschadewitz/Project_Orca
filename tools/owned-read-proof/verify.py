"""Independent, deliberately narrow Linux candidate verifier. No acceptance capability."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity(path):
    s = Path(path).lstat()
    return [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid]


def inventory(root):
    result = {}
    for path in sorted(Path(root).rglob('*')):
        if path.is_symlink():
            raise RuntimeError('image alias')
        if path.is_file() or path.is_dir():
            result[str(path)] = [identity(path), digest(path) if path.is_file() else None]
    return result


def retain(base, installed, lifetime_fd, node, tracer, scenario):
    """Called before launch. Original values remain supervisor-owned, never child JSON."""
    roots = [base / p for p in ('workspace', 'workspace/.orca',
             'workspace/.orca/workspace-identity', 'workspace/.orca/workspace-identity/id',
             'control', 'releases', 'lifetime.lock', 'input')]
    return {'version': 1, 'scenario': scenario, 'base': str(base), 'installed': str(installed),
            'image': inventory(installed), 'roots': {str(p): identity(p) for p in roots},
            'rootBytes': {str(base / p): digest(base / p) for p in
                          ('workspace/.orca/workspace-identity/id', 'input')},
            'lifetimeFd': lifetime_fd, 'lifetime': identity(base / 'lifetime.lock'),
            'identities': {str(p): [identity(p), digest(p)] for p in
                           (Path(node).resolve(), Path(tracer).resolve(), Path(__file__).resolve(),
                            Path(__file__).with_name('run.py').resolve(), Path(os.sys.executable).resolve())},
            'node': node, 'argv': [node, str(installed / 'child.mjs'), str(base), str(lifetime_fd), scenario],
            'offset': 2, 'length': 4, 'inputHex': (base / 'input').read_bytes().hex(),
            'serviceReads': 0, 'timeoutSeconds': 30, 'verifierTimeoutSeconds': 45, 'maximumTraceBytes': 268435456,
            'identityHex': (base / 'workspace/.orca/workspace-identity/id').read_bytes().hex(),
            'processModel': 'one cooperative process; Node CLONE_THREAD|CLONE_FILES threads only; one group'}


def check_physical(plan):
    if inventory(plan['installed']) != plan['image']:
        raise RuntimeError('changed image')
    for path, expected in plan['roots'].items():
        if identity(path) != expected:
            raise RuntimeError('changed root/lifetime binding')
    for path, expected in plan['rootBytes'].items():
        if digest(path) != expected:
            raise RuntimeError('changed root/input bytes')
    for path, expected in plan['identities'].items():
        if [identity(path), digest(path)] != expected:
            raise RuntimeError('changed runtime/observer/verifier')
    s = os.fstat(plan['lifetimeFd'])
    if [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid] != plan['lifetime']:
        raise RuntimeError('changed supervisor lifetime descriptor')
    if not re.search(r'lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE ',
                     Path(f"/proc/self/fdinfo/{plan['lifetimeFd']}").read_text()):
        raise RuntimeError('lost supervisor flock')


def split_args(value):
    parts, start, depth, quoted, escaped = [], 0, 0, False, False
    for index, char in enumerate(value):
        if quoted:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in '([{':
            depth += 1
        elif char in ')]}':
            depth -= 1
        elif char == ',' and depth == 0:
            parts.append(value[start:index].strip())
            start = index + 1
    if depth or quoted:
        raise RuntimeError('ambiguous arguments')
    return parts + [value[start:].strip()]


def string(value):
    if not re.fullmatch(r'"(?:[^"\\]|\\.)*"', value):
        raise RuntimeError('missing/truncated string')
    try:
        return ast.literal_eval('b' + value)
    except (ValueError, SyntaxError) as error:
        raise RuntimeError('ambiguous string') from error


def fd(value):
    match = re.fullmatch(r'(0x[0-9a-f]+|[0-9]+)(?:<.*>)?', value)
    if not match:
        raise RuntimeError('ambiguous descriptor')
    return int(match[1], 16 if match[1].startswith('0x') else 10)


def events(text):
    """Reassemble at syscall entry order, including clone before its child's events.

    Resource operations are restricted to the one leader below; concurrent
    shared-table resource operations are outside this narrow verifier's model.
    """
    pending, records = {}, []
    for line in text.splitlines():
        match = re.fullmatch(r'(\d+)\s+(.*)', line)
        if not match:
            raise RuntimeError('missing trace PID')
        pid, body = int(match[1]), match[2]
        if body.endswith(' <unfinished ...>'):
            if pid in pending:
                raise RuntimeError('duplicate unfinished event')
            pending[pid] = (body[:-len(' <unfinished ...>')], len(records))
            records.append(None)
            continue
        resumed = re.match(r'<\.\.\. (\w+) resumed>(.*)', body)
        if resumed:
            item = pending.pop(pid, None)
            if item is None or not item[0].startswith(resumed[1] + '('):
                raise RuntimeError('unmatched resumed event')
            records[item[1]] = (pid, item[0] + resumed[2])
        else:
            records.append((pid, body))
    if pending:
        raise RuntimeError('incomplete trace')
    for pid, body in records:
        if body == '+++ exited with 0 +++':
            yield pid, 'settled', [], '0'
        elif body.startswith('--- SIG'):
            raise RuntimeError('unexpected signal')
        else:
            call = re.fullmatch(r'(\w+)\((.*)\)\s+= (.*)', body)
            if not call:
                raise RuntimeError('incomplete/unknown trace record')
            if call[1] in ('statx', 'newfstatat'):
                stat_args = re.fullmatch(r'([^,]+), ("(?:[^"\\]|\\.)*"), (.*)', call[2])
                if not stat_args:
                    raise RuntimeError('ambiguous stat arguments')
                args = list(stat_args.groups())
            elif call[1] == 'fstat':
                args = call[2].split(', ', 1)
            else:
                args = split_args(call[2])
            yield pid, call[1], args, call[3]


FD_FIRST = set(('read readv write writev pread64 pwrite64 preadv preadv2 pwritev pwritev2 '
    'fstat newfstatat statx fstatfs fcntl fcntl64 ioctl dup dup2 dup3 lseek _llseek ftruncate '
    'fchmod fchown fallocate fsync fdatasync fadvise64 getdents64 readlinkat unlinkat linkat '
    'renameat renameat2 fchmodat fchownat utimensat flock sendmsg recvmsg sendto recvfrom '
    'shutdown accept accept4 bind listen connect getsockname getpeername getsockopt setsockopt '
    'epoll_ctl epoll_wait epoll_pwait epoll_pwait2 timerfd_settime timerfd_gettime').split())


def verify_trace(text, plan):
    """Reconstruct descriptor lineage; filename annotations never establish ownership."""
    if plan['serviceReads'] != 0:
        raise RuntimeError('candidate verifier has no positive authority')
    table, directories, resources = {}, set(), []
    threads, settled, leader = set(), set(), None
    calibration, service_reads, execs, calibration_handles = [], [], 0, []
    calibration_started = False
    lifetime_closed = False
    forbidden = {'fork', 'vfork', 'execveat', 'unshare', 'setns', 'setsid', 'setpgid',
                 'io_uring_setup', 'io_uring_enter', 'io_uring_register', 'open_by_handle_at',
                 'pidfd_getfd', 'sendmsg', 'recvmsg', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'close_range', 'sendfile', 'splice', 'tee', 'copy_file_range'}
    for pid, call, args, result in events(text):
        if call == 'execve':
            execs += 1
            if execs != 1 or string(args[0]).decode() != plan['node'] or result != '0':
                raise RuntimeError('unexpected exec')
            expected = '[' + ', '.join(json.dumps(s) for s in plan['argv']) + ']'
            if args[1] != expected:
                raise RuntimeError('changed launch arguments')
            leader = pid
            threads.add(pid)
        elif leader is None:
            raise RuntimeError('missing initial exec')
        elif call == 'settled':
            if pid not in threads or pid in settled:
                raise RuntimeError('unexpected settlement')
            settled.add(pid)
        elif pid not in threads or pid in settled:
            raise RuntimeError('unexpected process')
        elif call == 'io_uring_setup' and result.startswith(('-1 EPERM ', '-1 ENOSYS ')):
            pass  # Kernel refused creation; successful asynchronous I/O is unsupported.
        elif call in forbidden:
            raise RuntimeError('unsupported process/descriptor operation: ' + call)
        elif call in ('clone', 'clone3'):
            if result.startswith('-1 '):
                continue
            if not all(flag in ','.join(args) for flag in ('CLONE_THREAD', 'CLONE_FILES', 'CLONE_VM', 'CLONE_SIGHAND')):
                raise RuntimeError('unexpected process clone')
            child = int(result.split()[0])
            if child in threads:
                raise RuntimeError('duplicate thread')
            threads.add(child)
        elif calibration_started and call in ('rename', 'renameat', 'renameat2', 'link', 'linkat', 'symlink', 'symlinkat', 'chmod', 'fchmod', 'truncate'):
            raise RuntimeError('unsupported post-calibration path mutation')
        elif call == 'mkdir' and result == '0':
            if args[1] == '0700':
                directories.add(string(args[0]).decode())
        elif call in ('open', 'openat', 'openat2', 'creat'):
            if call != 'openat':
                raise RuntimeError('unsupported open variant')
            if result.startswith('-1 '):
                continue
            if not re.fullmatch(r'AT_FDCWD(?:<.*>)?', args[0]):
                raise RuntimeError('unsupported relative descriptor open')
            path = string(args[1]).decode()
            if path.startswith('/proc/') and '/fd/' in path or path.startswith('/dev/fd/'):
                raise RuntimeError('unsupported descriptor path alias')
            number = fd(result)
            if number in table:
                raise RuntimeError('descriptor reused without close')
            flags = set(args[2].split('|'))
            obj = {'path': path, 'flags': flags, 'closed': False}
            if (len(args) == 4 and args[3] == '0400' and
                    {'O_WRONLY', 'O_CREAT', 'O_EXCL'} <= flags):
                if str(Path(path).parent) not in directories or not path.startswith(plan['base'] + '/'):
                    raise RuntimeError('resource not newly created under disposable private directory')
                if pid != leader:
                    raise RuntimeError('resource created by unexpected thread')
                obj.update(kind='resource', writer=number, writes=[], unlinked=False, reader=None,
                           created=True, writerClosed=False, readerClosed=False, stats=[])
                resources.append(obj)
            else:
                matches = [r for r in resources if r['path'] == path]
                if matches:
                    obj = matches[0]
                    if pid != leader:
                        raise RuntimeError('resource opened by unexpected thread')
                    if (len(matches) != 1 or obj['reader'] is not None or not obj['writerClosed'] or
                            obj['unlinked'] or flags != {'O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC'}):
                        raise RuntimeError('resource read-only open lineage')
                    obj['reader'] = number
                elif path == str(Path(plan['base']) / 'workspace/.orca/workspace-identity/id'):
                    if flags not in ({'O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC'}, {'O_RDONLY', 'O_CLOEXEC'}):
                        raise RuntimeError('identity open flags changed')
                    obj['kind'] = 'rootIdentity'
                elif path == str(Path(plan['base']) / 'input'):
                    if flags != {'O_RDONLY', 'O_CLOEXEC'}:
                        raise RuntimeError('calibration open is not read-only')
                    if pid != leader:
                        raise RuntimeError('calibration opened by unexpected thread')
                    obj['kind'] = 'calibration'
                    calibration_handles.append(obj)
                    calibration_started = True
            table[number] = obj
        elif call == 'unlink' and result == '0':
            path = string(args[0]).decode()
            for obj in resources:
                if path == obj['path']:
                    if pid != leader:
                        raise RuntimeError('resource unlinked by unexpected thread')
                    if obj['reader'] is None or obj['unlinked']:
                        raise RuntimeError('resource unlink lineage')
                    obj['unlinked'] = True
        elif call in ('fstat', 'newfstatat', 'statx', 'lstat', 'stat'):
            obj = None
            if re.fullmatch(r'[0-9]+', args[0]):
                obj = table.get(int(args[0]))
            path_arg = args[0] if call in ('lstat', 'stat') else args[1] if call != 'fstat' else None
            if path_arg and path_arg.startswith('"') and string(path_arg):
                matches = [r for r in resources if r['path'] == string(path_arg).decode()]
                if matches:
                    obj = matches[0]
            if obj and obj.get('kind') == 'resource':
                if pid != leader:
                    raise RuntimeError('resource stat by unexpected thread')
                if result != '0':
                    raise RuntimeError('missing resource stat')
                obj['stats'].append((','.join(args), obj['unlinked']))
        elif call == 'close':
            number = fd(args[0])
            if number == plan['lifetimeFd']:
                lifetime_closed = True
            obj = table.get(number)
            if result == '0' and obj is not None:
                obj['closed'] = True
                if obj.get('kind') == 'resource':
                    if pid != leader:
                        raise RuntimeError('resource closed by unexpected thread')
                    obj['writerClosed' if obj['reader'] is None else 'readerClosed'] = True
                del table[number]
        else:
            # Operations whose first argument is a descriptor: establish identity
            # from the table, not strace's helpful but non-authoritative path label.
            match = re.fullmatch(r'(0x[0-9a-f]+|[0-9]+)(?:<.*>)?', args[0]) if args and call in FD_FIRST else None
            number = fd(args[0]) if match else None
            obj = table.get(number)
            if (number == plan['lifetimeFd'] and call not in ('fstat', 'newfstatat', 'statx') and
                    not (call == 'fcntl' and args[1:] == ['F_SETFD', 'FD_CLOEXEC'] and result == '0')):
                raise RuntimeError('unexpected lifetime operation: ' + call + repr(args))
            if obj and obj.get('kind') == 'resource':
                if pid != leader:
                    raise RuntimeError('resource accessed by unexpected thread')
                if call == 'write' and obj['reader'] is None and number == obj['writer']:
                    data = string(args[1])
                    if int(args[2]) != len(data) or result != str(len(data)):
                        raise RuntimeError('incomplete resource write')
                    obj['writes'].append(data)
                elif call in ('fstat', 'newfstatat', 'statx'):
                    obj['stats'].append(','.join(args))
                elif call == 'pread64' and number == obj['reader'] and obj['unlinked']:
                    service_reads.append((args, result))
                else:
                    raise RuntimeError('unsupported resource descriptor operation: ' + call)
            elif call == 'pread64' and obj and obj.get('kind') == 'rootIdentity':
                data = bytes.fromhex(plan['identityHex'])
                expected = data[int(args[3]):int(args[3]) + int(args[2])]
                if result != str(len(expected)) or string(args[1]) != expected:
                    raise RuntimeError('changed root identity read')
            elif call == 'pread64' and obj and obj.get('kind') == 'calibration':
                calibration.append((args, result))
            elif call in ('pread64', 'preadv', 'preadv2') and calibration_started:
                raise RuntimeError('wrong descriptor positional effect: ' + repr((args, obj)))
            # mmap's fd is argument 5; duplication can alias a resource even when
            # the target fd is not the first argument (dup2/dup3).
            if call in ('mmap', 'mmap2') and len(args) > 4:
                if re.match(r'\d+', args[4]) and table.get(fd(args[4]), {}).get('kind') == 'resource':
                    raise RuntimeError('resource mapping')
            if call in ('dup2', 'dup3') and fd(args[1]) in table:
                raise RuntimeError('descriptor replacement')
    if execs != 1 or threads != settled:
        raise RuntimeError('incomplete process settlement')
    if lifetime_closed:
        raise RuntimeError('tracee lifetime descriptor closed')
    if len(resources) != 1:
        raise RuntimeError('missing/ambiguous resource creation')
    resource = resources[0]
    if (b''.join(resource['writes']).hex() != plan['inputHex'] or not resource['unlinked'] or
            not resource['writerClosed'] or not resource['readerClosed'] or resource['reader'] is None):
        raise RuntimeError('incomplete resource lifetime/content')
    inodes, links = set(), set()
    for value, detached in resource['stats']:
        # This lane is pinned to the Linux statx decoder, not a cross-platform parser.
        fields = dict(re.findall(r'(stx_(?:ino|dev_major|dev_minor|nlink|uid|size))=(\d+)', value))
        if set(fields) != {'stx_ino', 'stx_dev_major', 'stx_dev_minor', 'stx_nlink', 'stx_uid', 'stx_size'}:
            raise RuntimeError('missing resource physical identity')
        if ('stx_mode=S_IFREG|0400' not in value or int(fields['stx_size']) != len(bytes.fromhex(plan['inputHex'])) or
                int(fields['stx_uid']) != os.getuid() or int(fields['stx_nlink']) != (0 if detached else 1)):
            raise RuntimeError('changed resource stat')
        inodes.add(tuple(fields[k] for k in ('stx_dev_major', 'stx_dev_minor', 'stx_ino')))
        links.add(detached)
    if len(inodes) != 1 or links != {False, True}:
        raise RuntimeError('missing/changed resource inode lineage')
    if len(calibration_handles) != 1 or not calibration_handles[0]['closed']:
        raise RuntimeError('incomplete calibration descriptor lifetime')
    if len(calibration) != 1:
        raise RuntimeError('missing/ambiguous calibration')
    args, result = calibration[0]
    expected = bytes.fromhex(plan['inputHex'])[plan['offset']:plan['offset'] + plan['length']]
    if (args[2:] != [str(plan['length']), str(plan['offset'])] or
            result != str(len(expected)) or string(args[1]) != expected):
        raise RuntimeError('calibration offset/length/result bytes differ')
    if len(service_reads) != plan['serviceReads']:
        raise RuntimeError('unexpected service read')
    return {'record': 'candidate-evidence-only', 'calibrationReads': 1, 'calibrationBytesHex': expected.hex(),
            'serviceReads': len(service_reads), 'resourceCreation': 'exclusive-write-readonly-open-unlink-close',
            'settledThreads': len(threads), 'authority': 'none'}


def verify(trace, plan):
    check_physical(plan)
    if Path(trace).stat().st_size > plan['maximumTraceBytes']:
        raise RuntimeError('trace exceeds bounded plan')
    return verify_trace(Path(trace).read_text(), plan)


if __name__ == '__main__':
    import sys
    request = json.load(sys.stdin)
    print(json.dumps(verify(request['trace'], request['plan'])))
