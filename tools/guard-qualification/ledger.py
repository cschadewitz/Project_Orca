"""Acquisition-scoped ownership and cleanup with settled process tracking.

Every resource is registered in the same call that acquires it, before control
returns to the caller, including when a later startup step fails. Close attempts
every registered cleanup in reverse order even after failures and returns a
settlement; success is refused when any cleanup or process outcome is uncertain.

Processes are signalled only through pidfds opened while the target is this
supervisor's unreaped child, so a numeric PID can never refer to a reused
process. Process groups are never signalled. In subreaper mode the supervisor
must be dedicated (no pre-existing children); orphaned descendants are then
re-parented to it and swept through pidfds until none remain.

Assumptions: Linux >= 5.4 pidfd/waitid(P_PIDFD); this process is the only code
that reaps its children (no os.wait(-1), SIGCHLD not ignored); a descendant can
only escape the sweep by being started by an unrelated service, which
containment must prevent.
"""
import ctypes
import os
import select
import shutil
import signal
import stat
import subprocess
import time

from bounds import MAX_CLEANUP_RESOURCES, MAX_OWNED_PROCESSES, PROCESS_KILL_WAIT_SECONDS
from reasons import Refusal, code_of, require

PR_SET_CHILD_SUBREAPER = 36
SWEEP_ROUNDS = MAX_OWNED_PROCESSES
_PENDING = object()


def _children():
    """PIDs of this process's unreaped children, across all threads."""
    out = set()
    for task in os.listdir('/proc/self/task'):
        try:
            with open('/proc/self/task/%s/children' % task, 'rb') as handle:
                out.update(int(item) for item in handle.read().split())
        except FileNotFoundError:
            continue
    return out


class Settlement:
    __slots__ = ('status', 'reasons', 'attempted', 'failed', 'body_failed')

    def __init__(self, status, reasons, attempted, failed, body_failed):
        self.status, self.reasons, self.attempted, self.failed = status, tuple(reasons), attempted, failed
        self.body_failed = body_failed

    @property
    def settled(self):
        return self.status == 'settled'

    def report(self):
        return {'record': 'acquisition-settlement', 'status': self.status, 'attempted': self.attempted,
                'failed': self.failed, 'reason': self.reasons[0] if self.reasons else None,
                'bodyFailed': self.body_failed, 'authority': 'none'}


class OwnedProcess:
    __slots__ = ('popen', 'pidfd', 'status')

    def __init__(self, popen, pidfd):
        self.popen, self.pidfd, self.status = popen, pidfd, None

    def poll_exit(self, timeout):
        """Wait for exit through the pidfd without reaping; True once exited."""
        ready, _, _ = select.select([self.pidfd], [], [], max(0.0, timeout))
        return bool(ready)


class OwnedFd:
    """A descriptor closed exactly once; a closed holder never touches its old number."""
    __slots__ = ('fd',)

    def __init__(self, fd):
        self.fd = fd

    def close(self):
        fd, self.fd = self.fd, None
        if fd is not None:
            os.close(fd)


