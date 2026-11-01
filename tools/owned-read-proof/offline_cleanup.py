"""One-shot synchronous cleanup for offline inspection, never process settlement.

Factories/disposers are trusted same-process functions, not commands or authority.
A factory that raises must clean resources it never returned. This owner cannot
discover hidden resources or prove that a callback actually released an OS object.
"""
from dataclasses import dataclass


# Existing inspector maximum: root + 32 path components + two FDs per image file.
MAX_RESOURCES = 1 + 32 + 2 * 3
_UNSET = object()


@dataclass(frozen=True)
class CleanupOutcome:
    status: str
    attempted: int
    failed: int

    def report(self):
        return {'record': 'offline-cleanup-callback-outcome', 'status': self.status,
                'attempted': self.attempted, 'failed': self.failed,
                'authority': 'none', 'processSettlementVerified': False}


class CleanupScope:
    """Single-threaded owner; no transfer, retry, worker or process API.

    A returned resource is registered before acquire() returns to its caller.
    Terminal outcomes are stable, including uncertainty. No numeric handle is
    retried after its cleanup callback may already have released/reused it.
    """
    def __init__(self):
        self._state, self._items = 'open', []
        self._acquiring = self._entered = self._uncertain = False
        self._outcome = None

    def _unavailable(self):
        if self._state != 'closed':
            self._uncertain = True
        raise RuntimeError('offline cleanup scope unavailable')

    def acquire(self, factory, dispose):
        if (self._state != 'open' or self._acquiring or self._uncertain or
                len(self._items) >= MAX_RESOURCES or not callable(factory) or not callable(dispose)):
            self._unavailable()
        self._acquiring = True
        try:
            # Reserve storage before acquisition, so registration allocation
            # failure cannot strand a newly returned resource.
            entry = [dispose, _UNSET]
            self._items.append(entry)
            resource = factory()
            entry[1] = resource
            return resource
        except BaseException:
            self._uncertain = True
            raise
        finally:
            self._acquiring = False

    def close(self):
        if self._state == 'closed':
            return self._outcome
        if self._state != 'open' or self._acquiring:
            self._unavailable()
        self._state = 'closing'
        attempted = failed = 0
        while self._items:
            # Consume before invoking: a failing/reentrant callback is never retried.
            dispose, resource = self._items.pop()
            if resource is _UNSET:
                continue
            attempted += 1
            try:
                if dispose(resource) is not None:
                    failed += 1
            except BaseException:
                failed += 1
        self._outcome = CleanupOutcome('uncertain' if failed or self._uncertain else 'callbacks-returned',
                                       attempted, failed)
        self._state = 'closed'
        return self._outcome

    def __enter__(self):
        if self._state != 'open' or self._entered or self._acquiring or self._uncertain:
            self._unavailable()
        self._entered = True
        return self

    def __exit__(self, kind, error, traceback):
        outcome = self.close()
        # Preserve an original body failure privately; never stringify it. If
        # cleanup alone fails, prevent returning the body's apparent success.
        if outcome.status == 'uncertain' and kind is None:
            raise RuntimeError('offline cleanup uncertain') from None
        return False
