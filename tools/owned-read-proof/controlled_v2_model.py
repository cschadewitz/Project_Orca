"""Fixed current-source semantic model for offline preparation only.

These selectors never enter the launcher or ConnectedDesignation. All results
remain non-authoritative; source correspondence is not an observation.
"""
from controlled_contract import require
from controlled_timestamps import _source_binding, validate_clock, OWNER_NS

SOURCE = '4ebf382fe6738bb11268b47b048a3d7c7a6f2586'
PRODUCER_INPUT_SHA = '9d96cddcbbc4ebe5c67657a94b7d219d534196db76cb440476f90c9d69ca0d4d'
CHILD_SHA = '17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13'
MS = 1_000_000


def expiry_bound(original, creation_ns, expiry_ns):
    _source_binding(original, SOURCE, PRODUCER_INPUT_SHA, CHILD_SHA)
    start, finish = validate_clock(original)
    require(all(type(v) is int for v in (creation_ns, expiry_ns)) and
            start <= creation_ns <= finish < expiry_ns <= creation_ns + OWNER_NS,
            'v2 action expiry outside original timestamped bound')


def model(standing_v2):
    require(type(standing_v2) is bool, 'explicit finite semantic model required')
    return standing_v2