class AcquisitionLedger:
    def __init__(self, *, subreaper=False, budget=MAX_CLEANUP_RESOURCES, clock=time.monotonic):
        require(type(budget) is int and 0 < budget <= MAX_CLEANUP_RESOURCES, 'resource_budget_exceeded')
        require(signal.getsignal(signal.SIGCHLD) not in (signal.SIG_IGN,), 'sigchld_ignored')
        require(hasattr(os, 'pidfd_open') and hasattr(os, 'P_PIDFD'), 'pidfd_unavailable')
        if subreaper:
            require(not _children(), 'supervisor_not_dedicated')
            libc = ctypes.CDLL(None, use_errno=True)
            require(libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0, 'supervisor_not_dedicated')
        self._subreaper = subreaper
        self._budget, self._items, self._state = budget, [], 'open'
        self._processes, self._uncertain, self._settlement = [], [], None
        self._process_uncertain = self._body_failed = False
        self._clock = clock

    # -- acquisition -------------------------------------------------------
    def acquire(self, factory, dispose, kind='resource'):
        """Reserve the slot first, acquire, then record the resource; never strands it."""
        require(self._state == 'open', 'ledger_closed')
        require(len(self._items) < self._budget, 'resource_budget_exceeded')
        entry = [kind, dispose, _PENDING]
        self._items.append(entry)
        try:
            entry[2] = factory()
        except BaseException:
            self._uncertain.append('acquisition_failed')
            raise
        return entry[2]

    def open_fd(self, path, flags, mode=0o600, dir_fd=None):
        return self.acquire(lambda: os.open(path, flags | os.O_CLOEXEC, mode, dir_fd=dir_fd), os.close, 'fd')

    def pipe(self):
        """Two CLOEXEC pipe ends, each registered before the next acquisition."""
        fds = []

        def make():
            fds.extend(os.pipe2(os.O_CLOEXEC))
            return OwnedFd(fds[0])
        read_end = self.acquire(make, OwnedFd.close, 'fd')
        write_end = self.acquire(lambda: OwnedFd(fds[1]), OwnedFd.close, 'fd')
        return read_end, write_end

    def private_dir(self, parent, name):
        """Create an owner-only directory and register its removal (skipped if unsettled)."""
        parent_fd = self.open_fd(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

        def make():
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            info = os.lstat(name, dir_fd=parent_fd)
            require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700, 'acquisition_failed')
            return name

        def remove(item):
            if self._process_uncertain:
                raise Refusal('preserved_unsettled')
            shutil.rmtree(item, dir_fd=parent_fd)
        self.acquire(make, remove, 'directory')
        return os.path.join(parent, name)

    def spawn(self, argv, *, env, cwd, pass_fds=(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL):
        """Start a process with an exact environment, closed inherited FDs and a pidfd."""
        require(len(self._processes) < MAX_OWNED_PROCESSES, 'resource_budget_exceeded')
        require(type(env) is dict and all(type(k) is str and type(v) is str for k, v in env.items()),
                'acquisition_failed')

        def start():
            popen = subprocess.Popen(argv, env=env, cwd=cwd, pass_fds=tuple(pass_fds), close_fds=True,
                                     start_new_session=True, stdin=stdin, stdout=stdout, stderr=stderr)
            try:
                pidfd = os.pidfd_open(popen.pid)
            except OSError:
                # Still our unreaped child: its PID cannot have been reused.
                popen.kill()
                popen.wait()
                raise Refusal('pidfd_unavailable') from None
            owned = OwnedProcess(popen, pidfd)
            self._processes.append(owned)
            return owned
        return self.acquire(start, self._settle_process, 'process')

    # -- cleanup -----------------------------------------------------------
    def _reap(self, owned):
        try:
            result = os.waitid(os.P_PIDFD, owned.pidfd, os.WEXITED)
        except ChildProcessError:
            raise Refusal('process_unsettled') from None
        require(result is not None, 'process_unsettled')
        owned.status = (result.si_code, result.si_status)
        owned.popen.returncode = -result.si_status if result.si_code in (
            os.CLD_KILLED, os.CLD_DUMPED) else result.si_status

    def _settle_process(self, owned):
        try:
            if owned.status is None:
                if not owned.poll_exit(0):
                    signal.pidfd_send_signal(owned.pidfd, signal.SIGKILL)
                    require(owned.poll_exit(PROCESS_KILL_WAIT_SECONDS), 'process_unsettled')
                self._reap(owned)
        finally:
            os.close(owned.pidfd)
        if self._subreaper:
            self._sweep_descendants()

    def _sweep_descendants(self):
        for _ in range(SWEEP_ROUNDS):
            found = _children() - {p.popen.pid for p in self._processes if p.status is None}
            if not found:
                return
            for pid in found:
                pidfd = os.pidfd_open(pid)  # unreaped child of ours: PID pinned
                try:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                    ready, _, _ = select.select([pidfd], [], [], PROCESS_KILL_WAIT_SECONDS)
                    require(ready, 'descendant_unsettled')
                    os.waitid(os.P_PIDFD, pidfd, os.WEXITED)
                finally:
                    os.close(pidfd)
        require(not (_children() - {p.popen.pid for p in self._processes if p.status is None}),
                'descendant_unsettled')

    def close(self):
        if self._state == 'closed':
            return self._settlement
        require(self._state == 'open', 'ledger_closed')
        self._state = 'closing'
        attempted = failed = 0
        while self._items:
            kind, dispose, resource = self._items.pop()
            if resource is _PENDING:
                continue
            attempted += 1
            try:
                dispose(resource)
            except BaseException as error:  # attempt every cleanup; keep only a public code
                failed += 1
                if kind == 'process':
                    self._process_uncertain = True
                code = code_of(error)
                self._uncertain.append(code if code != 'unlisted_reason' else 'cleanup_failed')
        status = 'uncertain' if self._uncertain else 'settled'
        self._settlement = Settlement(status, self._uncertain, attempted, failed, self._body_failed)
        self._state = 'closed'
        return self._settlement

    def __enter__(self):
        require(self._state == 'open', 'ledger_closed')
        return self

    def __exit__(self, kind, error, traceback):
        self._body_failed = kind is not None
        settlement = self.close()
        if kind is None and not settlement.settled:
            raise Refusal('cleanup_uncertain')
        return False
