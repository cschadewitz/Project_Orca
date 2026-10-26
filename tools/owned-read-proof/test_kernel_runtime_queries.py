"""Finite provenance/negative controls. Synthetic traces confer no qualification."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from controlled_replay import Object
from kernel_runtime_queries import (KIND, QUERIES, KernelRuntimeQueries, check_mount,
                                    check_process, open_exact, retained_contract)
import test_controlled_replay as helpers

MOUNTS = ('1 0 0:1 / / rw - overlay overlay rw\n'
          '2 1 0:30 / /proc ro - proc proc rw\n'
          '3 1 0:31 /.. /sys/fs/cgroup ro - cgroup2 cgroup2 rw\n')


def observation():
    leader = {'pid': 10, 'tgid': 10, 'starttime': 1234, 'ppid': 9, 'tracer': 9,
              'pgrp': 9, 'session': 9, 'uids': [os.getuid()] * 4}
    value = {'kind': KIND, 'leader': leader, 'tracer': {'pid': 9, 'ppid': 8},
             'supervisor': 8, 'mountinfo': MOUNTS, 'namespaces': {'mnt': 'mnt:[1]'},
             'verifiedBeforeRelease': True, 'traceAnchorLine': 100, 'queries': {}}
    for index, (path, (_, target, kind, magic)) in enumerate(QUERIES.items()):
        proc = kind == 'proc'
        dev = os.makedev(0, 30 if proc else 31)
        mount = {'id': 2 if proc else 3, 'device': '0:30' if proc else '0:31',
                 'target': target, 'type': kind, 'root': '/' if proc else '/..'}
        value['queries'][path] = {'resolved': '/proc/10/cgroup' if path == '/proc/self/cgroup'
                else path.replace('//', '/'), 'identity': [dev, 100 + index, 0o100444, 1000, 1000],
                'size': 0, 'links': 1, 'fsType': magic, 'mount': mount, 'heldFd': 40 + index}
    return value


class KernelProvenanceControls(unittest.TestCase):
    def test_retained_contract_preserves_opaque_cgroup_mount_root(self):
        value = observation()
        result = retained_contract(value, 10)
        self.assertEqual(result['/sys/fs/cgroup//memory.max']['mount']['root'], '/..')
        self.assertEqual(result['/proc/self/cgroup']['resolved'], '/proc/10/cgroup')

    def test_wrong_filesystem_covering_bind_and_stacked_mount_refuse(self):
        for raw in [MOUNTS.replace('- proc proc', '- tmpfs tmpfs'),
                    MOUNTS + '4 2 0:30 /other /proc/10/cgroup ro - proc proc rw\n',
                    MOUNTS + '4 2 0:30 /other /proc/10 ro - proc proc rw\n',
                    MOUNTS + '4 1 0:30 / /proc ro - proc proc rw\n',
                    MOUNTS.replace('0:30 / /proc', '0:30 /subtree /proc')]:
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                check_mount(raw, '/proc/10/cgroup', 2, '0:30', '/proc/self/cgroup')
        value = observation()
        value['queries']['/proc/meminfo']['fsType'] = 0x1234
        with self.assertRaisesRegex(RuntimeError, 'filesystem'):
            retained_contract(value, 10)

    def test_redirected_target_cannot_be_designated_by_retained_path(self):
        for path in ['/proc/self/cgroup', '/proc/11/cgroup', '/proc/10/../10/cgroup']:
            value = observation()
            value['queries']['/proc/self/cgroup']['resolved'] = path
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'redirected'):
                retained_contract(value, 10)

    def test_real_symlink_redirection_and_wrong_held_filesystem_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'redirect').symlink_to('/proc/meminfo')
            with self.assertRaises(OSError):
                open_exact(str(root / 'redirect'))
            (root / 'file').write_text('synthetic')
            observer = KernelRuntimeQueries()
            try:
                with self.assertRaisesRegex(RuntimeError, 'wrong held query filesystem'):
                    observer.retain('/proc/meminfo', str(root / 'file'))
            finally:
                observer.close()

    def test_wrong_pid_tgid_reuse_parent_group_and_uid_refuse(self):
        value = observation()
        for key, changed in [('pid', 11), ('tgid', 11), ('starttime', 1235),
                             ('ppid', 7), ('tracer', 7), ('pgrp', 10), ('session', 10),
                             ('uids', [os.getuid() + 1] * 4)]:
            actual = {**value['leader'], key: changed}
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                check_process(actual, value['leader'], value['tracer'], value['supervisor'])
        with self.assertRaisesRegex(RuntimeError, 'provenance'):
            retained_contract(value, 11)

    def test_missing_before_release_observation_refuses(self):
        value = observation()
        value['verifiedBeforeRelease'] = False
        with self.assertRaisesRegex(RuntimeError, 'pre-release'):
            retained_contract(value, 10)

    def test_changed_namespace_and_mountinfo_refuse_without_mutating_host(self):
        observer = KernelRuntimeQueries()
        try:
            with patch('kernel_runtime_queries.namespaces', return_value={'mnt': 'mnt:[wrong]'}):
                with self.assertRaisesRegex(RuntimeError, 'namespace/mountinfo'):
                    observer.validate_mounts()
            original = observer.value['mountinfo']
            observer.value['mountinfo'] = original + '\n'
            with self.assertRaisesRegex(RuntimeError, 'namespace/mountinfo'):
                observer.validate_mounts()
            observer.value['mountinfo'] = original
            observer.validate_mounts()
        finally:
            observer.close()


class NativeReplayControls(unittest.TestCase):
    def replay(self):
        r = helpers.QueryObjectControls().replay()
        r.base = '/base'
        value = observation()
        r.native_queries = retained_contract(value, 10)
        r.native_completed = []
        r.javascript_opened = False
        r.initial = {}
        r.objects = []
        for path in QUERIES:
            r.original['queries'][path] = QUERIES[path][0]
        return r

    def event(self, r, call, args, result='0', pid=10, entered=1, completed=1):
        r.event((pid, call, args, result, entered, completed))

    def open(self, r, path='/proc/self/cgroup', flags='O_RDONLY|O_CLOEXEC', **kwargs):
        self.event(r, 'openat', ['AT_FDCWD', json.dumps(path), flags], '20', **kwargs)

    def read(self, r, path='/proc/self/cgroup', data=b'0::/\n', **kwargs):
        encoded = json.dumps(data.decode()).replace('\\u0000', '\\x00')
        self.event(r, 'read', ['20', encoded, str(QUERIES[path][0])], str(len(data)), **kwargs)

    def test_process_observation_must_fall_in_original_traced_leader_lifetime(self):
        for trace in ['11 execve("/node", [], []) = 0\n11 +++ exited with 0 +++\n',
                      '10 execve("/node", [], []) = 0\n10 +++ exited with 0 +++\n']:
            r = self.replay()
            r.original['kernelRuntimeQueries'] = observation()
            with self.subTest(trace=trace), self.assertRaisesRegex(RuntimeError, 'traced leader lifetime'):
                r.run(trace)

    def test_only_four_exact_single_read_lifecycles_complete_before_javascript(self):
        r = self.replay()
        for path in QUERIES:
            self.open(r, path)
            self.assertEqual(r.handles[20].obj.family, 'trusted-kernel-runtime-query')
            self.read(r, path)
            self.event(r, 'close', ['20'])
        self.assertEqual(r.native_completed, list(QUERIES))
        with self.assertRaisesRegex(RuntimeError, 'startup sequence'):
            self.open(r)

    def test_missing_provenance_fails_at_exact_query(self):
        r = self.replay()
        r.native_queries = {}
        with self.assertRaisesRegex(RuntimeError, 'missing trusted-kernel-runtime-query provenance: /proc/self/cgroup'):
            self.open(r)

    def test_widened_flags_spelling_wrong_thread_or_late_open_refuse(self):
        for flags in ['O_RDONLY', 'O_RDONLY|O_NOFOLLOW|O_CLOEXEC', 'O_RDWR|O_CLOEXEC',
                      'O_RDONLY|O_NONBLOCK|O_CLOEXEC']:
            with self.subTest(flags=flags), self.assertRaises(RuntimeError):
                self.open(self.replay(), flags=flags)
        for path in ['/proc/10/cgroup', '/proc//self/cgroup', '/sys/fs/cgroup/memory.max']:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                self.open(self.replay(), path=path)
        r = self.replay()
        r.threads.add(11)
        with self.assertRaisesRegex(RuntimeError, 'startup sequence'):
            self.open(r, pid=11)
        r = self.replay()
        r.javascript_opened = True
        with self.assertRaisesRegex(RuntimeError, 'startup sequence'):
            self.open(r)

    def test_short_read_bound_fully_decoded_no_extra_eof_or_premature_close(self):
        for data in [b'x' * 1023, b'x' * 1024, b'', b'x\0']:
            r = self.replay()
            self.open(r)
            with self.subTest(size=len(data)), self.assertRaises(RuntimeError):
                self.read(r, data=data)
        for args, result in [(['20', '"x"...', '1023'], '1'),
                             (['20', '"x"', '1024'], '1'), (['20', '"x"', '1023'], '2')]:
            r = self.replay()
            self.open(r)
            with self.subTest(args=args), self.assertRaises((RuntimeError, ValueError)):
                self.event(r, 'read', args, result)
        r = self.replay()
        self.open(r)
        with self.assertRaisesRegex(RuntimeError, 'without exact single read'):
            self.event(r, 'close', ['20'])
        self.read(r)
        with self.assertRaisesRegex(RuntimeError, 'single sequential read'):
            self.read(r, data=b'')

    def test_write_vector_positional_mapping_and_descriptor_control_refuse(self):
        for call, args in [('write', ['20', '"x"', '1']), ('readv', ['20', '[]', '0']),
                           ('writev', ['20', '[]', '0']), ('pread64', ['20', '"x"', '1', '0']),
                           ('lseek', ['20', '0', 'SEEK_SET']), ('fcntl', ['20', 'F_GETFL']),
                           ('mmap', ['NULL', '4096', 'PROT_READ', 'MAP_PRIVATE', '20', '0'])]:
            r = self.replay()
            self.open(r)
            with self.subTest(call=call), self.assertRaises(RuntimeError):
                self.event(r, call, args, '1')

    def test_known_shared_files_thread_cannot_read_any_native_query(self):
        for index, path in enumerate(QUERIES):
            r = self.replay()
            r.native_completed = list(QUERIES)[:index]
            r.threads.add(11)  # Known CLONE_THREAD|CLONE_FILES member, same handle table.
            self.open(r, path)
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'native query thread'):
                self.read(r, path, pid=11)
            self.assertFalse(r.handles[20].native_read)
            self.read(r, path)

    def test_known_shared_files_thread_cannot_close_any_native_query(self):
        for index, path in enumerate(QUERIES):
            r = self.replay()
            preceding = list(QUERIES)[:index]
            r.native_completed = preceding.copy()
            r.threads.add(11)
            self.open(r, path)
            self.read(r, path)
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'native query thread'):
                self.event(r, 'close', ['20'], pid=11)
            self.assertIn(20, r.handles)
            self.assertEqual(r.native_completed, preceding)
            self.event(r, 'close', ['20'])
            self.assertEqual(r.native_completed, preceding + [path])

    def test_present_stat_still_compares_actual_held_inode_and_metadata(self):
        r = self.replay()
        self.open(r)
        args = ['20', '{st_dev=makedev(0, 30), st_ino=100, st_mode=S_IFREG|0444, st_nlink=1, st_uid=1000, st_gid=1000, st_size=0}']
        self.event(r, 'fstat', args)
        for old, new in [('st_ino=100', 'st_ino=101'), ('st_uid=1000', 'st_uid=1001'),
                         ('st_size=0', 'st_size=1'), ('st_nlink=1', 'st_nlink=2')]:
            with self.subTest(old=old), self.assertRaises(RuntimeError):
                self.event(r, 'fstat', [args[0], args[1].replace(old, new)])

    def test_alias_namespace_exec_and_chroot_attempts_refuse(self):
        r = self.replay()
        r.inodes[(0, 30, 100)] = Object('resource', 0o100444)
        with self.assertRaisesRegex(RuntimeError, 'physical alias'):
            self.open(r)
        for call, args in [('unshare', ['CLONE_NEWNS']), ('setns', ['20', 'CLONE_NEWNS']),
                           ('chroot', ['"/tmp"']), ('mount', ['"x"', '"/proc"', 'NULL', 'MS_BIND', 'NULL']),
                           ('execve', ['"/other"', '[]', '[]']),
                           ('clone', ['CLONE_THREAD|CLONE_FILES|CLONE_VM|CLONE_SIGHAND|CLONE_NEWNS'])]:
            r = self.replay()
            r.original['node'], r.original['argv'] = '/node', ['/node']
            with self.subTest(call=call), self.assertRaises(RuntimeError):
                self.event(r, call, args, '11')
