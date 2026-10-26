"""Counter/role controls and an independent exhaustive linearization oracle."""
from functools import lru_cache
from itertools import permutations
import random
import unittest

from controlled_notifications import NotificationIO, notification_io, prove_unit_counter
from controlled_replay import Handle, Object
import test_controlled_replay as helpers


def quoted_counter(value):
    return '"' + ''.join('\\x%02x' % b for b in value.to_bytes(8, 'little')) + '"'


def io(pid, call, value, entered, completed=None):
    return NotificationIO(pid, call, value, entered, entered if completed is None else completed)


def exhaustive_counter(operations):
    # Enumerate all orders consistent with completion-before-entry precedence,
    # executing the actual reset-on-read counter. No greedy/deadline logic here.
    predecessors = [sum(1 << j for j, other in enumerate(operations)
                        if i != j and other.completed < op.entered) for i, op in enumerate(operations)]
    @lru_cache(None)
    def visit(done, counter):
        if done == (1 << len(operations)) - 1:
            return counter == 0
        for i, op in enumerate(operations):
            if done & (1 << i) or predecessors[i] & ~done:
                continue
            if op.call == 'write':
                if visit(done | (1 << i), counter + 1): return True
            elif counter == op.value and visit(done | (1 << i), 0):
                return True
        return False
    return visit(0, 0)


class CounterProofControls(unittest.TestCase):
    def test_read_before_writer_resumed_return_and_coalesced_units_are_valid(self):
        proof = prove_unit_counter([io(11,'write',1,1,9), io(10,'read',1,4)],10)
        self.assertEqual((proof['unitWrites'],proof['counterFinal'],proof['authority']), (1,0,'none'))
        proof = prove_unit_counter([io(11,'write',1,1,8),io(12,'write',1,2,9),io(10,'read',2,5)],10)
        self.assertEqual(proof['unitWrites'],2)

    def test_future_missing_double_consumed_and_unavoidable_units_refuse(self):
        cases = [[io(10,'read',1,1),io(11,'write',1,2)],
                 [io(11,'write',1,1),io(10,'read',2,2)],
                 [io(11,'write',1,1),io(10,'read',1,2),io(10,'read',1,3)],
                 [io(11,'write',1,1),io(12,'write',1,2),io(10,'read',1,3)],
                 [io(11,'write',1,1,10),io(10,'read',1,3),io(12,'write',1,4),
                  io(13,'write',1,5),io(10,'read',1,6),io(10,'read',1,8)]]
        for history in cases:
            with self.subTest(history=history),self.assertRaises(RuntimeError): prove_unit_counter(history,10)

    def test_unread_tail_duplicate_boundary_and_multiple_readers_refuse(self):
        for history in [[io(11,'write',1,1),io(10,'read',1,2),io(11,'write',1,3)],
                        [io(11,'write',1,1),io(10,'read',1,1)],
                        [io(11,'write',1,1),io(12,'read',1,2)],
                        [io(11,'write',1,1,5),io(11,'write',1,2,6),io(10,'read',2,9)]]:
            with self.subTest(history=history),self.assertRaises(RuntimeError): prove_unit_counter(history,10)

    def test_exact_byte_request_result_and_reader_grammar(self):
        valid=(11,'write',['19',quoted_counter(1),'8'],'8',1,5)
        self.assertEqual(notification_io(valid,10).value,1)
        bad=[(11,'write',['19',quoted_counter(2),'8'],'8',1,5),
             (11,'write',['19',quoted_counter(1),'9'],'8',1,5),
             (11,'write',['19',quoted_counter(1),'8'],'7',1,5),
             (10,'read',['19',quoted_counter(0),'1024'],'8',1,5),
             (10,'read',['19',quoted_counter(1),'8'],'8',1,5),
             (11,'read',['19',quoted_counter(1),'1024'],'8',1,5),
             (10,'read',['19','0x1234','1024'],'-1 EAGAIN (Resource temporarily unavailable)',1,5),
             (11,'writev',['19','[]','0'],'8',1,5),
             (10,'read',['19','"x"','1024'],'8',1,5),
             (10,'read',['19',quoted_counter(1)+'...','1024'],'8',1,5)]
        for record in bad:
            with self.subTest(record=record),self.assertRaises(RuntimeError): notification_io(record,10)

    def test_greedy_matches_independent_exhaustive_small_histories(self):
        histories=[]
        for points in permutations(range(1,6)):
            a,b,c,d,r=points
            histories.append([io(11,'write',1,min(a,b),max(a,b)),
                              io(12,'write',1,min(c,d),max(c,d)),io(10,'read',2,r)])
        rng=random.Random(706)
        for _ in range(500):
            points=list(range(1,9));rng.shuffle(points)
            r1,r2=sorted(points[6:]);counts=rng.choice([(1,2),(2,1),(1,1),(2,2)])
            histories.append([io(11+i,'write',1,min(points[i*2:i*2+2]),max(points[i*2:i*2+2])) for i in range(3)] +
                             [io(10,'read',counts[0],r1),io(10,'read',counts[1],r2)])
        for history in histories:
            try: prove_unit_counter(history,10);actual=True
            except RuntimeError: actual=False
            self.assertEqual(actual,exhaustive_counter(history),history)


