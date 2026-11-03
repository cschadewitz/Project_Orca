"""Real isolated AF_UNIX child fixtures; never Proxmox, QEMU or an observer."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import pickle
import select
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import host_control_peer as subject


GREETING = b'{"QMP":{"version":{"qemu":{"major":9,"minor":2,"micro":0},"package":"local-fixture"},"capabilities":["oob"]}}\r\n'
CHILD = '''import socket,sys,json
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.bind(sys.argv[1]);s.listen(1)
print('READY',flush=True)
c,_=s.accept()
for line in sys.stdin:
 v=json.loads(line)
 if v['op']=='stop':break
 if v['op']=='send':c.sendall(bytes.fromhex(v['hex']))
 elif v['op']=='eof':c.close()
 print('ACK',flush=True)
c.close();s.close()
'''


class PrivateFailure(BaseException):
    def __str__(self): raise AssertionError('private formatting')
    def __repr__(self): raise AssertionError('private representation')
    def __bool__(self): raise AssertionError('private truthiness')


class NativePeerTests(unittest.TestCase):
    def line(self, process, expected):
        self.assertTrue(select.select([process.stdout], [], [], 3)[0], 'local fixture response bound')
        self.assertEqual(process.stdout.readline(), expected)

    def tell(self, process, op, payload=b''):
        process.stdin.write(json.dumps({'op': op, 'hex': payload.hex()})+'\n');process.stdin.flush()
        self.line(process, 'ACK\n')

    @contextmanager
    def peer(self, directory=None):
        with tempfile.TemporaryDirectory(prefix='orca-native-control-test-') as temporary:
            path=Path(directory or temporary)/'local-control.sock'
            process=subprocess.Popen([sys.executable,'-I','-S','-B','-c',CHILD,str(path)],
                                     stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            client=None
            try:
                self.line(process,'READY\n')
                client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);client.connect(str(path))
                yield process,client
            finally:
                if client is not None:client.close()
                if process.poll() is None:
                    try:process.communicate(json.dumps({'op':'stop'})+'\n',timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill();process.communicate(timeout=3)
                else:process.communicate(timeout=3)

    @contextmanager
    def owner(self, client):
        value=subject.OriginalControlPeer()
        try:
            value.adopt(client.fileno())
            yield value
        finally:value.close()

    def test_real_cached_peer_pidfd_bound_without_pid_reopening_and_original_greeting(self):
        with self.peer() as (process,client):
            flags=fcntl.fcntl(client,fcntl.F_GETFL);timeout=client.gettimeout()
            with patch.object(subject.os,'pidfd_open',side_effect=AssertionError('numeric PID reopen forbidden')):
                with self.owner(client) as owner:
                    self.assertEqual(struct.unpack('iII',owner._credentials),(process.pid,os.geteuid(),os.getegid()))
                    self.assertFalse(os.get_inheritable(owner._pidfd));self.assertFalse(os.get_inheritable(owner._socket.fileno()))
                    owner.check_current();self.tell(process,'send',GREETING);owner.consume_greeting()
                    self.assertEqual(owner.state(),'greeting-observed');owner.check_current()
                    with self.assertRaises(subject.PeerUnavailable):owner.require_vm_authority()
                    with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()
                self.assertEqual(fcntl.fcntl(client,fcntl.F_GETFL),flags)
                self.assertEqual(client.gettimeout(),timeout)
                self.assertFalse(select.select([client],[],[],0)[0])

    def test_nonblocking_borrowed_flags_unchanged_and_no_protocol_writes(self):
        for seconds in (0.0,0.25):
            with self.peer() as (process,client):
                client.settimeout(seconds);flags=fcntl.fcntl(client,fcntl.F_GETFL)
                with patch.object(subject.socket.socket,'send',side_effect=AssertionError('send forbidden')),\
                     patch.object(subject.socket.socket,'sendall',side_effect=AssertionError('sendall forbidden')),\
                     patch.object(subject.socket.socket,'connect',side_effect=AssertionError('connect forbidden')):
                    with self.owner(client) as owner:
                        self.tell(process,'send',GREETING);owner.consume_greeting()
                        self.assertEqual(fcntl.fcntl(client,fcntl.F_GETFL),flags)
                self.assertEqual(client.gettimeout(),seconds)

    def test_peer_death_queued_complete_greeting_refuses_and_restart_never_revives(self):
        with tempfile.TemporaryDirectory(prefix='orca-same-path-restart-test-') as directory:
            value=None
            with self.peer(directory) as (process,client),self.owner(client) as owner:
                value=owner
                self.tell(process,'send',GREETING);process.terminate();process.wait(timeout=3)
                with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()
                self.assertEqual(owner.state(),'uncertain')
            # Only the isolated fixture owner removes its dead test socket path.
            # Production component has no path lookup, removal or reconnection.
            (Path(directory)/'local-control.sock').unlink()
            with self.peer(directory) as (_,replacement):
                with self.assertRaises(subject.PeerUnavailable):value.adopt(replacement.fileno())
                with self.assertRaises(subject.PeerUnavailable):value.check_current()

    def test_peer_death_after_greeting_refuses_fresh_check(self):
        with self.peer() as (process,client),self.owner(client) as owner:
            self.tell(process,'send',GREETING);owner.consume_greeting()
            process.terminate();process.wait(timeout=3)
            with self.assertRaises(subject.PeerUnavailable):owner.check_current()
            self.assertEqual(owner.state(),'uncertain')

    def test_lost_partial_greeting_and_eof_are_absorbing_without_retry(self):
        with self.peer() as (process,client),self.owner(client) as owner:
            self.tell(process,'send',b'{"QMP":');self.tell(process,'eof')
            with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()
            with patch.object(subject.socket.socket,'recv',side_effect=AssertionError('retry read')):
                with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()
            self.assertEqual(owner.state(),'uncertain')

    def test_slow_partial_greeting_cannot_renew_one_deadline(self):
        with self.peer() as (process,client),patch.object(subject,'SESSION_SECONDS',0.04),self.owner(client) as owner:
            deadline=owner._deadline;self.tell(process,'send',b'{')
            start=time.monotonic()
            with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()
            self.assertEqual(owner._deadline,deadline);self.assertLess(time.monotonic()-start,1)

    def test_overflow_before_json_construction(self):
        with self.peer() as (process,client),self.owner(client) as owner:
            self.tell(process,'send',b' '*(subject.GREETING_LIMIT+1))
            with patch.object(subject.json,'loads',side_effect=AssertionError('parse before bound')):
                with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()
            self.assertEqual(owner.state(),'uncertain')

    def test_cached_credential_change_refuses_before_read(self):
        with self.peer() as (_,client),self.owner(client) as owner:
            original=socket.socket.getsockopt
            def altered(stream,level,option,*args):
                if option==socket.SO_PEERCRED:return struct.pack('iII',1,os.geteuid()+1,os.getegid())
                return original(stream,level,option,*args)
            with patch.object(subject.socket.socket,'getsockopt',altered),\
                 patch.object(subject.socket.socket,'recv',side_effect=AssertionError('identity changed')):
                with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()
            self.assertEqual(owner.state(),'uncertain')

    def test_unsupported_peerpidfd_never_falls_back_and_leaves_borrowed_open(self):
        with self.peer() as (_,client):
            original=socket.socket.getsockopt;owner=subject.OriginalControlPeer();failure=OSError(92,'PRIVATE')
            def unsupported(stream,level,option,*args):
                if option==subject.SO_PEERPIDFD:raise failure
                return original(stream,level,option,*args)
            with patch.object(subject.socket.socket,'getsockopt',unsupported),\
                 patch.object(subject.os,'pidfd_open',side_effect=AssertionError('fallback')):
                with self.assertRaises(subject.PeerUnavailable) as caught:owner.adopt(client.fileno())
            self.assertIs(owner._first_failure,failure);self.assertIsNone(caught.exception.__context__)
            self.assertIsNone(owner._socket);self.assertIsNone(owner._pidfd)
            self.assertGreaterEqual(client.fileno(),0);owner.close()

    def test_wrong_native_domain_type_listener_or_unconnected_rejected(self):
        sockets=[socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM),socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)]
        with tempfile.TemporaryDirectory(prefix='orca-listener-negative-') as d:
            listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(d+'/socket');listener.listen(1);sockets.append(listener)
            try:
                for stream in sockets:
                    value=subject.OriginalControlPeer()
                    with self.assertRaises(subject.PeerUnavailable):value.adopt(stream.fileno())
                    self.assertEqual(value.state(),'uncertain');value.close();self.assertGreaterEqual(stream.fileno(),0)
            finally:
                for stream in sockets:stream.close()

    def test_failed_close_is_consumed_once_and_retains_original_private_error(self):
        with self.peer() as (_,client):
            owner=subject.OriginalControlPeer();owner.adopt(client.fileno());number=owner._pidfd
            native=os.close;calls=[];failure=PrivateFailure();replacement=[]
            def uncertain(fd):
                if fd==number:
                    calls.append(fd);native(fd)
                    replacement.append(os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC))
                    self.assertEqual(replacement[0],number)
                    raise failure
                return native(fd)
            with patch.object(subject.os,'close',uncertain):owner.close();owner.close()
            self.assertEqual(calls,[number]);self.assertIs(owner._first_failure,failure)
            self.assertIsNone(owner._pidfd);self.assertIsNone(owner._socket);self.assertEqual(owner.state(),'uncertain')
            self.assertIsInstance(os.fstat(replacement[0]).st_ino,int);native(replacement[0])
            with self.assertRaises(subject.PeerUnavailable):owner.check_current()

    def test_private_read_failure_precedes_later_close_and_has_no_public_context(self):
        with self.peer() as (process,client),self.owner(client) as owner:
            self.tell(process,'send',GREETING);failure=PrivateFailure();later=PrivateFailure()
            native_recv=socket.socket.recv;native_close=os.close;reads=[];pidfd=owner._pidfd
            def partial_then_lost(stream,size,flags):
                reads.append(size)
                if len(reads)==1:return native_recv(stream,min(size,7),flags)
                raise failure
            def later_close(number):
                native_close(number)
                if number==pidfd:raise later
            with patch.object(subject.socket.socket,'recv',partial_then_lost),patch.object(subject.os,'close',later_close):
                with self.assertRaises(subject.PeerUnavailable) as caught:owner.consume_greeting()
            self.assertEqual(len(reads),2)
            self.assertIs(owner._first_failure,failure);self.assertIsNone(caught.exception.__context__)
            self.assertNotIn('local-fixture',str(caught.exception));self.assertEqual(repr(owner),'<OriginalLocalControlPeer>')

    def test_inherited_listener_identifies_creator_not_child_handler_and_never_vm_authority(self):
        with tempfile.TemporaryDirectory(prefix='orca-inherited-peer-test-') as d:
            listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(d+'/inherited');listener.listen(1)
            code='import socket,sys; s=socket.socket(fileno=int(sys.argv[1])); c,_=s.accept(); c.sendall(bytes.fromhex(sys.argv[2])); print("READY",flush=True); sys.stdin.readline(); c.close(); s.close()'
            child=subprocess.Popen([sys.executable,'-I','-S','-B','-c',code,str(listener.fileno()),GREETING.hex()],
                                   pass_fds=(listener.fileno(),),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            try:
                client.connect(d+'/inherited');self.line(child,'READY\n')
                with self.owner(client) as owner:
                    self.assertEqual(struct.unpack('iII',owner._credentials)[0],os.getpid())
                    self.assertNotEqual(struct.unpack('iII',owner._credentials)[0],child.pid)
                    owner.consume_greeting()
                    with self.assertRaises(subject.PeerUnavailable):owner.require_vm_authority()
                    child.terminate();child.wait(timeout=3)
                    # Creator pidfd is alive; stream death must still refuse.
                    self.assertFalse(select.select([owner._pidfd],[],[],0)[0])
                    with self.assertRaises(subject.PeerUnavailable):owner.check_current()
            finally:
                client.close();listener.close()
                if child.poll() is None:child.kill()
                child.communicate(timeout=3)

    def test_owned_duplicate_survives_borrower_close_but_not_added_unnegotiated_bytes(self):
        with self.peer() as (process,client),self.owner(client) as owner:
            client.close();self.tell(process,'send',GREETING);owner.consume_greeting();owner.check_current()
            self.tell(process,'send',b'{"event":"UNNEGOTIATED"}\r\n')
            with self.assertRaises(subject.PeerUnavailable):owner.check_current()

    def test_fd_replacement_and_expired_session_refuse_without_reopening(self):
        with self.peer() as (_,client),self.owner(client) as owner:
            owner._deadline=time.monotonic()-1
            with self.assertRaises(subject.PeerUnavailable):owner.check_current()
        with self.peer() as (_,client),self.owner(client) as owner:
            # Controlled source-owner fault, never a hostile-root protection claim.
            with open('/dev/null','rb') as replacement:os.dup2(replacement.fileno(),owner._pidfd,inheritable=False)
            with self.assertRaises(subject.PeerUnavailable):owner.check_current()

    def test_complete_prefix_plus_queued_trailing_bytes_refuses(self):
        with self.peer() as (process,client),self.owner(client) as owner:
            self.tell(process,'send',GREETING+b'{}\r\n')
            native=socket.socket.recv
            def first_frame_only(stream,size,flags):return native(stream,min(size,len(GREETING)),flags)
            with patch.object(subject.socket.socket,'recv',first_frame_only):
                with self.assertRaises(subject.PeerUnavailable):owner.consume_greeting()

    def test_constructor_passive_and_bad_fd_type_rejects_before_acquisition(self):
        class Hostile:
            def __int__(self):raise AssertionError('coercion')
            def __eq__(self,other):raise AssertionError('comparison')
            def __repr__(self):raise AssertionError('formatting')
        with patch.object(subject.socket,'socket',side_effect=AssertionError('socket acquisition')),\
             patch.object(subject.os,'fstat',side_effect=AssertionError('native query')):
            for value in (True,-1,Hostile()):
                owner=subject.OriginalControlPeer()
                with self.assertRaises(subject.PeerUnavailable):owner.adopt(value)
                self.assertEqual(owner.state(),'uncertain');owner.close()

    def test_original_owner_pid_thread_serialization_and_unavailable_authority(self):
        value=subject.OriginalControlPeer()
        with patch.object(subject.os,'getpid',return_value=value._pid+1):
            with self.assertRaises(subject.PeerUnavailable):value.adopt(0)
        errors=[]
        def wrong_thread():
            try:value.adopt(0)
            except subject.PeerUnavailable:errors.append(True)
        t=threading.Thread(target=wrong_thread);t.start();t.join(timeout=2);self.assertEqual(errors,[True])
        with self.assertRaises(TypeError):pickle.dumps(value)
        with patch.object(subject.socket,'socket',side_effect=AssertionError('authority acquisition')):
            with self.assertRaises(subject.PeerUnavailable):value.require_vm_authority()
        self.assertEqual(value.state(),'new');value.close()

    def test_final_current_poll_reentry_cannot_close_or_consume_owned_peer(self):
        with self.peer() as (_,client),self.owner(client) as owner:
            factory=select.poll;refusals=[]
            class ReentrantPoll:
                def __init__(self):self.native=factory()
                def register(self,*args):return self.native.register(*args)
                def poll(inner,timeout):
                    result=inner.native.poll(timeout)
                    for operation in (owner.close,owner.consume_greeting,owner.check_current):
                        try:operation()
                        except subject.PeerUnavailable:refusals.append(True)
                        else:raise AssertionError('reentrant effects allowed')
                    return result
            with patch.object(subject.select,'poll',ReentrantPoll):owner.check_current()
            self.assertEqual(refusals,[True]*3);self.assertEqual(owner.state(),'peer-bound')
            self.assertIsNotNone(owner._socket);self.assertIsNotNone(owner._pidfd)

    def test_close_reentry_cannot_check_consume_or_close_again(self):
        with self.peer() as (_,client):
            owner=subject.OriginalControlPeer();owner.adopt(client.fileno());native=os.close;calls=[]
            def reentrant(number):
                calls.append(number)
                for operation in (owner.check_current,owner.consume_greeting,owner.close):
                    with self.assertRaises(subject.PeerUnavailable):operation()
                return native(number)
            with patch.object(subject.os,'close',reentrant):owner.close()
            self.assertEqual(len(calls),1);self.assertEqual(owner.state(),'closed');owner.close()


class GreetingBoundsTests(unittest.TestCase):
    def test_valid_standard_shape_and_local_restrictive_bounds(self):
        subject._greeting(GREETING)
        subject._greeting(b' '*(subject.GREETING_LIMIT-len(GREETING))+GREETING)
        v=json.loads(GREETING);v['QMP']['version']['package']='x'*1024
        subject._greeting(json.dumps(v).encode()+b'\r\n')
        v['QMP']['version']['package']+='x'
        with self.assertRaises(subject._Refusal):subject._greeting(json.dumps(v).encode()+b'\r\n')

    def test_duplicate_nonjson_depth_nonascii_trailing_and_shape_negatives(self):
        cases=[GREETING+b'{}\r\n',GREETING.replace(b'\r\n',b'\n'),b'{"QMP":{},"QMP":{}}\r\n',
               GREETING.replace(b'"major":9',b'"major":NaN'),GREETING.replace(b'"major":9',b'"major":true'),
               GREETING.replace(b'"major":9',b'"major":99999999999999999999999'),
               GREETING.replace(b'local-fixture',b'private\xff'),b'['*9+b']'*9+b'\r\n',
               GREETING.replace(b'"oob"',b'"oob","oob"'),GREETING.replace(b'"QMP"',b'"caller-authority"')]
        for raw in cases:
            with self.subTest(rawLength=len(raw)),self.assertRaises((subject._Refusal,ValueError)):subject._greeting(raw)


if __name__=='__main__':unittest.main()
