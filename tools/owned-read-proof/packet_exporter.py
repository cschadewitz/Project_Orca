"""Native, one-attempt export of independently declared private bytes.

This is a file-copy component for a future trusted operator/controller, not an
observation issuer, custody/session grant, inventory selector or transport. Native
FDs and byte expectations do not establish original-run ownership or permission
to disclose private evidence. Complete-source certification remains unavailable.

prepare() first snapshots/checks all expectations and borrowed source FDs, then
hashes every complete source before any output allocation. It reserves the exact
chunk+index data bytes using O_TMPFILE/posix_fallocate before copying. Payload uses
64 KiB pread/pwrite; only bounded index metadata is buffered. No sparse/zero-fill,
allocation fallback, named staging copy, journal or source mutation is used.
Native allocation does not reserve filesystem metadata, inode/directory operations
or a quota, and does not impose an I/O deadline. Unsupported/ENOSPC/EMFILE refuse.

The returned immutable plan is DATA ONLY. The later trusted owner must retain its
index hash and independent whole-original expectations through an approved existing
management route before calling publish(). This component neither invents a new
journal allowance nor claims to verify that external retention or privacy policy.
publish() rechecks the same native sources/copies, consumes one publication attempt,
create-only links readonly chunks, then publishes packet-index.v1 LAST. Partial
visible files remain on failure; no overwrite, unlink, repair or automatic retry.
An index is a byte-protocol marker, never an original receipt or durable-media proof.
Lost replies remain uncertain even if the existing read-only receiver later matches
bytes. Closing unpublished unnamed copies does not dispose of the borrowed originals.

Linux O_TMPFILE, posix_fallocate, trusted local procfs and cooperative original
PID/thread/ancestors are required; no fallback exists. UID/mode/stamp checks do not
authenticate a custodian, isolate hostile same-UID/root actors or detect hostile
ABA. Source link counts 1 or 2 are retained: an existing host-report custody copy's
two aliases are not relabeled as the guest original's unaliased physical lineage.
All exported files are NEW inodes with one final link. Existing observer budgets,
pins, guards and receipt non-serialization are independent and unchanged.
"""
import fcntl
import hashlib
import os
import stat
import sys
import threading
from dataclasses import dataclass

from packet_receiver import (CHUNK_LIMIT, READ_SIZE, MAX_INDEX_BYTES, MAX_LINE_BYTES,
                             MAX_ARTIFACTS, MAX_CHUNKS, MAX_DECLARED_BYTES,
                             INDEX_NAME, ExpectedArtifact)


_SCOPE = 'declared-export-bytes-only'


class ExportError(RuntimeError):
    def __init__(self):
        super().__init__('private packet export unavailable')


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


def _content(info):
    # Linking legitimately changes nlink/ctime; it must not change these fields.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns)


class _File:
    __slots__ = ('fd', 'name', 'size', 'stamp', 'digest', 'source', 'offset', 'linked')

    def __init__(self, name=None, size=0, source=None, offset=0):
        self.fd, self.name, self.size = None, name, size
        self.stamp = self.digest = None
        self.source, self.offset, self.linked = source, offset, False


@dataclass(frozen=True)
class ExportPlan:
    """Independent-correlation DATA; not a session, signature or receipt."""
    scope: str
    inventory: tuple
    index_sha256: str
    index_bytes: int
    payload_bytes: int
    chunks: int
    reserved_data_bytes: int


@dataclass(frozen=True)
class ExportOutcome:
    state: str
    first_failure_phase: str
    first_failure_code: str
    closed: bool


