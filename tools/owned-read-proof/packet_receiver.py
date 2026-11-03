"""Read-only native-FD verification of an independently declared uploaded set.

This is receiver byte integrity only: no host export, reconstruction, archives,
path recreation, report parsing, source acceptance, issuer authentication, session
or receipt capability. The caller must independently supply BOTH the exact index
SHA-256 and the entire expected inventory of opaque IDs, sizes and whole hashes.
Those expectations correlate data; they are not signatures or trusted-origin proof.
An index cannot nominate its own completeness or an expected digest.

Protocol: private preopened 0700 root, packet-index.v1, chunk-00000000.bin, etc.
The strict ASCII index is ORCA-UPLOAD-1 followed by, for each expected artifact in
increasing opaque-ID order, `A <id> <size> <sha256> <chunk-count>` and its ordered
`C <global-eight-digit-number> <offset> <size> <sha256>` lines. Every line ends
in LF; tokens have single spaces. Chunks are exactly 16 MiB except the last;
zero-byte artifacts have no chunks and SHA256(empty). No index field is a path.
File names are derived from checked independent counts, never supplied by index.
On Linux, O_PATH pins validate regular-file identity, owner, mode, size and the
original path before any read-open. A reader is opened only from the owned pin
through trusted local /proc/self/fd, never from the unvalidated uploaded name.
This initial reader reopen assumes the local process/procfs, not a remote host or
authenticated source; unsupported pin/procfd operation has no fallback.
Every directory entry, artifact and chunk must be accounted for, with distinct
regular-file inodes and no extra hard links. Index bytes are hashed before bounded
line decoding. Payload uses 64 KiB pread into chunk and whole-artifact hashes;
no payload buffer, reassembled file, journal or output file is created.

All limits below are RECEIVER decoder/streaming-work limits, not source ceilings,
host/export quotas, user upload limits, or allocations. In particular 8 GiB means
maximum streamed payload work, not memory reservation. These limits do not make a
complete source packet bounded. Unknown helper/diagnostic/export policies remain
open, and certify_current_source_packet() always refuses without an override.

Native UID/mode/identity checks are mechanics under a trusted local operator;
they do not authenticate an uploader or protect against hostile same-UID/root
mutation or undetectable ABA. Metadata checks detect observed changes through the
last retained-root checks. Byte results are historical observations, not a lease
on bytes after return, original physical lineage, semantic replay, or durable media.
Every acquisition is registered before subsequent effects. Every owned FD/scan
is consumed once at close; any failure is absorbing, retains the original private
exception and returns only fixed public errors/codes. No retry or reopening of
failed/consumed handles exists. A transient pin closes once after reader validation;
uncertain pin close prohibits any further index/payload reads. At most
MAX_CHUNKS + 3 owned native FDs coexist (readers/root plus one pin OR scandir
duplicate); the caller's borrowed root descriptor is separate.
"""
import fcntl
import hashlib
import os
import stat
import sys
import threading
from dataclasses import dataclass


CHUNK_LIMIT = 16 * 1024 * 1024
READ_SIZE = 65536
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_LINE_BYTES = 512
MAX_ARTIFACTS = 4096
MAX_CHUNKS = 8192
MAX_DECLARED_BYTES = 8 * 1024 * 1024 * 1024
INDEX_NAME = 'packet-index.v1'
_SCOPE = 'declared-upload-bytes-only'
_SOURCE_GAPS = ('clock-trace-source-byte-cap-missing',
                'enabled-diagnostic-serialized-cap-missing',
                'checkpoint-standalone-budget-policy-missing',
                'host-export-policy-missing', 'source-physical-and-semantic-closure-unverified')


class PacketError(RuntimeError):
    def __init__(self):
        super().__init__('private uploaded packet verification unavailable')


class SourcePacketUnavailable(RuntimeError):
    def __init__(self):
        super().__init__('current source packet qualification unavailable')


def source_packet_gaps():
    """Fixed source/policy gaps, independent of index content or byte success.

    The fixed-schema checkpoint is bounded by construction; this does not assign
    it a standalone source/export byte allowance. Clock trace has no explicit
    source byte cap; enabled diagnostics have no separate serialized source cap.
    """
    return _SOURCE_GAPS


def certify_current_source_packet():
    """No candidate index, success result or caller flag can clear these gaps."""
    raise SourcePacketUnavailable()


class _CheckFailure(Exception):
    pass


def _check(condition, code):
    if not condition:
        raise _CheckFailure(code)


