"""Original local control-peer lifetime, before any VM/issuer authority exists.

SOURCE ONLY. This never connects, sends, launches, discovers a PID/path or grants
VM authority. A future protected owner must provide an already connected native
AF_UNIX stream FD and exclusive read custody. Its borrowed FD/flags stay external;
our duplicate shares its receive queue. Same-UID code/root is trusted, not isolated.

SO_PEERPIDFD returns the kernel's cached peer struct-pid directly. SO_PEERCRED
records the cached connection/listener credentials; neither identifies Casey, a
VM generation, the current FD holder after passing, or a current authorization.
No numeric PID reopening, portable fallback, command negotiation or reconnect.
The installed protected origin/VM binding remains unavailable. A genuine pidfd
pins identity, not life: death can occur immediately after a successful check.
"""
import os
import select
import socket
import stat
import struct
import sys
import threading
import time
import json


# Linux asm-generic UAPI; this implementation deliberately qualifies x86_64 only.
SO_PEERPIDFD = 77
GREETING_LIMIT = 65536  # Restrictive transport-buffer ceiling, NOT disk/journal quota.
READ_SIZE = 4096
SESSION_SECONDS = 5.0  # One total adoption/greeting deadline, never renewed.


class PeerUnavailable(RuntimeError):
    def __init__(self):
        super().__init__('original local control peer unavailable')


class _Refusal(Exception):
    pass


def _require(value):
    if not value:
        raise _Refusal()


def _identity(number):
    info = os.fstat(number)
    return info.st_dev, info.st_ino, info.st_mode


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result)
        result[key] = value
    return result


def _integer(value):
    _require(len(value) <= 10 and value.isascii() and value.isdecimal())
    number = int(value)
    _require(number <= 2147483647)
    return number


def _no_number(value):
    raise _Refusal()


def _greeting(raw):
    # Preflight bounded ASCII/depth before JSON creates nested containers/strings.
    _require(type(raw) is bytes and 2 < len(raw) <= GREETING_LIMIT and raw.endswith(b'\r\n'))
    depth, quoted, escaped = 0, False, False
    for byte in raw:
        _require(byte < 128)
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            _require(depth <= 8)
        elif byte in (93, 125):
            depth -= 1
            _require(depth >= 0)
    _require(depth == 0 and not quoted)
    value = json.loads(raw, object_pairs_hook=_pairs, parse_int=_integer,
                       parse_float=_no_number, parse_constant=_no_number)
    _require(type(value) is dict and set(value) == {'QMP'})
    qmp = value['QMP']
    _require(type(qmp) is dict and set(qmp) == {'version', 'capabilities'})
    version, caps = qmp['version'], qmp['capabilities']
    _require(type(version) is dict and set(version) == {'qemu', 'package'})
    numbers, package = version['qemu'], version['package']
    _require(type(numbers) is dict and set(numbers) == {'major', 'minor', 'micro'})
    _require(all(type(n) is int and 0 <= n <= 2147483647 for n in numbers.values()))
    _require(type(package) is str and len(package) <= 1024 and all(32 <= ord(c) < 127 for c in package))
    _require(type(caps) is list and len(caps) <= 16)
    _require(all(type(c) is str and 0 < len(c) <= 64 and
                 all(ch in 'abcdefghijklmnopqrstuvwxyz0123456789_-' for ch in c) for c in caps))
    _require(len(set(caps)) == len(caps))
    # Parsed peer strings/claims are discarded, never promoted to authority.


