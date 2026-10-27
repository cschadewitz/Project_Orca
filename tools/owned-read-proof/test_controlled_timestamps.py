"""Timestamp grammar/negative controls; no synthetic bootstrap qualification."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import subprocess
import unittest

from controlled_timestamps import (NS, OWNER_NS, OPTION, KIND, SOURCE, PRODUCER,
    PRODUCER_INPUT_SHA, CHILD_SHA, sha, unix_ns, iso_ns, clock_samples, validate_clock,
    strip_prefixes, timestamped_events, resource_entry, expiry_bound)

START = 1793030000 * NS
# Historical grammar fixtures must retain their reviewed bytes when the working
# child changes. This does not update the observer's reviewed source/image pins.
REVIEWED_CHILD = subprocess.run(
    ['git', 'show', SOURCE + ':tools/owned-read-proof/controlled-child.mjs'],
    cwd=Path(__file__).resolve().parents[2], capture_output=True, check=True, timeout=5).stdout


def clock_original():
    def sample(wall):
        return {'wallNs': wall, 'monotonicBeforeNs': wall - 10**18 - 10,
                'monotonicAfterNs': wall - 10**18 + 10}
    child = REVIEWED_CHILD
    producer = b'synthetic bundle for grammar controls only'
    return {'sourceHead': SOURCE, 'argv': ['/node', '/image/controlled-child.mjs'],
        'immutable': {path: {'family': 'image', 'hex': data.hex(), 'sha256': sha(data)} for path, data in
                      [('/image/controlled-child.mjs', child), ('/image/controlled-producer.mjs', producer)]},
        'controlledBuild': {'childSha256': CHILD_SHA, 'producerSha256': sha(producer),
                            'sources': {PRODUCER: PRODUCER_INPUT_SHA}},
        'startedWallNs': START, 'finishedWallNs': START + 10 * NS,
        'clockSamples': {'start': sample(START), 'finish': sample(START + 10 * NS)},
        'traceClock': {'kind': KIND, 'clock': 'CLOCK_REALTIME', 'option': OPTION,
            'supervisorRealtime': 'clock_gettime(CLOCK_REALTIME)',
            'supervisorMonotonic': 'clock_gettime(CLOCK_MONOTONIC)',
            'tracerPath': '/strace', 'tracerSha256': 'a'*64, 'helpSha256': 'b'*64,
            'version': 'strace -- version 6.13\n', 'bootId': 'test-original-boot',
            'namespaces': {'names': ['time', 'time_for_children'],
                           'time': {'time': 'time:[1]', 'time_for_children': 'time:[1]'}},
            'probe': {'start': sample(START - 2 * NS), 'finish': sample(START - NS),
                      'firstPrefixNs': START - 2 * NS + 1, 'lastPrefixNs': START - NS - 1,
                      'traceSha256': 'c'*64}}}


def prefix(value):
    return f'{value // NS}.{value % NS:09d}'


class EntryClockControls(unittest.TestCase):
    def test_exact_integer_unix_and_iso_fractional_rollover(self):
        self.assertEqual(unix_ns('1793030001.000000000') - unix_ns('1793030000.999999999'), 1)
        self.assertEqual(iso_ns('2026-10-27T00:00:00.000Z') - iso_ns('2026-10-26T23:59:59.999Z'), 1_000_000)
        self.assertIs(type(iso_ns('2026-10-26T18:18:00.230Z')), int)
        self.assertEqual(iso_ns('2026-10-26T18:18:00.230Z'), 1793038680230000000)
        for value in ['2026-10-26T18:18:00.230+00:00', '2026-10-26T18:18:00Z',
                      '2026-10-26T18:18:00.230000Z', '2026-13-26T18:18:00.230Z']:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                iso_ns(value)

    def test_exact_prefixes_preserve_unfinished_resumed_raw_line_intervals(self):
        o = clock_original()
        trace = (f'10 {prefix(START+1)} openat(AT_FDCWD, "/fixture", O_RDONLY <unfinished ...>\n'
                 f'11 {prefix(START+2)} getpid() = 11\n'
                 f'10 {prefix(START+3)} <... openat resumed>) = 20\n')
        records, times = timestamped_events(trace, o)
        self.assertEqual(records[0][4:], (0, 2))
        self.assertEqual(times[records[0][4]], START+1)
        self.assertEqual(times[records[0][5]], START+3)  # resumed prefix, not fabricated one-line completion
        self.assertEqual(records[1][4:], (1, 1))

    def test_missing_wrong_precision_format_or_elapsed_suffix_refuse(self):
        for value in ['', '1793030000.000000', '18:18:00.000000000', '10.000000000',
                      '1793030000.0000000000', '1793030000,000000000']:
            trace = f'10 {value} getpid() = 10\n'
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                timestamped_events(trace, clock_original())
        # -T is not enabled. Its suffix must not become a completion observation.
        trace = f'10 {prefix(START+1)} getpid() = 10 <0.000000001>\n'
        with self.assertRaisesRegex(RuntimeError, 'elapsed-time suffix'):
            timestamped_events(trace, clock_original())

    def test_wrong_clock_metadata_and_missing_independent_probe_refuse(self):
        for key, value in [('clock', 'CLOCK_MONOTONIC'), ('option', '-ttt'),
                           ('supervisorRealtime', 'time()'), ('kind', 'child-supplied')]:
            o = clock_original(); o['traceClock'][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): validate_clock(o)
        o = clock_original(); o['traceClock']['probe']['firstPrefixNs'] = START - 3*NS
        with self.assertRaisesRegex(RuntimeError, 'probe'): validate_clock(o)
        o = clock_original()
        o['producerReport'] = {'traceClock': o.pop('traceClock'), 'createdAtNs': START+NS}
        with self.assertRaisesRegex(RuntimeError, 'supervisor-retained'): validate_clock(o)

    def test_reversed_out_of_run_and_backward_prefixes_refuse(self):
        for entries in [[START-1], [START+10*NS+1], [START+2, START+1]]:
            trace = ''.join(f'10 {prefix(t)} getpid() = 10\n' for t in entries)
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                timestamped_events(trace, clock_original())
        with self.assertRaisesRegex(RuntimeError, 'reversed'):
            strip_prefixes(f'10 {prefix(START)} getpid() = 10\n', START+1, START)

    def test_incompatible_clock_sample_and_monotonic_timeout_refuse(self):
        o = clock_original()
        o['clockSamples']['finish']['wallNs'] += 1
        o['finishedWallNs'] += 1
        # 1ns remains inside the sample's genuine read bracket; no guessed epsilon.
        validate_clock(o)
        o['clockSamples']['finish']['wallNs'] += 100
        o['finishedWallNs'] += 100
        with self.assertRaisesRegex(RuntimeError, 'incompatible'): validate_clock(o)
        o = clock_original(); finish = o['clockSamples']['finish']
        for key in finish: finish[key] += 51*NS
        o['finishedWallNs'] += 51*NS
        with self.assertRaisesRegex(RuntimeError, '60-second'): validate_clock(o)
        o = clock_original(); o['startedWallNs'] = float(o['startedWallNs'])
        with self.assertRaises(RuntimeError): validate_clock(o)

    def test_exact_bound_equality_plus_one_ns_and_finish_equality(self):
        o = clock_original(); c = START + NS
        expiry_bound(o, c, c+OWNER_NS)
        with self.assertRaisesRegex(RuntimeError, 'create-entry bound'): expiry_bound(o, c, c+OWNER_NS+1)
        with self.assertRaisesRegex(RuntimeError, 'create-entry bound'): expiry_bound(o, c, o['finishedWallNs'])
        for bad in [START-1, o['finishedWallNs']+1]:
            with self.assertRaises(RuntimeError): expiry_bound(o, bad, c+OWNER_NS)

    def test_source_ordering_and_exact_image_binding_are_required(self):
        for change in ['source', 'producer', 'child', 'image', 'child-bytes']:
            o = clock_original()
            if change == 'source': o['sourceHead'] = 'other'
            elif change == 'producer': o['controlledBuild']['sources'][PRODUCER] = '0'*64
            elif change == 'child': o['controlledBuild']['childSha256'] = '0'*64
            elif change == 'image': o['immutable']['/image/controlled-producer.mjs']['hex'] = b'redirected'.hex()
            else: o['immutable']['/image/controlled-child.mjs']['hex'] = b'unreviewed child'.hex()
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                expiry_bound(o, START+NS, START+NS+OWNER_NS)


class ResourceEntryControls(unittest.TestCase):
    def fixture(self):
        args = ['AT_FDCWD', '"/base/orca-owned-service-Ab1234/fixture"',
                'O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC', '0400']
        obj = SimpleNamespace(creation_record=(10, 'openat', args, '20', 0, 2),
                              creation_entry=0, creation_path='/base/orca-owned-service-Ab1234/fixture')
        replay = SimpleNamespace(resources=[obj], leader=10, entry_times={0:START+NS, 2:START+9*NS},
                                 family=lambda p: 'resource' if p == obj.creation_path else 'unknown')
        return replay, obj

    def test_delayed_completion_cannot_excuse_one_ns_excess(self):
        r, obj = self.fixture()
        c = resource_entry(r, obj)
        self.assertEqual(c, START+NS)
        with self.assertRaisesRegex(RuntimeError, 'create-entry bound'):
            expiry_bound(clock_original(), c, c+OWNER_NS+1)
        # Selecting completion would incorrectly pass this; it is never selected.
        expiry_bound(clock_original(), r.entry_times[2], c+OWNER_NS+1)

    def test_failed_readonly_wrong_pid_and_wrong_raw_line_anchors_refuse(self):
        for change in ['failed', 'readonly', 'pid', 'raw-line', 'call', 'family']:
            r, obj = self.fixture(); pid, call, args, result, en, co = obj.creation_record
            if change == 'failed': result = '-1 EACCES (Permission denied)'
            elif change == 'readonly': args[2] = 'O_RDONLY|O_CLOEXEC'
            elif change == 'pid': pid = 11
            elif change == 'raw-line': en = 1
            elif change == 'call': call = 'statx'
            else: r.family = lambda p: 'private'
            obj.creation_record = (pid, call, args, result, en, co)
            with self.subTest(change=change), self.assertRaises(RuntimeError): resource_entry(r, obj)

    def test_missing_duplicate_other_object_and_child_timestamp_refuse(self):
        r, obj = self.fixture(); r.resources.append(deepcopy(obj))
        with self.assertRaisesRegex(RuntimeError, 'duplicate'): resource_entry(r, obj)
        r, obj = self.fixture()
        with self.assertRaisesRegex(RuntimeError, 'original resource'): resource_entry(r, deepcopy(obj))
        r.entry_times = {2: START+9*NS}
        obj.childTimestampNs = START+NS
        with self.assertRaisesRegex(RuntimeError, 'ENTRY timestamp'): resource_entry(r, obj)
