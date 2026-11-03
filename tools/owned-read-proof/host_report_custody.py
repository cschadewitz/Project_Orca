"""Native, single-threaded custody of ONE existing private report artifact.

This implements only the report-artifact part of G4 S4-S9/G7; it does not
discharge whole-attempt custody, S0 readiness, or independent authorization.

This is a filesystem component for a later trusted host controller, not an issuer,
launcher, session grant, transport, report parser or observer adapter. A caller
retains the original object before calling reserve() with a preopened private
0700 directory FD. The constructor acquires nothing. All acquisitions have slots
before their first effect; the caller's descriptors are borrowed and never closed.

reserve() physically preallocates the existing REPORT_LIMIT (1 MiB) on one inode
before a delegate/report exists. publish() consumes one attempt to copy the fixed
lane report from a regular FD and its preopened source directory. It checks the
complete source size/hash/correspondence before the first payload write. The
pending and final names are hard-link aliases of that SAME inode, never two data
copies. At most two links are allowed; unknown aliases/substitution refuse. The
pending alias is deliberately retained, including after successful publication.
The inode is truncated to the exact report size only after the complete copy.
No journal, extra data-file budget, metadata allowance or trace capacity is used.
Filesystem metadata/rounding and the source report's existing allocation still
need an operator-reviewed quota; fallocate is not a whole-filesystem quota.

Ordering is allocation + file/directory sync, then complete copy + verification,
read-only mode + file sync + close, create-only link + directory sync, then local
acknowledgment. Any failure retains the first original exception privately and
makes uncertainty absorbing. No unlink, replacement, replay or automatic retry
exists. close() consumes each owned FD once even if close raises. A lost process
cannot reconstruct ownership or an acknowledgment from visible bytes. Read-only
reconciliation reports observations, never acceptance, durable-media proof,
process settlement, a receipt, or permission to execute.

Native UID/mode/FD checks do not authenticate Casey, protect against a hostile
same-UID process/root, or establish a session. The later console-operated host
controller, named principal, exact host path, private readers/export/retention,
existing quota and protection from guest snapshots need separate setup review.
No path is selected or installed here. Host disk loss remains an operator policy
choice. Source identity checks detect observed changes, not hostile-owner races.
"""
import fcntl
import hashlib
import os
import stat
import threading
from dataclasses import dataclass


# Same existing report ceiling, deliberately independent of original metadata,
# trace, runtime-source and compact-association limits. No observer import.
REPORT_LIMIT = 1024 * 1024
_COPY_CHUNK = 65536
_NAMES = {'bootstrap': ('bootstrap-attempt.json', '.bootstrap-attempt.json.pending'),
          'connected': ('connected-attempt.json', '.connected-attempt.json.pending')}
_PUBLIC_ERROR = 'private report custody unavailable'


class CustodyError(RuntimeError):
    """Fixed public failure; contains no OS exception, FD, pathname or report."""

    def __init__(self):
        super().__init__(_PUBLIC_ERROR)


class _CheckFailure(Exception):
    pass


def _check(condition, code):
    if not condition:
        raise _CheckFailure(code)


def _identity(info):
    return info.st_dev, info.st_ino


def _content_stamp(info):
    # Link creation and chmod deliberately change ctime/nlink/mode. Payload
    # writes must not change this retained identity/size/mtime correspondence.
    return _identity(info), info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns


