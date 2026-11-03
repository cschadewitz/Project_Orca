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



# This bound is derived from the existing collector, not an artifact allocation.
# R=8192, S=62, three process roles, four resource files. A live role reads
# before-stat/schedstat/io/after-stat: 3*4+4 = 16 separately bounded read groups.
# ASCII JSON expands each read byte at most sixfold; quotes add two: G=6R+2.
# Each group below independently enforces its aggregate encoded-value envelope;
# per-field integer bounds alone would NOT justify this equation.
#
# Native metadata uses B=4R bits, covering <=R ASCII decimal digits (log2(10)<4)
# as well as native Linux process/stat/clock/len fields. Its signed decimal width
# is at most N=2+floor(B*30103/100000), since log10(2)<30103/100000.
# No int->str conversion occurs before this cheap magnitude check. Python's
# existing integer conversion guard remains enabled and can refuse sooner.
INTEGER_BITS = 4 * READ_BOUND
INTEGER_JSON_BOUND = 2 + INTEGER_BITS * 30103 // 100000
READ_JSON_BOUND = 6 * READ_BOUND + 2
MAX_COUNTER_PAIRS = (READ_BOUND + 1) // 4  # Minimal 'a 0\n', last LF optional.
_EXPECTED_KEYS = ('pid', 'starttime', 'ppid', 'pgrp', 'session')
_PROC_KEYS = ('pid', 'state', 'ppid', 'pgrp', 'session', 'starttime', 'userTicks',
              'systemTicks', 'minorFaults', 'majorFaults', 'rssPages')
_SCHED_KEYS = ('runtimeNs', 'runnableWaitNs', 'timeslices')
_AFTER_KEYS = ('sampleEndUserTicks', 'sampleEndSystemTicks')
_PROGRESS_KEYS = ('monotonicBeforeNs', 'wallNs', 'traceBytes', 'phaseEventCount', 'monotonicAfterNs')
_ROLES = ('supervisor', 'tracer', 'leader')
_ERROR_CODES = ('sampler-work-failed', 'final-sample-failed')
_CONFIG_FIELDS = tuple((k, tuple(v) if type(v) is list else v) for k, v in CONFIG.items())
_SOURCE_SAMPLES = MAX_SAMPLES


def _fixed_json_bytes(value):
    # Called only at import on the small literal schema, never candidate values.
    return len(json.dumps(value, separators=(',', ':')).encode('ascii'))


_PROC_FRAME_VALUE = {'status': 'live-pinned-original', **{k: 0 for k in _PROC_KEYS},
                     'schedstat': {k: 0 for k in _SCHED_KEYS}, 'io': {},
                     **{k: 0 for k in _AFTER_KEYS}}
_PROC_FRAME_VALUE['state'] = ''
# Strip ten before-stat integers + empty-state quotes + three scheduler integers,
# empty io braces + two after-stat integers; each goes in its read-group envelope.
PROCESS_JSON_FRAME = _fixed_json_bytes(_PROC_FRAME_VALUE) - (10 + 2 + 3 + 2 + 2)
PROCESS_JSON_BOUND = PROCESS_JSON_FRAME + 4 * READ_JSON_BOUND
_SAMPLE_FRAME_VALUE = {**{k: 0 for k in _PROGRESS_KEYS},
                       'processes': {k: None for k in _ROLES},
                       'resources': {k: None for k in RESOURCE_NAMES},
                       'finalAfterOwnedSettlement': True}
SAMPLE_JSON_FRAME = _fixed_json_bytes(_SAMPLE_FRAME_VALUE) - (5 + 3 * 4 + 4 * 4)
SAMPLE_JSON_BOUND = (SAMPLE_JSON_FRAME + 5 * INTEGER_JSON_BOUND +
                     3 * PROCESS_JSON_BOUND + 4 * READ_JSON_BOUND)
PIN_JSON_FRAME = _fixed_json_bytes({'expected': {k: 0 for k in _EXPECTED_KEYS},
                                   'procIdentity': [0, 0, 0]}) - 8
PINS_JSON_BOUND = (_fixed_json_bytes({k: None for k in _ROLES}) - 3 * 4 +
                   3 * (PIN_JSON_FRAME + 8 * INTEGER_JSON_BOUND))
ERRORS_JSON_BOUND = 2 + 1 + 2 * max(_fixed_json_bytes(e) for e in _ERROR_CODES)
CONFIG_JSON_BOUND = _fixed_json_bytes(CONFIG)
PACKET_JSON_FRAME = _fixed_json_bytes({'config': None, 'authority': 'none', 'samples': [],
                                      'errors': [], 'pins': {}, 'samplerStopped': True}) - (4 + 2 + 2 + 2)
