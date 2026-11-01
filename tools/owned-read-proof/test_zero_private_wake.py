"""Per-record zero-wake controls; no original observation or acceptance run.

The 52 positive-return tuples are exact sanitized records from the refused trace.
Their arguments/results are transplanted to synthetic boundary intervals only to
prove that address/thread-level reuse cannot admit a different record.
"""
from copy import deepcopy
from collections import Counter
import json
from pathlib import Path
import stat
import unittest
from unittest.mock import patch

from controlled_contract import BOUNDARY_PASSIVE, wire
from controlled_replay import Replay, zero_private_wake_record

FIXTURE = json.loads(Path(__file__).with_name('fixtures').joinpath('zero-private-wake-records.json').read_bytes())
ZERO = tuple(FIXTURE['crossingZeroWake'])
POSITIVES = [tuple(record) for record in FIXTURE['sameAddressPositiveWakes']]
LEADER, WORKER = 15517, 15521


def original():
    lifetime = [1, 3, stat.S_IFREG | 0o600, 1000, 1000]
    return {'base': '/synthetic', 'leaderPid': LEADER, 'inheritedUmask': 0o077,
            'directories': {}, 'immutable': {'/synthetic/lifetime.lock': {
                'identity': lifetime, 'hex': '', 'family': 'lifetime'}},
            'descriptors': {str(fd): {'identity': identity, 'family': family, 'flags': flags}
                for fd, identity, family, flags in [
                    (3, lifetime, 'lifetime', ['O_RDWR']),
                    (4, [1, 4, stat.S_IFIFO | 0o600, 1000, 1000], 'command', ['O_RDONLY']),
                    (7, [1, 7, stat.S_IFIFO | 0o600, 1000, 1000], 'ack', ['O_WRONLY'])]},
            'commandFd': 4, 'ackFd': 7, 'lifetimeFd': 3, 'lane': 'bootstrap',
            'phases': [{'name': 'bootstrap', 'token': '1' * 64}], 'usedTokens': [],
            'node': '/node', 'argv': ['/node', '/image/controlled-child.mjs']}


def clone(child=WORKER, entered=1):
    return (LEADER, 'clone3', ['{flags=CLONE_THREAD|CLONE_FILES|CLONE_VM|CLONE_SIGHAND}', '88'],
            str(child), entered, entered)


def boundary(call, entered, completed):
    return LEADER, call, ['4' if call == 'read' else '7', 'synthetic-boundary'], '0', entered, completed


