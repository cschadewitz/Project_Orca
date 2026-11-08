"""Exact-session authority tests. Keys are ephemeral test keys, never a trust root."""
import copy
import hashlib
import os
import pickle
import tempfile
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import authority as au
from identity import canonical
from reasons import Refusal

NOW = 1_800_000_000_000
H = {k: hashlib.sha256(k.encode()).hexdigest() for k in ('plan', 'identity', 'principal', 'owner', 'other')}


class Clock:
    def __init__(self):
        self.wall, self.mono = NOW, 10 ** 12

    def __call__(self):
        return self.wall, self.mono


def statement(key, **overrides):
    value = {'version': 1, 'planSha256': H['plan'], 'identitySha256': H['identity'],
             'sessionId': 'a' * 32, 'nonce': os.urandom(16).hex(), 'issuedAtMs': NOW - 1000,
             'notBeforeMs': NOW - 1000, 'expiresAtMs': NOW + 60_000,
             'lanes': ['save', 'human-read', 'rule-read'], 'principalSha256': H['principal'],
             'ownerSha256': H['owner'], 'keyFingerprint': au.fingerprint(key.public_key())}
    value.update(overrides)
    data = canonical(value)
    return data, key.sign(au.DOMAIN + data)


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.key = Ed25519PrivateKey.generate()
        self.clock = Clock()
        self.ledger = au.ConsumptionLedger(self.tmp.name)
        self.verifier = self.make_verifier()
        self.context = au.SessionContext(H['principal'], H['owner'], 'a' * 32)

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def make_verifier(self, ledger=None):
        return au.AuthorityVerifier({au.fingerprint(self.key.public_key()): self.key.public_key()},
                                    ledger or self.ledger, clock=self.clock)

    def verify(self, data, signature, verifier=None, **kw):
        args = dict(plan_sha256=H['plan'], identity_sha256=H['identity'], context=self.context)
        args.update(kw)
        return (verifier or self.verifier).verify(data, signature, **args)

    def refuses(self, code, fn, *args, **kw):
        with self.assertRaises(Refusal) as caught:
            fn(*args, **kw)
        self.assertEqual(caught.exception.code, code)

    def check(self, authority, boundary='pre-dispatch', lane='human-read', context=None, identity=None):
        return self.verifier.check(authority, boundary, lane=lane, context=context or self.context,
                                   identity_sha256=identity or H['identity'])

    def test_valid_authorization_checks_at_every_boundary_and_closes(self):
        authority = self.verify(*statement(self.key))
        for boundary in ('phase', 'pre-dispatch'):
            self.assertTrue(self.check(authority, boundary))
        self.assertTrue(self.check(authority, 'final'))
        self.refuses('authority_closed', self.check, authority)

    def test_production_has_no_trust_root(self):
        self.assertEqual(au.PRODUCTION_TRUST_ROOT, ())
        self.refuses('no_trust_root', au.production_verifier, self.ledger)
        self.refuses('no_trust_root', au.AuthorityVerifier, {}, self.ledger)
        os.environ['ORCA_GUARD_AUTHORIZED'] = '1'
        try:
            self.refuses('no_trust_root', au.production_verifier, self.ledger)
        finally:
            del os.environ['ORCA_GUARD_AUTHORIZED']

    def test_caller_objects_cannot_mint_authority(self):
        data, _ = statement(self.key)
        for forged in (True, {'authority': 'granted'}, H['plan'], data, 'action-1', None):
            self.refuses('authority_unregistered', self.check, forged)
        self.refuses('authority_unregistered', au.SessionAuthority)
        rebuilt = object.__new__(au.SessionAuthority)
        self.refuses('authority_unregistered', self.check, rebuilt)
        real = self.verify(*statement(self.key))
        lookalike = object.__new__(au.SessionAuthority)
        for name in au.SessionAuthority.__slots__[:-1]:
            object.__setattr__(lookalike, name, getattr(real, name))
        self.refuses('authority_unregistered', self.check, lookalike)

    def test_copies_and_serialization_refuse(self):
        authority = self.verify(*statement(self.key))
        self.refuses('authority_copied', copy.copy, authority)
        self.refuses('authority_copied', copy.deepcopy, authority)
        self.refuses('authority_copied', pickle.dumps, authority)
        self.assertNotIn(H['plan'], repr(authority))

    def test_forged_untrusted_and_modified_statements_refuse(self):
        data, signature = statement(self.key)
        self.refuses('signature_invalid', self.verify, data, bytes(64))
        self.refuses('signature_invalid', self.verify, data, signature[:-1])
        tampered = data.replace(b'"save",', b'')
        self.refuses('signature_invalid', self.verify, tampered, signature)
        other = Ed25519PrivateKey.generate()
        self.refuses('key_untrusted', self.verify, *statement(other))
        data2, _ = statement(self.key)
        self.refuses('signature_invalid', self.verify, data2, other.sign(au.DOMAIN + data2))

    def test_malformed_statements_refuse(self):
        data, signature = statement(self.key)
        self.refuses('authorization_malformed', self.verify, data.replace(b'{', b'{ ', 1), signature)
        self.refuses('authorization_malformed', self.verify, data[:-1] + b',"version":1}', signature)
        self.refuses('authorization_oversize', self.verify, b'x' * 20000, signature)
        self.refuses('authorization_malformed', self.verify, *statement(self.key, lanes=['rule-read', 'save']))
        self.refuses('authorization_malformed', self.verify, *statement(self.key, lanes=['shell']))
        self.refuses('authorization_malformed', self.verify, *statement(self.key, version=True))
        self.refuses('authorization_lifetime_exceeded', self.verify,
                     *statement(self.key, expiresAtMs=NOW + 3_600_000))

    def test_time_window(self):
        self.refuses('authorization_not_yet_valid', self.verify,
                     *statement(self.key, issuedAtMs=NOW + 1, notBeforeMs=NOW + 10))
        self.refuses('authorization_expired', self.verify,
                     *statement(self.key, issuedAtMs=NOW - 120_000, notBeforeMs=NOW - 120_000,
                                expiresAtMs=NOW - 1))
        authority = self.verify(*statement(self.key))
        self.clock.mono += 61_000 * 10 ** 6  # monotonic elapsed beyond expiry, wall unchanged
        self.refuses('authorization_expired', self.check, authority)
        authority = self.verify(*statement(self.key))
        self.clock.wall -= 5_000  # wall moved backwards
        self.refuses('authorization_expired', self.check, authority)

    def test_single_use_and_replay_across_verifiers(self):
        data, signature = statement(self.key)
        self.verify(data, signature)
        self.refuses('authorization_replayed', self.verify, data, signature)
        ledger2 = au.ConsumptionLedger(self.tmp.name)
        try:
            self.refuses('authorization_replayed', self.verify, data, signature, verifier=self.make_verifier(ledger2))
        finally:
            ledger2.close()

    def test_revocation_is_checked_at_boundaries(self):
        authority = self.verify(*statement(self.key))
        revocation = canonical({'revokes': authority.statement_sha256,
                                'keyFingerprint': au.fingerprint(self.key.public_key())})
        self.refuses('signature_invalid', self.verifier.revoke, revocation, bytes(64))
        self.assertTrue(self.check(authority))
        self.verifier.revoke(revocation, self.key.sign(au.REVOCATION_DOMAIN + revocation))
        for boundary in ('pre-dispatch', 'phase', 'final'):
            self.refuses('authorization_revoked', self.check, authority, boundary)
        stale = statement(self.key)
        digest = hashlib.sha256(au.DOMAIN + stale[0]).hexdigest()
        revocation = canonical({'revokes': digest, 'keyFingerprint': au.fingerprint(self.key.public_key())})
        self.verifier.revoke(revocation, self.key.sign(au.REVOCATION_DOMAIN + revocation))
        self.refuses('authorization_revoked', self.verify, *stale)

    def test_plan_identity_lane_and_context_binding(self):
        self.refuses('plan_mismatch', self.verify, *statement(self.key), plan_sha256=H['other'])
        self.refuses('identity_mismatch', self.verify, *statement(self.key), identity_sha256=H['other'])
        self.refuses('context_changed', self.verify, *statement(self.key),
                     context=au.SessionContext(H['other'], H['owner'], 'a' * 32))
        authority = self.verify(*statement(self.key, lanes=['save']))
        self.refuses('lane_not_authorized', self.check, authority, lane='human-read')
        authority = self.verify(*statement(self.key))
        self.refuses('identity_mismatch', self.check, authority, identity=H['other'])
        for changed in (au.SessionContext(H['other'], H['owner'], 'a' * 32),
                        au.SessionContext(H['principal'], H['other'], 'a' * 32),
                        au.SessionContext(H['principal'], H['owner'], 'b' * 32)):
            self.refuses('context_changed', self.check, authority, context=changed)
        self.refuses('boundary_unknown', self.check, authority, boundary='post-dispatch')
        other_verifier = self.make_verifier()
        self.refuses('authority_unregistered', other_verifier.check, authority, 'phase', lane='save',
                     context=self.context, identity_sha256=H['identity'])

    def test_ledger_directory_must_be_private(self):
        with tempfile.TemporaryDirectory() as loose:
            os.chmod(loose, 0o755)
            self.refuses('ledger_unavailable', au.ConsumptionLedger, loose)


if __name__ == '__main__':
    unittest.main()
