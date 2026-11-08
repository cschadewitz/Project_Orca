"""Exact-session authority from an independently signed exact-run authorization.

Authority is never created from a caller-supplied object, digest, boolean,
environment variable, action id or fixture. It requires an Ed25519 signature
by a key whose fingerprint is in the verifier's trust root, over a statement
that binds the frozen run plan (hashed by the verifier from its bytes), the
exact identity tuple (measured by the verifier through a trusted measurement
function, never supplied by the caller), one designated consumption ledger,
session, principal, owner, lanes and a short validity window.

Ordering (no circular definitions):
  1. the pre-authorization identity tuple is measured first and contains no
     session, plan, authorization or envelope field;
  2. the frozen plan names that identity digest;
  3. the signed statement binds the pre-authorization identity (its digest,
     re-measured by the verifier at verify and every check), the plan digest
     and the designated ledger id;
  4. after verification, the verifier issues the outer run envelope, which
     names the identity digest, the plan digest, the consumed statement digest,
     the ledger and the session. Evidence cites the envelope digest. Nothing in
     steps 1-3 depends on a later step, so every digest can be computed.

Single use and revocation are durable in the designated ledger directory: a
statement names that ledger's id, so a fresh directory cannot accept it, and
signed revocations are written there and re-read and re-verified at every
check by every verifier that uses the ledger.

The returned SessionAuthority is an opaque handle. Every decision uses the
verifier's private record of the original statement bytes, so writing to the
handle's attributes changes nothing.

PRODUCTION_TRUST_ROOT is deliberately empty: no key is trusted by this source,
so production_verifier() refuses every authorization.

Trust assumptions and open gaps: the signer's private key is held outside this
host; the Python interpreter, the cryptography package and same-process code
are trusted (code in this process can still reach the verifier's private
record); the ledger directory's host is trusted not to delete consumption or
revocation records; delivery of a revocation to a ledger on another host is
not implemented; host clocks are trusted.
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
from identity import validate as validate_identity
from reasons import Refusal, require

DOMAIN = b'orca-guard-exact-run-authorization-v1\0'
ENVELOPE_DOMAIN = b'orca-guard-run-envelope-v1\0'
REVOCATION_DOMAIN = b'orca-guard-exact-run-revocation-v1\0'
# fingerprint -> raw Ed25519 public key hex. Empty: nothing is trusted.
PRODUCTION_TRUST_ROOT = ()
BOUNDARIES = ('pre-dispatch', 'phase', 'final')
STATEMENT_KEYS = frozenset(('version', 'planSha256', 'identitySha256', 'sessionId', 'nonce',
                            'issuedAtMs', 'notBeforeMs', 'expiresAtMs', 'lanes', 'principalSha256',
                            'ownerSha256', 'keyFingerprint', 'ledgerSha256'))
_HEX64 = re.compile(r'[0-9a-f]{64}')
_HEX32 = re.compile(r'[0-9a-f]{32}')
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
MAX_REVOCATIONS = 64


def fingerprint(public_key):
    return hashlib.sha256(public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)).hexdigest()


def _unique_pairs(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise Refusal('authorization_malformed')
    return dict(pairs)


def _parse_statement(data):
    require(type(data) is bytes, 'authorization_malformed')
    require(len(data) <= AUTHORIZATION_STATEMENT_LIMIT, 'authorization_oversize')
    try:
        value = json.loads(data.decode('ascii'), parse_constant=lambda _: None, object_pairs_hook=_unique_pairs)
    except (UnicodeDecodeError, ValueError, Refusal):
        raise Refusal('authorization_malformed') from None
    require(type(value) is dict and set(value) == STATEMENT_KEYS, 'authorization_malformed')
    require(canonical(value) == data, 'authorization_malformed')  # exactly one encoding
    ints = ('issuedAtMs', 'notBeforeMs', 'expiresAtMs')
    require(type(value['version']) is int and value['version'] == 1 and
            all(type(value[k]) is int and 0 < value[k] < 2 ** 53 for k in ints) and
            all(type(value[k]) is str and _HEX64.fullmatch(value[k]) for k in
                ('planSha256', 'identitySha256', 'principalSha256', 'ownerSha256', 'keyFingerprint',
                 'ledgerSha256')) and
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


def _parse_revocation(data):
    require(type(data) is bytes and len(data) <= 256, 'authorization_malformed')
    try:
        value = json.loads(data.decode('ascii'), object_pairs_hook=_unique_pairs)
    except (UnicodeDecodeError, ValueError, Refusal):
        raise Refusal('authorization_malformed') from None
    require(type(value) is dict and set(value) == {'revokes', 'keyFingerprint'} and
            type(value['revokes']) is str and _HEX64.fullmatch(value['revokes']) and
            type(value['keyFingerprint']) is str and canonical(value) == data, 'authorization_malformed')
    return value


class ConsumptionLedger:
    """The one designated durable ledger: consumption records and signed revocations.

    create() makes a fresh designated id exactly once; opening requires it. All
    checks are made on the opened descriptor (no path check-then-open race).
    """

    def __init__(self, directory, _create=False):
        try:
            fd = os.open(directory, _DIR_FLAGS)
        except OSError:
            raise Refusal('ledger_unavailable') from None
        try:
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
                    stat.S_IMODE(info.st_mode) == 0o700, 'ledger_unavailable')
            if _create:
                try:
                    self._write_exclusive(fd, 'ledger-id', os.urandom(16).hex().encode())
                except FileExistsError:
                    raise Refusal('ledger_unavailable') from None
            self.ledger_sha256 = hashlib.sha256(b'orca-guard-ledger-v1\0' +
                                                self._read(fd, 'ledger-id', 32)).hexdigest()
        except BaseException:
            os.close(fd)
            raise
        self._dir = fd

    @classmethod
    def create(cls, directory):
        return cls(directory, _create=True)

    @staticmethod
    def _write_exclusive(dir_fd, name, data):
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
                         dir_fd=dir_fd)
        except FileExistsError:
            raise
        except OSError:
            raise Refusal('ledger_unavailable') from None
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(dir_fd)

    @staticmethod
    def _read(dir_fd, name, exact=None, limit=512):
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dir_fd)
        except OSError:
            raise Refusal('ledger_unavailable') from None
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                    stat.S_IMODE(info.st_mode) & 0o077 == 0 and info.st_size <= limit, 'ledger_unavailable')
            data = os.read(fd, limit + 1)
        finally:
            os.close(fd)
        require(len(data) <= limit and (exact is None or len(data) == exact), 'ledger_unavailable')
        if exact is not None:
            require(_HEX32.fullmatch(data.decode('ascii', 'replace')) is not None, 'ledger_unavailable')
        return data

    def _fd(self):
        require(self._dir is not None, 'ledger_unavailable')
        return self._dir

    def consume(self, statement_digest):
        try:
            self._write_exclusive(self._fd(), 'used-' + statement_digest, b'')
        except FileExistsError:
            raise Refusal('authorization_replayed') from None

    def record_revocation(self, revocation_bytes, signature):
        name = 'revoked-' + hashlib.sha256(revocation_bytes).hexdigest()
        try:
            self._write_exclusive(self._fd(), name, json.dumps(
                {'statement': revocation_bytes.decode('ascii'), 'signature': signature.hex()}).encode())
        except FileExistsError:
            pass

    def revocations(self):
        """Every stored revocation, re-read from disk on each call."""
        try:
            names = [n for n in os.listdir(self._fd()) if n.startswith('revoked-')]
        except OSError:
            raise Refusal('ledger_unavailable') from None
        require(len(names) <= MAX_REVOCATIONS, 'ledger_unavailable')
        out = []
        for name in names:
            try:
                record = json.loads(self._read(self._fd(), name))
                data, signature = record['statement'].encode('ascii'), bytes.fromhex(record['signature'])
            except (ValueError, KeyError, TypeError, AttributeError, UnicodeError):
                raise Refusal('ledger_unavailable') from None
            require(name == 'revoked-' + hashlib.sha256(data).hexdigest(), 'ledger_unavailable')
            out.append((data, signature))
        return out

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
    """Opaque handle. Not serializable, copyable or constructible; carries no decision state."""
    __slots__ = ('_verifier', '_digest', '__weakref__')

    def __init__(self, *_args, **_kwargs):
        raise Refusal('authority_unregistered')

    def __setattr__(self, _name, _value):
        raise AttributeError('SessionAuthority is immutable')

    def __reduce_ex__(self, _protocol):
        raise Refusal('authority_copied')

    def __copy__(self):
        raise Refusal('authority_copied')

    def __deepcopy__(self, _memo):
        raise Refusal('authority_copied')

    def __repr__(self):
        return 'SessionAuthority(<opaque>)'


class _Record:
    __slots__ = ('handle', 'statement_bytes', 'digest', 'wall0', 'mono0')

    def __init__(self, handle, statement_bytes, digest, wall0, mono0):
        self.handle, self.statement_bytes, self.digest = handle, statement_bytes, digest
        self.wall0, self.mono0 = wall0, mono0


class AuthorityVerifier:
    def __init__(self, trust_root, ledger, measure_identity, clock=None):
        require(type(trust_root) is dict and trust_root and all(
            type(k) is str and _HEX64.fullmatch(k) and isinstance(v, Ed25519PublicKey) and fingerprint(v) == k
            for k, v in trust_root.items()), 'no_trust_root')
        require(isinstance(ledger, ConsumptionLedger), 'ledger_unavailable')
        require(callable(measure_identity), 'identity_incomplete')
        self._keys = dict(trust_root)
        self._ledger = ledger
        self._measure = measure_identity
        self._issued = {}
        self._closed = set()
        self._log = []
        self._clock = clock or (lambda: (time.time_ns() // 1_000_000, time.monotonic_ns()))

    def _identity_digest(self):
        return validate_identity(self._measure())

    def _revoked(self):
        revoked = set()
        for data, signature in self._ledger.revocations():
            try:
                value = _parse_revocation(data)
            except Refusal:
                raise Refusal('ledger_unavailable') from None
            key = self._keys.get(value['keyFingerprint'])
            require(key is not None, 'ledger_unavailable')
            try:
                key.verify(signature, REVOCATION_DOMAIN + data)
            except (InvalidSignature, TypeError, ValueError):
                raise Refusal('ledger_unavailable') from None
            revoked.add(value['revokes'])
        return revoked

    def revoke(self, revocation_bytes, signature):
        """Verify a signed revocation and store it durably in the designated ledger."""
        value = _parse_revocation(revocation_bytes)
        key = self._keys.get(value['keyFingerprint'])
        require(key is not None, 'key_untrusted')
        try:
            key.verify(signature, REVOCATION_DOMAIN + revocation_bytes)
        except (InvalidSignature, TypeError, ValueError):
            raise Refusal('signature_invalid') from None
        self._ledger.record_revocation(revocation_bytes, signature)

    def verify(self, statement_bytes, signature, *, plan_bytes, context):
        """Verify and consume one exact-run authorization; return an opaque handle."""
        require(self._keys, 'no_trust_root')
        statement = _parse_statement(statement_bytes)
        key = self._keys.get(statement['keyFingerprint'])
        require(key is not None, 'key_untrusted')
        require(type(signature) is bytes and len(signature) == 64, 'signature_invalid')
        try:
            key.verify(signature, DOMAIN + statement_bytes)
        except (InvalidSignature, TypeError, ValueError):
            raise Refusal('signature_invalid') from None
        digest = hashlib.sha256(DOMAIN + statement_bytes).hexdigest()
        require(statement['ledgerSha256'] == self._ledger.ledger_sha256, 'ledger_mismatch')
        require(digest not in self._revoked(), 'authorization_revoked')
        require(type(plan_bytes) is bytes and hashlib.sha256(plan_bytes).hexdigest() == statement['planSha256'],
                'plan_mismatch')
        require(self._identity_digest() == statement['identitySha256'], 'identity_mismatch')
        self._check_context(statement, context)
        wall, mono = self._clock()
        require(wall >= statement['notBeforeMs'], 'authorization_not_yet_valid')
        require(wall < statement['expiresAtMs'], 'authorization_expired')
        self._ledger.consume(digest)
        handle = object.__new__(SessionAuthority)
        object.__setattr__(handle, '_verifier', self)
        object.__setattr__(handle, '_digest', digest)
        self._issued[id(handle)] = _Record(handle, bytes(statement_bytes), digest, wall, mono)
        return handle

    @staticmethod
    def _check_context(statement, context):
        require(type(context) is SessionContext and context.principal_sha256 == statement['principalSha256']
                and context.owner_sha256 == statement['ownerSha256'] and
                context.session_id == statement['sessionId'], 'context_changed')

    def _record(self, handle):
        record = self._issued.get(id(handle))
        require(type(handle) is SessionAuthority and record is not None and record.handle is handle,
                'authority_unregistered')
        return record

    def statement_sha256(self, handle):
        return self._record(handle).digest

    def check(self, handle, boundary, *, lane, context, invocation_id=None):
        """Currentness, revocation, identity and context check at a named boundary."""
        record = self._record(handle)
        require(record.digest not in self._closed, 'authority_closed')
        require(boundary in BOUNDARIES, 'boundary_unknown')
        statement = _parse_statement(record.statement_bytes)
        require(record.digest not in self._revoked(), 'authorization_revoked')
        require(lane in statement['lanes'], 'lane_not_authorized')
        require(self._identity_digest() == statement['identitySha256'], 'identity_mismatch')
        self._check_context(statement, context)
        wall, mono = self._clock()
        elapsed_ms = max(0, mono - record.mono0) // 1_000_000
        require(wall >= record.wall0 and wall < statement['expiresAtMs'] and
                record.wall0 + elapsed_ms < statement['expiresAtMs'], 'authorization_expired')
        if boundary == 'final':
            self._closed.add(record.digest)
        self._log.append({'kind': 'authority.checked', 'boundary': boundary,
                          'phase': 'session' if boundary == 'final' else lane, 'invocationId': invocation_id,
                          'statementSha256': record.digest, 't': mono})
        return True

    def run_envelope(self, handle):
        """Outer run envelope bytes for a verified session, computed after verification.

        Refuses unless the re-measured pre-authorization identity still equals
        the identity the signed statement binds. The envelope grants nothing;
        it only names what was verified, so it stays computable after 'final'.
        """
        record = self._record(handle)
        statement = _parse_statement(record.statement_bytes)
        require(self._identity_digest() == statement['identitySha256'], 'identity_mismatch')
        return canonical({'version': 1, 'record': 'orca-guard-run-envelope',
                          'identitySha256': statement['identitySha256'], 'planSha256': statement['planSha256'],
                          'statementSha256': record.digest, 'ledgerSha256': statement['ledgerSha256'],
                          'sessionId': statement['sessionId']})

    def check_envelope(self, handle, envelope_bytes):
        """Return the envelope digest only if the bytes are exactly this session's envelope."""
        require(type(envelope_bytes) is bytes and envelope_bytes == self.run_envelope(handle),
                'run_envelope_mismatch')
        return envelope_sha256(envelope_bytes)

    def supervisor_records(self):
        """Copies of this verifier's own check log, for journal correspondence."""
        return [dict(item) for item in self._log]


def envelope_sha256(envelope_bytes):
    return hashlib.sha256(ENVELOPE_DOMAIN + envelope_bytes).hexdigest()


def production_verifier(ledger, measure_identity):
    """The only non-test constructor. With an empty trust root it always refuses."""
    if not PRODUCTION_TRUST_ROOT:
        raise Refusal('no_trust_root')
    keys = {fp: Ed25519PublicKey.from_public_bytes(bytes.fromhex(raw)) for fp, raw in PRODUCTION_TRUST_ROOT}
    return AuthorityVerifier(keys, ledger, measure_identity)
