"""Inert ownership/first-error model; no OS handles, launch adapter or authority.

This model is not imported by the observer. Its mutable objects and injected test
faults are trusted same-process fixtures, not containment or runtime capabilities.
"""
from offline_cleanup import CleanupScope


# Models the four existing pipe acquisitions, not a new execution budget.
PAIR_COUNT = 4


class PrivateFirstFailure:
    """Retain one original exception in memory, never serialize its contents.

    The exception may retain traceback frames and sensitive state. The caller must
    bound this holder's lifetime. This is not durable private evidence storage.
    """
    __slots__ = ('_error', '_phase')

    def __init__(self):
        self._error = self._phase = None

    def capture(self, phase, error):
        if type(phase) is not str or phase not in ('acquisition', 'body', 'cleanup'):
            raise ValueError('invalid private failure phase')
        if not isinstance(error, BaseException):
            raise ValueError('invalid private failure object')
        if self._error is None:
            self._phase, self._error = phase, error

    def original_error(self):
        """Private same-process inspection only; never used by public projection."""
        return self._error

    def public_report(self):
        return {'record': 'inert-first-failure-status', 'authority': 'none',
                'failurePresent': self._error is not None,
                'privateEvidencePersisted': False, 'observationAuthorized': False}

    def __repr__(self):
        return '<PrivateFirstFailure: private contents omitted>'

    def __reduce_ex__(self, protocol):
        raise TypeError('private failure serialization disabled')


class InertEndpoint:
    """A synthetic token; never a descriptor, PID, socket or release capability."""
    __slots__ = ('consumed', 'attempts', 'failure')

    def __init__(self):
        self.consumed = False
        self.attempts = 0
        self.failure = None

    def __repr__(self):
        return '<InertEndpoint: no OS resource>'


class InertAttempt:
    """Single-threaded pair-ownership model, deliberately without live adapters."""
    def __init__(self):
        self._scope = CleanupScope()
        self._failure = PrivateFirstFailure()
        self._pairs = 0
        self._closed = False
        self._result = None

    def _new_endpoint(self):
        return InertEndpoint()

    def _dispose_endpoint(self, endpoint):
        if endpoint.consumed:
            return
        # Consume first: failure can mean release already happened. Never retry.
        endpoint.consumed = True
        endpoint.attempts += 1
        if endpoint.failure is not None:
            raise endpoint.failure

    def _create_pair(self):
        first = self._new_endpoint()
        try:
            second = self._new_endpoint()
            return (first, second)
        except BaseException as error:
            # Factory owns anything it has not yet returned to the outer scope.
            self._failure.capture('acquisition', error)
            try:
                self._dispose_endpoint(first)
            except BaseException as cleanup_error:
                self._failure.capture('cleanup', cleanup_error)
            raise

    def _dispose_pair(self, pair):
        failed = False
        for endpoint in reversed(pair):
            try:
                self._dispose_endpoint(endpoint)
            except BaseException as error:
                self._failure.capture('cleanup', error)
                failed = True
        if failed:
            raise RuntimeError('inert pair cleanup uncertain') from None

    def _adopt_endpoint(self, endpoint):
        # Inert per-end setup only. Whole-pair ownership already belongs to scope.
        return endpoint

    def acquire_pair(self):
        if self._closed or self._failure.original_error() is not None or self._pairs >= PAIR_COUNT:
            error = RuntimeError('inert acquisition unavailable')
            if not self._closed:
                self._failure.capture('acquisition', error)
            raise error
        try:
            pair = self._scope.acquire(self._create_pair, self._dispose_pair)
            self._pairs += 1
            self._adopt_endpoint(pair[0])
            self._adopt_endpoint(pair[1])
            return pair
        except BaseException as error:
            self._failure.capture('acquisition', error)
            raise

    def capture_body_failure(self, error):
        if self._closed:
            raise RuntimeError('inert attempt closed')
        self._failure.capture('body', error)

    def private_first_error(self):
        return self._failure.original_error()

    def close(self):
        if self._closed:
            return dict(self._result)
        outcome = self._scope.close()
        self._closed = True
        self._result = {'record': 'inert-attempt-cleanup-model', 'authority': 'none',
                        'status': 'uncertain' if outcome.status == 'uncertain' or
                        self._failure.original_error() is not None else 'model-callbacks-returned',
                        'failurePresent': self._failure.original_error() is not None,
                        'processSettlementVerified': False, 'privateEvidencePersisted': False,
                        'observationAuthorized': False}
        return dict(self._result)

    def __enter__(self):
        self._scope.__enter__()
        return self

    def __exit__(self, kind, error, traceback):
        if kind is not None:
            self._failure.capture('body', error)
        result = self.close()
        if kind is None and result['status'] == 'uncertain':
            raise RuntimeError('inert attempt uncertain') from None
        return False
