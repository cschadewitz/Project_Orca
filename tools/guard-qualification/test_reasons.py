"""Public reporting and private evidence tests."""
import json
import os
import stat
import tempfile
import unittest

import bounds
from reasons import REASONS, PrivateEvidence, Refusal, code_of, public_summary


class ReasonTests(unittest.TestCase):
    def test_refusal_codes_are_allowlisted(self):
        self.assertEqual(Refusal('identity_drift').code, 'identity_drift')
        leaked = Refusal('/root/.ssh/id_ed25519 secret=hunter2')
        self.assertEqual((leaked.code, str(leaked)), ('unlisted_reason', 'unlisted_reason'))
        self.assertEqual(code_of(ValueError('raw /etc/shadow contents')), 'unlisted_reason')
        self.assertTrue(all(code == code.lower() and ' ' not in code for code in REASONS))

    def test_public_summary_rejects_raw_values_and_never_grants(self):
        summary = public_summary(record='x', reason='identity_drift', count=2, sha256='a' * 64,
                                 evidenceClass='simulated')
        self.assertEqual((summary['authority'], summary['productionEligible'], summary['qualified'],
                          summary['observationAuthorized']), ('none', False, False, False))
        for bad in ({'reason': 'Traceback (most recent call last)'}, {'stage': '/home/user/secret'},
                    {'error': 'x'}, {'count': 1.5}, {'sha256': 'not-hex'}, {'record': 'A' * 100},
                    {'evidenceClass': 'production-qualified'}, {'authority': 'granted'},
                    {'qualified': True}, {'productionEligible': True}, {'observationAuthorized': True}):
            with self.subTest(bad=bad):
                with self.assertRaises(Refusal):
                    public_summary(**bad)
        self.assertLess(len(json.dumps(summary)), 512)

    def test_private_evidence_is_bounded_and_owner_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            evidence = PrivateEvidence(tmp, limit=100)
            try:
                record = evidence.write('trace.raw', b'raw secret payload')
                self.assertEqual(record['bytes'], 18)
                self.assertEqual(stat.S_IMODE(os.stat(os.path.join(tmp, 'trace.raw')).st_mode), 0o600)
                with self.assertRaises(Refusal):
                    evidence.write('trace.raw', b'again')
                with self.assertRaises(Refusal):
                    evidence.write('big', b'x' * 200)
                with self.assertRaises(Refusal):
                    evidence.write('../escape', b'x')
                os.symlink('/etc/passwd', os.path.join(tmp, 'link'))
                with self.assertRaises(Refusal):
                    evidence.write('link', b'x')
            finally:
                evidence.close()
            os.chmod(tmp, 0o755)
            with self.assertRaises(Refusal):
                PrivateEvidence(tmp)
        with self.assertRaises(Refusal):
            PrivateEvidence('/tmp', limit=bounds.PRIVATE_EVIDENCE_LIMIT + 1)

    def test_cal4_partial_writes_are_accounted_and_removed(self):
        # Cal 4: a partial write followed by an error left unaccounted bytes on disk.
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            evidence = PrivateEvidence(tmp, limit=10)
            real_write, calls = os.write, []

            def flaky(fd, data):
                calls.append(len(data))
                if len(calls) == 1:
                    return real_write(fd, bytes(data[:4]))
                raise OSError(5, 'raw device error /dev/sda secret')
            try:
                with mock.patch('os.write', flaky):
                    with self.assertRaises(Refusal) as caught:
                        evidence.write('a', b'x' * 8)
                self.assertEqual(caught.exception.code, 'evidence_write_failed')
                self.assertEqual(os.listdir(tmp), [])
                with mock.patch('os.fsync', side_effect=OSError(5, 'fsync')):
                    with self.assertRaises(Refusal) as caught:
                        evidence.write('b', b'y' * 2)
                self.assertEqual(caught.exception.code, 'evidence_write_failed')
                evidence.write('c', b'z' * 8)
                with self.assertRaises(Refusal):
                    evidence.write('d', b'w' * 3)
                on_disk = sum(os.path.getsize(os.path.join(tmp, n)) for n in os.listdir(tmp))
                self.assertLessEqual(on_disk, 10)
            finally:
                evidence.close()

    def test_l6_evidence_directory_checked_on_the_opened_descriptor(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as good, tempfile.TemporaryDirectory() as loose:
            os.chmod(good, 0o700)
            os.chmod(loose, 0o755)
            stat_good = os.lstat(good)
            with mock.patch('os.lstat', return_value=stat_good):
                with self.assertRaises(Refusal):
                    PrivateEvidence(loose)

    def test_l8_callers_cannot_assert_observed_evidence(self):
        for cls in ('observed', 'production-qualified'):
            with self.assertRaises(Refusal):
                public_summary(evidenceClass=cls)
        self.assertEqual(public_summary(evidenceClass='simulated')['evidenceClass'], 'simulated')


class BoundsTests(unittest.TestCase):
    def test_existing_limits_are_mirrored_unchanged(self):
        self.assertEqual((bounds.OWNER_NS, bounds.RUN_NS), (55 * 10 ** 9, 60 * 10 ** 9))
        self.assertEqual(bounds.RUNTIME_ASSET_LIMIT, 256 * 1024 * 1024)
        self.assertEqual((bounds.REPORT_LIMIT, bounds.ORIGINAL_METADATA_LIMIT, bounds.CLOCK_PROBE_TRACE_LIMIT),
                         (1 << 20, 1 << 20, 1 << 20))
        self.assertEqual((bounds.MAX_RUNTIME_ASSETS, bounds.MAX_CLEANUP_RESOURCES), (32, 39))
        self.assertEqual((bounds.NONLIVE_OUTER_SECONDS, bounds.MODULE_OUTER_SECONDS, bounds.WORKER_JOIN_SECONDS),
                         (180, 60, 1))

    def test_new_bounds_do_not_extend_existing_ones(self):
        self.assertLessEqual(bounds.JOURNAL_BYTES_LIMIT, bounds.REPORT_LIMIT)
        self.assertLessEqual(bounds.PROCESS_KILL_WAIT_SECONDS, bounds.WORKER_JOIN_SECONDS)
        self.assertLessEqual(bounds.LOADER_MODULE_LIMIT, bounds.MAX_RUNTIME_ASSETS)
        self.assertLessEqual(bounds.PREFLIGHT_SECONDS * 1e9, bounds.RUN_NS)


if __name__ == '__main__':
    unittest.main()
