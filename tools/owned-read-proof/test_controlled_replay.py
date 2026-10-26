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
        epoll.registered_data = {}
        r.handles[12] = Handle(epoll, set())
        with self.assertRaisesRegex(RuntimeError, 'unverified registrations'):
            r.wait(event)
        epoll.watches[15] = Object('eventfd', 0)
        epoll.registered_data[15] = 15
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
        r.event((10, 'fstat', self.stat(), '0', 0, 0))
        r.event((10, 'read', ['20', '"maps"', '1024'], '4', 1, 1))
        r.event((10, 'close', ['20'], '0', 2, 2))
        self.open(r, 'O_RDONLY')
        self.assertIs(r.handles[20].obj, first)
        r.event((10, 'fstat', self.stat(), '0', 0, 0))
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
            r.event((10, 'fstat', self.stat(), '0', 0, 0))
            with self.subTest(encoded=encoded), self.assertRaises(RuntimeError):
                r.event((10, 'read', ['20', encoded, count], result, 1, 1))

class ExplicitEffectControls(unittest.TestCase):
    def replay(self):
        r = DraftReplayControls().replay()
        r.original = {'absentProbes': ['/etc/ld.so.preload'],
                      'readlinks': {'/proc/self/exe': '/node', '/etc': None},
                      'queries': {}, 'argv': ['/node', '/image/child.mjs']}
        return r

    def test_readlink_is_exact_original_target_and_never_descriptor_alias(self):
        r = self.replay()
        r.event((10, 'readlink', ['"/proc/self/exe"', '"/node"', '8191'], '5', 0, 0))
        for args, result in [(['"/proc/self/exe"', '"/other"', '8191'], '6'),
                             (['"/proc/self/fd/21"', '"/node"', '8191'], '5'),
                             (['"/etc"', '"/other"', '1023'], '6')]:
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                r.event((10, 'readlink', args, result, 0, 0))

    def test_process_limit_query_cannot_mutate_any_limit_or_target_other_pid(self):
        r = self.replay()
        output = '{rlim_cur=8192*1024, rlim_max=RLIM64_INFINITY}'
        r.event((10, 'prlimit64', ['0', 'RLIMIT_STACK', 'NULL', output], '0', 0, 0))
        for args in [['10', 'RLIMIT_STACK', 'NULL', output],
                     ['0', 'RLIMIT_STACK', output, 'NULL'], ['0', 'RLIMIT_FSIZE', 'NULL', output]]:
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                r.event((10, 'prlimit64', args, '0', 0, 0))

    def test_access_is_only_the_retained_absent_read_probe(self):
        r = self.replay()
        r.event((10, 'access', ['"/etc/ld.so.preload"', 'R_OK'], '-1 ENOENT (No such file or directory)', 0, 0))
        for args, result in [(['"/etc/ld.so.preload"', 'W_OK'], '0'),
                             (['"/base/private"', 'R_OK'], '0'), (['"/etc/ld.so.preload"', 'R_OK'], '0')]:
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                r.event((10, 'access', args, result, 0, 0))

    def directory(self):
        r = self.replay()
        r.paths = {'/base': Object('original-directory', 0o40700, {'/base'}, physical=(0, 33, 1)),
                   '/base/private': Object('state-directory', 0o40700, {'/base/private'}, physical=(0, 33, 2)),
                   '/base/private/file': Object('protected-temp', 0o100600, {'/base/private/file'}, physical=(0, 33, 3))}
        return r, Handle(r.paths['/base/private'], {'O_RDONLY'})

    def entry(self, inode, name, kind='DT_DIR'):
        return '{d_ino=%d, d_off=1, d_reclen=24, d_type=%s, d_name="%s"}' % (inode, kind, name)

    def test_directory_membership_inode_and_eof_are_checked(self):
        r, h = self.directory()
        entries = [self.entry(2, '.'), self.entry(1, '..'), self.entry(3, 'file', 'DT_REG')]
        r.directory_entries(h, '[' + ', '.join(entries) + ']', 72)
        r.directory_entries(h, '[]', 0)
        self.assertTrue(h.directory_eof)
        for bad in [self.entry(9, 'file', 'DT_REG'), self.entry(4, 'unknown', 'DT_REG'), self.entry(3, '../file', 'DT_REG')]:
            r, h = self.directory()
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                r.directory_entries(h, '[' + bad + ']', 24)
        r, h = self.directory()
        with self.assertRaisesRegex(RuntimeError, 'EOF omits'):
            r.directory_entries(h, '[]', 0)

