"""Exact-session authority from an independently signed exact-run authorization.

Authority is never created from a caller-supplied object, digest, boolean,
environment variable, action id or fixture. It requires an Ed25519 signature
by a key whose fingerprint is in the verifier's trust root, over a statement
that binds the exact run plan, exact identity tuple, session, lanes and a short
validity window. Each statement is consumed at most once (durable exclusive
ledger), and the resulting SessionAuthority is a live in-process capability
registered with the verifier that issued it. Copies, pickles and reconstructed
objects are not registered and refuse.

PRODUCTION_TRUST_ROOT is deliberately empty: no key is trusted by this source,
so production_verifier() refuses every authorization. Adding a key is a reviewed
source change that also changes the source identity bound in the tuple.

Trust assumptions: the signer's private key is held outside this host by the
authorizing person; the Python interpreter, the cryptography package and the
same process are trusted (code running in this process can bypass any Python
object boundary). Wall/monotonic clocks are those of this host.
"""
import hashlib
import json
import os
import re
import stat
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from bounds import AUTHORIZATION_MAX_LIFETIME_MS, AUTHORIZATION_STATEMENT_LIMIT
from identity import LANE_PHASES, canonical
from reasons import Refusal, require

DOMAIN = b'orca-guard-exact-run-authorization-v1\0'
REVOCATION_DOMAIN = b'orca-guard-exact-run-revocation-v1\0'
# fingerprint -> raw Ed25519 public key hex. Empty: nothing is trusted.
PRODUCTION_TRUST_ROOT = ()
BOUNDARIES = ('pre-dispatch', 'phase', 'final')
STATEMENT_KEYS = frozenset(('version', 'planSha256', 'identitySha256', 'sessionId', 'nonce',
                            'issuedAtMs', 'notBeforeMs', 'expiresAtMs', 'lanes', 'principalSha256',
                            'ownerSha256', 'keyFingerprint'))
_HEX64 = re.compile(r'[0-9a-f]{64}')
_HEX32 = re.compile(r'[0-9a-f]{32}')


def fingerprint(public_key):
    return hashlib.sha256(public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)).hexdigest()


def _parse_statement(data):
    require(type(data) is bytes, 'authorization_malformed')
    require(len(data) <= AUTHORIZATION_STATEMENT_LIMIT, 'authorization_oversize')
    try:
        value = json.loads(data.decode('ascii'), parse_constant=lambda _: None,
                           object_pairs_hook=_unique_pairs)
    except (UnicodeDecodeError, ValueError, Refusal):
        raise Refusal('authorization_malformed') from None
    require(type(value) is dict and set(value) == STATEMENT_KEYS, 'authorization_malformed')
    require(canonical(value) == data, 'authorization_malformed')  # exactly one encoding
    ints = ('issuedAtMs', 'notBeforeMs', 'expiresAtMs')
    require(value['version'] == 1 and type(value['version']) is int and
            all(type(value[k]) is int and 0 < value[k] < 2 ** 53 for k in ints) and
            all(type(value[k]) is str and _HEX64.fullmatch(value[k]) for k in
                ('planSha256', 'identitySha256', 'principalSha256', 'ownerSha256', 'keyFingerprint')) and
            type(value['sessionId']) is str and _HEX32.fullmatch(value['sessionId']) and
            type(value['nonce']) is str and _HEX32.fullmatch(value['nonce']) and
            type(value['lanes']) is list and value['lanes'] and
            all(type(lane) is str for lane in value['lanes']) and
            value['lanes'] == [p for p in LANE_PHASES if p in value['lanes']] and
            len(set(value['lanes'])) == len(value['lanes']), 'authorization_malformed')
    require(value['issuedAtMs'] <= value['notBeforeMs'] < value['expiresAtMs'], 'authorization_malformed')
    require(value['expiresAtMs'] - value['issuedAtMs'] <= AUTHORIZATION_MAX_LIFETIME_MS,
            'authorization_lifetime_exceeded')
    return value


def _unique_pairs(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise Refusal('authorization_malformed')
    return dict(pairs)


class ConsumptionLedger:
    """Durable single-use record: one exclusive file per consumed statement digest."""

    def __init__(self, directory):
        info = os.lstat(directory)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
                stat.S_IMODE(info.st_mode) == 0o700, 'ledger_unavailable')
        self._dir = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)

    def consume(self, statement_digest):
        try:
            fd = os.open('used-' + statement_digest, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self._dir)
        except FileExistsError:
            raise Refusal('authorization_replayed') from None
        except OSError:
            raise Refusal('ledger_unavailable') from None
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self._dir)

    def close(self):
        if self._dir is not None:
            fd, self._dir = self._dir, None
            os.close(fd)


class SessionContext:
    """The verified owner's current session facts, compared at every boundary."""
    __slots__ = ('principal_sha256', 'owner_sha256', 'session_id')

    def __init__(self, principal_sha256, owner_sha256, session_id):
        self.principal_sha256, self.owner_sha256 = principal_sha256, owner_sha256
        self.session_id = session_id