DIAGNOSTIC_SERIALIZED_BOUND = (PACKET_JSON_FRAME + CONFIG_JSON_BOUND +
                             2 + _SOURCE_SAMPLES * SAMPLE_JSON_BOUND + (_SOURCE_SAMPLES - 1) +
                             ERRORS_JSON_BOUND + PINS_JSON_BOUND)
# Current terms in bytes: process frame270, sample frame238, pin frame81,
# pin role-map frame35, errors45, config450, outer81. Thus Q=836842 and
# total=81+450+(2+62*836842+61)+45+237062=52,121,905 bytes.
# Every admitted packet fits the equation above, including fallback
# status objects. Fixed schema frames deliberately overcount absent roles/final
# flags. This is serialized-file sizing, not a memory/quota/durability guarantee.


def _raw_ascii(raw):
    require(type(raw) is str and len(raw) <= READ_BOUND and raw.isascii(),
            'diagnostic source exceeds fixed ASCII read bound')


def _integer_width(value):
    require(type(value) is int and value.bit_length() <= INTEGER_BITS,
            'diagnostic integer exceeds source envelope')
    return 1 + value.bit_length() * 30103 // 100000 + (1 if value < 0 else 0)


def _text_width(value):
    _raw_ascii(value)
    return 6 * len(value) + 2


def _shape(value, names, exact=True):
    require(type(value) is dict and len(value) <= len(names), 'invalid bounded diagnostic shape')
    for key in value:
        require(type(key) is str and len(key) <= max(map(len, names)) and key in names,
                'invalid bounded diagnostic field')
    require(not exact or len(value) == len(names), 'missing bounded diagnostic field')


def _literal(value, expected):
    require(type(value) is type(expected) and
            (type(value) is not str or len(value) == len(expected)) and value == expected,
            'invalid fixed diagnostic value')
    return expected


def _marker(value, key, code):
    _shape(value, (key,))
    return {key: _literal(value[key], code)}


def _native_keys(value, maximum):
    # Validate BEFORE discriminator/expected-key lookups. Even an exact dict may
    # contain a custom hash-colliding key with an effectful __eq__. The aggregate
    # key-length check is a necessary part of the existing G-byte JSON envelope.
    require(type(value) is dict and len(value) <= maximum, 'invalid bounded diagnostic mapping')
    total = 0
    for key in value:
        require(type(key) is str and len(key) <= READ_BOUND, 'invalid bounded diagnostic key')
        total += len(key)
        require(total <= READ_JSON_BOUND and key.isascii(), 'invalid bounded diagnostic keys')


def _expected_snapshot(expected, exact=True):
    # Acquisition callers can carry extra provenance fields; only five fixed
    # native dictionary lookups are used, never an arbitrary graph traversal.
    _native_keys(expected, len(_PROC_KEYS))
    if exact:
        _shape(expected, _EXPECTED_KEYS)
    result = {}
    for key in _EXPECTED_KEYS:
        value = expected[key]  # A missing acquisition field retains its KeyError.
        _integer_width(value)
        result[key] = value
    return result


def _counter_snapshot(value):
    require(type(value) is dict and len(value) <= MAX_COUNTER_PAIRS,
            'diagnostic counter count exceeds source envelope')
    result, width = {}, 2
    for key, number in value.items():
        key_width, number_width = _text_width(key), _integer_width(number)
        require(number >= 0, 'invalid diagnostic counter value')
        width += key_width + 1 + number_width + (1 if result else 0)
        require(width <= READ_JSON_BOUND, 'diagnostic counter group exceeds read envelope')
        result[key] = number
    return result


def _sched_snapshot(value):
    _shape(value, (*_SCHED_KEYS, 'unavailable'), exact=False)
    if 'unavailable' in value:
        return _marker(value, 'unavailable', 'FileNotFoundError')
    _shape(value, _SCHED_KEYS)
    require(sum(_integer_width(value[k]) for k in _SCHED_KEYS) <= READ_JSON_BOUND,
            'diagnostic scheduler group exceeds read envelope')
    return {k: value[k] for k in value}


