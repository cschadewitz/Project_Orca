"""Controlled-lane framing/specification grammar only; never execution acceptance.

Inputs must be retained by the cooperative same-UID test supervisor. This module
cannot authenticate JSON, establish pipe/file lineage, or create a capability.
The separate resource/private-I/O replay and lifecycle producer remain required.
"""
import re
import stat

from verify import FD_FIRST, SUPPORTED, events, fd, string

PHASES = {'bootstrap': ['bootstrap'], 'connected': ['save', 'human-read', 'rule-read']}
TOKEN = re.compile(r'[0-9a-f]{64}')
OPS = {
    'openat': {'flags'}, 'statx': set(), 'read': {'maximumBytes'},
    'pread64': {'offset', 'maximumBytes'}, 'write': {'maximumBytes'},
    'fsync': set(), 'close': set(),
}
# Retained-file grammar only. Creation/rename/unlink require the producer's exact
# physical-lineage contract; silently admitting those here would widen authority.
OPEN_FLAGS = ({'O_RDONLY', 'O_CLOEXEC'},
              {'O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC'},
              {'O_RDWR', 'O_NOFOLLOW', 'O_CLOEXEC'},
              {'O_WRONLY', 'O_NOFOLLOW', 'O_CLOEXEC'})
# Every supported call is a boundary effect unless explicitly passive here.
# Descriptor factories/close, path metadata and process/memory effects must not
# depend on the descriptor-first argument decoder's necessarily different set.
# A new supported syscall therefore refuses crossing intervals by default.
# All futex crossings refuse, including WAIT: the syscall name alone does not
# distinguish nonmutating waits from PI locks, WAKE_OP or unknown opcodes.
# "Passive" is a timing-call framing assumption, not proof of no memory effects:
# clock calls write output pointers; interrupted sleeps can write remainder data.
# This parser models no arbitrary user memory. Full replay must independently
# account for descriptor/path effects and reject writable resource/private-file
# mappings or aliases; crossing timing-call records remain available for replay.
BOUNDARY_PASSIVE = {'clock_gettime', 'clock_nanosleep', 'nanosleep',
                    'gettimeofday', 'sched_yield', 'settled'}


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def keys(value, expected, reason):
    require(type(value) is dict and set(value) == expected, reason)


def natural(value, positive=False):
    return type(value) is int and value >= (1 if positive else 0)


def canonical(path):
    return (type(path) is str and path.startswith('/') and
            all(part not in ('', '.', '..') for part in path.split('/')[1:]) and
            '\x00' not in path and not path.startswith(('/proc/', '/dev/fd/')))


def physical(value, kind):
    require(type(value) is list and len(value) == 5 and all(natural(n) for n in value),
            'missing physical identity')
    require((stat.S_ISDIR(value[2]) if kind == 'root' else stat.S_ISREG(value[2])),
            'wrong physical identity type')


def validate_plan(plan, used_tokens):
    """Validate a supervisor-retained plan, not producer flags or deserialized authority.

    used_tokens is the supervisor's retained set from all previously dispatched
    runs, including failed runs. The supervisor reserves new tokens before send.
    This pure validator does not reserve them or claim entropy/authenticity.
    """
    keys(plan, {'version', 'lane', 'leaderPid', 'commandFd', 'ackFd', 'phases',
                'privateRoots', 'privateFiles', 'privateIO', 'maximumTraceBytes'},
         'missing/unknown plan fields')
    require(type(plan['version']) is int and plan['version'] == 1, 'unknown contract version')
    require(type(plan['lane']) is str and plan['lane'] in PHASES, 'unknown lane')
    require(natural(plan['leaderPid'], True), 'missing original leader PID')
    require(natural(plan['maximumTraceBytes'], True) and plan['maximumTraceBytes'] <= 268435456,
            'missing/invalid trace bound')
    require(all(natural(plan[k]) and plan[k] > 2 for k in ('commandFd', 'ackFd')) and
            plan['commandFd'] != plan['ackFd'], 'ambiguous control descriptors')
    require(type(used_tokens) is set and all(type(t) is str and TOKEN.fullmatch(t) for t in used_tokens),
            'missing supervisor replay history')
    require(type(plan['phases']) is list, 'missing phases')
    names, tokens = [], []
    for phase in plan['phases']:
        keys(phase, {'name', 'token'}, 'missing/unknown phase fields')
        require(type(phase['name']) is str, 'invalid phase name')
        require(type(phase['token']) is str and TOKEN.fullmatch(phase['token']), 'invalid phase token')
        names.append(phase['name'])
        tokens.append(phase['token'])
    require(names == PHASES[plan['lane']], 'missing/reordered phases')
    require(len(set(tokens)) == len(tokens) and not set(tokens) & used_tokens, 'replayed phase token')
    require(type(plan['privateRoots']) is dict and type(plan['privateFiles']) is dict and
            type(plan['privateIO']) is list, 'missing finite private I/O specification')
    require(len(plan['privateRoots']) <= 16 and len(plan['privateFiles']) <= 128 and
            len(plan['privateIO']) <= 512, 'private I/O specification exceeds decoder bounds')
    root_ids = set()
    for path, original in plan['privateRoots'].items():
        require(canonical(path), 'noncanonical private root')
        physical(original, 'root')
        require(tuple(original[:2]) not in root_ids, 'private root physical alias')
        root_ids.add(tuple(original[:2]))
    file_ids = set()
    for path, entry in plan['privateFiles'].items():
        keys(entry, {'root', 'identity'}, 'missing private file binding')
        require(canonical(path) and type(entry['root']) is str and
                entry['root'] in plan['privateRoots'] and path.startswith(entry['root'] + '/'),
                'private file outside original root')
        physical(entry['identity'], 'file')
        inode = tuple(entry['identity'][:2])
        require(inode not in file_ids, 'private physical alias')
        file_ids.add(inode)
    active, seen, position = {}, set(), -1
    for step in plan['privateIO']:
        require(type(step) is dict and type(step.get('op')) is str and step['op'] in OPS,
                'unknown private operation')
        op = step['op']
        keys(step, {'phase', 'op', 'path'} | OPS[op], 'missing/unknown private operation fields')
        require(type(step['phase']) is str and step['phase'] in names and
                names.index(step['phase']) >= position, 'private operation phase order')
        position = names.index(step['phase'])
        require(type(step['path']) is str and step['path'] in plan['privateFiles'],
                'unbound private operation path')
        path = step['path']
        seen.add(path)
        if op == 'openat':
            flags = step['flags']
            require(type(flags) is list and all(type(f) is str for f in flags) and
                    len(flags) == len(set(flags)) and set(flags) in OPEN_FLAGS,
                    'unsupported private open flags')
            require(path not in active, 'private open before close')
            active[path] = set(flags)
        else:
            require(path in active, 'private operation without original open')
            if op in ('read', 'pread64'):
                require('O_WRONLY' not in active[path], 'private read through write-only open')
            if op == 'write':
                require(bool(active[path] & {'O_WRONLY', 'O_RDWR'}), 'private write through read-only open')
            if op == 'close':
                del active[path]
        if 'maximumBytes' in step:
            require(natural(step['maximumBytes'], True) and step['maximumBytes'] <= 8192,
                    'unbounded private operation bytes')
        if 'offset' in step:
            require(natural(step['offset']) and step['offset'] + step['maximumBytes'] <= 2**63 - 1,
                    'invalid private positional offset')
    require(not active and seen == set(plan['privateFiles']), 'incomplete finite private I/O sequence')


