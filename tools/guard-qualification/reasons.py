"""Allowlisted public reason codes, bounded public summaries and private evidence.

Public output never contains raw exception text, paths, payloads or caller
strings. A refusal carries only a code from REASONS; anything else becomes
'unlisted_reason'. Raw material goes to PrivateEvidence, which is bounded,
owner-only and reported publicly only by size and SHA-256.
"""
import hashlib
import os
import re
import stat

from bounds import PRIVATE_EVIDENCE_LIMIT, REPORT_LIMIT

REASONS = frozenset((
    'unlisted_reason',
    # identity
    'identity_incomplete', 'identity_malformed', 'identity_drift', 'identity_unknown_field',
    'source_unavailable', 'source_dirty', 'route_unsupported',
    # authority
    'no_trust_root', 'authorization_malformed', 'authorization_oversize', 'signature_invalid',
    'key_untrusted', 'authorization_not_yet_valid', 'authorization_expired',
    'authorization_lifetime_exceeded', 'authorization_replayed', 'authorization_revoked',
    'authority_unregistered', 'authority_copied', 'context_changed', 'plan_mismatch',
    'identity_mismatch', 'lane_not_authorized', 'boundary_unknown', 'authority_closed',
    'ledger_unavailable',
    # ownership / cleanup
    'supervisor_not_dedicated', 'sigchld_ignored', 'pidfd_unavailable', 'acquisition_failed',
    'resource_budget_exceeded', 'cleanup_failed', 'cleanup_uncertain', 'process_unsettled',
    'descendant_unsettled', 'ledger_closed', 'body_failed', 'preserved_unsettled',
    # containment
    'containment_unavailable', 'containment_namespace_shared', 'containment_network',
    'containment_fd_inherited', 'containment_env', 'containment_path_visible',
    'containment_root_writable', 'containment_workspace', 'containment_preflight_failed',
    'containment_startup_failed', 'containment_spec_invalid',
    # loaded code
    'loader_manifest_invalid', 'loader_digest_mismatch', 'loader_module_unlisted',
    'loader_builtin_denied', 'loader_symlink', 'loader_format_unknown', 'loader_failed',
    # journal / replay
    'journal_malformed', 'journal_oversize', 'journal_unknown_kind', 'journal_field',
    'journal_order', 'journal_incomplete', 'journal_duplicate', 'journal_attribution',
    'journal_effect_unattributed', 'journal_effect_mismatch', 'journal_timing',
    'journal_authority_check_missing', 'journal_count', 'journal_settlement', 'journal_input_changed',
    'journal_unexpected_mutation',
    # composition
    'prerequisite_missing', 'live_observation_not_authorized',
))

_HEX64 = re.compile(r'[0-9a-f]{64}')
_SAFE_KEYS = frozenset((
    'record', 'status', 'reason', 'stage', 'phase', 'lane', 'count', 'attempted', 'failed',
    'bytes', 'sha256', 'evidenceClass', 'loadedImageVerified', 'answersRecorded',
    'nativeDeliveries', 'executionsStarted', 'executionsCompleted', 'effectsObserved',
    'targetReads', 'decision', 'records', 'clean'))
EVIDENCE_CLASSES = frozenset(('implemented', 'simulated', 'observed', 'production-qualified'))


class Refusal(Exception):
    """A fail-closed refusal whose only public content is an allowlisted code."""

    def __init__(self, code):
        code = code if type(code) is str and code in REASONS else 'unlisted_reason'
        super().__init__(code)
        self.code = code

    def __str__(self):
        return self.code

    def __repr__(self):
        return 'Refusal(%r)' % self.code


def require(condition, code):
    if not condition:
        raise Refusal(code)


def code_of(error):
    """Map any exception to a public code without reading its message."""
    return error.code if isinstance(error, Refusal) else 'unlisted_reason'


def _safe_value(key, value):
    if type(value) is bool:
        return value
    if type(value) is int:
        return -(2 ** 53) < value < 2 ** 53
    if type(value) is str:
        if key == 'sha256':
            return _HEX64.fullmatch(value) is not None
        if key == 'reason':
            return value in REASONS
        if key == 'evidenceClass':
            return value in EVIDENCE_CLASSES
        return value in REASONS or re.fullmatch(r'[a-z][a-z0-9-]{0,47}', value) is not None
    return value is None


def public_summary(**fields):
    """Return a bounded public summary. Callers cannot set authority or eligibility fields."""
    for key, value in fields.items():
        require(key in _SAFE_KEYS and _safe_value(key, value), 'unlisted_reason')
    require(fields.get('evidenceClass', 'implemented') != 'production-qualified', 'unlisted_reason')
    summary = dict(fields)
    summary.update(authority='none', productionEligible=False, observationAuthorized=False,
                   qualified=False)
    return summary


class PrivateEvidence:
    """Owner-only bounded evidence directory; content never enters public output."""

    def __init__(self, directory, limit=PRIVATE_EVIDENCE_LIMIT):
        require(type(limit) is int and 0 < limit <= PRIVATE_EVIDENCE_LIMIT, 'resource_budget_exceeded')
        info = os.lstat(directory)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
                stat.S_IMODE(info.st_mode) == 0o700, 'acquisition_failed')
        self._dir = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self._limit, self._used, self._names = limit, 0, set()

    def close(self):
        if self._dir is not None:
            fd, self._dir = self._dir, None
            os.close(fd)

    def write(self, name, data):
        require(self._dir is not None, 'ledger_closed')
        require(type(data) is bytes and re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,63}', name or '') is not None
                and name not in self._names, 'acquisition_failed')
        require(len(data) <= REPORT_LIMIT and self._used + len(data) <= self._limit,
                'resource_budget_exceeded')
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=self._dir)
        except OSError:
            raise Refusal('acquisition_failed') from None
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        self._names.add(name)
        self._used += len(data)
        return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