class OriginalControlPeer:
    """Retain this passive owner before adopt(); all failures are absorbing."""

    def __init__(self):
        self._pid, self._thread = os.getpid(), threading.current_thread()
        self._socket = self._pidfd = None
        self._socket_identity = self._pidfd_identity = self._credentials = None
        self._deadline = None
        self._state, self._busy = 'new', False
        self._first_failure = None

    def __repr__(self):
        return '<OriginalLocalControlPeer>'

    def __reduce_ex__(self, protocol):
        raise TypeError('original control peer cannot be serialized')

    def __getstate__(self):
        raise TypeError('original control peer cannot be serialized')

    def _origin(self):
        if os.getpid() != self._pid or threading.current_thread() is not self._thread:
            raise PeerUnavailable()

    def _note(self, error):
        if self._first_failure is None:
            self._first_failure = error
        self._state = 'uncertain'

    def _dispose(self):
        number, self._pidfd = self._pidfd, None
        if number is not None:
            try:
                os.close(number)
            except BaseException as error:
                self._note(error)
        stream, self._socket = self._socket, None
        if stream is not None:
            try:
                stream.close()
            except BaseException as error:
                self._note(error)

    def _current(self, quiescent=False):
        _require(time.monotonic() < self._deadline)
        _require(_identity(self._socket.fileno()) == self._socket_identity and
                 _identity(self._pidfd) == self._pidfd_identity)
        _require(not os.get_inheritable(self._pidfd) and not os.get_inheritable(self._socket.fileno()))
        credentials = self._socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        _require(credentials == self._credentials)
        poll = select.poll()
        poll.register(self._pidfd, select.POLLIN)
        poll.register(self._socket.fileno(), select.POLLIN | select.POLLRDHUP)
        for number, flags in poll.poll(0):
            _require(number != self._pidfd and not flags &
                     (select.POLLERR | select.POLLHUP | select.POLLNVAL | select.POLLRDHUP))
            _require(not quiescent or not flags & select.POLLIN)

    def adopt(self, borrowed_fd):
        self._origin()
        if self._state != 'new' or self._busy:
            raise PeerUnavailable()
        self._state, self._busy = 'adopting', True
        try:
            _require(type(borrowed_fd) is int and borrowed_fd >= 0)
            _require(sys.platform == 'linux' and os.uname().machine == 'x86_64' and
                     socket.SOL_SOCKET == 1 and socket.SO_PEERCRED == 17 and struct.calcsize('3i') == 12)
            _require(stat.S_ISSOCK(os.fstat(borrowed_fd).st_mode))
            self._deadline = time.monotonic() + SESSION_SECONDS
            # Registered native target BEFORE dup2 changes its file description.
            # Never change shared OFD blocking flags or socket options afterwards.
            self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            os.dup2(borrowed_fd, self._socket.fileno(), inheritable=False)
            _require(self._socket.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) == socket.AF_UNIX and
                     self._socket.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM and
                     self._socket.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 0)
            self._socket.getpeername()  # Kernel connected-state check; never retain/print its path.
            self._socket_identity = _identity(self._socket.fileno())
            self._credentials = self._socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _require(type(self._credentials) is bytes and len(self._credentials) == 12)
            pid, uid, gid = struct.unpack('iII', self._credentials)
            _require(pid > 0 and uid == os.geteuid() and gid == os.getegid())
            # DIRECT kernel cached-peer acquisition; no PID number is reopened.
            self._pidfd = self._socket.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD)
            _require(type(self._pidfd) is int and self._pidfd >= 0)
            self._pidfd_identity = _identity(self._pidfd)
            self._current()
            self._state = 'peer-bound'
        except BaseException as error:
            self._note(error)
            self._dispose()
        finally:
            self._busy = False
        if self._state == 'uncertain':
            raise PeerUnavailable() from None

    def check_current(self):
        self._origin()
        if self._busy or self._state not in ('peer-bound', 'greeting-observed'):
            raise PeerUnavailable()
        self._busy = True
        try:
            self._current(quiescent=self._state == 'greeting-observed')
        except BaseException as error:
            self._note(error)
            self._dispose()
        finally:
            self._busy = False
        if self._state == 'uncertain':
            raise PeerUnavailable() from None

    def consume_greeting(self):
        self._origin()
        if self._state != 'peer-bound' or self._busy:
            raise PeerUnavailable()
        self._state, self._busy = 'reading-greeting', True
        try:
            buffer = bytearray()
            while True:
                self._current()
                poll = select.poll()
                poll.register(self._socket.fileno(), select.POLLIN | select.POLLRDHUP)
                poll.register(self._pidfd, select.POLLIN)
                remaining = self._deadline - time.monotonic()
                _require(remaining > 0)
                events = poll.poll(max(1, int(remaining * 1000)))
                _require(events)
                self._current()
                try:
                    data = self._socket.recv(min(READ_SIZE, GREETING_LIMIT + 1 - len(buffer)), socket.MSG_DONTWAIT)
                except BlockingIOError:
                    continue  # No bytes consumed; same fixed deadline, no message/connection replay.
                _require(type(data) is bytes and data)
                _require(len(buffer) + len(data) <= GREETING_LIMIT)
                buffer.extend(data)
                if b'\n' in data:
                    _greeting(bytes(buffer))
                    self._current(quiescent=True)
                    self._state = 'greeting-observed'
                    break
        except BaseException as error:
            self._note(error)
            self._dispose()
        finally:
            self._busy = False
        if self._state == 'uncertain':
            raise PeerUnavailable() from None

    def require_vm_authority(self):
        # No connection/greeting/native credential object is a VM/issuer grant.
        raise PeerUnavailable() from None

    def close(self):
        self._origin()
        if self._busy:
            raise PeerUnavailable()
        self._busy = True
        try:
            self._dispose()
            if self._state != 'uncertain':
                self._state = 'closed'
        finally:
            self._busy = False

    def state(self):
        self._origin()
        return self._state  # Data only, never a reconstructed resource or permission.