def _process_snapshot(value):
    _shape(value, ('status', *_PROC_KEYS, 'schedstat', 'io', *_AFTER_KEYS, 'diagnosticError'), exact=False)
    if 'diagnosticError' in value:
        return _marker(value, 'diagnosticError', 'process-sample-failed')
    if len(value) == 1:
        return _marker(value, 'status', 'exited-pinned-original')
    _shape(value, ('status', *_PROC_KEYS, 'schedstat', 'io', *_AFTER_KEYS))
    result = {'status': _literal(value['status'], 'live-pinned-original')}
    before_width = 0
    for key in _PROC_KEYS:
        before_width += _text_width(value[key]) if key == 'state' else _integer_width(value[key])
        require(before_width <= READ_JSON_BOUND, 'diagnostic stat group exceeds read envelope')
        result[key] = value[key]
    result['schedstat'] = _sched_snapshot(value['schedstat'])
    io = value['io']
    _native_keys(io, MAX_COUNTER_PAIRS)
    result['io'] = (_marker(io, 'unavailable', 'FileNotFoundError') if
                    'unavailable' in io else _counter_snapshot(io))
    require(sum(_integer_width(value[k]) for k in _AFTER_KEYS) <= READ_JSON_BOUND,
            'diagnostic end-stat group exceeds read envelope')
    result.update({k: value[k] for k in _AFTER_KEYS})
    return result


def _sample_snapshot(value):
    _shape(value, (*_PROGRESS_KEYS, 'processes', 'resources', 'finalAfterOwnedSettlement'), exact=False)
    require(all(k in value for k in (*_PROGRESS_KEYS, 'processes', 'resources')),
            'missing bounded diagnostic sample field')
    result = {}
    for key in _PROGRESS_KEYS:
        _integer_width(value[key])
        result[key] = value[key]
    _shape(value['processes'], _ROLES, exact=False)
    result['processes'] = {k: _process_snapshot(v) for k, v in value['processes'].items()}
    _shape(value['resources'], RESOURCE_NAMES)
    resources = {}
    for key, raw in value['resources'].items():
        if type(raw) is dict:
            _native_keys(raw, MAX_COUNTER_PAIRS)
        if type(raw) is dict and 'diagnosticError' in raw:
            resources[key] = _marker(raw, 'diagnosticError', 'resource-sample-failed')
        elif key in ('cpu.stat', 'memory.events'):
            resources[key] = _counter_snapshot(raw)
        else:
            _text_width(raw)
            resources[key] = raw
    result['resources'] = resources
    if 'finalAfterOwnedSettlement' in value:
        result['finalAfterOwnedSettlement'] = _literal(value['finalAfterOwnedSettlement'], True)
    return {key: result[key] for key in value}


def diagnostic_snapshot(samples, errors, processes):
    """Bounded native snapshot BEFORE JSON or encoded/output allocation.

    Exact builtins exclude custom iteration/conversion callbacks and deep graphs.
    Copying the stopped owner's containers prevents later input-container mutation
    from changing the validated serialization graph. Trusted owner/pin attribute
    access itself remains within the existing cooperative-process model.
    """
    require(type(samples) is list and len(samples) <= _SOURCE_SAMPLES and
            type(errors) is list and len(errors) <= 2, 'diagnostic packet count exceeds source envelope')
    _shape(processes, _ROLES, exact=False)
    _shape(CONFIG, tuple(k for k, _ in _CONFIG_FIELDS))
    config = {}
    for key, expected in _CONFIG_FIELDS:
        if type(expected) is tuple:
            raw = CONFIG[key]
            require(type(raw) is list and len(raw) == len(expected), 'invalid fixed diagnostic config')
            config[key] = [_literal(v, e) for v, e in zip(raw, expected)]
        else:
            config[key] = _literal(CONFIG[key], expected)
    error_snapshot = []
    for error in errors:
        require(type(error) is str and len(error) <= max(map(len, _ERROR_CODES)) and error in _ERROR_CODES,
                'invalid fixed diagnostic error code')
        error_snapshot.append(error)
    pins = {}
    for name, process in processes.items():
        expected, identity = process.expected, process.identity
        expected = _expected_snapshot(expected)
        require(type(identity) in (tuple, list) and len(identity) == 3,
                'invalid bounded diagnostic proc identity')
        for number in identity:
            _integer_width(number)
        pins[name] = {'expected': expected, 'procIdentity': list(identity)}
    return {'config': config, 'authority': 'none',
            'samples': [_sample_snapshot(value) for value in samples], 'errors': error_snapshot,
            'pins': pins, 'samplerStopped': True}


