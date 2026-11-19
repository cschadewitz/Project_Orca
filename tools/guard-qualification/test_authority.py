"""Exact-session authority tests. Keys are ephemeral test keys, never a trust root."""
import copy
import hashlib
import os
import pickle
import tempfile
import unittest
from unittest import mock

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import authority as au
import identity as idn
from identity import canonical
from reasons import Refusal
from test_identity import sample

NOW = 1_800_000_000_000
PLAN = b'frozen exact-run plan bytes'
H = {k: hashlib.sha256(k.encode()).hexdigest() for k in ('principal', 'owner', 'other')}
H['plan'] = hashlib.sha256(PLAN).hexdigest()
H['identity'] = idn.digest(sample())


class Clock:
    def __init__(self):
        self.wall, self.mono = NOW, 10 ** 12

    def __call__(self):
        return self.wall, self.mono


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, 'ledger')
        os.mkdir(self.dir, 0o700)
        self.key = Ed25519PrivateKey.generate()
        self.clock = Clock()
        self.measured = sample()
        self.ledger = au.ConsumptionLedger.create(self.dir)
        self.verifier = self.make_verifier()
        self.context = au.SessionContext(H['principal'], H['owner'], 'a' * 32)

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def make_verifier(self, ledger=None):
        return au.AuthorityVerifier({au.fingerprint(self.key.public_key()): self.key.public_key()},
                                    ledger or self.ledger, lambda: self.measured, clock=self.clock)

    def statement(self, key=None, ledger=None, **overrides):
        key = key or self.key
        value = {'version': 1, 'planSha256': H['plan'], 'identitySha256': H['identity'],
                 'sessionId': 'a' * 32, 'nonce': os.urandom(16).hex(), 'issuedAtMs': NOW - 1000,
                 'notBeforeMs': NOW - 1000, 'expiresAtMs': NOW + 60_000,
                 'lanes': ['save', 'human-read', 'rule-read'], 'principalSha256': H['principal'],
                 'ownerSha256': H['owner'], 'keyFingerprint': au.fingerprint(key.public_key()),
                 'ledgerSha256': (ledger or self.ledger).ledger_sha256}
        value.update(overrides)
        data = canonical(value)
        return data, key.sign(au.DOMAIN + data)

    def verify(self, data, signature, verifier=None, **kw):
        args = dict(plan_bytes=PLAN, context=self.context)
        args.update(kw)
        return (verifier or self.verifier).verify(data, signature, **args)

    def refuses(self, code, fn, *args, **kw):
        with self.assertRaises(Refusal) as caught:
            fn(*args, **kw)
        self.assertEqual(caught.exception.code, code)

    def check(self, authority, boundary='pre-dispatch', lane='human-read', context=None, verifier=None):
        return (verifier or self.verifier).check(authority, boundary, lane=lane, context=context or self.context)

    def revoke(self, verifier, digest):
        revocation = canonical({'revokes': digest, 'keyFingerprint': au.fingerprint(self.key.public_key())})
        verifier.revoke(revocation, self.key.sign(au.REVOCATION_DOMAIN + revocation))

    def test_valid_authorization_checks_at_every_boundary_and_closes(self):
        authority = self.verify(*self.statement())
        for boundary in ('phase', 'pre-dispatch'):
            self.assertTrue(self.check(authority, boundary))
        self.assertTrue(self.check(authority, 'final'))
        self.refuses('authority_closed', self.check, authority)
        self.assertEqual([r['boundary'] for r in self.verifier.supervisor_records()],
                         ['phase', 'pre-dispatch', 'final'])

    def test_production_has_no_trust_root(self):
        self.assertEqual(au.PRODUCTION_TRUST_ROOT, ())
        self.refuses('no_trust_root', au.production_verifier, self.ledger, lambda: self.measured)
        self.refuses('no_trust_root', au.AuthorityVerifier, {}, self.ledger, lambda: self.measured)
        with mock.patch.dict(os.environ, {'ORCA_GUARD_AUTHORIZED': '1'}):
            self.refuses('no_trust_root', au.production_verifier, self.ledger, lambda: self.measured)

    def test_caller_objects_cannot_mint_authority(self):
        data, _ = self.statement()
        for forged in (True, {'authority': 'granted'}, H['plan'], data, 'action-1', None):
            self.refuses('authority_unregistered', self.check, forged)
        self.refuses('authority_unregistered', au.SessionAuthority)
        self.refuses('authority_unregistered', self.check, object.__new__(au.SessionAuthority))
        real = self.verify(*self.statement())
        lookalike = object.__new__(au.SessionAuthority)
        for name in ('_verifier', '_digest'):
            object.__setattr__(lookalike, name, getattr(real, name))
        self.refuses('authority_unregistered', self.check, lookalike)

    def test_copies_and_serialization_refuse(self):
        authority = self.verify(*self.statement())
        self.refuses('authority_copied', copy.copy, authority)
        self.refuses('authority_copied', copy.deepcopy, authority)
        self.refuses('authority_copied', pickle.dumps, authority)
        self.assertNotIn(H['plan'], repr(authority))

    def test_forged_untrusted_and_modified_statements_refuse(self):
        data, signature = self.statement()
        self.refuses('signature_invalid', self.verify, data, bytes(64))
        self.refuses('signature_invalid', self.verify, data, signature[:-1])
        self.refuses('signature_invalid', self.verify, data.replace(b'"save",', b''), signature)
        other = Ed25519PrivateKey.generate()
        self.refuses('key_untrusted', self.verify, *self.statement(other))
        data2, _ = self.statement()
        self.refuses('signature_invalid', self.verify, data2, other.sign(au.DOMAIN + data2))

    def test_malformed_statements_refuse(self):
        data, signature = self.statement()
        self.refuses('authorization_malformed', self.verify, data.replace(b'{', b'{ ', 1), signature)
        self.refuses('authorization_malformed', self.verify, data[:-1] + b',"version":1}', signature)
        self.refuses('authorization_oversize', self.verify, b'x' * 20000, signature)
        self.refuses('authorization_malformed', self.verify, *self.statement(lanes=['rule-read', 'save']))
        self.refuses('authorization_malformed', self.verify, *self.statement(lanes=['shell']))
        self.refuses('authorization_malformed', self.verify, *self.statement(version=True))
        self.refuses('authorization_lifetime_exceeded', self.verify, *self.statement(expiresAtMs=NOW + 3_600_000))

    def test_time_window(self):
        self.refuses('authorization_not_yet_valid', self.verify,
                     *self.statement(issuedAtMs=NOW + 1, notBeforeMs=NOW + 10))
        self.refuses('authorization_expired', self.verify,
                     *self.statement(issuedAtMs=NOW - 120_000, notBeforeMs=NOW - 120_000, expiresAtMs=NOW - 1))
        authority = self.verify(*self.statement())
        self.clock.mono += 61_000 * 10 ** 6
        self.refuses('authorization_expired', self.check, authority)
        authority = self.verify(*self.statement())
        self.clock.wall -= 5_000
        self.refuses('authorization_expired', self.check, authority)

    def test_single_use_and_replay_across_verifiers(self):
        data, signature = self.statement()
        self.verify(data, signature)
        self.refuses('authorization_replayed', self.verify, data, signature)
        reopened = au.ConsumptionLedger(self.dir)
        try:
            self.refuses('authorization_replayed', self.verify, data, signature, verifier=self.make_verifier(reopened))
        finally:
            reopened.close()

    def test_m4_statement_is_bound_to_one_designated_ledger(self):
        # Reviewer M4: a second verifier with a fresh ledger directory accepted the same statement.
        data, signature = self.statement()
        self.verify(data, signature)
        fresh_dir = os.path.join(self.tmp.name, 'fresh')
        os.mkdir(fresh_dir, 0o700)
        fresh = au.ConsumptionLedger.create(fresh_dir)
        try:
            self.assertNotEqual(fresh.ledger_sha256, self.ledger.ledger_sha256)
            self.refuses('ledger_mismatch', self.verify, data, signature, verifier=self.make_verifier(fresh))
        finally:
            fresh.close()
        self.refuses('ledger_unavailable', au.ConsumptionLedger, os.path.join(self.tmp.name, 'missing'))
        empty = os.path.join(self.tmp.name, 'empty')
        os.mkdir(empty, 0o700)
        self.refuses('ledger_unavailable', au.ConsumptionLedger, empty)  # no designated id
        self.refuses('ledger_unavailable', au.ConsumptionLedger.create, self.dir)  # never re-created

    def test_revocation_is_checked_at_boundaries(self):
        authority = self.verify(*self.statement())
        revocation = canonical({'revokes': self.verifier.statement_sha256(authority),
                                'keyFingerprint': au.fingerprint(self.key.public_key())})
        self.refuses('signature_invalid', self.verifier.revoke, revocation, bytes(64))
        self.assertTrue(self.check(authority))
        self.revoke(self.verifier, self.verifier.statement_sha256(authority))
        for boundary in ('pre-dispatch', 'phase', 'final'):
            self.refuses('authorization_revoked', self.check, authority, boundary)
        stale = self.statement()
        self.revoke(self.verifier, hashlib.sha256(au.DOMAIN + stale[0]).hexdigest())
        self.refuses('authorization_revoked', self.verify, *stale)

    def test_m5_revocation_is_durable_and_shared_through_the_ledger(self):
        # Reviewer M5: revocation lived only in one verifier's memory.
        other_verifier = self.make_verifier(au.ConsumptionLedger(self.dir))
        authority = other_verifier.verify(*self.statement(), plan_bytes=PLAN, context=self.context)
        self.assertTrue(self.check(authority, verifier=other_verifier))
        self.revoke(self.verifier, other_verifier.statement_sha256(authority))
        self.refuses('authorization_revoked', self.check, authority, verifier=other_verifier)
        # A tampered revocation record makes the ledger unusable rather than being ignored.
        name = next(n for n in os.listdir(self.dir) if n.startswith('revoked-'))
        with open(os.path.join(self.dir, name), 'r+b') as handle:
            handle.write(b'X')
        self.refuses('ledger_unavailable', self.check, authority, verifier=other_verifier)

    def test_m6_capability_attributes_do_not_carry_authority(self):
        # Reviewer M6: plain attribute writes added lanes, reopened, or extended expiry.
        authority = self.verify(*self.statement(lanes=['save']))
        for name in ('_statement', '_lanes', '_closed', '_expires'):
            try:
                object.__setattr__(authority, name, {'lanes': ['human-read'], 'expiresAtMs': NOW * 2})
            except AttributeError:
                pass
        self.refuses('lane_not_authorized', self.check, authority, lane='human-read')
        self.assertTrue(self.check(authority, 'final', lane='save'))
        with self.assertRaises(AttributeError):
            authority._closed = False
        self.refuses('authority_closed', self.check, authority, lane='save')
        self.assertEqual(authority.__slots__, ('_verifier', '_digest', '__weakref__'))

    def test_m7_identity_is_measured_by_the_verifier_not_supplied(self):
        # Reviewer M7: check() trusted a caller-supplied identity hash.
        self.assertNotIn('session', idn.SCHEMA)
        authority = self.verify(*self.statement())
        self.measured = sample()
        self.measured['runtime']['node']['exeSha256'] = hashlib.sha256(b'drift').hexdigest()
        self.refuses('identity_mismatch', self.check, authority)
        self.measured = sample()
        self.assertTrue(self.check(authority))
        self.measured = dict(sample(), lane=None)
        self.refuses('identity_incomplete', self.check, authority)
        self.measured = sample()
        self.measured['runtime']['python']['version'] = '3.14.0'
        self.refuses('identity_mismatch', self.verify, *self.statement())
        with self.assertRaises(TypeError):
            self.verifier.check(authority, 'phase', lane='save', context=self.context, identity_sha256=H['identity'])

    def test_cal5_end_to_end_with_measured_digests(self):
        # Cal 5 / reviewer M7: identity -> plan -> signed statement -> outer run envelope, every
        # digest actually computed from measurements, none of them a placeholder.
        import subprocess
        import sys
        import containment
        repo = os.path.join(self.tmp.name, 'repo')
        os.mkdir(repo)
        with open(os.path.join(repo, 'f'), 'w') as handle:
            handle.write('reviewed\n')
        env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t',
                   GIT_COMMITTER_EMAIL='t@t')
        for args in (['init', '-q'], ['add', 'f'], ['commit', '-q', '-m', 'x']):
            subprocess.run(['git', '-C', repo, *args], check=True, env=env)
        workspace = os.path.join(self.tmp.name, 'ws')
        os.mkdir(workspace, 0o700)
        here = os.path.dirname(os.path.abspath(__file__))

        def measure():
            measured = sample()
            measured['source'] = idn.measure_source(repo)
            measured['host'] = idn.measure_host()
            measured['runtime']['python'] = {'version': '%d.%d.%d' % sys.version_info[:3],
                                             'exeSha256': idn.file_digest(os.path.realpath(sys.executable))['sha256']}
            measured['loader']['loaderSha256'] = idn.file_digest(os.path.join(here, 'bound-loader.mjs'))['sha256']
            spec = containment.make_spec(workspace=workspace, snapshot=None, snapshot_digests=None,
                                         runtime_dirs=['/usr'], argv=['/usr/bin/true'], env={'PATH': '/usr/bin'})
            spec['hostNamespaces'] = {ns: 0 for ns in containment.NAMESPACES}  # host-independent for the digest
            measured['containment']['specSha256'] = containment.spec_digest(spec)
            return measured

        # 1. identity first: it has no session, plan, statement or envelope field.
        identity = measure()
        identity_sha = idn.validate(identity)
        self.assertTrue(identity['source']['clean'])
        # 2. the frozen plan names the identity digest.
        plan = canonical({'record': 'exact-run-plan', 'version': 1, 'identitySha256': identity_sha,
                          'lanes': ['save', 'human-read', 'rule-read'], 'expected': {'save': 0, 'allowOnce': 1,
                                                                                     'freshRule': 1}})
        plan_sha = hashlib.sha256(plan).hexdigest()
        # 3. the signed statement binds the pre-authorization identity, the plan and the ledger.
        verifier = au.AuthorityVerifier({au.fingerprint(self.key.public_key()): self.key.public_key()},
                                        self.ledger, measure, clock=self.clock)
        data, signature = self.statement(planSha256=plan_sha, identitySha256=identity_sha)
        statement_sha = hashlib.sha256(au.DOMAIN + data).hexdigest()
        authority = verifier.verify(data, signature, plan_bytes=plan, context=self.context)
        # 4. the outer run envelope names identity, plan and statement digests.
        envelope = verifier.run_envelope(authority)
        expected = canonical({'version': 1, 'record': 'orca-guard-run-envelope', 'identitySha256': identity_sha,
                              'planSha256': plan_sha, 'statementSha256': statement_sha,
                              'ledgerSha256': self.ledger.ledger_sha256, 'sessionId': 'a' * 32})
        self.assertEqual(envelope, expected)
        envelope_sha = verifier.check_envelope(authority, envelope)
        self.assertEqual(envelope_sha, hashlib.sha256(au.ENVELOPE_DOMAIN + expected).hexdigest())
        # No earlier object contains a later digest: the order is acyclic.
        for later in (plan_sha, statement_sha, envelope_sha):
            self.assertNotIn(later.encode(), canonical(identity))
        for later in (statement_sha, envelope_sha):
            self.assertNotIn(later.encode(), plan)
        self.assertNotIn(envelope_sha.encode(), data)
        self.assertEqual(len({identity_sha, plan_sha, statement_sha, envelope_sha}), 4)
        for value in (identity_sha, plan_sha, statement_sha, envelope_sha):
            self.assertNotIn(value, H.values())
        self.assertTrue(verifier.check(authority, 'pre-dispatch', lane='save', context=self.context))
        # A different envelope, or drift in the measured identity, refuses.
        self.refuses('run_envelope_mismatch', verifier.check_envelope, authority,
                     expected.replace(statement_sha.encode(), b'0' * 64))
        with open(os.path.join(repo, 'f'), 'w') as handle:
            handle.write('changed after authorization\n')
        self.assertFalse(idn.measure_source(repo)['clean'])  # a dirty tree is not a valid identity at all
        self.refuses('identity_malformed', verifier.check, authority, 'phase', lane='save', context=self.context)
        subprocess.run(['git', '-C', repo, 'commit', '-q', '-am', 'y'], check=True, env=env)
        self.assertTrue(idn.measure_source(repo)['clean'])  # clean again, but a different commit and tree
        self.refuses('identity_mismatch', verifier.check, authority, 'phase', lane='save', context=self.context)
        self.refuses('identity_mismatch', verifier.run_envelope, authority)

    def test_plan_lane_and_context_binding(self):
        self.refuses('plan_mismatch', self.verify, *self.statement(), plan_bytes=b'other plan')
        self.refuses('context_changed', self.verify, *self.statement(),
                     context=au.SessionContext(H['other'], H['owner'], 'a' * 32))
        authority = self.verify(*self.statement(lanes=['save']))
        self.refuses('lane_not_authorized', self.check, authority, lane='human-read')
        authority = self.verify(*self.statement())
        for changed in (au.SessionContext(H['other'], H['owner'], 'a' * 32),
                        au.SessionContext(H['principal'], H['other'], 'a' * 32),
                        au.SessionContext(H['principal'], H['owner'], 'b' * 32)):
            self.refuses('context_changed', self.check, authority, context=changed)
        self.refuses('boundary_unknown', self.check, authority, boundary='post-dispatch')
        self.refuses('authority_unregistered', self.make_verifier().check, authority, 'phase', lane='save',
                     context=self.context)

    def test_l6_ledger_directory_checked_on_the_opened_descriptor(self):
        loose = os.path.join(self.tmp.name, 'loose')
        os.mkdir(loose, 0o755)
        self.refuses('ledger_unavailable', au.ConsumptionLedger.create, loose)
        good = os.lstat(self.dir)
        with mock.patch('os.lstat', return_value=good):  # a forged path check must not matter
            self.refuses('ledger_unavailable', au.ConsumptionLedger.create, loose)
        link = os.path.join(self.tmp.name, 'link')
        os.symlink(self.dir, link)
        self.refuses('ledger_unavailable', au.ConsumptionLedger, link)


if __name__ == '__main__':
    unittest.main()
