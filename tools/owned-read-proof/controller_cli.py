"""Runnable bounded NONSECRET indexed trials; no observation or private exporter CLI.

The existing pilot and synthetic selftest are separate hard-pinned profiles. No
caller-supplied digest, manifest, approval flag or JSON can authorize other bytes.
The observed pilot's original path is an argument, never bundled or projected.
Only new private trial files/directories are created, never overwritten/deleted.
Failure/uncertainty is absorbing and the original private exception is retained
until this original owner exits. There is no journal, network, credential, service,
observer, issuer or receipt factory. Permanent host setup remains a proposal.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import os
import stat
import sys
import threading
import secrets
import errno

from packet_exporter import PacketExporter
from packet_receiver import PacketReceiver, ExpectedArtifact


READ_SIZE = 65536
PILOT_SIZE = 16777216
PILOT_SHA256 = '080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e'
SELFTEST_SIZE = 16777217
SELFTEST_SHA256 = '36cc1f42062fe57caf7ce314090b0fdf4c6a652f8d8b616c544dfac47ed87f06'
IDENTIFIER = '00000000000000000000000000000001'


@dataclass(frozen=True)
class Profile:
    name: str
    size: int
    sha256: str
    index: bytes

    @property
    def index_sha256(self):
        return hashlib.sha256(self.index).hexdigest()


_PILOT_INDEX = (f'ORCA-UPLOAD-1\nA {IDENTIFIER} {PILOT_SIZE} {PILOT_SHA256} 1\n'
                f'C 00000000 0 {PILOT_SIZE} {PILOT_SHA256}\n').encode('ascii')
_SELFTEST_INDEX = (f'ORCA-UPLOAD-1\nA {IDENTIFIER} {SELFTEST_SIZE} {SELFTEST_SHA256} 2\n'
                   'C 00000000 0 16777216 d61744896212f04ac9995775ccebc979df4d04f99b6f64bfb012ef5ef436c251\n'
                   'C 00000001 16777216 1 4ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260\n').encode('ascii')
PILOT = Profile('known-nonsecret-pilot', PILOT_SIZE, PILOT_SHA256, _PILOT_INDEX)
SELFTEST = Profile('synthetic-local-selftest-not-observed-pilot', SELFTEST_SIZE, SELFTEST_SHA256, _SELFTEST_INDEX)


class TrialError(RuntimeError):
    def __init__(self):
        super().__init__('nonsecret indexed trial unavailable; stop without retry or cleanup')


class _CheckFailure(Exception):
    pass


def _check(condition, code):
    if not condition:
        raise _CheckFailure(code)


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class _FD:
    __slots__ = ('value',)

    def __init__(self):
        self.value = None


class TrialOwner:
    """Own one fixed-public trial before its first acquisition; never serialize."""
    def __init__(self):
        self._pid, self._thread = os.getpid(), threading.current_thread()
        self._state, self._closed, self._busy = 'new', False, False
        self._original_pin, self._original = _FD(), _FD()
        self._parent, self._root, self._writer, self._custody, self._packet = (_FD() for _ in range(5))
        self._exporter = self._receiver = None
        self._first_failure = None
        self._phase = self._first_phase = 'none'
        self._source_path = self._source_stamp = self._root_stamp = self._custody_stamp = None
        self._packet_stamp = None
        self._trial_name = None

    def __repr__(self):
        return '<NonsecretTrialOwner>'

    def __reduce_ex__(self, protocol):
        raise TypeError('private trial owner cannot be serialized')

    def __getstate__(self):
        raise TypeError('private trial owner cannot be serialized')

    def _origin(self):
        if os.getpid() != self._pid or threading.current_thread() is not self._thread:
            raise TrialError()

    def _note(self, error):
        if self._first_failure is None:
            self._first_failure, self._first_phase = error, self._phase
        self._state = 'uncertain'

    def _close_fd(self, slot):
        number, slot.value = slot.value, None
        if number is not None:
            try:
                os.close(number)
            except BaseException as error:
                self._note(error)

    def _dispose(self, retain_roots=False):
        for component in (self._receiver, self._exporter):
            if component is not None:
                try:
                    outcome = component.close()
                    if outcome is not None and outcome.state == 'uncertain':
                        original = component._first_failure
                        self._note(original if original is not None else TrialError())
                except BaseException as error:
                    self._note(error)
        for slot in (self._writer, self._custody, self._packet, self._original_pin, self._original):
            self._close_fd(slot)
        if not retain_roots:
            self._close_fd(self._root)
            self._close_fd(self._parent)
            self._closed = True

    @staticmethod
    def _path(value):
        _check(type(value) is str and 0 < len(value) <= 4096 and '\0' not in value and
               os.path.isabs(value) and len(os.fsencode(value)) <= 4096, 'path')

    @staticmethod
    def _hash(number, size):
        value, offset = hashlib.sha256(), 0
        while offset < size:
            amount = min(READ_SIZE, size - offset)
            data = os.pread(number, amount, offset)
            _check(type(data) is bytes and 0 < len(data) <= amount, 'read')
            value.update(data)
            offset += len(data)
        _check(os.pread(number, 1, size) == b'', 'read')
        return value.hexdigest()

    def _source_check(self):
        info = os.fstat(self._original.value)
        _check(_stamp(info) == self._source_stamp == _stamp(os.lstat(self._source_path)), 'source-changed')

    def _pin_source(self, path):
        self._path(path)
        self._source_path = path
        self._original_pin.value = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(self._original_pin.value)
        _check(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
               info.st_nlink in (1, 2) and info.st_size == PILOT.size and
               stat.S_IMODE(info.st_mode) in (0o400, 0o600, 0o644), 'source-protection')
        self._source_stamp = _stamp(info)
        _check(_stamp(os.lstat(path)) == self._source_stamp, 'source-changed')
        self._original.value = os.open('/proc/self/fd/' + str(self._original_pin.value),
                                       os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        self._source_check()
        self._close_fd(self._original_pin)
        _check(self._state != 'uncertain', 'close')
        # Exact independently known public bytes before mkdir/copy/allocation.
        _check(self._hash(self._original.value, PILOT.size) == PILOT.sha256, 'source-digest')
        self._source_check()

    def _open_parent(self, parent):
        self._path(parent)
        self._parent.value = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(self._parent.value)
        mode = stat.S_IMODE(info.st_mode)
        _check(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
               (mode == 0o700 or mode == 0o1777), 'parent-protection')

    def _root_check(self):
        info = os.fstat(self._root.value)
        path = os.stat(self._trial_name, dir_fd=self._parent.value, follow_symlinks=False)
        _check(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) == 0o700 and _stamp(info) == _stamp(path), 'root-changed')
        if self._root_stamp is not None:
            _check((info.st_dev, info.st_ino) == self._root_stamp[:2], 'root-changed')

    def _create_root(self):
        self._trial_name = 'orca-evidence-trial-' + secrets.token_hex(16)
        os.mkdir(self._trial_name, mode=0o700, dir_fd=self._parent.value)
        self._root.value = os.open(self._trial_name, os.O_RDONLY | os.O_DIRECTORY |
                                  os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self._parent.value)
        os.fchmod(self._root.value, 0o700)  # Only the newly created directory.
        self._root_stamp = _stamp(os.fstat(self._root.value))
        self._root_check()
        os.fsync(self._parent.value)

    def _custody_check(self, profile, number):
        info = os.fstat(number)
        path = os.stat('custody.bin', dir_fd=self._root.value, follow_symlinks=False)
        _check(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) in (0o400, 0o600) and info.st_nlink == 1 and
               info.st_size == profile.size and _stamp(info) == _stamp(path) and
               (self._custody_stamp is None or _stamp(info) == self._custody_stamp), 'custody-changed')

    def _packet_check(self):
        info = os.fstat(self._packet.value)
        path = os.stat('packet', dir_fd=self._root.value, follow_symlinks=False)
        _check(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
               stat.S_IMODE(info.st_mode) == 0o700 and _stamp(info) == _stamp(path) and
               (self._packet_stamp is None or _stamp(info)[:2] == self._packet_stamp[:2]), 'packet-changed')
        return _stamp(info)

    def _final_paths_check(self):
        self._root_check()
        _check(_stamp(os.stat('packet', dir_fd=self._root.value, follow_symlinks=False)) ==
               self._packet_stamp, 'packet-changed')
        _check(_stamp(os.stat('custody.bin', dir_fd=self._root.value, follow_symlinks=False)) ==
               self._custody_stamp, 'custody-changed')

    def _write(self, data, offset, size):
        done = 0
        while done < len(data):
            _check(type(data) is bytes and 0 < len(data) <= READ_SIZE and
                   0 <= offset + done < offset + len(data) <= size, 'write-bound')
            count = os.pwrite(self._writer.value, data[done:], offset + done)
            _check(type(count) is int and 0 < count <= len(data) - done, 'write-progress')
            done += count

    def _copy_custody(self, profile):
        self._writer.value = os.open('custody.bin', os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                                     os.O_RDWR | os.O_CLOEXEC, 0o600, dir_fd=self._root.value)
        os.fchmod(self._writer.value, 0o600)
        os.posix_fallocate(self._writer.value, 0, profile.size)
        self._custody_check(profile, self._writer.value)
        offset, digest = 0, hashlib.sha256()
        while offset < profile.size:
            amount = min(READ_SIZE, profile.size - offset)
            if profile is PILOT:
                data = os.pread(self._original.value, amount, offset)
            else:
                # Fixed PUBLIC synthetic fixture, never the observed 080acf pilot.
                data = b'P' * min(amount, max(0, PILOT_SIZE - offset))
                if offset + len(data) < profile.size and len(data) < amount:
                    data += b'Q'
            _check(type(data) is bytes and 0 < len(data) <= amount, 'read')
            digest.update(data)
            self._write(data, offset, profile.size)
            offset += len(data)
        _check(digest.hexdigest() == profile.sha256 and
               self._hash(self._writer.value, profile.size) == profile.sha256, 'custody-digest')
        if profile is PILOT:
            self._source_check()
        os.fchmod(self._writer.value, 0o400)
        os.fsync(self._writer.value)
        self._custody_stamp = _stamp(os.fstat(self._writer.value))
        self._custody_check(profile, self._writer.value)
        # Reopen ONLY the already owned validated regular inode, never an unvalidated path.
        self._custody.value = os.open('/proc/self/fd/' + str(self._writer.value),
                                     os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        self._custody_check(profile, self._custody.value)
        self._close_fd(self._writer)
        _check(self._state != 'uncertain', 'close')
        self._custody_check(profile, self._custody.value)
        os.fsync(self._root.value)

    def run(self, profile_name, parent, source=None):
        self._origin()
        if self._state != 'new' or self._busy or self._closed:
            raise TrialError()
        self._state, self._busy = 'running', True
        result = None
        try:
            _check(type(profile_name) is str and profile_name in ('pilot', 'selftest'), 'profile')
            profile = PILOT if profile_name == 'pilot' else SELFTEST
            _check(sys.platform == 'linux' and sys.version_info >= (3, 11) and
                   all(hasattr(os, n) for n in ('O_PATH', 'O_TMPFILE', 'posix_fallocate', 'pread', 'pwrite')),
                   'unsupported')
            self._phase = 'source'
            if profile is PILOT:
                self._pin_source(source)
            else:
                _check(source is None, 'profile')
            self._phase = 'root'
            self._open_parent(parent)
            self._create_root()
            self._phase = 'custody'
            self._copy_custody(profile)
            self._phase = 'packet-root'
            os.mkdir('packet', mode=0o700, dir_fd=self._root.value)
            self._packet.value = os.open('packet', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                                        os.O_CLOEXEC, dir_fd=self._root.value)
            os.fchmod(self._packet.value, 0o700)
            self._packet_stamp = self._packet_check()
            os.fsync(self._root.value)
            expected = (ExpectedArtifact(IDENTIFIER, profile.size, profile.sha256),)
            self._phase = 'prepare'
            self._exporter = PacketExporter()
            plan = self._exporter.prepare((self._custody.value,), expected, self._packet.value,
                                          profile.size + len(profile.index))
            # Independent SOURCE PIN, not a digest learned from the new packet/index.
            _check(plan.index_sha256 == profile.index_sha256 and plan.index_bytes == len(profile.index),
                   'independent-index')
            if profile is PILOT:
                self._source_check()
            self._packet_check()
            self._phase = 'publish'
            self._exporter.publish()
            self._phase = 'verify'
            self._receiver = PacketReceiver()
            verified = self._receiver.verify(self._packet.value, profile.index_sha256, expected)
            self._custody_check(profile, self._custody.value)
            if profile is PILOT:
                _check(self._hash(self._original.value, profile.size) == profile.sha256, 'source-digest')
                self._source_check()
            self._root_check()
            self._packet_stamp = self._packet_check()
            result = {'scope': 'nonsecret-indexed-bytes-only', 'profile': profile.name,
                      'trial_name': self._trial_name, 'packet_relative': 'packet',
                      'files': [f'chunk-{i:08d}.bin' for i in range(verified.chunks)] + ['packet-index.v1'],
                      'artifact_sha256': profile.sha256, 'index_sha256': profile.index_sha256,
                      'artifacts': verified.artifacts, 'chunks': verified.chunks,
                      'payload_bytes': verified.payload_bytes, 'index_bytes': verified.index_bytes,
                      'new_trial_file_data_bytes': 2 * profile.size + len(profile.index),
                      'original_or_observation_authority': False}
            self._phase = 'close'
            self._dispose(retain_roots=True)
            _check(self._state != 'uncertain', 'close')
            self._final_paths_check()
            self._dispose()
            _check(self._state != 'uncertain', 'close')
            self._state = 'verified'
        except BaseException as error:
            original = error
            for component in (self._receiver, self._exporter):
                if component is not None and component._first_failure is not None:
                    original = component._first_failure
                    break
            self._note(original)
            self._dispose()
        finally:
            self._busy = False
        if self._state == 'uncertain':
            raise TrialError()
        return result

    def verify(self, profile_name, packet_path):
        self._origin()
        if self._state != 'new' or self._busy or self._closed:
            raise TrialError()
        self._state, self._busy, self._phase = 'verifying', True, 'verify'
        result = None
        try:
            _check(type(profile_name) is str and profile_name in ('pilot', 'selftest'), 'profile')
            profile = PILOT if profile_name == 'pilot' else SELFTEST
            self._path(packet_path)
            self._packet.value = os.open(packet_path, os.O_RDONLY | os.O_DIRECTORY |
                                        os.O_NOFOLLOW | os.O_CLOEXEC)
            self._receiver = PacketReceiver()
            value = self._receiver.verify(self._packet.value, profile.index_sha256,
                                          (ExpectedArtifact(IDENTIFIER, profile.size, profile.sha256),))
            _check(_stamp(os.fstat(self._packet.value)) == _stamp(os.lstat(packet_path)), 'packet-changed')
            result = {'scope': 'nonsecret-indexed-bytes-only', 'profile': profile.name,
                      'artifacts': value.artifacts, 'chunks': value.chunks,
                      'payload_bytes': value.payload_bytes, 'index_sha256': profile.index_sha256,
                      'original_or_observation_authority': False}
            self._dispose()
            _check(self._state != 'uncertain', 'close')
            self._state = 'verified'
        except BaseException as error:
            original = (self._receiver._first_failure if self._receiver is not None and
                        self._receiver._first_failure is not None else error)
            self._note(original)
            self._dispose()
        finally:
            self._busy = False
        if self._state == 'uncertain':
            raise TrialError()
        return result

    def close(self):
        self._origin()
        if self._busy:
            raise TrialError()
        if not self._closed:
            self._dispose()

    def failure_projection(self):
        """Finite codes only; never native error text, argv, paths or raw bytes."""
        phases = ('none', 'source', 'root', 'custody', 'packet-root', 'prepare', 'publish', 'verify', 'close')
        phase = self._first_phase if type(self._first_phase) is str and self._first_phase in phases else 'none'
        error = self._first_failure
        native_types = (OSError, PermissionError, FileNotFoundError, FileExistsError, NotADirectoryError,
                        IsADirectoryError, BlockingIOError, InterruptedError, TimeoutError, ProcessLookupError)
        number = error.errno if any(type(error) is native for native in native_types) else None
        if type(number) is not int:
            number = None
        if (type(error) is _CheckFailure and len(error.args) == 1 and type(error.args[0]) is str and
                len(error.args[0]) <= 64 and error.args[0] in (
                'source-protection', 'source-changed', 'source-digest', 'parent-protection',
                'unsupported', 'independent-index', 'custody-changed', 'custody-digest')):
            reason = error.args[0]
        elif number in (errno.EOPNOTSUPP, errno.ENOSYS):
            reason = 'native-api-unsupported'
        elif number in (errno.ENOSPC, errno.EDQUOT):
            reason = 'native-capacity-unavailable'
        elif number in (errno.EMFILE, errno.ENFILE):
            reason = 'native-fd-unavailable'
        else:
            reason = 'verification-or-close-unavailable'
        return phase, reason


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # Never echo arbitrary argv, paths, values or exceptions through parser errors.
        self.exit(2, 'nonsecret CLI arguments unavailable; use --help\n')


def _error(text):
    try:
        sys.stderr.write(text + '\n')
        sys.stderr.flush()
    except BaseException:
        pass


def main(argv=None, source_commit='unknown'):
    if not (sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode):
        _error('use python3 -I -S -B with the reviewed bundle')
        return 2
    parser = _Parser(prog='orca-evidence', description='Fixed nonsecret indexed trials only; no private/raw export or observation grants.')
    parser.add_argument('--version', action='version', version='orca-evidence source ' + source_commit)
    commands = parser.add_subparsers(dest='command', required=True, parser_class=_Parser)
    for command in ('pilot', 'selftest'):
        p = commands.add_parser(command)
        p.add_argument('--output-parent', default='/var/tmp')
        if command == 'pilot':
            p.add_argument('--source', required=True)
    for command in ('verify-pilot', 'verify-selftest'):
        commands.add_parser(command).add_argument('--packet', required=True)
    commands.add_parser('private-export')
    args = parser.parse_args(argv)
    if args.command == 'private-export':
        _error('private export unavailable: original owner/privacy binding missing')
        return 2
    owner = None
    try:
        owner = TrialOwner()
        if args.command.startswith('verify-'):
            result = owner.verify(args.command[7:], args.packet)
        else:
            result = owner.run(args.command, args.output_parent, getattr(args, 'source', None))
    except BaseException:
        # The original error remains solely on this original in-process owner.
        phase, reason = owner.failure_projection() if owner is not None else ('none', 'startup-unavailable')
        _error('nonsecret indexed trial unavailable; phase=' + phase + '; reason=' + reason +
               '; stop without retry or cleanup')
        return 1
    try:
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    except BaseException as error:
        if owner is not None:
            owner._note(error)
        _error('trial result delivery uncertain; preserve files and do not retry')
        return 1
    return 0