def _stamp(info):
    return (_identity(info), info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class _FD:
    __slots__ = ('value',)

    def __init__(self):
        self.value = None


@dataclass(frozen=True)
class CustodyOutcome:
    """Only fixed codes/booleans. An acknowledgment is local historical knowledge."""
    state: str
    known_acknowledged: bool
    closed: bool
    first_failure_phase: str
    first_failure_code: str


@dataclass(frozen=True)
class ReportSnapshot:
    """Read observations only; visibility never establishes an acknowledgment."""
    pending_present: bool
    final_present: bool
    original_inode_observed: bool
    aliases_valid: bool
    complete_bytes_observed: bool
    known_acknowledged: bool


class HostReportCustody:
    """Retain this original owner; call reserve before any report-producing delegate.

    Public methods are synchronous and restricted to the constructing thread.
    publish() accepts native descriptors and bounded scalar expectations only.
    A fresh owner may reconcile(directory_fd) for read-only inspection; that owner
    is permanently unable to reserve/publish and gains no original association.
    """
    __slots__ = ('_thread', '_pid', '_busy', '_state', '_closed', '_lane', '_final', '_pending',
                 '_root', '_report', '_source', '_source_root', '_root_identity',
                 '_inode', '_source_stamp', '_content_stamp', '_expected_size', '_expected_digest',
                 '_first_failure', '_first_phase', '_first_code', '_acknowledged')

    def __init__(self, lane):
        # No native resource is acquired in this constructor. Even a failure in
        # reserve leaves a returned owner with every acquisition slot registered.
        if type(lane) is not str or lane not in _NAMES:
            raise CustodyError()
        self._thread, self._pid, self._busy = threading.current_thread(), os.getpid(), False
        self._state, self._closed, self._lane = 'new', False, lane
        self._final, self._pending = _NAMES[lane]
        self._root, self._report, self._source, self._source_root = _FD(), _FD(), _FD(), _FD()
        self._root_identity = self._inode = self._source_stamp = self._content_stamp = None
        self._expected_size = self._expected_digest = None
        self._first_failure = None
        self._first_phase = self._first_code = 'none'
        self._acknowledged = False

    def __repr__(self):
        return '<HostReportCustody>'

    def __reduce_ex__(self, protocol):
        raise TypeError('private report custody cannot be serialized')

    def __getstate__(self):
        raise TypeError('private report custody cannot be serialized')

    def _enter(self):
        if (os.getpid() != self._pid or threading.current_thread() is not self._thread or
                self._busy or self._closed):
            raise CustodyError()
        self._busy = True

    def _note(self, error, phase):
        # Identity, not truthiness: a private error may have hostile __bool__.
        if self._first_failure is None:
            self._first_failure = error
            self._first_phase = phase
            self._first_code = error.args[0] if type(error) is _CheckFailure else 'native-failure'
        self._state = 'uncertain'

    def _close_slot(self, slot):
        descriptor, slot.value = slot.value, None  # Consume BEFORE native close.
        if descriptor is not None:
            try:
                os.close(descriptor)
            except BaseException as error:
                self._note(error, 'close')
                return False
        return True

    @staticmethod
    def _duplicate(slot, descriptor):
        _check(type(descriptor) is int and descriptor >= 0, 'descriptor')
        slot.value = os.dup(descriptor)  # Registered before any later fallible call.
        _check(not os.get_inheritable(slot.value), 'protection')

    def _bind(self, directory_fd):
        self._duplicate(self._root, directory_fd)
        info = os.fstat(self._root.value)
        self._root_identity = _identity(info)
        self._check_root()

    def _check_root(self):
        info = os.fstat(self._root.value)
        flags = fcntl.fcntl(self._root.value, fcntl.F_GETFL)
        _check(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) == 0o700 and
               _identity(info) == self._root_identity and
               flags & os.O_ACCMODE == os.O_RDONLY and
               not flags & getattr(os, 'O_PATH', 0), 'protection')

    @staticmethod
    def _entry(directory_fd, name):
        try:
            return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def _report_info(self, info, links, mode, size=None):
        _check(info is not None and stat.S_ISREG(info.st_mode) and
               _identity(info) == self._inode and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) == mode and info.st_nlink == links and
               0 <= info.st_size <= REPORT_LIMIT and
               (size is None or info.st_size == size) and
               (self._content_stamp is None or _content_stamp(info) == self._content_stamp),
               'destination-changed')

    def _aliases(self, links, mode, size=None):
        self._check_root()
        pending = self._entry(self._root.value, self._pending)
        final = self._entry(self._root.value, self._final)
        self._report_info(pending, links, mode, size)
        if self._report.value is not None:
            self._report_info(os.fstat(self._report.value), links, mode, size)
        if links == 1:
            _check(final is None, 'destination-exists')
        else:
            self._report_info(final, links, mode, size)
            _check(_stamp(final) == _stamp(pending), 'destination-changed')

    def reserve(self, directory_fd):
        """Allocate/sync one 1 MiB report inode under the borrowed private root FD.

        The exact existing bound is checked before allocation, independently of
        the not-yet-created report. No payload is accepted by this operation.
        """
        self._enter()
        phase = 'bind'
        failed = False
        try:
            _check(self._state == 'new', 'consumed')
            self._state = 'reserving'
            self._bind(directory_fd)
            phase = 'reserve'
            _check(REPORT_LIMIT == 1048576 and callable(getattr(os, 'posix_fallocate', None)) and
                   hasattr(os, 'O_NOFOLLOW'), 'unsupported')
            _check(self._entry(self._root.value, self._final) is None and
                   self._entry(self._root.value, self._pending) is None, 'destination-exists')
            self._report.value = os.open(self._pending, os.O_RDWR | os.O_CREAT | os.O_EXCL |
                                         os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
                                         dir_fd=self._root.value)
            self._inode = _identity(os.fstat(self._report.value))
            self._aliases(1, 0o600, 0)
            # Actual OS reservation; unsupported/ENOSPC/etc. is terminal. No
            # sparse truncate, zero-fill, memory buffer or allocation fallback.
            os.posix_fallocate(self._report.value, 0, REPORT_LIMIT)
            self._aliases(1, 0o600, REPORT_LIMIT)
            os.fsync(self._report.value)
            os.fsync(self._root.value)
            self._aliases(1, 0o600, REPORT_LIMIT)
            self._state = 'reserved'
        except BaseException as error:
            self._note(error, phase)
            failed = True
        finally:
            if failed:
                self._close_slot(self._report)
            self._busy = False
        # Raise outside the handler: no private exception context/cause escapes.
        if failed:
            raise CustodyError()
        return self.outcome()

    def _source_info(self):
        fd_info = os.fstat(self._source.value)
        path_info = self._entry(self._source_root.value, self._final)
        _check(stat.S_ISREG(fd_info.st_mode) and fd_info.st_nlink == 1 and
               fd_info.st_size == self._expected_size and
               _identity(fd_info) != self._inode and path_info is not None and
               _stamp(fd_info) == _stamp(path_info), 'source-changed')
        if self._source_stamp is not None:
            _check(_stamp(fd_info) == self._source_stamp, 'source-changed')
        return _stamp(fd_info)

    @staticmethod
    def _hash_fd(descriptor, size):
        digest, offset = hashlib.sha256(), 0
        while offset < size:
            amount = min(_COPY_CHUNK, size - offset)
            chunk = os.pread(descriptor, amount, offset)
            _check(type(chunk) is bytes and 0 < len(chunk) <= amount, 'source-changed')
            digest.update(chunk)
            offset += len(chunk)
        _check(os.pread(descriptor, 1, size) == b'', 'source-changed')
        return digest.hexdigest()

    def _copy(self):
        offset, digest = 0, hashlib.sha256()
        while offset < self._expected_size:
            amount = min(_COPY_CHUNK, self._expected_size - offset)
            chunk = os.pread(self._source.value, amount, offset)
            _check(type(chunk) is bytes and 0 < len(chunk) <= amount, 'source-changed')
            digest.update(chunk)
            written = 0
            while written < len(chunk):
                _check(0 <= offset + written < offset + len(chunk) <=
                       self._expected_size <= REPORT_LIMIT, 'size')
                count = os.pwrite(self._report.value, chunk[written:], offset + written)
                _check(type(count) is int and 0 < count <= len(chunk) - written, 'write-progress')
                written += count  # Positive short writes are valid progress.
            offset += len(chunk)
        _check(os.pread(self._source.value, 1, self._expected_size) == b'' and
               digest.hexdigest() == self._expected_digest, 'source-changed')
        self._source_info()

    def publish(self, source_fd, source_directory_fd, expected_size, expected_sha256):
        """Consume one publication attempt for the fixed existing lane filename.

        Scalar/type/size, regular-file/path identity and a complete bounded hash
        precede every payload write. Borrowed FD offsets are never changed.
        Expected bytes/digest identify an artifact; they grant no authority.
        """
        self._enter()
        phase, failed = 'source', False
        try:
            _check(self._state == 'reserved', 'consumed')
            self._state = 'publishing'
            _check(type(expected_size) is int and 0 <= expected_size <= REPORT_LIMIT and
                   type(expected_sha256) is str and len(expected_sha256) == 64 and
                   all(c in '0123456789abcdef' for c in expected_sha256), 'size')
            self._expected_size, self._expected_digest = expected_size, expected_sha256
            self._duplicate(self._source_root, source_directory_fd)
            _check(stat.S_ISDIR(os.fstat(self._source_root.value).st_mode), 'descriptor')
            self._duplicate(self._source, source_fd)
            flags = fcntl.fcntl(self._source.value, fcntl.F_GETFL)
            _check(flags & os.O_ACCMODE == os.O_RDONLY and
                   not flags & getattr(os, 'O_PATH', 0), 'descriptor')
            self._source_stamp = self._source_info()
            _check(self._hash_fd(self._source.value, expected_size) == expected_sha256, 'source-changed')
            self._source_info()
            self._aliases(1, 0o600, REPORT_LIMIT)
            phase = 'copy'
            self._copy()
            self._aliases(1, 0o600, REPORT_LIMIT)
            os.ftruncate(self._report.value, expected_size)
            self._content_stamp = _content_stamp(os.fstat(self._report.value))
            _check(self._hash_fd(self._report.value, expected_size) == expected_sha256, 'destination-changed')
            self._aliases(1, 0o600, expected_size)
            phase = 'seal'
            os.fchmod(self._report.value, 0o400)
            self._aliases(1, 0o400, expected_size)
            os.fsync(self._report.value)
            # All per-publication handles close before a local acknowledgment.
            # No writable descriptor remains when the final alias is created.
            self._close_slot(self._source)
            self._close_slot(self._source_root)
            self._close_slot(self._report)
            _check(self._state != 'uncertain', 'close-failed')
            phase = 'publish'
            self._aliases(1, 0o400, expected_size)
            os.link(self._pending, self._final, src_dir_fd=self._root.value,
                    dst_dir_fd=self._root.value, follow_symlinks=False)
            self._aliases(2, 0o400, expected_size)
            phase = 'directory-sync'
            os.fsync(self._root.value)
            self._aliases(2, 0o400, expected_size)
            self._acknowledged, self._state = True, 'acknowledged'
        except BaseException as error:
            self._note(error, phase)
            failed = True
        finally:
            self._close_slot(self._source)
            self._close_slot(self._source_root)
            # On any failure no further payload write is possible.
            self._close_slot(self._report)
            self._busy = False
        if failed:
            raise CustodyError()
        return self.outcome()

    def reconcile(self, directory_fd=None):
        """Read pending/final snapshots without changing files or known uncertainty.

        A new process may bind a preopened root for inspection only. Its visible
        complete report never becomes an acknowledgment or original ownership.
        """
        self._enter()
        result, failed, close_failed = None, False, False
        try:
            if self._state == 'new':
                self._state = 'inspection'
                self._bind(directory_fd)
            else:
                _check(directory_fd is None and self._root.value is not None, 'consumed')
            self._check_root()
            pending = self._entry(self._root.value, self._pending)
            final = self._entry(self._root.value, self._final)
            original = (pending is not None and self._inode is not None and
                        _identity(pending) == self._inode)
            links = 2 if final is not None else 1
            mode = 0o400 if final is not None else None
            aliases = (pending is not None and stat.S_ISREG(pending.st_mode) and
                       pending.st_uid == os.geteuid() and pending.st_nlink == links and
                       0 <= pending.st_size <= REPORT_LIMIT and
                       stat.S_IMODE(pending.st_mode) in (0o400, 0o600) and
                       (mode is None or stat.S_IMODE(pending.st_mode) == mode) and
                       (final is None or _stamp(pending) == _stamp(final)))
            complete = False
            if aliases:
                self._source.value = os.open(self._pending, os.O_RDONLY | os.O_NOFOLLOW |
                                             os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self._root.value)
                _check(_stamp(os.fstat(self._source.value)) == _stamp(pending), 'destination-changed')
                # Only the retained original knows the expected bytes. A restarted
                # inspector observes alias structure, never reconstructs that seal.
                observed = self._hash_fd(self._source.value, pending.st_size)
                complete = (original and self._expected_size == pending.st_size and
                            self._expected_digest == observed)
                _check(_stamp(os.fstat(self._source.value)) == _stamp(pending) and
                       _stamp(self._entry(self._root.value, self._pending)) == _stamp(pending) and
                       ((final is None and self._entry(self._root.value, self._final) is None) or
                        (final is not None and _stamp(self._entry(self._root.value, self._final)) ==
                         _stamp(final))), 'destination-changed')
            if self._inode is not None:
                _check(original and aliases, 'destination-changed')
                if self._acknowledged:
                    _check(complete and _content_stamp(pending) == self._content_stamp,
                           'destination-changed')
            result = ReportSnapshot(pending is not None, final is not None, original,
                                    aliases, complete, self._acknowledged)
        except BaseException as error:
            self._note(error, 'reconcile')
            failed = True
        finally:
            close_failed = not self._close_slot(self._source)
            self._busy = False
        if failed or close_failed:
            raise CustodyError()
        return result

    def outcome(self):
        """Fixed public projection, including a remembered acknowledgment after close."""
        if os.getpid() != self._pid or threading.current_thread() is not self._thread:
            raise CustodyError()
        return CustodyOutcome(self._state, self._acknowledged, self._closed,
                              self._first_phase, self._first_code)

    def close(self):
        """Close every owned FD once, continue eligible closes, never remove a file."""
        if self._closed:
            return self.outcome()
        self._enter()
        try:
            if self._state not in ('new', 'inspection', 'acknowledged', 'uncertain'):
                self._note(_CheckFailure('incomplete'), 'close')
            self._close_slot(self._source)
            self._close_slot(self._source_root)
            self._close_slot(self._report)
            self._close_slot(self._root)
            self._closed = True
            if self._state in ('new', 'inspection'):
                self._state = 'closed'
        finally:
            self._busy = False
        return self.outcome()
