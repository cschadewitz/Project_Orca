"""Sparse original observer measurements; no execution or acceptance authority.

Never reads a raw trace, protected packet, argv, environment or arbitrary path.
Process counters come only through pinned proc-directory descriptors and pidfds.
Diagnostic failures remain visible and cannot replace any original guard.
"""
import json
import os
from pathlib import Path
import select
import threading
import time

from controlled_contract import require

PERIOD_NS = 1_000_000_000
MAX_SAMPLES = 62
READ_BOUND = 8192
RESOURCE_NAMES = ('cpu.stat', 'io.stat', 'memory.events', 'memory.current')
CONFIG = {'record': 'sparse-original-diagnostics-v1', 'periodNanoseconds': PERIOD_NS,
          'maximumSamples': MAX_SAMPLES, 'maximumReadBytes': READ_BOUND,
          'resourceRoot': '/sys/fs/cgroup', 'resourceFiles': list(RESOURCE_NAMES),
          'processFiles': ['stat', 'schedstat', 'io'], 'processes': ['supervisor', 'tracer', 'leader'],
          'finalSample': 'after-owned-original-settlement',
          'progress': 'trace-size-and-phase-event-count-only', 'rawTraceReading': False,
          'authority': 'none'}


def read_at(directory, name):
    number = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        value = os.read(number, READ_BOUND + 1)
        require(len(value) <= READ_BOUND, 'diagnostic counter exceeds fixed read bound')
        return value.decode('ascii')
    finally:
        os.close(number)


def counters(raw):
    result = {}
    for line in raw.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].isdigit():
            result[fields[0].rstrip(':')] = int(fields[1])
    return result


def proc_fields(raw):
    fields = raw[raw.rindex(')') + 2:].split()
    return {'pid': int(raw.split(' ', 1)[0]), 'state': fields[0],
            'ppid': int(fields[1]), 'pgrp': int(fields[2]), 'session': int(fields[3]),
            'starttime': int(fields[19]), 'userTicks': int(fields[11]), 'systemTicks': int(fields[12]),
            'minorFaults': int(fields[7]), 'majorFaults': int(fields[9]), 'rssPages': int(fields[21])}


