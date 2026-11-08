"""Explicit offline selection for the guard-qualification preparation modules.

Run from this directory with an outer bound: `timeout 180 python3 check_offline.py`
and again with `python3 -O`. Nothing here launches a candidate image, observer,
tracer or provider; containment tests launch only synthetic probe programs.
Missing node, unshare or user namespaces are failures, never skips.
"""
import sys
import unittest

TESTS = (
    'test_reasons',
    'test_identity',
    'test_authority',
    'test_journal',
    'test_ledger',
    'test_loader',
    'test_containment',
)


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('offline selection accepts no extra test names or arguments')
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(TESTS))
    if result.skipped:
        raise SystemExit('skips are not permitted in this selection')
    raise SystemExit(0 if result.wasSuccessful() else 1)
