"""Existing diagnostic source bounds with synthetic metadata and owned temp FDs.

No observer/tracer/probe body is invoked or extracted. Large synthetic escaping
checks the real serializer/writer; this does not allocate host observation quota.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import controlled_diagnostics as subject
from test_diagnostic_rollback import EXPECTED, RAW_STAT


class PrivateFailure(BaseException):
    def __str__(self):
        raise AssertionError('private exception string conversion')

    def __repr__(self):
        raise AssertionError('private exception representation')

    def __bool__(self):
        raise AssertionError('private exception truthiness')


class Pin:
    def __init__(self, error=None):
        self.expected, self.identity = dict(EXPECTED), (0o40500, 2, 3)
        self.error, self.closes = error, 0

    def close(self):
        self.closes += 1
        if self.error is not None:
            raise self.error


def sample():
    return {'monotonicBeforeNs': 1, 'wallNs': 2, 'traceBytes': 3, 'phaseEventCount': 4,
            'processes': {}, 'resources': {'cpu.stat': {}, 'io.stat': '',
                                         'memory.events': {}, 'memory.current': ''},
            'monotonicAfterNs': 5}


def process():
    return {'status': 'live-pinned-original', **subject.proc_fields(RAW_STAT),
            'schedstat': {'runtimeNs': 1, 'runnableWaitNs': 2, 'timeslices': 3},
            'io': {}, 'sampleEndUserTicks': 3, 'sampleEndSystemTicks': 4}


@contextmanager
def retention(samples=None, errors=None, pins=None):
    with tempfile.TemporaryDirectory(prefix='orca-diagnostic-bound-') as directory:
        root = Path(directory)
        value = subject.SparseDiagnostics.__new__(subject.SparseDiagnostics)
        value._retention_state = 'ready'
        value._first_failure = value._cleanup_error = value._collection_failure = None
        value.samples = [sample()] if samples is None else samples
        value.errors = [] if errors is None else errors
        value.processes = {'supervisor': Pin()} if pins is None else pins
        value.resource = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        value.thread, value.stopped = None, True
        try:
            yield value, root / 'diagnostics.json'
        finally:
            if value.resource is not None:
                number, value.resource = value.resource, None
                os.close(number)


class DiagnosticBounds(unittest.TestCase):
    def test_bound_equation_uses_existing_reads_frames_and_separate_native_metadata(self):
        self.assertEqual((subject.READ_BOUND, subject.MAX_SAMPLES, subject.PERIOD_NS),
                         (8192, 62, 1_000_000_000))
        self.assertEqual(subject.CONFIG_JSON_BOUND, 450)
        self.assertEqual(subject.READ_JSON_BOUND, 49154)
        self.assertEqual(subject.INTEGER_BITS, 4 * subject.READ_BOUND)
        self.assertEqual(subject.INTEGER_JSON_BOUND, 9866)
        self.assertEqual(subject.MAX_COUNTER_PAIRS, 2048)
        self.assertEqual(subject.PROCESS_JSON_FRAME, 270)
        self.assertEqual(subject.SAMPLE_JSON_FRAME, 238)
        self.assertEqual(subject.PIN_JSON_FRAME, 81)
        self.assertEqual(subject.PINS_JSON_BOUND, 35 + 3 * (81 + 8 * 9866))
        row = 238 + 5 * 9866 + (3 * 4 + 4) * 49154 + 3 * 270
        self.assertEqual(row, subject.SAMPLE_JSON_BOUND)
        self.assertEqual(81 + 450 + 2 + 62 * row + 61 + 45 + 237062,
                         subject.DIAGNOSTIC_SERIALIZED_BOUND)
        self.assertEqual(subject.DIAGNOSTIC_SERIALIZED_BOUND, 52121905)

    def test_max_sample_role_resource_count_and_escaping_real_serialization_and_write(self):
        counter = subject.counters('\x00' * (subject.READ_BOUND - 2) + ' 0')
        row = sample()
        row['resources'] = {'cpu.stat': counter, 'io.stat': '\x00' * subject.READ_BOUND,
                            'memory.events': counter, 'memory.current': '\x00' * subject.READ_BOUND}
        for role in subject.CONFIG['processes']:
            item = process()
            item['io'] = counter
            row['processes'][role] = item
        for key in ('monotonicBeforeNs', 'wallNs', 'traceBytes', 'phaseEventCount', 'monotonicAfterNs'):
            row[key] = (1 << 64) - 1
        row['finalAfterOwnedSettlement'] = True
        pins = {name: Pin() for name in subject.CONFIG['processes']}
        pin_values = list(pins.values())
        with retention([row] * 62, ['sampler-work-failed', 'final-sample-failed'], pins) as (owner, path):
            original_collection = PrivateFailure()
            owner._collection_failure = original_collection
            value = owner.retain_and_close(path)
            size = path.stat().st_size
            self.assertGreater(size, 16 * 1024 * 1024)
            self.assertLessEqual(size, subject.DIAGNOSTIC_SERIALIZED_BOUND)
            self.assertEqual(json.loads(path.read_bytes()), value)
            self.assertEqual(list(value['samples'][0]), list(row))  # Preserve source insertion order.
            self.assertEqual(value['config'], subject.CONFIG)
            self.assertIs(owner._collection_failure, original_collection)
            self.assertEqual([pin.closes for pin in pin_values], [1, 1, 1])
            self.assertIsNone(owner.resource)
            self.assertEqual(owner._retention_state, 'consumed')

    def test_raw_entry_checks_precede_splitting_and_numeric_conversion(self):
        class Text(str):
            def split(self, *args):
                raise AssertionError('custom split')
            def splitlines(self, *args):
                raise AssertionError('custom splitlines')
        for raw in ('x' * (subject.READ_BOUND + 1), 'é', Text('a 0'), b'a 0', None):
            for parser in (subject.counters, subject.proc_fields):
                with self.subTest(parser=parser.__name__, kind=type(raw)), self.assertRaisesRegex(RuntimeError, 'ASCII read bound'):
                    parser(raw)
        self.assertEqual(subject.counters('a 0\n' * (subject.READ_BOUND // 4)), {'a': 0})
        padded = RAW_STAT + ' ' * (subject.READ_BOUND - len(RAW_STAT))
        self.assertEqual(subject.proc_fields(padded), subject.proc_fields(RAW_STAT))

    def test_aggregate_stat_group_rejects_individually_bounded_giant_values(self):
        row, item = sample(), process()
        number = 1 << (subject.INTEGER_BITS - 1)
        for key in subject._PROC_KEYS:
            if key != 'state':
                item[key] = number
        row['processes'] = {'supervisor': item}
        with patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion')) as dumps:
            with self.assertRaisesRegex(RuntimeError, 'stat group exceeds read envelope'):
                subject._encode_diagnostic([row], [], {})
        self.assertEqual(dumps.call_count, 0)

    def test_counter_group_and_count_envelopes_precede_json(self):
        cases = ({'x' * subject.READ_BOUND: 0},
                 {str(i): 0 for i in range(subject.MAX_COUNTER_PAIRS + 1)},
                 {'a': 1 << (subject.INTEGER_BITS + 1)}, {'a': -1}, {'a': True})
        for counters in cases:
            row = sample()
            row['resources']['cpu.stat'] = counters
            with self.subTest(count=len(counters)), patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion')) as dumps:
                with self.assertRaises(RuntimeError):
                    subject._encode_diagnostic([row], [], {})
                self.assertEqual(dumps.call_count, 0)

    def test_all_scalar_groups_and_native_fields_have_preconversion_checks(self):
        cases = []
        row = sample(); row['wallNs'] = 1 << (subject.INTEGER_BITS + 1); cases.append(row)
        row = sample(); row['traceBytes'] = True; cases.append(row)
        row = sample(); row['resources']['io.stat'] = 'é'; cases.append(row)
        row = sample(); row['resources']['memory.current'] = 'x' * (subject.READ_BOUND + 1); cases.append(row)
        row = sample(); item = process(); item['state'] = 'x' * subject.READ_BOUND; row['processes']['supervisor'] = item; cases.append(row)
        row = sample(); item = process(); item['schedstat']['timeslices'] = 1 << (subject.INTEGER_BITS + 1); row['processes']['supervisor'] = item; cases.append(row)
        row = sample(); item = process(); item['sampleEndUserTicks'] = 1 << (subject.INTEGER_BITS + 1); row['processes']['supervisor'] = item; cases.append(row)
        for row in cases:
            with patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion')) as dumps:
                with self.assertRaises(RuntimeError):
                    subject._encode_diagnostic([row], [], {})
                self.assertEqual(dumps.call_count, 0)

    def test_invalid_graphs_and_custom_objects_refuse_before_json_and_file_open(self):
        class Mapping(dict):
            def items(self):
                raise AssertionError('custom items')
        class Sequence(list):
            def __iter__(self):
                raise AssertionError('custom iteration')
        class Integer(int):
            def __str__(self):
                raise AssertionError('custom numeric conversion')
        cases = []
        cases.append([None])
        cases.append([sample()] * 63)
        cases.append(Sequence([sample()]))
        cases.append([Mapping(sample())])
        row = sample(); row['extra'] = [row]; cases.append([row])
        row = sample(); row['wallNs'] = Integer(1); cases.append([row])
        row = sample(); row['resources']['cpu.stat'] = {'x': row}; cases.append([row])
        row = sample(); row['processes'] = {'unknown-private-role': process()}; cases.append([row])
        for rows in cases:
            with retention(rows) as (owner, path):
                pins = list(owner.processes.values())
                with patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion')) as dumps, patch.object(subject.os, 'open', side_effect=AssertionError('file open')) as opened:
                    with self.assertRaises(RuntimeError):
                        owner.retain_and_close(path)
                    self.assertEqual(dumps.call_count, 0)
                    self.assertEqual(opened.call_count, 0)
                self.assertIsNone(owner.resource)
                self.assertEqual([pin.closes for pin in pins], [1])
                self.assertEqual(owner._retention_state, 'consumed')
                with self.assertRaisesRegex(RuntimeError, 'already attempted'):
                    owner.retain_and_close(path)

    def test_fixed_config_errors_and_pin_metadata_reject_unbounded_or_custom_values(self):
        for errors in (['unknown-private-error'], [PrivateFailure()], ['sampler-work-failed'] * 3):
            with patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion')):
                with self.assertRaises(RuntimeError):
                    subject._encode_diagnostic([], errors, {})
        for field in ('expected', 'identity'):
            pin = Pin()
            if field == 'expected':
                pin.expected['pid'] = 1 << (subject.INTEGER_BITS + 1)
            else:
                pin.identity = [1, 2, []]
            with patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion')):
                with self.assertRaises(RuntimeError):
                    subject._encode_diagnostic([], [], {'supervisor': pin})
        with patch.dict(subject.CONFIG, {'maximumReadBytes': subject.READ_BOUND + 1}), patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion')):
            with self.assertRaisesRegex(RuntimeError, 'fixed diagnostic value'):
                subject._encode_diagnostic([], [], {})

    def test_hash_colliding_custom_keys_cannot_run_equality_before_refusal(self):
        calls = []
        class Key:
            def __init__(self, literal):
                self.literal = literal
            def __hash__(self):
                return hash(self.literal)
            def __eq__(self, other):
                calls.append('eq')
                raise AssertionError('custom equality invoked')
        item = process(); item['io'] = {Key('unavailable'): 0}
        row = sample(); row['resources']['cpu.stat'] = {Key('diagnosticError'): 0}
        expected = {Key('pid'): 9, 'starttime': 1, 'ppid': 8, 'pgrp': 7, 'session': 7}
        checks = (lambda: subject._process_snapshot({Key('diagnosticError'): 0}),
                  lambda: subject._sched_snapshot({Key('unavailable'): 0}),
                  lambda: subject._process_snapshot(item),
                  lambda: subject._sample_snapshot(row),
                  lambda: subject._expected_snapshot(expected, exact=False))
        for check in checks:
            with self.assertRaises(RuntimeError):
                check()
        self.assertEqual(calls, [])

    def test_expected_pid_bound_precedes_str_and_every_native_acquisition(self):
        expected = {**EXPECTED, 'pid': 1 << (subject.INTEGER_BITS + 1)}
        with patch.object(subject.os, 'pidfd_open', side_effect=AssertionError('pidfd')), patch.object(subject.os, 'open', side_effect=AssertionError('open')), patch.object(subject.os, 'dup', side_effect=AssertionError('dup')):
            value = subject.PinnedProcess.__new__(subject.PinnedProcess)
            with self.assertRaisesRegex(RuntimeError, 'integer exceeds source envelope') as caught:
                value.__init__(expected)
            self.assertIs(value._first_failure, caught.exception)
            self.assertIsNone(value.pidfd)
            self.assertIsNone(value.procfd)

    def test_default_integer_conversion_guard_is_preserved(self):
        guard = sys.get_int_max_str_digits()
        number = 1 << (subject.INTEGER_BITS - 1)
        self.assertLessEqual(subject._integer_width(-number), subject.INTEGER_JSON_BOUND)
        row = sample(); row['wallNs'] = number
        if guard and guard < subject.INTEGER_JSON_BOUND - 1:
            with self.assertRaises(ValueError):
                subject._encode_diagnostic([row], [], {})
        else:
            _, data = subject._encode_diagnostic([row], [], {})
            self.assertLessEqual(len(data), subject.DIAGNOSTIC_SERIALIZED_BOUND)
        self.assertEqual(sys.get_int_max_str_digits(), guard)

    def test_input_mutation_after_preflight_does_not_change_serialized_snapshot(self):
        with retention() as (owner, path):
            real_dumps = subject.json.dumps
            original = owner.samples[0]
            pin = owner.processes['supervisor']
            def mutate(value, **kwargs):
                original['resources']['io.stat'] = 'x' * (subject.READ_BOUND + 1)
                owner.samples.append(None)
                pin.expected['pid'] = 1 << (subject.INTEGER_BITS + 1)
                return real_dumps(value, **kwargs)
            with patch.object(subject.json, 'dumps', side_effect=mutate):
                value = owner.retain_and_close(path)
            self.assertEqual(value['samples'][0]['resources']['io.stat'], '')
            self.assertEqual(len(value['samples']), 1)
            self.assertEqual(value['pins']['supervisor']['expected']['pid'], EXPECTED['pid'])
            self.assertEqual(json.loads(path.read_bytes()), value)

    def test_serializer_overflow_and_direct_payload_overflow_refuse_before_open(self):
        overflow = 'x' * (subject.DIAGNOSTIC_SERIALIZED_BOUND + 1)
        with patch.object(subject.json, 'dumps', return_value=overflow), patch.object(subject.os, 'open', side_effect=AssertionError('file open')) as opened:
            with self.assertRaisesRegex(RuntimeError, 'serialization exceeds source envelope'):
                subject._encode_diagnostic([], [], {})
            self.assertEqual(opened.call_count, 0)
        payload = overflow.encode('ascii')
        del overflow
        with patch.object(subject.os, 'open', side_effect=AssertionError('file open')) as opened:
            with self.assertRaisesRegex(RuntimeError, 'payload exceeds source envelope'):
                subject._write_private_diagnostic('synthetic-only', payload)
            self.assertEqual(opened.call_count, 0)

    def test_preflight_and_serializer_failures_keep_existing_private_precedence_and_cleanup(self):
        for failure in ('preflight', 'serializer'):
            with retention() as (owner, path):
                previous, original, cleanup = PrivateFailure(), PrivateFailure(), PrivateFailure()
                owner._collection_failure, owner._first_failure = previous, previous
                pin = owner.processes['supervisor']; pin.error = cleanup
                if failure == 'preflight':
                    owner.samples = [None]
                    override = patch.object(subject.json, 'dumps', side_effect=AssertionError('conversion'))
                    expected = RuntimeError
                else:
                    override = patch.object(subject.json, 'dumps', side_effect=original)
                    expected = PrivateFailure
                with override, self.assertRaises(expected) as caught:
                    owner.retain_and_close(path)
                if failure == 'serializer':
                    self.assertIs(caught.exception, original)
                self.assertIs(owner._first_failure, previous)
                self.assertIs(owner._collection_failure, previous)
                self.assertIs(owner._cleanup_error, cleanup)
                self.assertEqual(pin.closes, 1)
                self.assertIsNone(owner.resource)
                self.assertFalse(path.exists())

    def test_fallback_frames_and_exact_worst_ascii_string_width(self):
        raw = '\x00' * subject.READ_BOUND
        self.assertEqual(len(json.dumps(raw).encode('ascii')), subject.READ_JSON_BOUND)
        for status in ({'status': 'exited-pinned-original'},
                       {'diagnosticError': 'process-sample-failed'}):
            self.assertLessEqual(len(json.dumps(status, separators=(',', ':'))), subject.PROCESS_JSON_FRAME)
        item = process()
        item['schedstat'] = item['io'] = {'unavailable': 'FileNotFoundError'}
        row = sample()
        row['processes'] = {'supervisor': item, 'tracer': {'status': 'exited-pinned-original'},
                            'leader': {'diagnosticError': 'process-sample-failed'}}
        row['resources'] = {key: {'diagnosticError': 'resource-sample-failed'}
                            for key in subject.RESOURCE_NAMES}
        value, data = subject._encode_diagnostic([row], [], {})
        self.assertEqual(json.loads(data), value)
        self.assertLessEqual(len(data), subject.DIAGNOSTIC_SERIALIZED_BOUND)

    def test_own_stat_uncertain_native_close_never_retries_reused_descriptor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'stat'; path.write_text(RAW_STAT)
            real_open, real_close, error = os.open, os.close, PrivateFailure()
            calls, reused = [], []
            def close(number):
                calls.append(number)
                real_close(number)
                reused.append(real_open(root, os.O_RDONLY | os.O_DIRECTORY))
                self.assertEqual(reused[0], number)
                raise error
            try:
                with patch.object(subject.os, 'open', side_effect=lambda name, flags, **kwargs: real_open(path, flags)), patch.object(subject.os, 'close', side_effect=close):
                    with self.assertRaisesRegex(RuntimeError, '^diagnostic reader cleanup uncertain$') as caught:
                        subject._read_own_stat()
                self.assertIs(caught.exception.__context__, error)
                self.assertTrue(caught.exception.__suppress_context__)
                self.assertEqual(calls, reused)
                self.assertEqual(len(calls), 1)
                os.fstat(reused[0])
            finally:
                for number in reused:
                    real_close(number)

    def test_own_stat_uses_actual_bounded_reader_and_closes_once(self):
        for overflow in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'stat'
                raw = RAW_STAT + ' ' * (subject.READ_BOUND - len(RAW_STAT))
                path.write_bytes((raw + (' ' if overflow else '')).encode('ascii'))
                real_open, real_close, opened, closed = os.open, os.close, [], []
                def open_stat(name, flags, *, dir_fd=None):
                    self.assertEqual(name, '/proc/self/stat')
                    self.assertIsNone(dir_fd)
                    number = real_open(path, flags)
                    opened.append(number)
                    return number
                def close(number):
                    closed.append(number)
                    real_close(number)
                with patch.object(subject.os, 'open', side_effect=open_stat), patch.object(subject.os, 'close', side_effect=close):
                    if overflow:
                        with self.assertRaisesRegex(RuntimeError, 'fixed read bound'):
                            subject._read_own_stat()
                    else:
                        self.assertEqual(subject._read_own_stat(), subject.proc_fields(RAW_STAT))
                self.assertEqual(closed, opened)
                self.assertEqual(len(closed), 1)

    def test_own_stat_read_error_beats_later_native_close_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'stat'; path.write_text(RAW_STAT)
            real_open, real_close, original, cleanup = os.open, os.close, PrivateFailure(), PrivateFailure()
            closed = []
            def close(number):
                closed.append(number)
                real_close(number)
                raise cleanup
            with patch.object(subject.os, 'open', side_effect=lambda name, flags, **kwargs: real_open(path, flags)), patch.object(subject.os, 'read', side_effect=original), patch.object(subject.os, 'close', side_effect=close):
                with self.assertRaises(PrivateFailure) as caught:
                    subject._read_own_stat()
            self.assertIs(caught.exception, original)
            self.assertEqual(len(closed), 1)


if __name__ == '__main__':
    unittest.main()