class PinnedProcess:
    def __init__(self, expected, procfd=None, pidfd=None):
        self.expected = {key: expected[key] for key in ('pid', 'starttime', 'ppid', 'pgrp', 'session')}
        self.procfd = self.pidfd = None
        try:
            self.pidfd = os.dup(pidfd) if pidfd is not None else os.pidfd_open(expected['pid'])
            self.procfd = os.dup(procfd) if procfd is not None else os.open('/proc/' + str(expected['pid']),
                os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            os.set_inheritable(self.pidfd, False)
            os.set_inheritable(self.procfd, False)
            self.identity = tuple(os.fstat(self.procfd)[i] for i in (0, 1, 2))
            actual = proc_fields(read_at(self.procfd, 'stat'))
            require({k: actual[k] for k in self.expected} == self.expected, 'diagnostic initial process identity differs')
            self.sample()  # Refuse a stale/reused initial identity.
        except BaseException:
            self.close()
            raise

    def sample(self):
        poll = select.poll()
        poll.register(self.pidfd, select.POLLIN)
        if poll.poll(0):
            return {'status': 'exited-pinned-original'}
        before = proc_fields(read_at(self.procfd, 'stat'))
        require({k: before[k] for k in self.expected} == self.expected, 'diagnostic process identity changed')
        result = {'status': 'live-pinned-original', **before}
        for name in ('schedstat', 'io'):
            try:
                raw = read_at(self.procfd, name)
                if name == 'schedstat':
                    values = raw.split()
                    require(len(values) == 3 and all(v.isdigit() for v in values), 'invalid diagnostic scheduler counter')
                    result[name] = dict(zip(('runtimeNs', 'runnableWaitNs', 'timeslices'), map(int, values)))
                else:
                    result[name] = counters(raw)
            except FileNotFoundError:
                result[name] = {'unavailable': 'FileNotFoundError'}
        after = proc_fields(read_at(self.procfd, 'stat'))
        require({k: after[k] for k in self.expected} == self.expected and
                tuple(os.fstat(self.procfd)[i] for i in (0, 1, 2)) == self.identity,
                'diagnostic pinned identity changed during sample')
        result['sampleEndUserTicks'], result['sampleEndSystemTicks'] = after['userTicks'], after['systemTicks']
        return result

    def close(self):
        for name in ('procfd', 'pidfd'):
            value = getattr(self, name)
            if value is not None:
                os.close(value)
                setattr(self, name, None)


class SparseDiagnostics:
    def __init__(self, trace, phases):
        self.trace, self.phases = Path(trace), phases
        self.processes, self.samples, self.errors = {}, [], []
        self.lock, self.done, self.thread = threading.Lock(), threading.Event(), None
        self.stopped = False
        self.resource = os.open('/sys/fs/cgroup', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            own = proc_fields(Path('/proc/self/stat').read_text())
            self.bind('supervisor', own)
        except BaseException:
            os.close(self.resource)
            raise

    def bind(self, name, expected, procfd=None, pidfd=None):
        require(name in CONFIG['processes'], 'unknown diagnostic process role')
        with self.lock:
            require(name not in self.processes, 'diagnostic process role already pinned')
            self.processes[name] = PinnedProcess(expected, procfd, pidfd)

    def capture(self):
        require(len(self.samples) < MAX_SAMPLES, 'diagnostic sample count exceeds bound')
        started = time.monotonic_ns()
        sample = {'monotonicBeforeNs': started, 'wallNs': time.time_ns(),
                  'traceBytes': self.trace.stat().st_size, 'phaseEventCount': len(self.phases), 'processes': {}, 'resources': {}}
        with self.lock:
            for name, process in self.processes.items():
                try:
                    sample['processes'][name] = process.sample()
                except (OSError, RuntimeError, ValueError) as error:
                    sample['processes'][name] = {'diagnosticError': type(error).__name__ + ': ' + str(error)}
        for name in RESOURCE_NAMES:
            try:
                raw = read_at(self.resource, name)
                sample['resources'][name] = counters(raw) if name in {'cpu.stat', 'memory.events'} else raw.strip()
            except (OSError, RuntimeError, ValueError) as error:
                sample['resources'][name] = {'diagnosticError': type(error).__name__ + ': ' + str(error)}
        sample['monotonicAfterNs'] = time.monotonic_ns()
        self.samples.append(sample)

    def start(self):
        require(self.thread is None, 'diagnostic sampler already started')
        def work():
            try:
                # Relative waits avoid catch-up bursts if the observer itself is
                # delayed. Timing brackets retain actual overhead and intervals.
                self.capture()
                while not self.done.wait(PERIOD_NS / 1_000_000_000):
                    self.capture()
            except BaseException as error:
                self.errors.append(type(error).__name__ + ': ' + str(error))
        self.thread = threading.Thread(target=work, daemon=True)
        self.thread.start()

    def stop(self):
        if self.stopped:
            return
        self.done.set()
        if self.thread is not None:
            self.thread.join(timeout=1)
            require(not self.thread.is_alive(), 'diagnostic sampler did not stop')
            if len(self.samples) < MAX_SAMPLES:
                try:
                    self.capture()
                    self.samples[-1]['finalAfterOwnedSettlement'] = True
                except BaseException as error:
                    self.errors.append(type(error).__name__ + ': ' + str(error))
        self.stopped = True

    def retain_and_close(self, destination):
        self.stop()
        value = {'config': CONFIG, 'authority': 'none', 'samples': self.samples, 'errors': self.errors,
                 'pins': {name: {'expected': process.expected, 'procIdentity': list(process.identity)}
                          for name, process in self.processes.items()},
                 'samplerStopped': self.thread is None or not self.thread.is_alive()}
        try:
            Path(destination).write_text(json.dumps(value, separators=(',', ':')))
            Path(destination).chmod(0o600)
            return value
        finally:
            for process in self.processes.values():
                process.close()
            os.close(self.resource)