class CheckpointReviewControls(unittest.TestCase):
    def test_first_and_reopened_query_reads_require_own_successful_stat(self):
        helper = QueryObjectControls()
        r = helper.replay()
        helper.open(r)
        read = (10, 'read', ['20', '"x"', '1'], '1', 1, 1)
        with self.assertRaisesRegex(RuntimeError, 'per-open physical bind'):
            r.event(read)
        r.event((10, 'fstat', helper.stat(), '0', 0, 0))
        r.event(read)
        r.event((10, 'close', ['20'], '0', 2, 2))
        helper.open(r, 'O_RDONLY')
        with self.assertRaisesRegex(RuntimeError, 'per-open physical bind'):
            r.event(read)
        with self.assertRaisesRegex(RuntimeError, 'changed inode'):
            r.event((10, 'fstat', helper.stat(43), '0', 3, 3))

    def epoll(self):
        r = DraftReplayControls().replay()
        epoll = Object('epoll', 0)
        epoll.watches = {15: Object('eventfd', 0)}
        epoll.registered_data = {15: 15}
        r.handles[12] = Handle(epoll, set())
        return r

    def test_completed_epoll_calls_receive_same_full_validation(self):
        for entered, completed in [(0, 0), (0, 2)]:
            r = self.epoll()
            r.waits = []
            valid = ['12', '[{events=EPOLLIN, data=0xf}]', '1024', '0', 'NULL', '8']
            r.event((10, 'epoll_pwait', valid, '1', entered, completed))
            for args, result in [(['99', '[]', '1024', '0', 'NULL', '8'], '0'),
                                 (['12', '[]', '1024', '0', 'NULL', '8'], '?'),
                                 (['12', '[]', '1024', '0', 'NULL', '8'], '1025'),
                                 (['12', '[]', '1024', '0', 'NULL', '8'], '1'),
                                 (['12', '[{events=EPOLLIN, data=0x20}]', '1024', '0', 'NULL', '8'], '1'),
                                 (['12', '[]', '1024', '0', '0x123', '8'], '0')]:
                with self.subTest(args=args, completed=completed), self.assertRaises(RuntimeError):
                    r.event((10, 'epoll_pwait', args, result, entered, completed))
            r.handles[12].obj.family = 'resource'
            with self.assertRaisesRegex(RuntimeError, 'unretained epoll'):
                r.event((10, 'epoll_pwait', valid, '1', entered, completed))

class MembershipAndFlockControls(unittest.TestCase):
    def test_epoll_membership_changes_must_match_existing_set(self):
        helper = CheckpointReviewControls()
        for op, target in [('EPOLL_CTL_ADD', 15), ('EPOLL_CTL_MOD', 16)]:
            r = helper.epoll()
            r.handles[15] = Handle(r.handles[12].obj.watches[15], set())
            r.handles[16] = Handle(Object('eventfd', 0), set())
            with self.subTest(op=op), self.assertRaisesRegex(RuntimeError, 'ADD existing/MOD absent'):
                r.event((10, 'epoll_ctl', ['12', op, str(target), '{events=EPOLLIN, data=0xf}'], '0', 0, 0))

    def test_fdinfo_binds_original_supervisor_lock_inode_and_flags(self):
        r = DraftReplayControls().replay()
        r.lifetime = 3
        r.original = {'supervisorPid': 99}
        r.handles[3] = Handle(Object('lifetime', 0o100600, physical=(0, 33, 88)), {'O_RDWR'})
        valid = b'pos:\t0\nflags:\t02000002\nmnt_id:\t1\nino:\t88\nlock:\t1: FLOCK ADVISORY WRITE 99 00:21:88 0 EOF\n'
        r.check_fdinfo(valid)
        for changed in [valid.replace(b'WRITE 99', b'WRITE 100'), valid.replace(b'ino:\t88', b'ino:\t89'),
                        valid.replace(b'02000002', b'00000002'), valid.replace(b'02000002', b'02000001'),
                        valid.replace(b'FLOCK', b'UNKNOWN')]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                r.check_fdinfo(changed)

