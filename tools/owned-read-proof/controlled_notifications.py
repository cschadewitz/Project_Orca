"""Finite normal-eventfd unit-notification grammar, never service authority.

Only little-endian uint64 writes of one and successful 1024-byte-buffer reads of
an exact uint64 counter are modeled. The initial counter is independently bound
by Replay to eventfd2(0, EFD_CLOEXEC|EFD_NONBLOCK); semaphore/overflow/control modes
are outside this grammar. Raw intervals supply a partial order, not clock instants.
"""
from dataclasses import dataclass
import heapq
import sys

from controlled_contract import require
from verify import string

KIND = 'leader-eventfd-unit-notification-v1'


@dataclass(frozen=True)
class NotificationIO:
    pid: int
    call: str
    value: int
    entered: int
    completed: int


def notification_io(record, reader):
    pid, call, args, result, entered, completed = record
    require(sys.byteorder == 'little', 'unreviewed eventfd notification byte order')
    require(call in {'read', 'write'} and len(args) == 3 and result == '8' and
            type(entered) is int and type(completed) is int and 0 <= entered <= completed,
            'unreviewed eventfd notification operation/result/interval')
    data = string(args[1])
    require(len(data) == 8, 'notification counter is not fully decoded uint64')
    value = int.from_bytes(data, 'little')
    if call == 'write':
        require(args[2] == '8' and value == 1, 'notification write is not exact unit increment')
    else:
        require(pid == reader and args[2] == '1024' and 0 < value < 2**64 - 1,
                'notification read is not original leader positive-counter drain')
    return NotificationIO(pid, call, value, entered, completed)


def prove_unit_counter(operations, reader):
    """Check one single-reader counter lifetime against all observed intervals.

    Unit writes commute. At each drain, greedily consume eligible writes with the
    earliest completion bound. Any unconsumed earlier-deadline write makes that
    drain impossible. This preserves the most flexible writes for later drains.
    No witness order is applied to unrelated effects or interpreted as clock time.
    """
    require(operations, 'missing eventfd notification history')
    by_thread, boundaries = {}, set()
    for op in operations:
        require(op.call in {'read', 'write'} and op.pid > 0 and 0 <= op.entered <= op.completed and
                (op.call != 'read' or op.pid == reader and op.value > 0) and
                (op.call != 'write' or op.value == 1), 'invalid typed notification history')
        endpoints = {op.entered, op.completed}
        require(not boundaries & endpoints, 'duplicate notification raw boundary identity')
        boundaries |= endpoints
        by_thread.setdefault(op.pid, []).append(op)
    for history in by_thread.values():
        history.sort(key=lambda op: op.entered)
        require(all(a.completed < b.entered for a, b in zip(history, history[1:])),
                'overlapping calls in one notification thread')
    writes = sorted((op for op in operations if op.call == 'write'), key=lambda op: op.entered)
    reads = sorted((op for op in operations if op.call == 'read'), key=lambda op: op.entered)
    require(reads and len(writes) < 2**64 - 1, 'notification drain/overflow observation unavailable')
    eligible, cursor, previous_point = [], 0, -1
    for read in reads:
        while cursor < len(writes) and writes[cursor].entered < read.completed:
            op = writes[cursor]
            heapq.heappush(eligible, (op.completed, op.entered, cursor))
            cursor += 1
        require(read.value <= len(eligible), 'counter drain exceeds interval-eligible unit writes')
        point = read.entered
        for _ in range(read.value):
            completed, entered, _ = heapq.heappop(eligible)
            require(previous_point < completed, 'counter write was already due before preceding drain')
            point = max(point, entered)
        require(point <= read.completed and (not eligible or point < eligible[0][0]),
                'counter drain leaves an unavoidable earlier unit write')
        previous_point = point
    require(not eligible and cursor == len(writes), 'notification lifetime lacks final counter drain')
    return {'kind': KIND, 'authority': 'none', 'unitWrites': len(writes),
            'counterReads': len(reads), 'counterFinal': 0,
            'ordering': 'notification-counter-partial-order-only'}