def _encode_diagnostic(samples, errors, processes):
    value = diagnostic_snapshot(samples, errors, processes)
    text = json.dumps(value, separators=(',', ':'))
    require(type(text) is str and len(text) <= DIAGNOSTIC_SERIALIZED_BOUND and text.isascii(),
            'diagnostic serialization exceeds source envelope')
    return value, text.encode('ascii')


def _read_own_stat():
    # The same owned reader/8192-byte sentinel/ASCII/consume-once close rules as
    # every other proc read; no unbounded Path.read_text during construction.
    return proc_fields(read_at(None, '/proc/self/stat'))


def _write_private_diagnostic(destination, payload):
    """Create the existing artifact once; trusted ancestors, no custody claim."""
    require(type(payload) is bytes, 'diagnostic writer requires encoded bytes')
    require(len(payload) <= DIAGNOSTIC_SERIALIZED_BOUND, 'diagnostic payload exceeds source envelope')
    number = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                     os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(number, 0o600)
        view, offset = memoryview(payload), 0
        while offset < len(view):
            written = os.write(number, view[offset:])
            require(type(written) is int and 0 < written <= len(view) - offset,
                    'diagnostic writer made invalid progress')
            offset += written
        os.fsync(number)
    except BaseException:
        try:
            os.close(number)
        except BaseException:
            # A consumed close is never retried. Keep the original private error.
            pass
        raise
    else:
        # A close failure also refuses success; its outcome may be ambiguous.
        os.close(number)


def read_at(directory, name):
    number = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        value = os.read(number, READ_BOUND + 1)
        require(len(value) <= READ_BOUND, 'diagnostic counter exceeds fixed read bound')
        value = value.decode('ascii')
    except BaseException:
        try:
            os.close(number)
        except BaseException:
            # Keep the original read/bound/decode error, never format private
            # errors or retry a close which may already have released the FD.
            pass
        raise
    else:
        try:
            os.close(number)
        except BaseException:
            # The original close exception remains private implicit context;
            # display only fixed text and never return apparently valid data.
            raise RuntimeError('diagnostic reader cleanup uncertain') from None
        return value


def counters(raw):
    _raw_ascii(raw)
    result = {}
    for line in raw.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1].isdigit():
            result[fields[0].rstrip(':')] = int(fields[1])
    return result


def proc_fields(raw):
    _raw_ascii(raw)
    fields = raw[raw.rindex(')') + 2:].split()
    return {'pid': int(raw.split(' ', 1)[0]), 'state': fields[0],
            'ppid': int(fields[1]), 'pgrp': int(fields[2]), 'session': int(fields[3]),
            'starttime': int(fields[19]), 'userTicks': int(fields[11]), 'systemTicks': int(fields[12]),
            'minorFaults': int(fields[7]), 'majorFaults': int(fields[9]), 'rssPages': int(fields[21])}


