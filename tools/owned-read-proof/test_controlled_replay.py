"""Grammar/unit controls for DRAFT replay; no positive bootstrap acceptance."""
from collections import Counter
import unittest

from controlled_replay import Handle, Object, Replay, physical_fields


class DraftReplayControls(unittest.TestCase):
    def replay(self):
        r = object.__new__(Replay)
        r.handles = {}
        r.leader = 10
        r.threads, r.settled = {10}, set()
        r.execs, r.counts = 1, Counter()
        return r

    def test_only_exact_nonmutating_private_wait_forms_are_boundary_candidates(self):
        r = self.replay()
        forms = [(['0x123', 'FUTEX_WAIT_PRIVATE', '0', 'NULL'], True),
                 (['0x123', 'FUTEX_WAIT_BITSET_PRIVATE|FUTEX_CLOCK_REALTIME', '200', 'NULL', 'FUTEX_BITSET_MATCH_ANY'], True),
                 (['0x123', 'FUTEX_LOCK_PI_PRIVATE', '0', 'NULL'], False),
                 (['0x123', 'FUTEX_WAKE_OP_PRIVATE', '1', 'NULL'], False),
                 (['0x123', 'UNKNOWN', '0', 'NULL'], False),
                 (['0x123', 'FUTEX_WAIT_PRIVATE|UNKNOWN', '0', 'NULL'], False),
                 (['0x123', 'FUTEX_WAIT_PRIVATE', '0', '0x456'], False)]
        for args, expected in forms:
            with self.subTest(args=args):
                self.assertEqual(r.wait((10, 'futex', args, '0', 0, 2)), expected)

    def test_mutating_unknown_futex_opcodes_refuse_even_inside_phase(self):
        for op in ('FUTEX_LOCK_PI_PRIVATE', 'FUTEX_WAKE_OP_PRIVATE', 'UNKNOWN'):
            with self.subTest(op=op), self.assertRaisesRegex(RuntimeError, 'mutating futex'):
                self.replay().event((10, 'futex', ['0x123', op, '0', 'NULL'], '0', 0, 2))

    def test_zero_signal_liveness_is_only_for_original_retained_pid(self):
        self.replay().event((10, 'kill', ['10', '0'], '0', 0, 0))
        for args, result in [(['11', '0'], '0'), (['10', 'SIGTERM'], '0'),
                             (['-10', '0'], '0'), (['10', '0'], '-1 ESRCH (No such process)')]:
            with self.subTest(args=args), self.assertRaisesRegex(RuntimeError, 'liveness probe'):
                self.replay().event((10, 'kill', args, result, 0, 0))

    def test_epoll_wait_requires_original_epoll_and_nonfile_registrations(self):
        r = self.replay()
        event = (10, 'epoll_pwait', ['12', '[]', '1024', '-1', 'NULL', '8'], '0', 0, 2)
        with self.assertRaisesRegex(RuntimeError, 'unretained epoll'):
            r.wait(event)
        epoll = Object('epoll', 0)
        epoll.watches = {}
        r.handles[12] = Handle(epoll, set())
        with self.assertRaisesRegex(RuntimeError, 'unverified registrations'):
            r.wait(event)
        epoll.watches[15] = Object('eventfd', 0)
        self.assertTrue(r.wait(event))
        epoll.watches[21] = Object('resource', 0)
        with self.assertRaisesRegex(RuntimeError, 'unverified registrations'):
            r.wait(event)

    def test_character_stat_size_omission_does_not_allow_regular_file_omission(self):
        data = '{st_dev=makedev(0, 0x1f), st_ino=9, st_mode=S_IFCHR|0666, st_nlink=1, st_uid=1000, st_gid=1000}'
        self.assertEqual(physical_fields('fstat', ['0', data])[-2], 0)
        with self.assertRaisesRegex(RuntimeError, 'incomplete stat'):
            physical_fields('fstat', ['0', data.replace('S_IFCHR', 'S_IFREG')])


if __name__ == '__main__':
    unittest.main()

class QueryObjectControls(unittest.TestCase):
    """Exact observed procfs query grammar; no bootstrap acceptance fixture."""
    def replay(self):
        r = DraftReplayControls().replay()
        r.original = {'queries': {'/proc/self/maps': 65536},
                      'queryMetadata': {'/proc/self/maps': [0o100444, 1000, 1000]},
                      'absentProbes': []}
        r.paths, r.inodes, r.query_objects = {}, {}, {}
        r.resources, r.open_intervals, r.descriptor_intervals = [], [], []
        r.command, r.ack, r.lifetime = 4, 7, 3
        return r

    def stat(self, inode=42):
        return ['20', '{st_dev=makedev(0, 0x1e), st_ino=%d, st_mode=S_IFREG|0444, st_nlink=1, st_uid=1000, st_gid=1000, st_size=0}' % inode]

    def open(self, r, flags='O_RDONLY|O_CLOEXEC'):
        r.event((10, 'openat', ['AT_FDCWD', '"/proc/self/maps"', flags], '20', 0, 0))

    def test_repeated_exact_readonly_query_reuses_object_and_original_inode(self):
        r = self.replay()
        self.open(r)
        first = r.handles[20].obj
        r.bind(first, 'fstat', self.stat())
        r.event((10, 'read', ['20', '"maps"', '1024'], '4', 1, 1))
        r.event((10, 'close', ['20'], '0', 2, 2))
        self.open(r, 'O_RDONLY')
        self.assertIs(r.handles[20].obj, first)
        r.bind(first, 'fstat', self.stat())
        with self.assertRaisesRegex(RuntimeError, 'changed inode'):
            r.bind(first, 'fstat', self.stat(43))

    def test_query_write_mapping_and_unrelated_physical_alias_refuse(self):
        r = self.replay()
        self.open(r)
        for call, args in [('write', ['20', '"x"', '1']),
                           ('pread64', ['20', '"x"', '1', '0']),
                           ('mmap', ['NULL', '4096', 'PROT_READ|PROT_WRITE', 'MAP_PRIVATE', '20', '0'])]:
            with self.subTest(call=call), self.assertRaises(RuntimeError):
                r.event((10, call, args, '1', 1, 1))
        r.inodes[(0, 30, 42)] = Object('resource', 0o100444)
        with self.assertRaisesRegex(RuntimeError, 'unexpected physical alias'):
            r.bind(r.handles[20].obj, 'fstat', self.stat())

    def test_query_truncation_and_byte_count_forgery_refuse(self):
        for encoded, result, count in [('"x"...', '1', '1'), ('"x"', '2', '2'), ('"x"', '1', '65537')]:
            r = self.replay()
            self.open(r)
            with self.subTest(encoded=encoded), self.assertRaises(RuntimeError):
                r.event((10, 'read', ['20', encoded, count], result, 1, 1))