def wire(phase, ack=False):
    prefix = 'orca-done' if ack else 'orca-phase'
    return f"{prefix}:{phase['name']}:{phase['token']}\n".encode('ascii')


def frame_trace(text, plan, supervisor_log, used_tokens):
    """Locate complete phase windows; returned events still require full verification.

    supervisor_log consists of supervisor-owned sent/received entries, retained
    during actual channel I/O. A tracee's matching acknowledgement alone is never
    proof of a settled lease or authenticated lifecycle result.
    """
    validate_plan(plan, used_tokens)
    require(type(text) is str and len(text.encode('utf-8')) <= plan['maximumTraceBytes'],
            'trace exceeds bounded plan')
    expected_log = [{'event': event, **phase} for phase in plan['phases']
                    for event in ('sent', 'received')]
    require(supervisor_log == expected_log, 'missing/replayed/out-of-order supervisor acknowledgement')
    records = list(events(text, with_intervals=True))
    marks, next_mark = [], 0
    for record in records:
        pid, call, args, result, entered, completed = record
        require(call in SUPPORTED, 'unsupported syscall: ' + call)
        control = None
        if call in FD_FIRST | {'close'} and args and re.fullmatch(r'(0x[0-9a-f]+|[0-9]+)(?:<.*>)?', args[0]):
            number = fd(args[0])
            if number in (plan['commandFd'], plan['ackFd']):
                control = number
        if call == 'mmap' and len(args) > 4 and args[4] not in ('-1', '0xffffffffffffffff'):
            require(fd(args[4]) not in (plan['commandFd'], plan['ackFd']), 'control descriptor mapping')
        if control is None:
            continue
        require(next_mark < len(plan['phases']) * 2, 'replayed phase boundary')
        phase = plan['phases'][next_mark // 2]
        ack = bool(next_mark % 2)
        data = wire(phase, ack)
        require(pid == plan['leaderPid'] and call == ('write' if ack else 'read') and
                control == plan['ackFd' if ack else 'commandFd'], 'wrong phase boundary operation')
        require(len(args) == 3 and args[2] == str(len(data)) and
                result == str(len(data)) and string(args[1]) == data, 'partial/changed phase boundary')
        require(not marks or entered > marks[-1][5], 'overlapping phase boundaries')
        marks.append(record)
        next_mark += 1
    require(next_mark == len(plan['phases']) * 2, 'missing phase command/acknowledgement')
    # A non-passive operation spanning either edge cannot safely be assigned by
    # entry order. Classify it here, before returning events for downstream replay.
    boundaries = [(r[4], r[5]) for r in marks]
    for record in records:
        if record in marks or record[1] in BOUNDARY_PASSIVE:
            continue
        require(not any(record[4] <= b and record[5] >= a for a, b in boundaries),
                'effect crosses phase boundary interval')
    return {
        'record': 'phase-framing-only', 'authority': 'none',
        'phases': [{'name': phase['name'], 'startCompletion': marks[i * 2][5],
                    'ackEntry': marks[i * 2 + 1][4],
                    'events': [r for r in records if r[4] > marks[i * 2][5] and
                               r[5] < marks[i * 2 + 1][4]]}
                   for i, phase in enumerate(plan['phases'])],
        'outsideEvents': [r for r in records if r not in marks and not any(
            r[4] > marks[i * 2][5] and r[5] < marks[i * 2 + 1][4]
            for i in range(len(plan['phases'])))],
    }