class PacketExporter:
    """Retain the original owner; prepare, independently retain plan, publish once.

    source_fds and expected_inventory are separate exact tuples in increasing
    opaque-ID order. Sources are preopened owner-controlled readonly regular FDs,
    not paths found by walking a candidate tree. The borrowed root is a private,
    empty output directory; this component chooses no installed host path.
    capacity_bytes is a restrictive data-byte ceiling, not an allocation/authority
    grant. Actual file allocations precede the first copy write.
    """
    __slots__ = ('_pid', '_thread', '_busy', '_state', '_closed', '_root', '_root_identity',
                 '_sources', '_borrowed', '_expected', '_chunks', '_index', '_scan',
                 '_first_failure', '_first_phase', '_first_code', '_index_bytes',
                 '_index_digest', '_total', '_reserved')

    def __init__(self):
        self._pid, self._thread = os.getpid(), threading.current_thread()
        self._busy, self._closed, self._state = False, False, 'new'
        self._root, self._root_identity = _File(), None
        self._sources, self._borrowed, self._expected, self._chunks = (), (), (), ()
        self._index, self._scan = _File(INDEX_NAME), None
        self._first_failure = None
        self._first_phase = self._first_code = 'none'
        self._index_bytes = self._index_digest = None
        self._total = self._reserved = 0

    def __repr__(self):
        return '<PacketExporter>'

    def __reduce_ex__(self, protocol):
        raise TypeError('private packet exporter cannot be serialized')

    def __getstate__(self):
        raise TypeError('private packet exporter cannot be serialized')

    def _origin(self):
        if os.getpid() != self._pid or threading.current_thread() is not self._thread:
            raise ExportError()

    def _enter(self, state):
        self._origin()
        if self._busy or self._closed or self._state != state:
            raise ExportError()
        self._busy = True

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

    def _dispose(self):
        self._close_scan()
        for entry in (*self._chunks, self._index, *self._sources):
            self._close_file(entry)
        self._close_file(self._root)
        self._closed = True

    def _layout(self, expected, source_fds, capacity):
        _check(type(expected) is tuple and 0 < len(expected) <= MAX_ARTIFACTS and
               type(source_fds) is tuple and len(source_fds) == len(expected) and
               type(capacity) is int and 0 < capacity <= MAX_DECLARED_BYTES + MAX_INDEX_BYTES,
               'expectations')
        previous, total, number = '', 0, 0
        normalized, chunks = [], []
        index_size = len(b'ORCA-UPLOAD-1\n')
        for i, item in enumerate(expected):
            _check(type(item) is ExpectedArtifact and _hex(item.identifier, 32) and
                   item.identifier > previous and type(item.size) is int and
                   0 <= item.size <= MAX_DECLARED_BYTES and _hex(item.sha256, 64), 'expectations')
            _check(type(source_fds[i]) is int and source_fds[i] >= 0, 'descriptor')
            count = (item.size + CHUNK_LIMIT - 1) // CHUNK_LIMIT
            total += item.size
            _check(total <= MAX_DECLARED_BYTES and number + count <= MAX_CHUNKS, 'export-bound')
            artifact = ExpectedArtifact(item.identifier, item.size, item.sha256)
            normalized.append(artifact)
            index_size += len(self._artifact_line(artifact))
            for offset in range(0, item.size, CHUNK_LIMIT):
                entry = _File(f'chunk-{number:08d}.bin', min(CHUNK_LIMIT, item.size - offset), i, offset)
                chunks.append(entry)
                index_size += len(self._chunk_line(number, entry, '0' * 64))
                number += 1
            previous = item.identifier
        _check(index_size <= MAX_INDEX_BYTES and total + index_size <= capacity, 'capacity')
        self._expected, self._borrowed = tuple(normalized), tuple(source_fds)
        self._sources = tuple(_File(size=e.size) for e in self._expected)
        self._chunks = tuple(chunks)
        self._total, self._index.size, self._reserved = total, index_size, total + index_size

    @staticmethod
    def _artifact_line(item):
        count = (item.size + CHUNK_LIMIT - 1) // CHUNK_LIMIT
        line = f'A {item.identifier} {item.size} {item.sha256} {count}\n'.encode('ascii')
        _check(len(line) <= MAX_LINE_BYTES, 'index-bound')
        return line

    @staticmethod
    def _chunk_line(number, entry, digest):
        line = f'C {number:08d} {entry.offset} {entry.size} {digest}\n'.encode('ascii')
        _check(len(line) <= MAX_LINE_BYTES, 'index-bound')
        return line

    def _root_check(self):
        info = os.fstat(self._root.fd)
        flags = fcntl.fcntl(self._root.fd, fcntl.F_GETFL)
        _check(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) == 0o700 and
               flags & os.O_ACCMODE == os.O_RDONLY and not flags & os.O_PATH and
               (self._root_identity is None or (info.st_dev, info.st_ino) == self._root_identity),
               'protection')
        return info

    def _directory_check(self, expected):
        self._root_check()
        seen = set()
        self._scan = os.scandir(self._root.fd)
        try:
            for entry in self._scan:
                _check(len(seen) < len(expected) and entry.name in expected and
                       entry.name not in seen, 'inventory')
                seen.add(entry.name)
            _check(seen == expected, 'inventory')
        except BaseException as error:
            self._note(error, 'inventory')
        finally:
            self._close_scan()
        _check(self._state != 'uncertain', 'close-failed')
        self._root_check()

    def _source_check(self, entry, descriptor=None):
        descriptor = entry.fd if descriptor is None else descriptor
        info = os.fstat(descriptor)
        flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
        _check(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) in (0o400, 0o600) and info.st_nlink in (1, 2) and
               info.st_size == entry.size and flags & os.O_ACCMODE == os.O_RDONLY and
               not flags & os.O_PATH and (entry.stamp is None or _stamp(info) == entry.stamp),
               'source-changed')
        return _stamp(info)

    @staticmethod
    def _hash_fd(descriptor, size):
        offset, digest = 0, hashlib.sha256()
        while offset < size:
            amount = min(READ_SIZE, size - offset)
            data = os.pread(descriptor, amount, offset)
            _check(type(data) is bytes and 0 < len(data) <= amount, 'read-size')
            digest.update(data)
            offset += len(data)
        _check(os.pread(descriptor, 1, size) == b'', 'read-size')
        return digest.hexdigest()

    def _sources_check(self, hashes=False, borrowed=False):
        for i, entry in enumerate(self._sources):
            descriptor = self._borrowed[i] if borrowed else entry.fd
            self._source_check(entry, descriptor)
            if hashes:
                _check(self._hash_fd(descriptor, entry.size) == self._expected[i].sha256, 'source-digest')
                self._source_check(entry, descriptor)

    def _output_check(self, entry):
        info = os.fstat(entry.fd)
        _check(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) in (0o400, 0o600) and
               info.st_nlink == (1 if entry.linked else 0) and info.st_size == entry.size,
               'output-changed')
        if entry.stamp is not None:
            _check(_stamp(info) == entry.stamp, 'output-changed')
        if entry.linked:
            _check(_stamp(os.stat(entry.name, dir_fd=self._root.fd, follow_symlinks=False)) == _stamp(info),
                   'output-changed')
        return _stamp(info)

    def _allocate(self, entry):
        entry.fd = os.open('.', os.O_TMPFILE | os.O_RDWR | os.O_CLOEXEC, 0o600, dir_fd=self._root.fd)
        _check(not os.get_inheritable(entry.fd), 'protection')
        info = os.fstat(entry.fd)
        _check(stat.S_ISREG(info.st_mode) and info.st_nlink == 0 and info.st_size == 0 and
               info.st_uid == os.geteuid(), 'protection')
        os.fchmod(entry.fd, 0o600)
        os.posix_fallocate(entry.fd, 0, entry.size)
        self._output_check(entry)
        os.fsync(entry.fd)

    @staticmethod
    def _write(entry, data, offset):
        done = 0
        while done < len(data):
            _check(0 <= offset + done < offset + len(data) <= entry.size and
                   len(data) <= READ_SIZE, 'write-size')
            count = os.pwrite(entry.fd, data[done:], offset + done)
            _check(type(count) is int and 0 < count <= len(data) - done, 'write-progress')
            done += count

    def _copy(self):
        number = 0
        for i, artifact in enumerate(self._expected):
            source, whole = self._sources[i], hashlib.sha256()
            for _ in range((artifact.size + CHUNK_LIMIT - 1) // CHUNK_LIMIT):
                entry, offset, digest = self._chunks[number], 0, hashlib.sha256()
                while offset < entry.size:
                    amount = min(READ_SIZE, entry.size - offset)
                    data = os.pread(source.fd, amount, entry.offset + offset)
                    _check(type(data) is bytes and 0 < len(data) <= amount, 'read-size')
                    digest.update(data)
                    whole.update(data)
                    self._write(entry, data, offset)
                    offset += len(data)
                entry.digest = digest.hexdigest()
                _check(self._hash_fd(entry.fd, entry.size) == entry.digest, 'output-digest')
                os.fchmod(entry.fd, 0o400)
                os.fsync(entry.fd)
                entry.stamp = self._output_check(entry)
                number += 1
            _check(os.pread(source.fd, 1, artifact.size) == b'' and
                   whole.hexdigest() == artifact.sha256, 'source-digest')
            self._source_check(source)
        self._sources_check()

    def prepare(self, source_fds, expected_inventory, directory_fd, capacity_bytes):
        self._enter('new')
        self._state = 'preparing'
        phase, plan = 'expectations', None
        try:
            self._layout(expected_inventory, source_fds, capacity_bytes)
            _check(sys.platform == 'linux' and all(hasattr(os, name) for name in
                   ('O_TMPFILE', 'O_PATH', 'O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC', 'posix_fallocate')),
                   'unsupported')
            phase = 'sources'
            identities = set()
            for entry, borrowed in zip(self._sources, self._borrowed):
                entry.fd = os.dup(borrowed)
                _check(not os.get_inheritable(entry.fd), 'protection')
                entry.stamp = self._source_check(entry)
                identity = entry.stamp[:2]
                _check(identity not in identities, 'source-alias')
                identities.add(identity)
            self._sources_check(hashes=True)
            phase = 'root'
            _check(type(directory_fd) is int and directory_fd >= 0, 'descriptor')
            original = os.fstat(directory_fd)
            flags = fcntl.fcntl(directory_fd, fcntl.F_GETFL)
            _check(stat.S_ISDIR(original.st_mode) and flags & os.O_ACCMODE == os.O_RDONLY and
                   not flags & os.O_PATH, 'protection')
            self._root.fd = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                    dir_fd=directory_fd)
            _check(not os.get_inheritable(self._root.fd), 'protection')
            info = self._root_check()
            self._root_identity = info.st_dev, info.st_ino
            _check(_stamp(info) == _stamp(original) == _stamp(os.fstat(directory_fd)), 'root-changed')
            self._directory_check(set())
            phase = 'reserve'
            for entry in (*self._chunks, self._index):
                self._allocate(entry)
                identity = _stamp(os.fstat(entry.fd))[:2]
                _check(identity not in identities, 'output-alias')
                identities.add(identity)
            # All exact data bytes are physically allocated BEFORE copy writes.
            phase = 'copy'
            self._copy()
            lines, number = [b'ORCA-UPLOAD-1\n'], 0
            for artifact in self._expected:
                lines.append(self._artifact_line(artifact))
                for _ in range((artifact.size + CHUNK_LIMIT - 1) // CHUNK_LIMIT):
                    lines.append(self._chunk_line(number, self._chunks[number], self._chunks[number].digest))
                    number += 1
            self._index_bytes = b''.join(lines)
            _check(len(self._index_bytes) == self._index.size <= MAX_INDEX_BYTES, 'index-bound')
            self._index_digest = hashlib.sha256(self._index_bytes).hexdigest()
            for offset in range(0, self._index.size, READ_SIZE):
                self._write(self._index, self._index_bytes[offset:offset + READ_SIZE], offset)
            _check(self._hash_fd(self._index.fd, self._index.size) == self._index_digest, 'output-digest')
            os.fchmod(self._index.fd, 0o400)
            os.fsync(self._index.fd)
            self._index.stamp = self._output_check(self._index)
            self._sources_check()
            self._directory_check(set())
            # Return fresh data records so caller mutation cannot affect internals.
            inventory = tuple(ExpectedArtifact(e.identifier, e.size, e.sha256) for e in self._expected)
            plan = ExportPlan(_SCOPE, inventory, self._index_digest, self._index.size,
                              self._total, len(self._chunks), self._reserved)
            self._state = 'prepared'
        except BaseException as error:
            self._note(error, phase)
            self._dispose()
        finally:
            self._busy = False
        if self._state == 'uncertain':
            raise ExportError()
        return plan

    def _link(self, entry):
        before = os.fstat(entry.fd)
        self._output_check(entry)
        os.link('/proc/self/fd/' + str(entry.fd), entry.name,
                dst_dir_fd=self._root.fd, follow_symlinks=True)
        entry.linked = True
        info = os.fstat(entry.fd)
        _check(_content(info) == _content(before), 'output-changed')
        entry.stamp = None
        entry.stamp = self._output_check(entry)

    def _published_check(self):
        for entry in (*self._chunks, self._index):
            _check(entry.linked and _stamp(os.stat(entry.name, dir_fd=self._root.fd,
                                                 follow_symlinks=False)) == entry.stamp, 'output-changed')
        self._directory_check({entry.name for entry in (*self._chunks, self._index)})

    def publish(self):
        self._enter('prepared')
        # The attempt is consumed before the first possible publication effect.
        self._state = 'publishing'
        phase = 'recheck'
        try:
            self._sources_check(hashes=True)
            self._directory_check(set())
            for entry in (*self._chunks, self._index):
                self._output_check(entry)
                _check(self._hash_fd(entry.fd, entry.size) ==
                       (self._index_digest if entry is self._index else entry.digest), 'output-digest')
            phase = 'chunks'
            for entry in self._chunks:
                self._link(entry)
            os.fsync(self._root.fd)
            self._sources_check()
            for entry in self._chunks:
                self._output_check(entry)
            self._directory_check({entry.name for entry in self._chunks})
            phase = 'index'
            self._link(self._index)
            phase = 'directory-sync'
            os.fsync(self._root.fd)
            self._sources_check(hashes=True)
            self._published_check()
            for entry in (*self._chunks, self._index, *self._sources):
                self._close_file(entry)
            _check(self._state != 'uncertain', 'close-failed')
            self._sources_check(borrowed=True)
            self._published_check()
            self._close_file(self._root)
            _check(self._state != 'uncertain', 'close-failed')
            self._closed, self._state = True, 'published'
        except BaseException as error:
            self._note(error, phase)
            self._dispose()
        finally:
            self._busy = False
        if self._state == 'uncertain':
            raise ExportError()
        return self.outcome()

    def outcome(self):
        self._origin()
        return ExportOutcome(self._state, self._first_phase, self._first_code, self._closed)

    def close(self):
        self._origin()
        if self._busy:
            raise ExportError()
        if not self._closed:
            self._dispose()
            if self._state != 'uncertain':
                self._state = 'closed'
        return self.outcome()
