"""Real bounded FIFO open demonstrates entry/resume interval retention, not service dispatch."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from run import require_exitkill, run_traced
from verify import events

SCRIPT = r'''
import os, sys, threading, time
base=sys.argv[1]
fifo=base+'/fifo'
os.mkfifo(fifo)
ready=threading.Event()
def blocked():
    ready.set()
    fd=os.open(fifo,os.O_RDONLY)
    os.close(fd)
t=threading.Thread(target=blocked)
t.start();ready.wait();time.sleep(0.05)
fd=os.open(base+'/resource',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400)
os.write(fd,b'test');os.close(fd)
w=os.open(fifo,os.O_WRONLY);os.close(w)
t.join(timeout=2)
assert not t.is_alive()
'''


class IntervalTests(unittest.TestCase):
    def test_real_blocking_open_preserves_cross_creation_interval(self):
        tracer=shutil.which('strace')
        require_exitkill(tracer)
        with tempfile.TemporaryDirectory(prefix='orca-interval-control-') as directory:
            trace=Path(directory)/'trace'
            result=run_traced([tracer,'--kill-on-exit','-f','-q','-s','4096','-o',str(trace),
                sys.executable,'-c',SCRIPT,directory],stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            calls=list(events(trace.read_text(),with_intervals=True))
            blocked=[e for e in calls if e[1]=='openat' and e[2][1]=='"'+directory+'/fifo"' and 'O_RDONLY' in e[2][2]]
            created=[e for e in calls if e[1]=='openat' and e[2][1]=='"'+directory+'/resource"']
            self.assertEqual(len(blocked),1)
            self.assertEqual(len(created),1)
            self.assertLess(blocked[0][4],created[0][4])
            self.assertGreater(blocked[0][5],created[0][5])
