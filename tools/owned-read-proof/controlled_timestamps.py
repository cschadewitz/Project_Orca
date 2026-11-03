"""Supervisor-owned strace 6.13 UNIX entry prefixes, never completion estimates.

Only the finite controlled lane uses this adapter. Candidate events/behavior are
unchanged. A normal completed line still supplies only an entry-prefix sample;
unfinished/resumed framing remains the candidate decoder's original raw lines.
"""
import calendar
from datetime import datetime
import hashlib
from pathlib import Path
import re
import subprocess
import time
import os
import stat

from controlled_contract import require
from run import run_traced
from verify import events, string

NS = 1_000_000_000
OWNER_NS = 55 * NS
RUN_NS = 60 * NS
# Provisional engineering restriction, not a measured need or storage grant.
# Changing this fixed source cap requires a later review; overflow never retries.
CLOCK_PROBE_TRACE_LIMIT = 1024 * 1024
_CLOCK_PROBE_READ_SIZE = 64 * 1024
OPTION = '--absolute-timestamps=format:unix,precision:ns'
KIND = 'strace-6.13-unix-entry-nanoseconds-v1'
SOURCE = '3fce8bcc9afd381cd07c0e06051921307d6322b3'
PRODUCER = 'packages/cli/test/controlled-owned-read-producer.ts'
PRODUCER_INPUT_SHA = '61d62d01d32057036ea3cd638fa6a04abcf3f0b04be9973ae3c1c24ee44295a8'
CHILD_SHA = '17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13'
PREFIX = re.compile(r'([1-9][0-9]*)\s+([1-9][0-9]*\.[0-9]{9})\s+(\S.*)')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def integer(value):
    return type(value) is int and value >= 0


def unix_ns(text):
    require(type(text) is str and re.fullmatch(r'[1-9][0-9]*\.[0-9]{9}', text),
            'missing/wrong-format UNIX nanosecond prefix')
    seconds, fraction = text.split('.')
    return int(seconds) * NS + int(fraction)


def iso_ns(text):
    # Reviewed producer uses Date.toISOString(): exactly milliseconds and UTC Z.
    require(type(text) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', text),
            'authenticated timestamp is not exact UTC milliseconds')
    try:
        value = datetime.strptime(text, '%Y-%m-%dT%H:%M:%S.%fZ')
    except ValueError as error:
        raise RuntimeError('invalid authenticated UTC timestamp') from error
    return calendar.timegm(value.timetuple()) * NS + value.microsecond * 1000


def sample_clock():
    before = time.monotonic_ns()
    wall = time.time_ns()
    after = time.monotonic_ns()
    return {'wallNs': wall, 'monotonicBeforeNs': before, 'monotonicAfterNs': after}


def clock_namespaces():
    # CONFIG_TIME_NS is optional. Retain the actual namespace inventory and
    # explicit absence, rather than inventing an unavailable time namespace link.
    names = sorted(os.listdir('/proc/self/ns'))
    return {'names': names, 'time': {name: os.readlink('/proc/self/ns/' + name)
            for name in ('time', 'time_for_children') if name in names}}


def clock_samples(samples):
    """Require a common realtime-minus-monotonic offset, without guessed slack."""
    low, high, previous = None, None, None
    for sample in samples:
        wall, before, after = [sample[k] for k in ('wallNs', 'monotonicBeforeNs', 'monotonicAfterNs')]
        require(all(integer(v) for v in (wall, before, after)) and before <= after,
                'invalid integer supervisor clock sample')
        require(previous is None or previous <= before, 'backward supervisor monotonic clock')
        previous = after
        a, b = wall - after, wall - before
        low = a if low is None else max(low, a)
        high = b if high is None else min(high, b)
        require(low <= high, 'incompatible/backward realtime and monotonic clocks')
    require(low is not None, 'missing independent supervisor clock samples')


def strip_prefixes(text, start_ns, finish_ns):
    require(integer(start_ns) and integer(finish_ns) and 0 < start_ns <= finish_ns,
            'invalid/reversed supervisor UNIX nanosecond bounds')
    require(text and text.endswith('\n'), 'missing/incomplete timestamped trace')
    cleaned, times, previous = [], {}, start_ns
    for number, line in enumerate(text.splitlines()):
        match = PREFIX.fullmatch(line)
        require(match is not None, f'line {number}: missing/wrong-precision UNIX nanosecond prefix')
        require(re.search(r' <[0-9]+\.[0-9]+>$', match[3]) is None,
                f'line {number}: unrequested elapsed-time suffix is not an absolute completion stamp')
        instant = unix_ns(match[2])
        require(start_ns <= instant <= finish_ns, f'line {number}: timestamp outside original run/clock')
        require(previous <= instant, f'line {number}: backward trace clock')
        previous = instant
        times[number] = instant
        cleaned.append(match[1] + ' ' + match[3])
    return '\n'.join(cleaned) + '\n', times


