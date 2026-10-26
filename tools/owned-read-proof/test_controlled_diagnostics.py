"""Sparse observer controls, with real self pins; no producer execution."""
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from controlled_observation import diagnose_bootstrap

from controlled_diagnostics import (CONFIG, MAX_SAMPLES, PERIOD_NS, READ_BOUND,
    PinnedProcess, SparseDiagnostics, proc_fields, read_at)


class PinnedCounters(unittest.TestCase):
    def test_stale_starttime_refuses_and_closes_temporary_pins(self):
        expected = proc_fields(Path('/proc/self/stat').read_text())
        expected['starttime'] += 1
        before = set(os.listdir('/proc/self/fd'))
        with self.assertRaisesRegex(RuntimeError, 'initial process identity'):
            PinnedProcess(expected)
        self.assertEqual(set(os.listdir('/proc/self/fd')), before)

    def test_live_samples_use_only_relative_pinned_counter_paths(self):
        process = PinnedProcess(proc_fields(Path('/proc/self/stat').read_text()))
        original_open = os.open
        calls = []
        def opened(path, flags, **kwargs):
            self.assertIn(path, {'stat', 'schedstat', 'io'})
            self.assertEqual(kwargs['dir_fd'], process.procfd)
            calls.append(path)
            return original_open(path, flags, **kwargs)
        try:
            with patch('controlled_diagnostics.os.open', side_effect=opened):
                sample = process.sample()
            self.assertEqual(sample['pid'], os.getpid())
            self.assertEqual(sample['status'], 'live-pinned-original')
            self.assertEqual(calls, ['stat', 'schedstat', 'io', 'stat'])
            self.assertFalse(os.get_inheritable(process.procfd))
            self.assertFalse(os.get_inheritable(process.pidfd))
        finally:
            process.close()

    def test_exited_pidfd_never_reopens_numeric_pid_or_reads_replacement(self):
        process = PinnedProcess(proc_fields(Path('/proc/self/stat').read_text()))
        try:
            with patch('controlled_diagnostics.select.poll') as factory, \
                 patch('controlled_diagnostics.read_at', side_effect=AssertionError('read after pinned exit')):
                factory.return_value.poll.return_value = [(process.pidfd, 1)]
                self.assertEqual(process.sample(), {'status': 'exited-pinned-original'})
        finally:
            process.close()

    def test_truncated_counter_refuses_and_closes_reader(self):
        directory = os.open('/proc/self', os.O_PATH | os.O_DIRECTORY)
        try:
            before = set(os.listdir('/proc/self/fd'))
            with patch('controlled_diagnostics.os.read', return_value=b'x'*(READ_BOUND+1)):
                with self.assertRaisesRegex(RuntimeError, 'fixed read bound'):
                    read_at(directory, 'stat')
            self.assertEqual(set(os.listdir('/proc/self/fd')), before)
        finally:
            os.close(directory)


class SparseMeasurementControls(unittest.TestCase):
    def test_single_original_launcher_does_not_construct_connected_designation_on_success(self):
        with tempfile.TemporaryDirectory() as value:
            run = SimpleNamespace(assert_bootstrap_closed=lambda: None)
            with patch('controlled_observation.committed_observer', return_value={}), \
                 patch('controlled_observation.tempfile.mkdtemp', return_value=value), \
                 patch('controlled_observation.subprocess.run'), \
                 patch('controlled_observation.safe_summary', return_value={'authority': 'none'}), \
                 patch('controlled_observation.observe', return_value=run) as observe, \
                 patch('controlled_observation.ConnectedDesignation') as designation:
                result = diagnose_bootstrap()
            self.assertEqual(observe.call_count, 1)
            self.assertIs(observe.call_args.kwargs['diagnostic'], True)
            designation.assert_not_called()
            self.assertIsNone(result['acceptingToken'])
            self.assertFalse(result['productionEligible'])
            self.assertFalse(result['connectedCommandsReleased'])

    def test_progress_reads_size_and_count_without_trace_packet_or_token(self):
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            trace = directory/'trace'
            trace.write_text('never inspect raw private trace payload')
            sampler = SparseDiagnostics(trace, [{'event': 'sent', 'token': 'private-phase-token'}])
            try:
                with patch.object(Path, 'read_bytes', side_effect=AssertionError('packet read')), \
                     patch.object(Path, 'read_text', side_effect=AssertionError('packet read')):
                    sampler.capture()
                row = sampler.samples[0]
                self.assertEqual(row['traceBytes'], trace.stat().st_size)
                self.assertEqual(row['phaseEventCount'], 1)
                self.assertGreaterEqual(row['monotonicAfterNs'], row['monotonicBeforeNs'])
                self.assertNotIn('private-phase-token', json.dumps(row))
                self.assertNotIn('never inspect', json.dumps(row))
            finally:
                result = sampler.retain_and_close(directory/'diagnostics.json')
            self.assertEqual(result['authority'], 'none')
            self.assertEqual((directory/'diagnostics.json').stat().st_mode & 0o777, 0o600)

    def test_missing_counter_is_visible_without_changing_original_guards(self):
        with tempfile.TemporaryDirectory() as value:
            trace = Path(value)/'trace';trace.touch()
            sampler = SparseDiagnostics(trace, [])
            original = read_at
            def counter(directory, name):
                if name == 'cpu.stat':
                    raise FileNotFoundError('counter unavailable')
                return original(directory, name)
            try:
                with patch('controlled_diagnostics.read_at', side_effect=counter):
                    sampler.capture()
                self.assertIn('diagnosticError', sampler.samples[0]['resources']['cpu.stat'])
            finally:
                sampler.retain_and_close(Path(value)/'diagnostics.json')

    def test_sample_budget_and_duplicate_role_refuse(self):
        with tempfile.TemporaryDirectory() as value:
            trace = Path(value)/'trace';trace.touch()
            sampler = SparseDiagnostics(trace, [])
            try:
                with self.assertRaisesRegex(RuntimeError, 'already pinned'):
                    sampler.bind('supervisor', proc_fields(Path('/proc/self/stat').read_text()))
                with patch('controlled_diagnostics.MAX_SAMPLES', 1):
                    sampler.capture()
                    with self.assertRaisesRegex(RuntimeError, 'sample count'):
                        sampler.capture()
            finally:
                sampler.retain_and_close(Path(value)/'diagnostics.json')

    def test_one_second_sampler_stops_before_retention(self):
        self.assertEqual(PERIOD_NS, 1_000_000_000)
        self.assertEqual(MAX_SAMPLES, 62)
        self.assertFalse(CONFIG['rawTraceReading'])
        with tempfile.TemporaryDirectory() as value:
            trace = Path(value)/'trace';trace.touch()
            sampler = SparseDiagnostics(trace, [])
            sampler.start()
            result = sampler.retain_and_close(Path(value)/'diagnostics.json')
            self.assertTrue(result['samplerStopped'])
            self.assertEqual(len(result['samples']), 2)
            self.assertTrue(result['samples'][-1]['finalAfterOwnedSettlement'])
            self.assertEqual(result['errors'], [])


if __name__ == '__main__':
    unittest.main()
