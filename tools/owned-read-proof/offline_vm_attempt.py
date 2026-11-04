"""Non-authoritative single-threaded VM-attempt specimen; no runtime integration.

Only closed synthetic records cross the inert acknowledgment boundary. The port is
a trusted test fixture, never an issuer, manager, live transport or custody adapter.
There is no load/resume API, launch callback, arbitrary payload or external ID.
"""
from enum import Enum

from offline_attempt_model import PrivateFirstFailure


class Event(Enum):
    RESERVED = 'reserved'
    BOOTSTRAP_INTENT = 'bootstrap-intent'
    BOOTSTRAP_RECORDED = 'bootstrap-recorded'
    CONNECTED_INTENT = 'connected-intent'
    CONNECTED_RECORDED = 'connected-recorded'
    UNCERTAIN = 'uncertain'


SEQUENCE = tuple(event for event in Event if event is not Event.UNCERTAIN)
FRAMES = {event: ('inert-vm-attempt/1\n' + event.value + '\n').encode('ascii') for event in Event}
# Synthetic-fixture allocation ONLY. Conservatively charge temporary + published
# bytes separately, even if a filesystem fixture publishes via a hard link.
# Includes a dedicated uncertainty slot; none of this borrows observer capacity.
FIXTURE_BYTES = 2 * sum(map(len, FRAMES.values()))
FIXTURE_FILES = 1 + 2 * len(FRAMES)  # exclusive reservation marker + two names/record


class SpecimenRefusal(RuntimeError):
    """Fixed public diagnostic; original errors remain private and process-local."""


class InertAcknowledgment:
    """No callable transport, endpoint, command, descriptor or management API."""
    def acknowledge(self, event):
        if type(event) is not Event:
            raise SpecimenRefusal('invalid inert event')
        return None


class MemoryEvidenceFixture:
    """Bounded create-only bytes for tests; no physical durability or quota claim.

    Factory failure owns any unreturned resource. Fixtures may inject failures;
    methods are trusted same-process dependencies, not a hostile-code boundary.
    """
    def __init__(self, byte_capacity=FIXTURE_BYTES, file_capacity=FIXTURE_FILES):
        self.byte_capacity = byte_capacity
        self.file_capacity = file_capacity
        self.reserved = False
        self.temporary = {}
        self.published = {}
        self.closed = set()
        self.calls = []

    def reserve(self):
        self.calls.append('reserve')
        if (self.reserved or type(self.byte_capacity) is not int or
                type(self.file_capacity) is not int or self.byte_capacity != FIXTURE_BYTES or
                self.file_capacity != FIXTURE_FILES):
            raise SpecimenRefusal('fixture reservation unavailable')
        self.reserved = True

    def create(self, event):
        self.calls.append('create')
        if not self.reserved or type(event) is not Event or event in self.temporary:
            raise SpecimenRefusal('fixture create refused')
        self.temporary[event] = bytearray()
        return event

    def write(self, handle, data):
        self.calls.append('write')
        if (handle in self.closed or type(data) is not bytes or not data or
                len(self.temporary[handle]) + len(data) > len(FRAMES[handle])):
            raise SpecimenRefusal('fixture write refused')
        self.temporary[handle].extend(data)
        return len(data)

    def sync_file(self, handle):
        self.calls.append('file-sync')
        if bytes(self.temporary[handle]) != FRAMES[handle]:
            raise SpecimenRefusal('incomplete fixture frame')

    def publish(self, handle):
        self.calls.append('publish')
        if handle in self.published:
            raise SpecimenRefusal('fixture publication exists')
        self.published[handle] = bytes(self.temporary[handle])

    def sync_directory(self):
        self.calls.append('directory-sync')

    def close(self, handle):
        self.calls.append('close')
        if handle in self.closed:
            raise SpecimenRefusal('fixture handle consumed')
        self.closed.add(handle)


class AttemptSpecimen:
    """One original fixture attempt, with absorbing uncertainty and no replay.

    A model outcome is caller-supplied bookkeeping, never settlement or authority.
    Existing original-bootstrap graph obligations cannot be satisfied by this class.
    """
    def __init__(self, fixture, acknowledgment):
        if not isinstance(fixture, MemoryEvidenceFixture) or not isinstance(acknowledgment, InertAcknowledgment):
            raise SpecimenRefusal('inert fixtures required')
        self._fixture, self._ack = fixture, acknowledgment
        self._position = 0
        self._busy = self._uncertain = False
        self._first = PrivateFirstFailure()

    def _capture(self, error):
        self._uncertain = True
        self._first.capture('body', error)

    def _call(self, operation, *args):
        result = operation(*args)
        if self._uncertain:
            raise SpecimenRefusal('inert attempt uncertain')
        return result

    def record(self, event):
        if (self._busy or self._uncertain or self._position == len(SEQUENCE) or
                type(event) is not Event or
                (event is Event.UNCERTAIN and self._position == 0) or
                (event is not Event.UNCERTAIN and event is not SEQUENCE[self._position])):
            self._capture(SpecimenRefusal('inert transition refused'))
            raise SpecimenRefusal('inert transition refused') from None
        self._busy = True
        handle = None
        try:
            if event is Event.RESERVED:
                self._call(self._fixture.reserve)
            # Adopt a returned handle before checking a reentrant fixture refusal.
            handle = self._fixture.create(event)
            if self._uncertain:
                raise SpecimenRefusal('inert attempt uncertain')
            data = FRAMES[event]
            offset = 0
            while offset < len(data):
                count = self._call(self._fixture.write, handle, data[offset:])
                if type(count) is not int or not 0 < count <= len(data) - offset:
                    raise SpecimenRefusal('incomplete fixture write')
                offset += count  # finite positive progress, never retry an exception
            self._call(self._fixture.sync_file, handle)
            self._call(self._fixture.publish, handle)
            self._call(self._fixture.sync_directory)
        except BaseException as error:
            self._capture(error)
        finally:
            if handle is not None:
                # Consume before close; ambiguous release is never retried.
                consumed, handle = handle, None
                try:
                    self._fixture.close(consumed)
                except BaseException as error:
                    self._capture(error)
            self._busy = False
        if self._uncertain:
            raise SpecimenRefusal('inert attempt uncertain') from None
        # The original record may already exist when this acknowledgment is lost.
        # No rollback, overwrite, reload, resend or automatic relaunch follows.
        self._busy = True
        try:
            if self._call(self._ack.acknowledge, event) is not None:
                raise SpecimenRefusal('inert acknowledgment unavailable')
            if event is Event.UNCERTAIN:
                self._uncertain = True
            else:
                self._position += 1
        except BaseException as error:
            self._capture(error)
            raise SpecimenRefusal('inert attempt uncertain') from None
        finally:
            self._busy = False

    def private_first_error(self):
        return self._first.original_error()

    def report(self):
        return {'record': 'inert-vm-attempt-specimen', 'authority': 'none',
                'acknowledgedModelRecords': self._position,
                'status': 'uncertain' if self._uncertain else 'model-only',
                'observationAuthorized': False, 'processSettlementVerified': False,
                'custodyIntegrationVerified': False, 'durableMediaVerified': False}

    def __reduce_ex__(self, protocol):
        raise TypeError('attempt specimen serialization disabled')