def clock_probe_command(tracer, path):
    """Fixed regular-file limit around the tracer, with no caller cap/flags."""
    return ['prlimit', f'--fsize={CLOCK_PROBE_TRACE_LIMIT}:{CLOCK_PROBE_TRACE_LIMIT}',
            '--core=0:0', tracer, '--kill-on-exit', '--always-show-pid', OPTION,
            '-o', str(path), '/usr/bin/true']


def _clock_probe_stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _clock_probe_file(info):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600,
            'clock probe trace is not a private unaliased regular file')
    require(0 <= info.st_size <= CLOCK_PROBE_TRACE_LIMIT,
            'clock probe trace exceeds fixed source byte bound')
    return _clock_probe_stamp(info)


def _close_clock_probe_files(numbers, failure):
    # Every owned descriptor is consumed once, including an ambiguous close.
    # Keep the first private exception without formatting or cleanup masking.
    for number in numbers:
        if number is not None:
            try:
                os.close(number)
            except BaseException as error:
                if failure is None:
                    failure = error
    if failure is not None:
        raise failure


def prepare_clock_probe_trace(path):
    """Create once in the original fresh root; existing paths never get touched."""
    number = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                     os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    failure = None
    try:
        os.fchmod(number, 0o600)
        info = os.fstat(number)
        require(info.st_size == 0 and _clock_probe_file(info) ==
                _clock_probe_stamp(os.lstat(path)), 'clock probe trace changed during preparation')
    except BaseException as error:
        failure = error
    _close_clock_probe_files((number,), failure)