class NotificationRoleControls(unittest.TestCase):
    def replay(self, registered=True):
        r=helpers.DraftReplayControls().replay()
        r.threads |= {11,12}
        r.original={'queries':{}}
        r.paths={};r.pending_intervals=[];r.waits=[];r.descriptor_intervals=[]
        r.command,r.ack,r.lifetime=4,7,3
        self.event(r,'epoll_create1',['EPOLL_CLOEXEC'],'16',en=1)
        self.event(r,'eventfd2',['0','EFD_CLOEXEC|EFD_NONBLOCK'],'19',en=2)
        if registered:
            self.event(r,'epoll_ctl',['16','EPOLL_CTL_ADD','19','{events=EPOLLIN, data=0x13}'],en=3)
        return r

    def event(self,r,call,args,result='0',en=5,co=None,pid=10):
        record=(pid,call,args,result,en,en if co is None else co)
        r.check_intervals(record);r.event(record)

    def counter(self,r,call,value,en,co=None,pid=10):
        self.event(r,call,['19',quoted_counter(value),'1024' if call=='read' else '8'],'8',en,co,pid)

    def test_original_diagnostic_registration_overlap_remains_explicitly_unsupported(self):
        # Original diagnostic raw intervals: worker write4091..4093 versus
        # leader ADD4092..4094. No generic success-return ordering inference.
        r=self.replay(registered=False)
        self.counter(r,'write',1,4091,4093,11)
        with self.assertRaisesRegex(RuntimeError,'ambiguous shared descriptor/path interval'):
            self.event(r,'epoll_ctl',['16','EPOLL_CTL_ADD','19','{events=EPOLLIN, data=0x13}'],en=4092,co=4094)

    def test_settled_preregistration_unit_then_registration_and_drain_is_supported(self):
        r=self.replay(registered=False)
        self.counter(r,'write',1,4091,4093,11)
        self.event(r,'epoll_ctl',['16','EPOLL_CTL_ADD','19','{events=EPOLLIN, data=0x13}'],en=4094)
        self.counter(r,'read',1,4100)
        proof=r.prove_notifications()[0]
        self.assertEqual((proof['unitWrites'],proof['counterReads'],proof['counterFinal']), (1,1,0))
        self.assertEqual(proof['authority'],'none')

    def test_exact_live_role_permits_only_counter_overlap_pending_whole_lifetime_proof(self):
        r=self.replay()
        self.counter(r,'write',1,5,9,11)
        self.counter(r,'read',1,7)
        proof=r.prove_notifications()[0]
        self.assertEqual((proof['unitWrites'],proof['counterReads'],proof['overlapPairs']), (1,1,1))

    def test_impossible_observed_counter_still_refuses_after_overlap_shape(self):
        r=self.replay()
        self.counter(r,'write',1,5,9,11)
        self.counter(r,'read',2,7)
        with self.assertRaisesRegex(RuntimeError,'eligible unit writes'): r.prove_notifications()

    def test_no_factory_wrong_creator_unregistered_or_opaque_data_cannot_qualify(self):
        for mode in ('no-factory','wrong-creator','wrong-epoll-owner','unregistered','opaque-data'):
            r=self.replay();obj=r.handles[19].obj;epoll=r.handles[16].obj
            if mode=='no-factory':obj.factory_record=None
            elif mode=='wrong-creator':
                obj.factory_record=(11,*obj.factory_record[1:])
            elif mode=='wrong-epoll-owner':
                epoll.factory_record=(11,*epoll.factory_record[1:])
            elif mode=='unregistered':
                self.event(r,'epoll_ctl',['16','EPOLL_CTL_DEL','19','NULL'],en=4)
            else:epoll.registered_data[19]=20
            self.counter(r,'write',1,5,9,11)
            with self.subTest(mode=mode),self.assertRaisesRegex(RuntimeError,'ambiguous shared'):
                self.counter(r,'read',1,7)

    def test_private_file_same_size_bytes_never_uses_notification_exception(self):
        r=self.replay()
        r.handles[19]=Handle(Object('protected-temp',0o100600,{'/base/private'}),{'O_RDONLY'})
        r.check_intervals((11,'write',['19',quoted_counter(1),'8'],'8',5,9))
        with self.assertRaisesRegex(RuntimeError,'ambiguous shared'):
            r.check_intervals((10,'read',['19',quoted_counter(1),'1024'],'8',7,7))

    def test_close_reuse_controls_and_noncanonical_bytes_remain_refused(self):
        for mode in ('close','reuse','fcntl','nonunit','vector'):
            r=self.replay()
            self.counter(r,'write',1,5,9,11)
            with self.subTest(mode=mode),self.assertRaises(RuntimeError):
                if mode=='close':self.event(r,'close',['19'],en=7)
                elif mode=='reuse':
                    del r.handles[19]
                    self.event(r,'eventfd2',['0','EFD_CLOEXEC|EFD_NONBLOCK'],'19',en=7)
                elif mode=='fcntl':self.event(r,'fcntl',['19','F_SETFL','O_RDONLY'],en=7)
                elif mode=='vector':self.event(r,'readv',['19','[]','0'],'8',en=7)
                else:self.counter(r,'write',2,7,pid=12)

    def test_semaphore_or_nonzero_initial_counter_creation_is_not_supported(self):
        for args in (['1','EFD_CLOEXEC|EFD_NONBLOCK'],['0','EFD_SEMAPHORE|EFD_CLOEXEC|EFD_NONBLOCK']):
            with self.subTest(args=args),self.assertRaisesRegex(RuntimeError,'unknown eventfd creation flags'):
                self.event(self.replay(),'eventfd2',args,'23',en=5)

    def test_later_control_or_missing_final_drain_invalidates_entire_proof(self):
        r=self.replay();self.counter(r,'write',1,5,pid=11)
        with self.assertRaisesRegex(RuntimeError,'drain'):r.prove_notifications()
        self.counter(r,'read',1,7)
        with self.assertRaisesRegex(RuntimeError,'unreviewed effect'):
            self.event(r,'fcntl',['19','F_GETFL'],'0x802 (flags O_RDWR|O_NONBLOCK)',en=9)

    def test_control_before_role_qualification_prevents_overlap_exception(self):
        r=self.replay()
        self.event(r,'fcntl',['19','F_GETFL'],'0x802 (flags O_RDWR|O_NONBLOCK)',en=4)
        self.counter(r,'write',1,5,9,11)
        with self.assertRaisesRegex(RuntimeError,'ambiguous shared'):
            self.counter(r,'read',1,7)

    def test_close_after_complete_drain_retains_proof_and_invalidates_watch(self):
        r=self.replay();self.counter(r,'write',1,5,9,11);self.counter(r,'read',1,7)
        self.event(r,'close',['19'],en=11)
        self.assertNotIn(19,r.handles[16].obj.watches)
        self.assertEqual(r.prove_notifications()[0]['counterFinal'],0)

    def test_epoll_role_removal_does_not_release_counter_io(self):
        r=self.replay();self.counter(r,'write',1,5,pid=11);self.counter(r,'read',1,7)
        self.event(r,'epoll_ctl',['16','EPOLL_CTL_DEL','19','NULL'],en=9)
        with self.assertRaisesRegex(RuntimeError,'lost original epoll/handle role'):
            self.counter(r,'write',1,11,pid=11)

    def test_second_reader_is_refused_even_without_overlapping_calls(self):
        r=self.replay();self.counter(r,'write',1,5,pid=11);self.counter(r,'read',1,7)
        self.counter(r,'write',1,9,pid=11)
        with self.assertRaisesRegex(RuntimeError,'unreviewed effect'):
            self.counter(r,'read',1,11,pid=12)

    def test_role_is_bound_to_factory_and_handle_not_fd19_literal(self):
        r=self.replay();self.event(r,'close',['19'],en=4)
        self.event(r,'eventfd2',['0','EFD_CLOEXEC|EFD_NONBLOCK'],'23',en=5)
        self.event(r,'epoll_ctl',['16','EPOLL_CTL_ADD','23','{events=EPOLLIN, data=0x17}'],en=6)
        self.event(r,'write',['23',quoted_counter(1),'8'],'8',en=7,co=11,pid=11)
        self.event(r,'read',['23',quoted_counter(1),'1024'],'8',en=9)
        self.assertEqual(r.prove_notifications()[0]['overlapPairs'],1)
