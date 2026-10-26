"""Actual same-process batched SCM_RIGHTS alias/read, replayed into candidate evidence."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from run import require_exitkill, run_traced
from verify import events, verify_trace
from test_observer import TRACE, PLAN, stat_line

SCRIPT = r'''
import ctypes as c, os, socket, struct, sys
class Iov(c.Structure):
    _fields_ = [('base', c.c_void_p), ('length', c.c_size_t)]
class Msg(c.Structure):
    _fields_ = [('name', c.c_void_p), ('namelen', c.c_uint), ('iov', c.POINTER(Iov)),
                ('iovlen', c.c_size_t), ('control', c.c_void_p), ('controllen', c.c_size_t), ('flags', c.c_int)]
class Batch(c.Structure):
    _fields_ = [('msg', Msg), ('length', c.c_uint)]
a,b = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
source = os.open(sys.argv[1], os.O_RDONLY)
data = c.create_string_buffer(b'x')
iov = Iov(c.cast(data,c.c_void_p),1)
control = c.create_string_buffer(socket.CMSG_SPACE(4))
header = struct.pack('@Qii',socket.CMSG_LEN(4),socket.SOL_SOCKET,socket.SCM_RIGHTS)
c.memmove(control,header+struct.pack('@i',source),len(header)+4)
sent = Batch(Msg(None,0,c.pointer(iov),1,c.cast(control,c.c_void_p),len(control),0),0)
libc = c.CDLL(None,use_errno=True)
assert libc.sendmmsg(a.fileno(),c.byref(sent),1,0)==1
received_control=c.create_string_buffer(socket.CMSG_SPACE(4))
received=Batch(Msg(None,0,c.pointer(iov),1,c.cast(received_control,c.c_void_p),len(received_control),0),0)
assert libc.recvmmsg(b.fileno(),c.byref(received),1,0,None)==1
alias=struct.unpack_from('@i',received_control.raw,socket.CMSG_LEN(0))[0]
assert os.read(alias,4)==b'test'
print('actual-batched-alias-read')
os.close(alias);os.close(source);a.close();b.close()
'''


class BatchTransferTests(unittest.TestCase):
    def test_actual_batched_transfer_is_unsupported_evidence(self):
        tracer = shutil.which('strace')
        require_exitkill(tracer)
        with tempfile.TemporaryDirectory(prefix='orca-batch-control-') as directory:
            base = Path(directory)
            source = base / 'input'
            source.write_bytes(b'test')
            trace = base / 'trace'
            result = run_traced([tracer, '--kill-on-exit', '-f', '-q', '-v', '-s', '4096',
                '-o', str(trace), sys.executable, '-c', SCRIPT, str(source)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'actual-batched-alias-read')
            observed = [(call, args, value) for _,call,args,value in events(trace.read_text())
                        if call in ('sendmmsg','recvmmsg')]
            self.assertEqual([call for call,_,_ in observed], ['sendmmsg','recvmmsg'])
            for call,args,value in observed:
                self.assertEqual(value, '1')
                # Actual kernel arguments/results, not producer verdict flags.
                mutation = '1 ' + call + '(' + ', '.join(args) + ') = ' + value + '\n'
                with self.subTest(call=call), self.assertRaisesRegex(RuntimeError, 'unsupported syscall: ' + call):
                    verify_trace(TRACE.replace(stat_line(0),stat_line(0)+mutation),PLAN)