def _hex(value, length):
    return type(value) is str and len(value) == length and all(c in '0123456789abcdef' for c in value)


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _decimal(value, expected):
    # Compare canonical text rather than parsing attacker-controlled integers.
    return value == str(expected)


@dataclass(frozen=True)
class ExpectedArtifact:
    """Independent byte expectations, not an artifact role, path or authority."""
    identifier: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ByteVerification:
    scope: str
    artifacts: int
    chunks: int
    payload_bytes: int
    index_bytes: int


@dataclass(frozen=True)
class ReceiverOutcome:
    state: str
    first_failure_phase: str
    first_failure_code: str
    closed: bool


class _File:
    __slots__ = ('fd', 'name', 'size', 'digest', 'stamp')

    def __init__(self, name, size=None):
        self.fd, self.name, self.size, self.digest, self.stamp = None, name, size, None, None


class PacketReceiver:
    """Passive constructor; verify() consumes one original process/thread attempt."""
    __slots__ = ('_pid', '_thread', '_busy', '_state', '_closed', '_root', '_root_stamp',
                 '_files', '_pin', '_scan', '_first_failure', '_first_phase', '_first_code')

    def __init__(self):
        self._pid, self._thread = os.getpid(), threading.current_thread()
        self._busy, self._closed, self._state = False, False, 'new'
        self._root, self._root_stamp = _File(None), None
        self._files, self._pin, self._scan = (), _File(None), None
        self._first_failure = None
        self._first_phase = self._first_code = 'none'

    def __repr__(self):
        return '<PacketReceiver>'

    def __reduce_ex__(self, protocol):
        raise TypeError('private packet receiver cannot be serialized')

    def __getstate__(self):
        raise TypeError('private packet receiver cannot be serialized')

    def _origin(self):
        if os.getpid() != self._pid or threading.current_thread() is not self._thread:
            raise PacketError()

    def _note(self, error, phase):
        if self._first_failure is None:
            self._first_failure, self._first_phase = error, phase
            self._first_code = error.args[0] if type(error) is _CheckFailure else 'native-failure'
        self._state = 'uncertain'

    def _close_file(self, entry):
        descriptor, entry.fd = entry.fd, None
        if descriptor is not None:
            try:
                os.close(descriptor)
            except BaseException as error:
                self._note(error, 'close')

    def _close_scan(self):
        iterator, self._scan = self._scan, None
        if iterator is not None:
            try:
                iterator.close()
            except BaseException as error:
                self._note(error, 'close')

    def _root_check(self):
        info = os.fstat(self._root.fd)
        flags = fcntl.fcntl(self._root.fd, fcntl.F_GETFL)
        _check(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) == 0o700 and
               flags & os.O_ACCMODE == os.O_RDONLY and
               not flags & getattr(os, 'O_PATH', 0), 'protection')
        if self._root_stamp is not None:
            _check(_stamp(info) == self._root_stamp, 'input-changed')
        return _stamp(info)

    def _directory_check(self, names):
        self._root_check()
        seen = set()
        self._scan = os.scandir(self._root.fd)
        try:
            for entry in self._scan:
                _check(len(seen) < len(names) and entry.name in names and
                       entry.name not in seen, 'inventory')
                seen.add(entry.name)
            _check(seen == names, 'inventory')
        except BaseException as error:
            # Retain the detection before iterator cleanup can itself fail.
            self._note(error, 'inventory')
        finally:
            self._close_scan()
        _check(self._state != 'uncertain', 'close-failed')
        self._root_check()

    def _file_check(self, entry, check_fd=True, descriptor=None):
        info = os.stat(entry.name, dir_fd=self._root.fd, follow_symlinks=False)
        _check(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) in (0o400, 0o600) and info.st_nlink == 1 and
               info.st_size == entry.size and
               (entry.stamp is None or _stamp(info) == entry.stamp), 'input-changed')
        if check_fd:
            descriptor_info = os.fstat(entry.fd if descriptor is None else descriptor)
            _check(_stamp(descriptor_info) == _stamp(info), 'input-changed')
        return _stamp(info)

    def _open(self, entry, inodes):
        _check(self._pin.fd is None, 'consumed')
        # O_PATH acquires a reference without device/FIFO read-open effects.
        # Its registered slot survives every later fallible validation/open.
        self._pin.fd = os.open(entry.name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC,
                               dir_fd=self._root.fd)
        _check(not os.get_inheritable(self._pin.fd), 'protection')
        info = os.fstat(self._pin.fd)
        pin_flags = fcntl.fcntl(self._pin.fd, fcntl.F_GETFL)
        _check(pin_flags & os.O_PATH and stat.S_ISREG(info.st_mode) and
               info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) in (0o400, 0o600) and
               info.st_nlink == 1, 'protection')
        if entry.size is None:
            _check(0 < info.st_size <= MAX_INDEX_BYTES, 'index-bound')
            entry.size = info.st_size
        entry.stamp = self._file_check(entry, descriptor=self._pin.fd)
        identity = info.st_dev, info.st_ino
        _check(identity not in inodes, 'alias')
        # The trusted local procfs resolves this still-owned validated regular
        # inode. Never read-open the replaceable uploaded pathname itself.
        entry.fd = os.open('/proc/self/fd/' + str(self._pin.fd),
                           os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK)
        _check(not os.get_inheritable(entry.fd), 'protection')
        flags = fcntl.fcntl(entry.fd, fcntl.F_GETFL)
        _check(flags & os.O_ACCMODE == os.O_RDONLY and not flags & os.O_PATH,
               'protection')
        self._file_check(entry)
        _check(_stamp(os.fstat(self._pin.fd)) == entry.stamp, 'input-changed')
        self._close_file(self._pin)
        _check(self._state != 'uncertain', 'close-failed')
        inodes.add(identity)

    @staticmethod
    def _read_hash(entry, whole=None):
        offset, digest = 0, hashlib.sha256()
        while offset < entry.size:
            amount = min(READ_SIZE, entry.size - offset)
            chunk = os.pread(entry.fd, amount, offset)
            _check(type(chunk) is bytes and 0 < len(chunk) <= amount, 'read-size')
            digest.update(chunk)
            if whole is not None:
                whole.update(chunk)
            offset += len(chunk)
        _check(os.pread(entry.fd, 1, entry.size) == b'', 'read-size')
        return digest.hexdigest()

    @staticmethod
    def _lines(entry):
        # Only bounded index metadata is buffered, never payload. The pending
        # line is at most MAX_LINE_BYTES; each native read is at most READ_SIZE.
        offset, pending = 0, b''
        while offset < entry.size:
            amount = min(READ_SIZE, entry.size - offset)
            chunk = os.pread(entry.fd, amount, offset)
            _check(type(chunk) is bytes and 0 < len(chunk) <= amount, 'read-size')
            offset += len(chunk)
            data = pending + chunk
            start = 0
            while True:
                end = data.find(b'\n', start)
                if end < 0:
                    pending = data[start:]
                    _check(len(pending) < MAX_LINE_BYTES, 'index-grammar')
                    break
                _check(end + 1 - start <= MAX_LINE_BYTES, 'index-grammar')
                yield data[start:end + 1].decode('ascii')
                start = end + 1
        _check(pending == b'' and os.pread(entry.fd, 1, entry.size) == b'', 'index-grammar')

    def _decode(self, expected):
        lines = self._lines(self._files[0])
        _check(next(lines, None) == 'ORCA-UPLOAD-1\n', 'index-grammar')
        number = 0
        for artifact in expected:
            count = (artifact.size + CHUNK_LIMIT - 1) // CHUNK_LIMIT
            line = next(lines, '')
            fields = line[:-1].split(' ')
            _check(len(fields) == 5 and fields[0] == 'A' and fields[1] == artifact.identifier and
                   _decimal(fields[2], artifact.size) and fields[3] == artifact.sha256 and
                   _decimal(fields[4], count), 'index-inventory')
            offset = 0
            for _ in range(count):
                entry = self._files[number + 1]
                line = next(lines, '')
                fields = line[:-1].split(' ')
                _check(len(fields) == 5 and fields[0] == 'C' and fields[1] == f'{number:08d}' and
                       _decimal(fields[2], offset) and _decimal(fields[3], entry.size) and
                       _hex(fields[4], 64), 'index-inventory')
                entry.digest = fields[4]
                offset += entry.size
                number += 1
            _check(offset == artifact.size, 'index-inventory')
        _check(next(lines, None) is None, 'index-inventory')

    @staticmethod
    def _expected(expected, expected_index_sha256):
        _check(_hex(expected_index_sha256, 64) and type(expected) is tuple and
               0 < len(expected) <= MAX_ARTIFACTS, 'expectations')
        previous, total, chunks = '', 0, 0
        entries = [_File(INDEX_NAME)]
        for artifact in expected:
            _check(type(artifact) is ExpectedArtifact and _hex(artifact.identifier, 32) and
                   artifact.identifier > previous and type(artifact.size) is int and
                   0 <= artifact.size <= MAX_DECLARED_BYTES and _hex(artifact.sha256, 64), 'expectations')
            count = (artifact.size + CHUNK_LIMIT - 1) // CHUNK_LIMIT
            total += artifact.size
            _check(total <= MAX_DECLARED_BYTES and chunks + count <= MAX_CHUNKS, 'receiver-bound')
            for offset in range(0, artifact.size, CHUNK_LIMIT):
                entries.append(_File(f'chunk-{chunks:08d}.bin', min(CHUNK_LIMIT, artifact.size - offset)))
                chunks += 1
            previous = artifact.identifier
        return tuple(entries), total, chunks

    def verify(self, directory_fd, expected_index_sha256, expected_inventory):
        """Verify ALL independently expected uploaded bytes; return counts only.

        Success never means independently complete source evidence. Native opens
        are read-only; no retries, reconstruction, archive extraction or output.
        """
        self._origin()
        if self._busy or self._closed or self._state != 'new':
            raise PacketError()
        self._busy, self._state = True, 'verifying'
        phase, result = 'expectations', None
        try:
            self._files, total, count = self._expected(expected_inventory, expected_index_sha256)
            _check(sys.platform == 'linux' and all(hasattr(os, flag) for flag in
                   ('O_PATH', 'O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC')), 'unsupported')
            names = {entry.name for entry in self._files}
            _check(type(directory_fd) is int and directory_fd >= 0, 'descriptor')
            phase = 'root'
            borrowed = os.fstat(directory_fd)
            borrowed_flags = fcntl.fcntl(directory_fd, fcntl.F_GETFL)
            _check(stat.S_ISDIR(borrowed.st_mode) and
                   borrowed_flags & os.O_ACCMODE == os.O_RDONLY and
                   not borrowed_flags & getattr(os, 'O_PATH', 0), 'protection')
            # A dup shares directory position: scandir can rewind it. A fixed
            # dot open gives this receiver its own read-only file description
            # without touching the borrowed descriptor's offset or ownership.
            self._root.fd = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                                    os.O_CLOEXEC, dir_fd=directory_fd)
            _check(not os.get_inheritable(self._root.fd), 'protection')
            self._root_stamp = self._root_check()
            _check(self._root_stamp == _stamp(borrowed) == _stamp(os.fstat(directory_fd)),
                   'input-changed')
            phase = 'inventory'
            self._directory_check(names)
            phase = 'index'
            inodes = set()
            self._open(self._files[0], inodes)
            _check(self._read_hash(self._files[0]) == expected_index_sha256, 'index-digest')
            self._file_check(self._files[0])
            self._decode(expected_inventory)
            self._file_check(self._files[0])
            phase = 'payload'
            number = 0
            for artifact in expected_inventory:
                whole = hashlib.sha256()
                for _ in range((artifact.size + CHUNK_LIMIT - 1) // CHUNK_LIMIT):
                    entry = self._files[number + 1]
                    self._open(entry, inodes)
                    _check(self._read_hash(entry, whole) == entry.digest, 'chunk-digest')
                    self._file_check(entry)
                    number += 1
                _check(whole.hexdigest() == artifact.sha256, 'artifact-digest')
            phase = 'final-check'
            for entry in self._files:
                self._file_check(entry)
            self._directory_check(names)
            # Keep the original root through closing payload/index FDs so a
            # change observed during those closes cannot produce apparent success.
            for entry in self._files:
                self._close_file(entry)
            _check(self._state != 'uncertain', 'close-failed')
            for entry in self._files:
                self._file_check(entry, check_fd=False)
            self._directory_check(names)
            result = ByteVerification(_SCOPE, len(expected_inventory), count, total, self._files[0].size)
        except BaseException as error:
            self._note(error, phase)
        finally:
            self._close_scan()
            self._close_file(self._pin)
            for entry in self._files:
                self._close_file(entry)
            self._close_file(self._root)
            self._closed, self._busy = True, False
        if self._state == 'uncertain':
            raise PacketError()
        self._state = 'verified'
        return result

    def outcome(self):
        self._origin()
        return ReceiverOutcome(self._state, self._first_phase, self._first_code, self._closed)

    def close(self):
        self._origin()
        if self._busy:
            raise PacketError()
        if not self._closed:
            self._close_scan()
            self._close_file(self._pin)
            for entry in self._files:
                self._close_file(entry)
            self._close_file(self._root)
            self._closed = True
            if self._state == 'new':
                self._state = 'closed'
        return self.outcome()
