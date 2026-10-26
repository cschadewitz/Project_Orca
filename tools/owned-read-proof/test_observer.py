"""Evidence mutation controls for the narrow verifier; never producer JSON flags."""
import unittest
from verify import verify_trace

CONTENT = b'disposable candidate bytes'
PLAN = {'node': '/node', 'argv': ['/node', '/child'], 'base': '/base',
        'lifetimeFd': 3, 'offset': 2, 'length': 4, 'inputHex': CONTENT.hex(), 'serviceReads': 0}


def stat_line(links, ino=42):
    return ('1 statx(19, "", AT_EMPTY_PATH, STATX_ALL, '
            '{stx_nlink=%d, stx_uid=%d, stx_mode=S_IFREG|0400, stx_ino=%d, '
            'stx_size=26, stx_dev_major=0, stx_dev_minor=33}) = 0\n' % (links, __import__('os').getuid(), ino))


TRACE = ('1 execve("/node", ["/node", "/child"], []) = 0\n'
         '1 fcntl(3, F_SETFD, FD_CLOEXEC) = 0\n'
         '1 openat(AT_FDCWD, "/base/input", O_RDONLY|O_CLOEXEC) = 18\n'
         '1 pread64(18, "spos", 4, 2) = 4\n'
         '1 close(18) = 0\n'
         '1 mkdir("/base/arbitrary-private-name", 0700) = 0\n'
         '1 openat(AT_FDCWD, "/base/arbitrary-private-name/data", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0400) = 19\n'
         '1 write(19, "disposable candidate bytes", 26) = 26\n'
         '1 close(19) = 0\n'
         '1 openat(AT_FDCWD, "/base/arbitrary-private-name/data", O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC) = 19\n'
         + stat_line(1) +
         '1 unlink("/base/arbitrary-private-name/data") = 0\n' + stat_line(0) +
         '1 close(19) = 0\n'
         '1 rmdir("/base/arbitrary-private-name") = 0\n'
         '1 exit_group(0) = ?\n'
         '1 +++ exited with 0 +++\n')