class ZeroPrivateWakeControls(unittest.TestCase):
    def replay(self):
        r = Replay(original())
        r.execs = 1
        children = ({WORKER} | {record[0] for record in POSITIVES}) - {LEADER}
        for index, child in enumerate(sorted(children), 1):
            r.event(clone(child, index))
        r.marks = [boundary('read', 100, 104), boundary('write', 200, 204)]
        return r

    def moved(self, record=ZERO, entered=99, completed=101):
        return (*deepcopy(record[:4]), entered, completed)

    def test_exact_observed_record_is_retained_and_not_classified_as_wait(self):
        self.assertEqual(ZERO, (WORKER, 'futex', ['0x43fa36b0', 'FUTEX_WAKE_PRIVATE', '1'], '0', 3400, 3402))
        r = self.replay()
        r.marks = [boundary('read', 3401, 3404)]
        r.event(ZERO)
        self.assertIsNone(r.check_phase_boundaries([ZERO]))
        self.assertEqual(r.zero_private_wakes, {zero_private_wake_record(ZERO)})
        self.assertEqual(r.counts['futex'], 1)
        self.assertEqual(r.waits, [])
        self.assertFalse(r.wait(ZERO))
        self.assertNotIn('futex', BOUNDARY_PASSIVE)

    def test_both_ends_of_command_and_ack_and_enclosing_interval(self):
        for entered, completed in [(99, 101), (103, 105), (199, 201), (203, 205), (99, 205)]:
            with self.subTest(interval=(entered, completed)):
                r = self.replay()
                record = self.moved(entered=entered, completed=completed)
                r.event(record)
                self.assertIsNone(r.check_phase_boundaries([record]))
                positive = (*record[:3], '1', entered, completed)
                r.event(positive)
                with self.assertRaisesRegex(RuntimeError, 'phase boundary'):
                    r.check_phase_boundaries([record, positive])

    def test_only_exact_arguments_and_successful_zero_are_candidates(self):
        variants = [([], '0'), (['0x1000'], '0'),
                    (['0x1000', 'FUTEX_WAKE_PRIVATE'], '0')]
        for address in ['NULL', '0', '0x0', '0x1', '0x1001', '0x1002', '0x1003', '0x1000...', '-4']:
            variants.append(([address, 'FUTEX_WAKE_PRIVATE', '1'], '0'))
        for opcode in ['FUTEX_WAKE', 'FUTEX_WAKE_PRIVATE|UNKNOWN', 'FUTEX_WAKE_OP_PRIVATE',
                       'FUTEX_LOCK_PI_PRIVATE', 'FUTEX_WAIT_PRIVATE', 'UNKNOWN']:
            variants.append((['0x1000', opcode, '1'], '0'))
        for count in ['0', '2', '2147483647', '-1', '01']:
            variants.append((['0x1000', 'FUTEX_WAKE_PRIVATE', count], '0'))
        for result in ['1', '2', '-1 EFAULT (Bad address)', '-1 EAGAIN (Resource temporarily unavailable)', '00', '?']:
            variants.append((['0x1000', 'FUTEX_WAKE_PRIVATE', '1'], result))
        variants.append((['0x1000', 'FUTEX_WAKE_PRIVATE', '1', 'NULL'], '0'))
        for args, result in variants:
            for interval in [(99, 101), (199, 201)]:
                with self.subTest(args=args, result=result, interval=interval):
                    r = self.replay()
                    record = (WORKER, 'futex', args, result, *interval)
                    self.assertIsNone(zero_private_wake_record(record))
                    # Some malformed/unsupported records refuse before the boundary check.
                    try:
                        r.event(record)
                    except (RuntimeError, IndexError):
                        pass
                    self.assertEqual(r.zero_private_wakes, set())
                    with self.assertRaisesRegex(RuntimeError, 'phase boundary'):
                        r.check_phase_boundaries([record])

    def test_unknown_and_already_settled_threads_cannot_retain_a_record(self):
        for pid, settled in [(99999, False), (WORKER, True)]:
            r = self.replay()
            if settled:
                r.event((WORKER, 'settled', [], '0', 2, 2))
            record = (pid, *self.moved()[1:])
            with self.subTest(pid=pid), self.assertRaisesRegex(RuntimeError, 'unknown/settled process'):
                r.event(record)
            self.assertEqual(r.zero_private_wakes, set())
            with self.assertRaisesRegex(RuntimeError, 'phase boundary'):
                r.check_phase_boundaries([record])

    def test_retention_is_original_per_record_not_current_thread_state(self):
        r = self.replay()
        record = self.moved()
        r.event(record)
        r.event((WORKER, 'settled', [], '0', 250, 250))
        self.assertIsNone(r.check_phase_boundaries([record]))
        self.assertEqual(r.counts['futex'], 1)
        # Same address/op/result on another interval has not been processed.
        unseen = self.moved(entered=199, completed=201)
        with self.assertRaisesRegex(RuntimeError, 'phase boundary'):
            r.check_phase_boundaries([unseen])
        with self.assertRaisesRegex(RuntimeError, 'unknown/settled process'):
            r.event(unseen)

    def test_mutating_processed_arguments_cannot_reuse_an_immutable_identity(self):
        r = self.replay()
        record = self.moved()
        r.event(record)
        retained = deepcopy(r.zero_private_wakes)
        record[2].append('NULL')
        self.assertEqual(r.zero_private_wakes, retained)
        with self.assertRaisesRegex(RuntimeError, 'phase boundary'):
            r.check_phase_boundaries([record])

    def test_all_52_same_address_positive_records_refuse_at_both_boundaries(self):
        self.assertEqual(FIXTURE['sourceTraceSha256'],
                         '4ef32094110e8299c2b983f9f649109e8123f207ac6b56bc2601d350b9c430a9')
        self.assertEqual(len(POSITIVES), 52)
        self.assertEqual(len({r[4] for r in POSITIVES}), 52)
        for positive in POSITIVES:
            self.assertEqual(positive[2], ZERO[2])
            self.assertEqual(positive[3], '1')
            for interval in [(99, 101), (199, 201)]:
                with self.subTest(originalEntry=positive[4], interval=interval):
                    r = self.replay()
                    prior_zero = self.moved(entered=90, completed=91)
                    r.event(prior_zero)
                    record = self.moved(positive, *interval)
                    r.event(record)
                    self.assertEqual(r.counts['futex'], 2)
                    with self.assertRaisesRegex(RuntimeError, 'phase boundary'):
                        r.check_phase_boundaries([prior_zero, record])

    def test_other_boundary_effects_are_not_exempted(self):
        r = self.replay()
        zero = self.moved()
        r.event(zero)
        other = (LEADER, 'getuid', [], '1000', 199, 201)
        r.event(other)
        with self.assertRaisesRegex(RuntimeError, 'phase boundary'):
            r.check_phase_boundaries([zero, other])

    def test_run_retains_events_and_continues_to_original_resource_check(self):
        o = original()
        phase = o['phases'][0]
        command, ack = wire(phase), wire(phase, ack=True)
        records = [
            (LEADER, 'execve', [json.dumps(o['node']), json.dumps(o['argv'])], '0', 0, 0),
            clone(), (WORKER, 'futex', deepcopy(ZERO[2]), '0', 2, 4),
            (LEADER, 'read', ['4', json.dumps(command.decode()), str(len(command))], str(len(command)), 3, 5),
            (LEADER, 'write', ['7', json.dumps(ack.decode()), str(len(ack))], str(len(ack)), 6, 7),
            (WORKER, 'settled', [], '0', 8, 8), (LEADER, 'settled', [], '0', 9, 9)]
        r = Replay(o)
        with patch('controlled_replay.timestamped_events', return_value=(records, dict.fromkeys(range(10), 1))):
            with self.assertRaisesRegex(RuntimeError, 'missing/ambiguous service resource'):
                r.run('synthetic decoded records only')
        self.assertEqual(r.counts, Counter(record[1] for record in records))
        self.assertEqual(r.threads, r.settled)
        self.assertEqual(len(r.marks), 2)
        self.assertEqual(r.zero_private_wakes, {zero_private_wake_record(records[2])})


if __name__ == '__main__':
    unittest.main()