class OptimizedSupervisorControls(unittest.TestCase):
    def test_optimized_python_still_refuses_wrong_image_designation(self):
        import json
        from pathlib import Path
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory(prefix='orca-optimized-check-') as directory:
            image = Path(directory)
            (image / 'controlled-build.json').write_text(json.dumps({'entry': 'wrong-child', 'profileRef': 'wrong-profile'}))
            code = ('import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); '
                    'from controlled_supervisor import assert_image_sources; assert_image_sources(Path(sys.argv[2]))')
            result = subprocess.run([sys.executable, '-O', '-B', '-c', code,
                str(Path(__file__).resolve().parent), str(image)], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('RuntimeError: supervisor retained-original check failed', result.stderr)

class SharedIntervalControls(unittest.TestCase):
    def replay(self):
        r = DraftReplayControls().replay()
        r.original = {'queries': {}}
        r.pending_intervals = []
        obj = Object('protected-temp', 0o100600, {'/base/file'})
        r.handles[20] = Handle(obj, {'O_RDONLY'})
        r.paths = {'/base/file': obj}
        return r

    def test_fd_number_reuse_overlapping_close_refuses_even_after_table_removal(self):
        r = self.replay()
        r.check_intervals((11, 'close', ['20'], '0', 1, 9))
        del r.handles[20]
        with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
            r.check_intervals((10, 'openat', ['AT_FDCWD', '"/base/other"', 'O_RDONLY|O_CLOEXEC'], '20', 2, 2))

    def test_metadata_and_publication_intervals_cannot_cross_same_path(self):
        for mutator, args in [('unlink', ['"/base/file"']), ('rename', ['"/base/file"', '"/base/final"']),
                              ('link', ['"/base/file"', '"/base/final"'])]:
            r = self.replay()
            r.check_intervals((11, mutator, args, '0', 1, 9))
            with self.subTest(mutator=mutator), self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
                r.check_intervals((10, 'statx', ['AT_FDCWD', '"/base/file"', 'AT_SYMLINK_NOFOLLOW'], '0', 2, 2))

    def test_independent_readonly_descriptors_can_overlap_without_alias_inference(self):
        r = self.replay()
        r.handles[21] = Handle(r.handles[20].obj, {'O_RDONLY'})
        r.check_intervals((11, 'read', ['20', '"x"', '1'], '1', 1, 9))
        r.check_intervals((10, 'read', ['21', '"x"', '1'], '1', 2, 2))
        with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
            r.check_intervals((10, 'close', ['20'], '0', 3, 3))

class ImmutablePublicationControls(unittest.TestCase):
    def test_final_immutable_name_cannot_be_unlinked_or_republished_as_temporary(self):
        r = DraftReplayControls().replay()
        r.base = '/base'
        r.original, r.initial = {'queries': {}, 'directories': {}}, {}
        prefix = '/base/workspace/.orca/private-execution/'
        final = prefix + '00000000-0000-4000-8000-000000000001.payload.json'
        other = prefix + '00000000-0000-4000-8000-000000000002.payload.json'
        obj = Object('protected-temp', 0o100600, {final})
        obj.writer_closed = obj.synced = obj.published = obj.directory_synced = True
        r.paths = {final: obj}
        with self.assertRaisesRegex(RuntimeError, 'unplanned unlink'):
            r.event((10, 'unlink', ['"' + final + '"'], '0', 0, 0))
        with self.assertRaisesRegex(RuntimeError, 'original unpublished temporary'):
            r.event((10, 'link', ['"' + final + '"', '"' + other + '"'], '0', 0, 0))