class PinnedProcess:
    def __init__(self, expected, procfd=None, pidfd=None):
        self.procfd = self.pidfd = None
        self._first_failure = self._cleanup_error = None
        try:
            self.expected = _expected_snapshot(expected, exact=False)
            self.pidfd = os.dup(pidfd) if pidfd is not None else os.pidfd_open(self.expected['pid'])
            self.procfd = os.dup(procfd) if procfd is not None else os.open('/proc/' + str(self.expected['pid']),
                os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            os.set_inheritable(self.pidfd, False)
            os.set_inheritable(self.procfd, False)
            self.identity = tuple(os.fstat(self.procfd)[i] for i in (0, 1, 2))
            actual = proc_fields(read_at(self.procfd, 'stat'))
            require({k: actual[k] for k in self.expected} == self.expected, 'diagnostic initial process identity differs')
            self.sample()  # Refuse a stale/reused initial identity.
        except BaseException as error:
            self._first_failure = error
            try:
                self.close()
            except BaseException:
                # close consumes both owned slots and privately retains the first
                # disposal error. Preserve the original constructor exception.
                pass
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
                    _raw_ascii(raw)
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
                setattr(self, name, None)
                try:
                    os.close(value)
                except BaseException as error:
                    if self._cleanup_error is None:
                        self._cleanup_error = error
        if self._cleanup_error is not None:
            raise RuntimeError('diagnostic pin cleanup uncertain') from None


class SparseDiagnostics:
    def __reduce_ex__(self, protocol):
        raise TypeError('private diagnostic owner serialization disabled') from None

    def __init__(self, trace, phases):
        self.resource = None
        self._first_failure = self._cleanup_error = None
        self._collection_failure = None
        self._retention_state = 'ready'
        self.trace, self.phases = Path(trace), phases
        self.processes, self.samples, self.errors = {}, [], []
        self.lock, self.done, self.thread = threading.Lock(), threading.Event(), None
        self.stopped = False
        try:
            self.resource = os.open('/sys/fs/cgroup', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            own = _read_own_stat()
            self.bind('supervisor', own)
        except BaseException as error:
            if self._first_failure is None:
                self._first_failure = error
            # Failed construction has no sampler. Consume registered ownership
            # before disposal, including successful bind followed by lock-exit failure.
            while self.processes:
                _, process = dict.popitem(self.processes)
                self._rollback_pin(process)
            resource, self.resource = self.resource, None
            if resource is not None:
                try:
                    os.close(resource)
                except BaseException as cleanup:
                    if self._cleanup_error is None:
                        self._cleanup_error = cleanup
            raise

    def _rollback_pin(self, process):
        try:
            process.close()
        except BaseException as error:
            if self._cleanup_error is None:
                self._cleanup_error = error

    def bind(self, name, expected, procfd=None, pidfd=None):
        require(name in CONFIG['processes'], 'unknown diagnostic process role')
        failure = None
        try:
            with self.lock:
                try:
                    require(name not in self.processes, 'diagnostic process role already pinned')
                    process = PinnedProcess(expected, procfd, pidfd)
                    try:
                        self.processes[name] = process
                    except BaseException:
                        # This internally owned dict may contain a partial insertion.
                        # Detach only our pin, using native dict rollback operations.
                        if dict.get(self.processes, name) is process:
                            dict.pop(self.processes, name)
                        self._rollback_pin(process)
                        raise
                except BaseException as error:
                    failure = error
                    raise
        except BaseException as error:
            original = failure if failure is not None else error
            if self._first_failure is None:
                self._first_failure = original
            if original is not error:
                # A secondary lock-exit failure cannot replace the original error.
                raise original from None
            raise

    def _remember_collection_failure(self, error):
        """Caller holds self.lock; order is recording order, not global chronology.

        Separate from constructor/bind/retention failures: those owners retain their
        existing error precedence and never race this collection-owned slot.
        """
        if self._collection_failure is None:
            self._collection_failure = error

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
                    self._remember_collection_failure(error)
                    sample['processes'][name] = {'diagnosticError': 'process-sample-failed'}
        for name in RESOURCE_NAMES:
            try:
                raw = read_at(self.resource, name)
                sample['resources'][name] = counters(raw) if name in {'cpu.stat', 'memory.events'} else raw.strip()
            except (OSError, RuntimeError, ValueError) as error:
                with self.lock:
                    self._remember_collection_failure(error)
                    sample['resources'][name] = {'diagnosticError': 'resource-sample-failed'}
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
                with self.lock:
                    self._remember_collection_failure(error)
                    self.errors.append('sampler-work-failed')
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
                    with self.lock:
                        self._remember_collection_failure(error)
                        self.errors.append('final-sample-failed')
        self.stopped = True

    def retain_and_close(self, destination):
        require(self._retention_state == 'ready', 'diagnostic retention already attempted')
        # One attempt only, including uncertain ownership. No retry of stop,
        # file publication or potentially consumed handles follows a failure.
        self._retention_state = 'uncertain'
        thread = self.thread
        disposable, primary, value = False, None, None
        try:
            try:
                self.stop()
            except BaseException:
                # With any sampler object present, stop failure leaves ownership
                # uncertain even if it may have finished. Do not infer settlement.
                disposable = thread is None and self.thread is None
                raise
            require(self.thread is thread, 'diagnostic sampler ownership uncertain')
            if thread is not None:
                require(thread.ident is not None and thread.is_alive() is False,
                        'diagnostic sampler ownership uncertain')
            disposable = True
            value, payload = _encode_diagnostic(self.samples, self.errors, self.processes)
            _write_private_diagnostic(Path(destination), payload)
        except BaseException as error:
            primary = error
            if self._first_failure is None:
                self._first_failure = error
        finally:
            if disposable:
                self._retention_state = 'consumed'
                while self.processes:
                    _, process = dict.popitem(self.processes)
                    self._rollback_pin(process)
                resource, self.resource = self.resource, None
                if resource is not None:
                    try:
                        os.close(resource)
                    except BaseException as error:
                        if self._cleanup_error is None:
                            self._cleanup_error = error
        if primary is not None:
            raise primary
        if self._cleanup_error is not None:
            raise RuntimeError('diagnostic retention cleanup uncertain') from None
        return value
