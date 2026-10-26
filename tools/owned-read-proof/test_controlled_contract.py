"""Grammar-only mutation tests. No canonical service run or positive acceptance."""
import copy
import json
import stat
import unittest

from controlled_contract import frame_trace, validate_plan, wire


def plan(lane='connected'):
    names = ['bootstrap'] if lane == 'bootstrap' else ['save', 'human-read', 'rule-read']
    return {'version': 1, 'lane': lane, 'leaderPid': 10, 'commandFd': 8, 'ackFd': 9,
            'maximumTraceBytes': 65536,
            'phases': [{'name': name, 'token': f'{i + 1:064x}'} for i, name in enumerate(names)],
            'privateRoots': {'/base/store': [1, 2, stat.S_IFDIR | 0o700, 1000, 1000]},
            'privateFiles': {'/base/store/credential': {
                'root': '/base/store', 'identity': [1, 3, stat.S_IFREG | 0o600, 1000, 1000]}},
            'privateIO': [
                {'phase': names[0], 'op': 'openat', 'path': '/base/store/credential',
                 'flags': ['O_RDONLY', 'O_CLOEXEC']},
                {'phase': names[0], 'op': 'pread64', 'path': '/base/store/credential',
                 'offset': 0, 'maximumBytes': 32},
                {'phase': names[0], 'op': 'close', 'path': '/base/store/credential'}]}


def trace_and_log(value):
    lines, log = [], []
    for phase in value['phases']:
        for ack in (False, True):
            data = wire(phase, ack)
            op = 'write' if ack else 'read'
            channel = value['ackFd' if ack else 'commandFd']
            lines.append(f"10 {op}({channel}, {json.dumps(data.decode())}, {len(data)}) = {len(data)}")
            log.append({'event': 'received' if ack else 'sent', **phase})
    return '\n'.join(lines) + '\n', log


