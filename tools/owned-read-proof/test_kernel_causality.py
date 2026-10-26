"""Kernel causality controls only; no synthetic service qualification."""
import stat
import unittest

from controlled_replay import Handle, Object
import test_controlled_replay as helpers


class PublicationCausalityControls(unittest.TestCase):
    def replay(self):
        r = helpers.DraftReplayControls().replay()
        r.threads |= {11, 12}
        r.base, r.initial = '/base', {}
        parent = '/base/workspace/.orca/private-execution'
        directories = {p: Object('original-directory', stat.S_IFDIR | 0o700, {p}, physical=(0, 33, inode))
                       for p, inode in [('/base', 1), (parent, 2)]}
        r.paths, r.objects = directories.copy(), list(directories.values())
        r.original = {'queries': {}, 'directories': dict.fromkeys(directories), 'absentProbes': []}
        r.used_paths, r.resources, r.inodes = set(directories), [], {}
        r.command, r.ack, r.lifetime, r.umask = 4, 7, 3, 0o077
        r.open_intervals, r.descriptor_intervals, r.pending_intervals = [], [], []
        r.total_written = 0
        r.entry_times = {}
        r.handles[21] = Handle(directories[parent], {'O_RDONLY', 'O_DIRECTORY', 'O_CLOEXEC'})
        r.handles[22] = Handle(directories['/base'], {'O_RDONLY', 'O_DIRECTORY', 'O_CLOEXEC'})
        return r

    def event(self, r, call, args, result='0', en=1, co=None, pid=10, intervals=True):
        record = (pid, call, args, result, en, en if co is None else co)
        r.entry_times[record[4]] = record[4]
        r.entry_times[record[5]] = record[5]
        if intervals: r.check_intervals(record)
        r.event(record)

    def writer(self, r, rename=False, sync=True, physical=True):
        final = ('/base/credentials.json' if rename else
                 '/base/workspace/.orca/private-execution/11111111-1111-4111-8111-111111111111.payload.json')
        temporary = (final + '.10.abcdef12.tmp' if rename else
                     final + '.22222222-2222-4222-8222-222222222222.tmp')
        flags = 'O_WRONLY|O_CREAT|' + ('' if rename else 'O_EXCL|') + 'O_TRUNC|O_CLOEXEC'
        self.event(r, 'openat', ['AT_FDCWD', '"'+temporary+'"', flags, '0600'], '20', en=1, co=2)
        self.event(r, 'write', ['20', '"payload"', '7'], '7', en=3)
        if physical:
            self.event(r, 'fstat', ['20', '{st_dev=makedev(0, 33), st_ino=100, st_mode=S_IFREG|0600, st_nlink=1, st_uid=%d, st_gid=%d, st_size=7}' %
                       (r.paths[temporary].uid, r.paths[temporary].gid)], en=4)
        if sync: self.event(r, 'fsync', ['20'], en=5, co=6)
        self.event(r, 'close', ['20'], en=7, co=8)
        return temporary, final, r.paths[temporary]

    def publish(self, r, temporary, final, rename=False, **kw):
        self.event(r, 'rename' if rename else 'link', ['"'+temporary+'"', '"'+final+'"'], en=10, co=12, **kw)

    def test_link_completion_directory_sync_then_cleanup_exposes_only_final_completion(self):
        r = self.replay(); temporary, final, obj = self.writer(r)
        self.publish(r, temporary, final)
        self.assertIsNone(obj.durable_publication_completion)
        self.event(r, 'fsync', ['21'], en=14, co=16)
        self.assertIsNone(obj.durable_publication_completion)
        self.event(r, 'unlink', ['"'+temporary+'"'], en=18, co=20)
        self.assertEqual((obj.publication_completion, obj.directory_sync_completion,
                          obj.temporary_cleanup_completion, obj.durable_publication_completion), (12, 16, 20, 20))
        self.assertEqual(obj.names, {final})
        self.assertFalse(obj.durable_publication_completion < 19)  # effect before cleanup completion
        self.event(r, 'fsync', ['21'], en=24, co=26)
        self.assertEqual(obj.directory_sync_completion, 16)
        self.assertEqual(obj.durable_publication_completion, 20)

    def test_rename_cleanup_is_atomic_and_durable_completion_is_later_directory_sync(self):
        r = self.replay(); temporary, final, obj = self.writer(r, rename=True)
        self.publish(r, temporary, final, rename=True)
        self.assertEqual(obj.temporary_cleanup_completion, 12)
        self.assertIsNone(obj.durable_publication_completion)
        self.event(r, 'fsync', ['22'], en=14, co=16)
        self.assertEqual(obj.durable_publication_completion, 16)

    def test_missing_data_sync_or_wrong_directory_never_exposes_durability(self):
        r = self.replay(); temporary, final, obj = self.writer(r, rename=True, sync=False)
        self.publish(r, temporary, final, rename=True)
        self.event(r, 'fsync', ['22'], en=14, co=16)
        self.assertIsNone(obj.data_sync_completion)
        self.assertIsNone(obj.durable_publication_completion)
        r = self.replay(); temporary, final, obj = self.writer(r)
        self.publish(r, temporary, final)
        self.event(r, 'fsync', ['22'], en=14, co=16)
        self.assertIsNone(obj.directory_sync_completion)
        self.assertIsNone(obj.durable_publication_completion)

    def test_complete_sequence_without_physical_file_binding_remains_unavailable(self):
        r = self.replay(); temporary, final, obj = self.writer(r, physical=False)
        self.publish(r, temporary, final)
        self.event(r, 'fsync', ['21'], en=14, co=16)
        self.event(r, 'unlink', ['"'+temporary+'"'], en=18, co=20)
        self.assertEqual(r.publication_sequence_completion(obj), 20)
        self.assertIsNone(obj.physical)
        self.assertIsNone(obj.durable_publication_completion)

    def test_missing_raw_prefix_index_cannot_supply_durable_position(self):
        r = self.replay(); temporary, final, obj = self.writer(r)
        self.publish(r, temporary, final)
        self.event(r, 'fsync', ['21'], en=14, co=16)
        self.event(r, 'unlink', ['"'+temporary+'"'], en=18, co=20)
        self.assertEqual(obj.durable_publication_completion, 20)
        del r.entry_times[20]
        r.durable_publication(obj)
        self.assertIsNone(obj.durable_publication_completion)

    def test_stale_data_sync_cannot_settle_a_later_write(self):
        r = self.replay()
        final = '/base/credentials.json'; temporary = final + '.10.abcdef12.tmp'
        self.event(r, 'openat', ['AT_FDCWD', '"'+temporary+'"', 'O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC', '0600'], '20', en=1)
        self.event(r, 'write', ['20', '"a"', '1'], '1', en=2)
        self.event(r, 'fsync', ['20'], en=3)
        self.event(r, 'write', ['20', '"b"', '1'], '1', en=4)
        self.event(r, 'fstat', ['20', '{st_dev=makedev(0, 33), st_ino=100, st_mode=S_IFREG|0600, st_nlink=1, st_uid=%d, st_gid=%d, st_size=2}' %
                   (r.paths[temporary].uid, r.paths[temporary].gid)], en=5)
        self.event(r, 'close', ['20'], en=6)
        obj = r.paths[temporary]
        self.publish(r, temporary, final, rename=True)
        self.event(r, 'fsync', ['22'], en=14, co=16)
        self.assertIsNone(obj.data_sync_completion)
        self.assertIsNone(obj.durable_publication_completion)

    def test_stale_directory_sync_cannot_settle_a_later_publication(self):
        r = self.replay(); temporary, final, obj = self.writer(r, rename=True)
        self.event(r, 'fsync', ['22'], en=9)
        self.publish(r, temporary, final, rename=True)
        self.assertIsNone(obj.directory_sync_completion)
        self.assertIsNone(obj.durable_publication_completion)
        self.event(r, 'fsync', ['22'], en=14, co=16)
        self.assertEqual(obj.durable_publication_completion, 16)

    def test_unfinished_link_then_parent_fsync_before_resume_refuses(self):
        r = self.replay(); temporary, final, obj = self.writer(r)
        self.event(r, 'link', ['"'+temporary+'"', '"'+final+'"'], en=10, co=30, pid=11)
        with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
            self.event(r, 'fsync', ['21'], en=14, co=16, pid=12)
        self.assertIsNone(obj.directory_sync_completion)
        self.assertIsNone(obj.durable_publication_completion)

    def test_unfinished_directory_sync_then_temporary_cleanup_refuses(self):
        r = self.replay(); temporary, final, obj = self.writer(r)
        self.publish(r, temporary, final)
        self.event(r, 'fsync', ['21'], en=14, co=30, pid=11)
        with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
            self.event(r, 'unlink', ['"'+temporary+'"'], en=18, co=20, pid=12)
        self.assertIsNone(obj.temporary_cleanup_completion)
        self.assertIsNone(obj.durable_publication_completion)

    def test_namespace_parent_dependencies_cover_link_rename_and_unlink_both_orders(self):
        for operation in ('link', 'rename', 'unlink'):
            for namespace_first in (True, False):
                r = self.replay(); temporary, final, _ = self.writer(r)
                args = ['"'+temporary+'"'] + ([] if operation == 'unlink' else ['"'+final+'"'])
                namespace = (11, operation, args, '0', 10, 30)
                sync = (12, 'fsync', ['21'], '0', 14, 16)
                if not namespace_first:
                    sync = (12, 'fsync', ['21'], '0', 10, 30)
                    namespace = (11, operation, args, '0', 14, 16)
                with self.subTest(operation=operation, namespace_first=namespace_first):
                    r.check_intervals(namespace if namespace_first else sync)
                    with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
                        r.check_intervals(sync if namespace_first else namespace)

    def test_entry_order_alone_cannot_qualify_sync_or_cleanup(self):
        r = self.replay(); temporary, final, obj = self.writer(r)
        self.event(r, 'link', ['"'+temporary+'"', '"'+final+'"'], en=10, co=30, intervals=False)
        self.event(r, 'fsync', ['21'], en=14, co=16, intervals=False)
        self.assertFalse(obj.directory_synced)
        self.assertIsNone(obj.directory_sync_completion)
        self.assertIsNone(obj.durable_publication_completion)
        r = self.replay(); temporary, final, obj = self.writer(r)
        self.publish(r, temporary, final)
        self.event(r, 'fsync', ['21'], en=14, co=30, intervals=False)
        self.event(r, 'unlink', ['"'+temporary+'"'], en=18, co=20, intervals=False)
        self.assertIsNone(obj.durable_publication_completion)