class ObserverTests(unittest.TestCase):
    def rejects(self, trace):
        with self.assertRaises(RuntimeError):
            verify_trace(trace, PLAN)

    def test_reconstructs_descriptor_reuse_without_resource_filename(self):
        result = verify_trace(TRACE, PLAN)
        self.assertEqual(result['serviceReads'], 0)
        self.assertEqual(result['calibrationBytesHex'], b'spos'.hex())
        self.assertEqual(result['authority'], 'none')

    def test_missing_events_refuse(self):
        for event in ('execve', 'pread64', 'mkdir', 'write', 'unlink', '+++ exited'):
            with self.subTest(event=event):
                self.rejects(''.join(line + '\n' for line in TRACE.splitlines() if event not in line))
        self.rejects('')
        self.rejects(TRACE.replace(stat_line(0), ''))
        self.rejects(TRACE.replace('1 close(19) = 0\n', ''))

    def test_positional_bytes_offset_length_and_descriptor(self):
        for value in ('1 pread64(18, "xxxx", 4, 2) = 4',
                      '1 pread64(18, "spos", 4, 3) = 4',
                      '1 pread64(18, "spos", 5, 2) = 4',
                      '1 pread64(18, "spo", 4, 2) = 3',
                      '1 pread64(99, "spos", 4, 2) = 4',
                      '1 pread64(18, "spos"..., 4, 2) = 4'):
            with self.subTest(value=value):
                self.rejects(TRACE.replace('1 pread64(18, "spos", 4, 2) = 4', value))

    def test_resource_descriptor_operations_refuse(self):
        for value in ('pread64(19, "spos", 4, 2) = 4', 'read(0x13, 0x123, 0x4) = 0x4',
                      'dup(19) = 20', 'fcntl(19, F_DUPFD, 0) = 20',
                      'lseek(19, 2, SEEK_SET) = 2', 'write(19, "x", 1) = 1',
                      'mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, 19, 0) = 0x123',
                      'close_range(3, 100, 0) = 0'):
            with self.subTest(value=value):
                self.rejects(TRACE.replace(stat_line(0), stat_line(0) + '1 ' + value + '\n'))

    def test_batched_transfer_untracked_alias_and_unknown_effects_refuse(self):
        # Reproduced false zero-read result before the default-refusal correction.
        transfer = ('1 socketpair(AF_UNIX, SOCK_DGRAM, 0, [30, 31]) = 0\n'
            '1 sendmmsg(30, [{msg_hdr={msg_control=[{cmsg_level=SOL_SOCKET, cmsg_type=SCM_RIGHTS, cmsg_data=[19]}]}}], 1, 0) = 1\n'
            '1 recvmmsg(31, [{msg_hdr={msg_control=[{cmsg_level=SOL_SOCKET, cmsg_type=SCM_RIGHTS, cmsg_data=[32]}]}}], 1, 0, NULL) = 1\n'
            '1 read(0x20, 0x123, 0x4) = 0x4\n')
        self.rejects(TRACE.replace(stat_line(0), stat_line(0) + transfer))
        for call in ('sendmmsg(30, [], 1, 0) = 1', 'recvmmsg(31, [], 1, 0, NULL) = 1',
                     'socketpair(AF_UNIX, SOCK_DGRAM, 0, [30, 31]) = 0',
                     'dup(19) = 32', 'dup3(19, 32, 0) = 32',
                     'fcntl(30, F_DUPFD_CLOEXEC, 32) = 32',
                     'sendfile(1, 19, NULL, 4) = 4', 'splice(19, NULL, 30, NULL, 4, 0) = 4',
                     'copy_file_range(19, NULL, 30, NULL, 4, 0) = 4',
                     'io_setup(1, [123]) = 0', 'io_submit(123, 1, []) = 1',
                     'read(0x20, 0x123, 0x4) = 0x4', 'ioctl(30, UNKNOWN_ALIAS_FACTORY, 32) = 0',
                     'future_descriptor_effect(19, 32) = 0'):
            with self.subTest(call=call):
                self.rejects(TRACE.replace(stat_line(0), stat_line(0) + '1 ' + call + '\n'))

    def test_unresolved_resource_opens_refuse_across_all_phases(self):
        paths = ('/base/arbitrary-private-name/./data', '/base/arbitrary-private-name//data',
                 '/base/arbitrary-private-name/../arbitrary-private-name/data',
                 'arbitrary-private-name/data', '/proc/self/root/base/arbitrary-private-name/data',
                 '/base/unrelated', '/base/arbitrary-private-name/other')
        for path in paths:
            alias = ('1 openat(AT_FDCWD, "' + path + '", O_RDONLY|O_CLOEXEC) = 32\n'
                     '1 read(0x20, 0x123, 0x4) = 0x4\n1 close(32) = 0\n')
            for marker in (stat_line(1), stat_line(0)):
                with self.subTest(path=path, marker=marker):
                    self.rejects(TRACE.replace(marker, marker + alias))

    def test_unfinished_open_crossing_creation_refuses(self):
        clone = '1 clone(child_stack=NULL, flags=CLONE_THREAD|CLONE_FILES|CLONE_VM|CLONE_SIGHAND) = 2\n'
        creator = '1 openat(AT_FDCWD, "/base/arbitrary-private-name/data", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0400) = 19\n'
        trace = TRACE.replace('1 fcntl', clone + '1 fcntl')
        trace = trace.replace(creator, '2 openat(AT_FDCWD, "/base/arbitrary-private-name/data", O_RDONLY|O_CLOEXEC <unfinished ...>\n' + creator)
        trace = trace.replace(stat_line(1), stat_line(1) + '2 <... openat resumed>) = 32\n2 read(0x20, 0x123, 0x4) = 0x4\n2 close(32) = 0\n')
        trace = trace.replace('1 exit_group', '2 +++ exited with 0 +++\n1 exit_group')
        with self.assertRaisesRegex(RuntimeError, 'ambiguous open interval'):
            verify_trace(trace, PLAN)
        # An open entered even before the resource namespace exists remains ambiguous.
        trace = trace.replace('2 openat(AT_FDCWD, "/base/arbitrary-private-name/data", O_RDONLY|O_CLOEXEC <unfinished ...>\n', '')
        trace = trace.replace('1 mkdir', '2 openat(AT_FDCWD, "/base/arbitrary-private-name/data", O_RDONLY|O_CLOEXEC <unfinished ...>\n1 mkdir')
        with self.assertRaisesRegex(RuntimeError, 'ambiguous open interval'):
            verify_trace(trace, PLAN)

    def test_same_thread_overlap_is_impossible_evidence(self):
        bad = TRACE.replace('1 fcntl', '1 openat(AT_FDCWD, "/base/unrelated", O_RDONLY <unfinished ...>\n1 fcntl')
        bad += '1 <... openat resumed>) = 32\n'
        with self.assertRaisesRegex(RuntimeError, 'overlapping calls in one thread'):
            verify_trace(bad, PLAN)

    def test_wrong_inode_or_open_flags_refuse(self):
        self.rejects(TRACE.replace(stat_line(0), stat_line(0, 43)))
        self.rejects(TRACE.replace('O_RDONLY|O_NOFOLLOW', 'O_RDWR|O_NOFOLLOW'))
        self.rejects(TRACE.replace('O_EXCL|', ''))
        self.rejects(TRACE.replace('0400)', '0600)'))
        self.rejects(TRACE.replace('26) = 26', '26) = 25'))

    def test_exec_process_lifetime_and_ambiguous_records_refuse(self):
        for value in ('2 getpid() = 2', '1 fork() = 2', '1 setsid() = 1',
                      '1 close(3) = 0', '1 execve("/node", ["/node", "/child"], []) = 0',
                      '1 clone(child_stack=NULL, flags=SIGCHLD) = 2',
                      '1 read(19, <unfinished ...>'):
            with self.subTest(value=value):
                self.rejects(TRACE.replace('1 exit_group', value + '\n1 exit_group'))

    def test_explicit_shared_thread_settlement(self):
        clone = '1 clone(child_stack=NULL, flags=CLONE_THREAD|CLONE_FILES|CLONE_VM|CLONE_SIGHAND) = 2\n'
        trace = TRACE.replace('1 fcntl', clone + '1 fcntl')
        trace = trace.replace('1 exit_group', '2 +++ exited with 0 +++\n1 exit_group')
        self.assertEqual(verify_trace(trace, PLAN)['settledThreads'], 2)
        self.rejects(trace.replace('2 +++ exited with 0 +++\n', ''))


if __name__ == '__main__':
    unittest.main()