def read_clock_probe_trace(path):
    """Bound exact bytes from a pinned inode; trusted local ancestors/procfs only.

    O_PATH avoids device/FIFO read-open effects before validation. The trusted
    procfd open follows only that owned, validated regular inode, never the
    replaceable input path. Stamps detect observed changes, not hostile ABA.
    """
    pin = reader = None
    failure = None
    try:
        pin = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(pin)
        before = _clock_probe_file(info)
        require(_clock_probe_stamp(os.lstat(path)) == before,
                'clock probe trace changed before read-open')
        reader = os.open('/proc/self/fd/' + str(pin),
                         os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        require(_clock_probe_file(os.fstat(reader)) == before and
                _clock_probe_stamp(os.fstat(pin)) == before and
                _clock_probe_stamp(os.lstat(path)) == before,
                'clock probe trace changed during read-open')
        chunks, count = [], 0
        while count < info.st_size:
            amount = min(_CLOCK_PROBE_READ_SIZE, info.st_size - count)
            chunk = os.read(reader, amount)
            require(type(chunk) is bytes and 0 < len(chunk) <= amount,
                    'clock probe trace ended before retained size')
            count += len(chunk)
            require(count <= CLOCK_PROBE_TRACE_LIMIT, 'clock probe trace exceeds fixed source byte bound')
            chunks.append(chunk)
        require(os.read(reader, 1) == b'', 'clock probe trace grew beyond retained size')
        require(_clock_probe_file(os.fstat(reader)) == before and
                _clock_probe_stamp(os.fstat(pin)) == before and
                _clock_probe_stamp(os.lstat(path)) == before,
                'clock probe trace changed during read')
        # Count is bounded before joining or decoding; sentinel bytes never join.
        data = b''.join(chunks)
    except BaseException as error:
        failure = error
    _close_clock_probe_files((reader, pin), failure)
    return data


def probe_clock(tracer, root):
    """Actual harmless capability/clock probe with this retained installed tracer."""
    help_data = subprocess.run([tracer, '--help'], capture_output=True, check=True, timeout=5).stdout
    version = subprocess.run([tracer, '--version'], capture_output=True, check=True, timeout=5).stdout
    require(version.splitlines()[0] == b'strace -- version 6.13', 'unreviewed tracer version for entry clock provenance')
    require(b'--absolute-timestamps=[[format:]FORMAT[,[precision:]PRECISION]]' in help_data and
            b'none, time, or unix' in help_data and b's, ms, us, ns' in help_data,
            'installed tracer lacks documented UNIX nanosecond option')
    require(time.get_clock_info('time').implementation == 'clock_gettime(CLOCK_REALTIME)' and
            time.get_clock_info('monotonic').implementation == 'clock_gettime(CLOCK_MONOTONIC)',
            'unsupported supervisor clock implementation')
    path = root / 'clock-probe.trace'
    prepare_clock_probe_trace(path)
    start = sample_clock()
    result = run_traced(clock_probe_command(tracer, path), stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, timeout=5)
    finish = sample_clock()
    clock_samples([start, finish])
    require(result.returncode == 0, 'installed tracer UNIX nanosecond probe failed')
    raw = read_clock_probe_trace(path)
    text = raw.decode('utf-8')
    cleaned, prefixes = strip_prefixes(text, start['wallNs'], finish['wallNs'])
    records = list(events(cleaned, with_intervals=True))
    require(records[0][1] == 'execve' and string(records[0][2][0]) == b'/usr/bin/true' and
            records[-1][1] == 'settled', 'clock probe is not the original harmless traced process')
    return {'kind': KIND, 'clock': 'CLOCK_REALTIME', 'option': OPTION,
            'supervisorRealtime': 'clock_gettime(CLOCK_REALTIME)',
            'supervisorMonotonic': 'clock_gettime(CLOCK_MONOTONIC)',
            'tracerPath': tracer, 'tracerSha256': sha(Path(tracer).read_bytes()),
            'version': version.decode(), 'helpSha256': sha(help_data),
            'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'namespaces': clock_namespaces(),
            'probe': {'start': start, 'finish': finish, 'traceSha256': sha(raw),
                      'firstPrefixNs': prefixes[0], 'lastPrefixNs': prefixes[len(prefixes) - 1]}}


def validate_clock(original):
    value = original.get('traceClock')
    require(type(value) is dict and value.get('kind') == KIND and
            value.get('clock') == 'CLOCK_REALTIME' and value.get('option') == OPTION and
            value.get('supervisorRealtime') == 'clock_gettime(CLOCK_REALTIME)' and
            value.get('supervisorMonotonic') == 'clock_gettime(CLOCK_MONOTONIC)',
            'missing/wrong-clock supervisor-retained entry timestamp provenance')
    require(value['version'].splitlines()[0] == 'strace -- version 6.13' and
            all(re.fullmatch(r'[0-9a-f]{64}', value[k]) for k in ('tracerSha256', 'helpSha256')) and
            value['bootId'], 'incomplete retained tracer clock identity')
    namespaces = value['namespaces']
    require(namespaces['names'] == sorted(set(namespaces['names'])) and
            set(namespaces['time']) == set(namespaces['names']) & {'time', 'time_for_children'} and
            all(re.fullmatch(r'time:\[[0-9]+\]', v) for v in namespaces['time'].values()),
            'missing/ambiguous retained time namespace inventory')
    probe = value['probe']
    require(all(integer(v) for v in (probe['start']['wallNs'], probe['firstPrefixNs'],
                                    probe['lastPrefixNs'], probe['finish']['wallNs'])) and
            probe['start']['wallNs'] <= probe['firstPrefixNs'] <= probe['lastPrefixNs'] <= probe['finish']['wallNs'] and
            re.fullmatch(r'[0-9a-f]{64}', probe['traceSha256']), 'invalid independent tracer clock probe')
    samples = [probe['start'], probe['finish'], original['clockSamples']['start']]
    samples.extend(original['clockSamples'].get('phases', []))
    samples.append(original['clockSamples']['finish'])
    clock_samples(samples)
    start, finish = original['startedWallNs'], original['finishedWallNs']
    require(type(start) is int and type(finish) is int and start == samples[2]['wallNs'] and
            finish == samples[-1]['wallNs'] and start <= finish, 'wrong retained run clock bounds')
    require(samples[-1]['monotonicAfterNs'] - samples[2]['monotonicBeforeNs'] <= RUN_NS,
            'original monotonic run exceeds unchanged 60-second bound')
    return start, finish


def timestamped_events(text, original):
    start, finish = validate_clock(original)
    cleaned, times = strip_prefixes(text, start, finish)
    return list(events(cleaned, with_intervals=True)), times


def resource_entry(replay, resource):
    require(len(replay.resources) == 1 and replay.resources[0] is resource and
            hasattr(resource, 'creation_record'), 'missing/duplicate original resource create anchor')
    pid, call, args, result, entered, completed = resource.creation_record
    require(pid == replay.leader and call == 'openat' and len(args) == 4 and
            args[0] == 'AT_FDCWD' and args[2:] == ['O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC', '0400'] and
            re.fullmatch(r'[1-9][0-9]*', result) and resource.creation_entry == entered and entered <= completed and
            string(args[1]).decode() == resource.creation_path and replay.family(resource.creation_path) == 'resource',
            'wrong original successful leader/exclusive resource create anchor')
    require(entered in replay.entry_times, 'missing original resource create ENTRY timestamp')
    return replay.entry_times[entered]


def source_binding(original):
    _source_binding(original, SOURCE, PRODUCER_INPUT_SHA, CHILD_SHA)


def _source_binding(original, source, producer_input_sha, child_sha):
    build = original.get('controlledBuild', {})
    require(original.get('sourceHead') == source and build.get('sources', {}).get(PRODUCER) == producer_input_sha and
            build.get('childSha256') == child_sha,
            'missing reviewed expiry-before-service source ordering')
    child = Path(original['argv'][1])
    for path, expected in [(str(child), build['childSha256']),
                           (str(child.parent / 'controlled-producer.mjs'), build['producerSha256'])]:
        value = original['immutable'][path]
        require(value['family'] == 'image' and value['sha256'] == expected and
                sha(bytes.fromhex(value['hex'])) == expected, 'expiry source ordering lacks exact original image binding')


def expiry_bound(original, creation_ns, expiry_ns):
    source_binding(original)
    start, finish = validate_clock(original)
    require(all(type(v) is int for v in (creation_ns, expiry_ns)) and
            start <= creation_ns <= finish < expiry_ns <= creation_ns + OWNER_NS,
            'bootstrap expiry outside original timestamped create-entry bound')
