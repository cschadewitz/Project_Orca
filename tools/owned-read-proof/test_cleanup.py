"""Real hung Node tree and tracer failure; only specifically launched children."""
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from run import require_exitkill, run_traced, proof_directory, OwnedCleanupError

NODE_TREE = r'''
const fs = require('node:fs'), {spawn} = require('node:child_process');
const [marker, mode, lock] = process.argv.slice(1);
const child = spawn(process.execPath, ['-e', `
  require('node:fs').appendFileSync(process.argv[1], process.pid+'\\n');
  if (require('node:fs').fstatSync(3).ino <= 0) process.exit(9);
  process.send('ready'); setInterval(()=>{},1000);
`, marker], {stdio:['ignore','ignore','ignore',Number(lock),'ipc']});
child.on('message', () => {
  fs.appendFileSync(marker, process.pid+'\n');
  if(mode==='tracer-error') process.kill(process.ppid,'SIGKILL');
});
setInterval(()=>{},1000);
'''


class CleanupTests(unittest.TestCase):
    def test_no_exitkill_fails_closed(self):
        with patch('run.subprocess.run') as command:
            command.return_value.stdout = 'older help'
            with self.assertRaises(RuntimeError):
                require_exitkill('strace')

    def test_unsettled_preserves_directory(self):
        target = None
        try:
            with self.assertRaises(OwnedCleanupError):
                with proof_directory() as directory:
                    target = Path(directory)
                    raise OwnedCleanupError('injected cleanup failure')
            self.assertTrue(target.is_dir())
        finally:
            if target:
                shutil.rmtree(target)

    def exercise(self, mode):
        tracer = shutil.which('strace')
        self.assertIsNotNone(tracer)
        require_exitkill(tracer)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            marker = base / 'pids'
            lock = base / 'lock'
            fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                args = [tracer, '--kill-on-exit', '-f', '-qq', '-o', str(base/'trace'),
                        shutil.which('node'), '-e', NODE_TREE, str(marker), mode, str(fd)]
                options = dict(pass_fds=(fd,), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, timeout=2)
                if mode == 'timeout':
                    with self.assertRaises(subprocess.TimeoutExpired):
                        run_traced(args, **options)
                else:
                    result = run_traced(args, **options)
                    self.assertLess(result.returncode, 0)
            finally:
                os.close(fd)
            # Both tracee and its actual descendant reached the ready handshake.
            pids = [int(value) for value in marker.read_text().splitlines()]
            self.assertEqual(len(pids), 2)
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            competitor = os.open(lock, os.O_RDWR)
            try:
                fcntl.flock(competitor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(competitor)
            self.assertTrue(base.is_dir())  # All settlement checks precede disposal.

    def test_hung_tracee_timeout_settles_tree(self):
        self.exercise('timeout')

    def test_tracer_error_settles_tree(self):
        self.exercise('tracer-error')


if __name__ == '__main__':
    unittest.main()