class EpollCausalityControls(unittest.TestCase):
    def replay(self):
        r = helpers.CheckpointReviewControls().epoll()
        r.threads |= {11, 12}
        r.pending_intervals, r.descriptor_intervals, r.waits = [], [], []
        r.paths, r.original = {}, {'queries': {}}
        r.command, r.ack, r.lifetime = 4, 7, 3
        return r

    def event(self, r, call, args, result='0', en=1, co=None, pid=10, intervals=True):
        record = (pid, call, args, result, en, en if co is None else co)
        if intervals: r.check_intervals(record)
        r.event(record)

    def wait_args(self, events='[{events=EPOLLIN, data=0xf}]'):
        return ['12', events, '1024', '0', 'NULL', '8']

    def test_unfinished_wait_then_watched_close_or_reuse_refuses(self):
        for reuse in (False, True):
            r = self.replay()
            self.event(r, 'epoll_pwait', self.wait_args(), '1', en=1, co=10, pid=11)
            if reuse:
                self.event(r, 'close', ['15'], en=2, pid=10, intervals=False)
                record = (10, 'eventfd2', ['0', 'EFD_CLOEXEC|EFD_NONBLOCK'], '15', 3, 3)
            else: record = (10, 'close', ['15'], '0', 3, 3)
            with self.subTest(reuse=reuse), self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
                r.check_intervals(record)

    def test_unfinished_watched_close_then_wait_refuses_even_after_invalidation(self):
        r = self.replay()
        self.event(r, 'close', ['15'], en=1, co=10, pid=11)
        with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
            self.event(r, 'epoll_pwait', self.wait_args('[]'), '0', en=3, pid=10)

    def test_last_close_erases_registration_data_and_reuse_does_not_restore_it(self):
        r = self.replay(); epoll = r.handles[12].obj
        self.event(r, 'close', ['15'], en=1)
        self.assertEqual((epoll.watches, epoll.registered_data, epoll.watch_handles), ({}, {}, {}))
        self.event(r, 'eventfd2', ['0', 'EFD_CLOEXEC|EFD_NONBLOCK'], '15', en=2)
        with self.assertRaisesRegex(RuntimeError, 'unverified registrations'):
            self.event(r, 'epoll_pwait', self.wait_args(), '1', en=3)
        self.event(r, 'epoll_ctl', ['12', 'EPOLL_CTL_ADD', '15', '{events=EPOLLIN, data=0x10}'], en=4)
        with self.assertRaisesRegex(RuntimeError, 'data not registered'):
            self.event(r, 'epoll_pwait', self.wait_args(), '1', en=5)
        self.event(r, 'epoll_pwait', self.wait_args('[{events=EPOLLIN, data=0x10}]'), '1', en=6)

    def test_changed_handle_same_fd_or_object_cannot_retain_old_binding(self):
        r = self.replay()
        r.handles[15] = Handle(r.handles[15].obj, set())
        with self.assertRaisesRegex(RuntimeError, 'closed/reused'):
            self.event(r, 'epoll_pwait', self.wait_args(), '1')

    def test_only_last_supported_handle_close_invalidates_watched_object(self):
        r = self.replay(); epoll = r.handles[12].obj
        # Internal table fixture only: no dup/transfer syscall becomes supported.
        r.handles[16] = Handle(r.handles[15].obj, set())
        self.event(r, 'close', ['16'], en=1)
        self.assertIn(15, epoll.watches)
        self.event(r, 'close', ['15'], en=2)
        self.assertEqual((epoll.watches, epoll.registered_data, epoll.watch_handles), ({}, {}, {}))

    def test_wait_notifications_and_independent_waits_are_not_close_dependencies(self):
        r = self.replay()
        self.event(r, 'epoll_pwait', self.wait_args(), '1', en=1, co=20, pid=11)
        self.event(r, 'write', ['15', '"12345678"', '8'], '8', en=3, pid=10)
        self.event(r, 'epoll_pwait', self.wait_args('[]'), '0', en=4, co=18, pid=12)

    def test_fd19_style_shared_eventfd_read_write_interval_remains_refused(self):
        r = self.replay()
        r.handles[19] = Handle(Object('eventfd', stat.S_IFIFO | 0o600), set())
        self.event(r, 'write', ['19', '"12345678"', '8'], '8', en=5432, co=5436, pid=11)
        with self.assertRaisesRegex(RuntimeError, 'ambiguous shared'):
            self.event(r, 'read', ['19', '"12345678"', '8'], '8', en=5434, pid=10)