class SessionAuthority:
    """Opaque live capability. Not serializable, copyable or constructible by callers."""
    __slots__ = ('_verifier', '_statement', '_digest', '_wall0', '_mono0', '_closed', '__weakref__')

    def __init__(self, *_args, **_kwargs):
        raise Refusal('authority_unregistered')

    def __reduce_ex__(self, _protocol):
        raise Refusal('authority_copied')

    def __copy__(self):
        raise Refusal('authority_copied')

    def __deepcopy__(self, _memo):
        raise Refusal('authority_copied')

    def __repr__(self):
        return 'SessionAuthority(<opaque>)'

    @property
    def statement_sha256(self):
        return self._digest

    @property
    def lanes(self):
        return tuple(self._statement['lanes'])


class AuthorityVerifier:
    def __init__(self, trust_root, ledger, revoked=(), clock=None):
        require(type(trust_root) is dict and trust_root and all(
            type(k) is str and _HEX64.fullmatch(k) and isinstance(v, Ed25519PublicKey) and fingerprint(v) == k
            for k, v in trust_root.items()), 'no_trust_root')
        require(isinstance(ledger, ConsumptionLedger), 'ledger_unavailable')
        self._keys = dict(trust_root)
        self._ledger = ledger
        self._revoked = set(revoked)
        self._issued = {}
        self._clock = clock or (lambda: (time.time_ns() // 1_000_000, time.monotonic_ns()))

    def revoke(self, revocation_bytes, signature):
        """Accept a signed revocation of a statement digest from a trusted key."""
        require(type(revocation_bytes) is bytes and len(revocation_bytes) <= 256, 'authorization_malformed')
        try:
            value = json.loads(revocation_bytes.decode('ascii'), object_pairs_hook=_unique_pairs)
        except (UnicodeDecodeError, ValueError, Refusal):
            raise Refusal('authorization_malformed') from None
        require(type(value) is dict and set(value) == {'revokes', 'keyFingerprint'} and
                type(value['revokes']) is str and _HEX64.fullmatch(value['revokes']) and
                canonical(value) == revocation_bytes, 'authorization_malformed')
        key = self._keys.get(value['keyFingerprint'])
        require(key is not None, 'key_untrusted')
        try:
            key.verify(signature, REVOCATION_DOMAIN + revocation_bytes)
        except (InvalidSignature, TypeError, ValueError):
            raise Refusal('signature_invalid') from None
        self._revoked.add(value['revokes'])

    def verify(self, statement_bytes, signature, *, plan_sha256, identity_sha256, context):
        """Verify and consume one exact-run authorization; return a live capability."""
        require(self._keys, 'no_trust_root')
        statement = _parse_statement(statement_bytes)
        key = self._keys.get(statement['keyFingerprint'])
        require(key is not None, 'key_untrusted')
        require(type(signature) is bytes and len(signature) == 64, 'signature_invalid')
        try:
            key.verify(signature, DOMAIN + statement_bytes)
        except (InvalidSignature, TypeError, ValueError):
            raise Refusal('signature_invalid') from None
        statement_digest = hashlib.sha256(DOMAIN + statement_bytes).hexdigest()
        require(statement_digest not in self._revoked, 'authorization_revoked')
        require(statement['planSha256'] == plan_sha256, 'plan_mismatch')
        require(statement['identitySha256'] == identity_sha256, 'identity_mismatch')
        self._check_context(statement, context)
        wall, mono = self._clock()
        require(wall >= statement['notBeforeMs'], 'authorization_not_yet_valid')
        require(wall < statement['expiresAtMs'], 'authorization_expired')
        self._ledger.consume(statement_digest)
        authority = object.__new__(SessionAuthority)
        for name, value in (('_verifier', self), ('_statement', statement), ('_digest', statement_digest),
                            ('_wall0', wall), ('_mono0', mono), ('_closed', False)):
            object.__setattr__(authority, name, value)
        self._issued[id(authority)] = authority
        return authority

    def _check_context(self, statement, context):
        require(type(context) is SessionContext and context.principal_sha256 == statement['principalSha256']
                and context.owner_sha256 == statement['ownerSha256'] and
                context.session_id == statement['sessionId'], 'context_changed')

    def check(self, authority, boundary, *, lane, context, identity_sha256):
        """Currentness/revocation/context check at a pre-dispatch, phase or final boundary."""
        require(type(authority) is SessionAuthority and self._issued.get(id(authority)) is authority
                and authority._verifier is self, 'authority_unregistered')
        require(not authority._closed, 'authority_closed')
        require(boundary in BOUNDARIES, 'boundary_unknown')
        statement = authority._statement
        require(authority._digest not in self._revoked, 'authorization_revoked')
        require(lane in statement['lanes'], 'lane_not_authorized')
        require(identity_sha256 == statement['identitySha256'], 'identity_mismatch')
        self._check_context(statement, context)
        wall, mono = self._clock()
        elapsed_ms = max(0, mono - authority._mono0) // 1_000_000
        require(wall >= authority._wall0 and wall < statement['expiresAtMs'] and
                authority._wall0 + elapsed_ms < statement['expiresAtMs'], 'authorization_expired')
        if boundary == 'final':
            object.__setattr__(authority, '_closed', True)
        return True


def production_verifier(ledger):
    """The only non-test constructor. With an empty trust root it always refuses."""
    if not PRODUCTION_TRUST_ROOT:
        raise Refusal('no_trust_root')
    keys = {fp: Ed25519PublicKey.from_public_bytes(bytes.fromhex(raw)) for fp, raw in PRODUCTION_TRUST_ROOT}
    return AuthorityVerifier(keys, ledger)
