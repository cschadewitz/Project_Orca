"""Acquisition-scoped cleanup tests. Subreaper scenarios run in a dedicated child
supervisor process so the test runner's own children are never touched."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PRELUDE = textwrap.dedent('''
    import json, os, signal, subprocess, sys, time
    sys.path.insert(0, %r)
    from ledger import AcquisitionLedger
    from reasons import Refusal, code_of
    numeric = []
    os.kill = lambda *a: numeric.append('kill') or (_ for _ in ()).throw(AssertionError('numeric kill'))
    os.killpg = lambda *a: numeric.append('killpg') or (_ for _ in ()).throw(AssertionError('killpg'))
    def alive(pid):
        try:
            with open('/proc/%%d/stat' %% pid) as h:
                return h.read().rsplit(')', 1)[1].split()[0] != 'Z'
        except FileNotFoundError:
            return False
    out = {}
''' % HERE)


def scenario(body, base):
    code = (PRELUDE + 'BASE = %r\n' % base + textwrap.dedent(body) +
            '\nout["numeric"] = numeric\nprint(json.dumps(out))\n')
    result = subprocess.run([sys.executable] + (['-O'] if not __debug__ else []) + ['-I', '-c', code],
                            capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError('scenario failed: ' + result.stderr[-2000:])
    return json.loads(result.stdout.strip().splitlines()[-1])


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def test_clean_settlement_reaps_and_removes(self):
        out = scenario('''
            with AcquisitionLedger(subreaper=True) as ledger:
                d = ledger.private_dir(BASE, 'w')
                p = ledger.spawn(['/bin/sleep', '30'], env={}, cwd=d)
                pid = p.popen.pid
            s = ledger.close().report()
            out.update(s=s, alive=alive(pid), exists=os.path.exists(d), rc=p.popen.returncode)
        ''', self.tmp.name)
        self.assertEqual(out['s']['status'], 'settled')
        self.assertFalse(out['alive'])
        self.assertFalse(out['exists'])
        self.assertEqual(out['rc'], -signal.SIGKILL)
        self.assertEqual(out['numeric'], [])

    def test_orphaned_descendants_are_swept_through_pidfds(self):
        out = scenario('''
            with AcquisitionLedger(subreaper=True) as ledger:
                d = ledger.private_dir(BASE, 'w')
                r, w = os.pipe()
                p = ledger.spawn(['/bin/sh', '-c', '(setsid sleep 30 & echo $!; sleep 30 &) ; sleep 30'],
                                 env={'PATH': '/usr/bin:/bin'}, cwd=d, stdout=w)
                os.close(w)
                time.sleep(0.3)
                grand = int(os.read(r, 64).split()[0])
                os.close(r)
            out.update(s=ledger.close().report(), grand=alive(grand))
        ''', self.tmp.name)
        self.assertEqual(out['s']['status'], 'settled')
        self.assertFalse(out['grand'])
        self.assertEqual(out['numeric'], [])

    def test_partial_startup_failure_still_cleans_prior_acquisitions(self):
        out = scenario('''
            ledger = AcquisitionLedger(subreaper=True)
            try:
                with ledger:
                    d = ledger.private_dir(BASE, 'w')
                    p = ledger.spawn(['/bin/sleep', '30'], env={}, cwd=d)
                    ledger.spawn(['/nonexistent/binary'], env={}, cwd=d)
            except Exception as error:
                out['body'] = code_of(error)
            out.update(s=ledger.close().report(), alive=alive(p.popen.pid), exists=os.path.exists(d))
        ''', self.tmp.name)
        self.assertEqual(out['body'], 'unlisted_reason')
        self.assertEqual((out['s']['status'], out['s']['reason']), ('uncertain', 'acquisition_failed'))
        self.assertTrue(out['s']['bodyFailed'])
        self.assertFalse(out['alive'])
        self.assertFalse(out['exists'])

    def test_every_cleanup_is_attempted_after_a_failure(self):
        out = scenario('''
            calls = []
            ledger = AcquisitionLedger()
            ledger.acquire(lambda: 1, lambda r: calls.append(r), 'a')
            ledger.acquire(lambda: 2, lambda r: (_ for _ in ()).throw(OSError('raw secret path /root')), 'b')
            ledger.acquire(lambda: 3, lambda r: calls.append(r), 'c')
            s = ledger.close()
            out.update(calls=calls, s=s.report(), again=ledger.close() is s)
            try:
                ledger.acquire(lambda: 4, lambda r: None)
            except Refusal as e:
                out['closed'] = e.code
        ''', self.tmp.name)
        self.assertEqual(out['calls'], [3, 1])
        self.assertEqual((out['s']['status'], out['s']['failed'], out['s']['attempted']), ('uncertain', 1, 3))
        self.assertEqual(out['s']['reason'], 'cleanup_failed')
        self.assertNotIn('secret', json.dumps(out))
        self.assertTrue(out['again'])
        self.assertEqual(out['closed'], 'ledger_closed')

    def test_successful_body_with_uncertain_cleanup_is_refused(self):
        out = scenario('''
            try:
                with AcquisitionLedger() as ledger:
                    ledger.acquire(lambda: 1, lambda r: 1 / 0)
                out['returned'] = True
            except Refusal as e:
                out['refusal'] = e.code
        ''', self.tmp.name)
        self.assertEqual(out.get('refusal'), 'cleanup_uncertain')
        self.assertNotIn('returned', out)

    def test_unsettled_process_preserves_directory_and_refuses(self):
        out = scenario('''
            import ledger as L
            ledger = L.AcquisitionLedger(subreaper=True)
            d = ledger.private_dir(BASE, 'w')
            p = ledger.spawn(['/bin/sleep', '30'], env={}, cwd=d)
            keep, send = os.pidfd_open(p.popen.pid), signal.pidfd_send_signal
            signal.pidfd_send_signal = lambda fd, sig: (_ for _ in ()).throw(PermissionError('denied'))
            s = ledger.close().report()
            out.update(s=s, exists=os.path.exists(d), alive=alive(p.popen.pid))
            send(keep, signal.SIGKILL)  # test teardown through a pidfd, never a numeric PID
            os.waitid(os.P_PIDFD, keep, os.WEXITED)
            import shutil; shutil.rmtree(d)
        ''', self.tmp.name)
        self.assertEqual(out['s']['status'], 'uncertain')
        self.assertTrue(out['exists'])
        self.assertTrue(out['alive'])  # not killed by any other means; reported, never guessed

    def test_budgets_and_preconditions_refuse(self):
        out = scenario('''
            ledger = AcquisitionLedger(budget=2)
            ledger.acquire(lambda: 1, lambda r: None)
            ledger.acquire(lambda: 2, lambda r: None)
            try:
                ledger.acquire(lambda: 3, lambda r: None)
            except Refusal as e:
                out['budget'] = e.code
            try:
                AcquisitionLedger(budget=40)
            except Refusal as e:
                out['wide'] = e.code
            child = subprocess.Popen(['/bin/sleep', '0.3'])
            try:
                AcquisitionLedger(subreaper=True)
            except Refusal as e:
                out['dedicated'] = e.code
            child.wait()
            signal.signal(signal.SIGCHLD, signal.SIG_IGN)
            try:
                AcquisitionLedger()
            except Refusal as e:
                out['sigchld'] = e.code
        ''', self.tmp.name)
        self.assertEqual((out['budget'], out['wide'], out['dedicated'], out['sigchld']),
                         ('resource_budget_exceeded', 'resource_budget_exceeded', 'supervisor_not_dedicated',
                          'sigchld_ignored'))

    def test_factory_failure_leaves_no_pending_cleanup(self):
        out = scenario('''
            ledger = AcquisitionLedger()
            try:
                ledger.acquire(lambda: 1 / 0, lambda r: out.setdefault('disposed', r))
            except ZeroDivisionError:
                pass
            out['s'] = ledger.close().report()
        ''', self.tmp.name)
        self.assertNotIn('disposed', out)
        self.assertEqual((out['s']['status'], out['s']['reason']), ('uncertain', 'acquisition_failed'))


if __name__ == '__main__':
    unittest.main()
