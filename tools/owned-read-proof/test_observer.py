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