class ControlledGrammarTests(unittest.TestCase):
    def test_framing_fixture_is_explicitly_non_authoritative(self):
        for lane in ('bootstrap', 'connected'):
            p = plan(lane)
            text, log = trace_and_log(p)
            result = frame_trace(text, p, log, set())
            self.assertEqual(result['record'], 'phase-framing-only')
            self.assertEqual(result['authority'], 'none')
            self.assertEqual([v['name'] for v in result['phases']], [v['name'] for v in p['phases']])
            self.assertTrue(all(not v['events'] for v in result['phases']))

    def test_every_required_field_missing_refuses(self):
        p = plan()
        for key in p:
            with self.subTest(key=key):
                changed = copy.deepcopy(p)
                del changed[key]
                with self.assertRaises(RuntimeError):
                    validate_plan(changed, set())
        for container, key in [('phases', 'token'), ('phases', 'name'), ('privateIO', 'op'),
                               ('privateIO', 'phase'), ('privateIO', 'path'), ('privateIO', 'flags')]:
            changed = plan()
            del changed[container][0][key]
            with self.subTest(container=container, key=key), self.assertRaises(RuntimeError):
                validate_plan(changed, set())

    def test_tokens_cannot_repeat_or_replay_previous_failed_runs(self):
        p = plan()
        with self.assertRaisesRegex(RuntimeError, 'replayed'):
            validate_plan(p, {p['phases'][0]['token']})
        p['phases'][1]['token'] = p['phases'][0]['token']
        with self.assertRaisesRegex(RuntimeError, 'replayed'):
            validate_plan(p, set())
        for token in ('', '1' * 63, 'g' * 64, 1, None):
            p = plan()
            p['phases'][0]['token'] = token
            with self.subTest(token=token), self.assertRaises(RuntimeError):
                validate_plan(p, set())
        with self.assertRaisesRegex(RuntimeError, 'replay history'):
            validate_plan(plan(), None)

    def test_wrong_phase_order_and_child_authority_fields_refuse(self):
        for mutate in (
            lambda p: p['phases'].reverse(),
            lambda p: p['phases'].pop(),
            lambda p: p.update(lane='production'),
            lambda p: p.update(qualified=True),
            lambda p: p.update(serviceReads=2),
            lambda p: p.update(version=True),
            lambda p: p.update(leaderPid=True),
            lambda p: p.update(maximumTraceBytes=268435457),
            lambda p: p.update(ackFd=p['commandFd']),
        ):
            p = plan()
            mutate(p)
            with self.assertRaises(RuntimeError):
                validate_plan(p, set())

    def test_missing_ack_replay_and_log_reordering_refuse(self):
        p = plan()
        text, log = trace_and_log(p)
        for changed in (log[:-1], log + log[:1], list(reversed(log)), []):
            with self.assertRaisesRegex(RuntimeError, 'supervisor acknowledgement'):
                frame_trace(text, p, changed, set())
        for changed in ('\n'.join(text.splitlines()[:-1]) + '\n',
                        text + text.splitlines()[0] + '\n', text.replace('orca-done:save', 'orca-done:rule-read')):
            with self.assertRaises(RuntimeError):
                frame_trace(changed, p, log, set())

    def test_partial_wrong_fd_wrong_thread_and_ack_failures_refuse(self):
        p = plan()
        text, log = trace_and_log(p)
        first = text.splitlines()[0]
        for changed in (text.replace(first, first.replace('10 read', '11 read'), 1),
                        text.replace(first, first.replace('read(8', 'read(7'), 1),
                        text.replace(first, first.replace('read(8', 'write(8'), 1),
                        text.replace(first, first.rsplit(' = ', 1)[0] + ' = 0', 1),
                        text.replace(first, first.rsplit(' = ', 1)[0] + ' = -1 EINTR (Interrupted)', 1),
                        text.replace('orca-phase:save', 'orca-phase:unknown', 1),
                        text.replace('orca-done:save', 'orca-phase:save', 1),
                        text.replace('10 write(9', '10 write(8', 1)):
            with self.assertRaises(RuntimeError):
                frame_trace(changed, p, log, set())

    def test_unfinished_effect_crossing_either_boundary_refuses(self):
        p = plan()
        text, log = trace_and_log(p)
        lines = text.splitlines()
        for boundary in (0, 1, 2, 5):
            changed = lines.copy()
            changed.insert(boundary, '11 openat(AT_FDCWD, "/base/store/credential", O_RDONLY <unfinished ...>')
            changed.insert(boundary + 2, '11 <... openat resumed>) = 20')
            with self.subTest(boundary=boundary), self.assertRaisesRegex(RuntimeError, 'crosses phase boundary'):
                frame_trace('\n'.join(changed) + '\n', p, log, set())
        # A partial command completion cannot overlap an unfinished worker read.
        changed = lines.copy()
        changed[0] = lines[0].split(') = ')[0] + ' <unfinished ...>'
        changed.insert(1, '11 read(20, "x", 1 <unfinished ...>')
        changed.insert(2, f'10 <... read resumed>) = {len(wire(p["phases"][0]))}')
        changed.insert(3, '11 <... read resumed>) = 1')
        with self.assertRaisesRegex(RuntimeError, 'crosses phase boundary'):
            frame_trace('\n'.join(changed) + '\n', p, log, set())

    def test_unfinished_missing_completion_and_unknown_effects_refuse(self):
        p = plan()
        text, log = trace_and_log(p)
        for call in ('11 openat(AT_FDCWD, "/base/store/credential", O_RDONLY <unfinished ...>',
                     '11 future_private_effect(20) = 0', '10 dup(8) = 30',
                     '10 fcntl(8, F_DUPFD, 30) = 30', '10 close(8) = 0',
                     '10 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, 8, 0) = 0x123'):
            with self.subTest(call=call), self.assertRaises(RuntimeError):
                frame_trace(text + call + '\n', p, log, set())

    def test_private_unknown_operations_and_wildcard_exemptions_refuse(self):
        for op in ('rename', 'unlink', 'socketpair', 'chmod', 'anything-under-.orca', 'openat2'):
            p = plan()
            p['privateIO'][0]['op'] = op
            with self.subTest(op=op), self.assertRaisesRegex(RuntimeError, 'unknown private operation'):
                validate_plan(p, set())
        p = plan()
        p['privateIO'][0]['allowEverythingUnder'] = '/base/store'
        with self.assertRaisesRegex(RuntimeError, 'operation fields'):
            validate_plan(p, set())

    def test_private_binding_flags_sequence_and_bounds_refuse(self):
        mutations = [
            lambda p: p['privateFiles']['/base/store/credential'].update(identity=None),
            lambda p: p['privateFiles']['/base/store/credential'].update(root='/other'),
            lambda p: p['privateRoots'].update({'/base/../store': p['privateRoots'].pop('/base/store')}),
            lambda p: p['privateIO'][0].update(path='/base/store/./credential'),
            lambda p: p['privateIO'][0].update(flags=['O_RDWR', 'O_TRUNC', 'O_CLOEXEC']),
            lambda p: p['privateIO'][0].update(flags=['O_RDONLY', 'O_CLOEXEC', 'O_CLOEXEC']),
            lambda p: p['privateIO'][0].update(flags=['O_WRONLY', 'O_NOFOLLOW', 'O_CLOEXEC']),
            lambda p: p['privateIO'][1].update(offset=-1),
            lambda p: p['privateIO'][1].update(offset=2**63 - 1),
            lambda p: p['privateIO'][1].update(maximumBytes=8193),
            lambda p: p['privateIO'][1].update(maximumBytes=True),
            lambda p: p['privateIO'][1].update(maximumBytes=0),
            lambda p: p['privateIO'][1].update(phase='rule-read'),
            lambda p: p['privateIO'][1].update(op='write', offset=0),
            lambda p: p['privateIO'].pop(),
            lambda p: p['privateIO'].reverse(),
        ]
        for i, mutate in enumerate(mutations):
            p = plan()
            mutate(p)
            with self.subTest(mutation=i), self.assertRaises(RuntimeError):
                validate_plan(p, set())
        p = plan()
        p['privateFiles']['/base/store/alias'] = copy.deepcopy(p['privateFiles']['/base/store/credential'])
        with self.assertRaisesRegex(RuntimeError, 'physical alias'):
            validate_plan(p, set())

    def test_trace_bound_and_root_aliases_refuse(self):
        p = plan()
        text, log = trace_and_log(p)
        p['maximumTraceBytes'] = len(text.encode()) - 1
        with self.assertRaisesRegex(RuntimeError, 'trace exceeds'):
            frame_trace(text, p, log, set())
        p = plan()
        p['privateRoots']['/base/alias'] = p['privateRoots']['/base/store']
        with self.assertRaisesRegex(RuntimeError, 'root physical alias'):
            validate_plan(p, set())

    def test_inside_events_and_setup_are_left_for_full_replay(self):
        p = plan()
        text, log = trace_and_log(p)
        text = '10 getpid() = 10\n' + text.replace('10 write(9', '10 fsync(20) = 0\n10 write(9', 1)
        result = frame_trace(text, p, log, set())
        self.assertEqual(result['phases'][0]['events'][0][1], 'fsync')
        self.assertEqual(result['outsideEvents'][0][1], 'getpid')
        self.assertNotIn('serviceReads', result)


if __name__ == '__main__':
    unittest.main()
