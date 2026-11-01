"""Explicit non-live test selection; never use full discovery for this checklist.

Run with an outer 180-second bound. The four real-tracer cases in batch_transfer,
intervals and cleanup are deliberately not selected. Image compatibility failures
remain failures; historical positives are not skipped or marked expectedFailure.
"""
import sys
import unittest

TESTS = (
    'test_bootstrap_receipt_child',
    'test_child_stat_observations',
    'test_controlled_aggregate',
    'test_controlled_connected',
    'test_controlled_contract',
    'test_controlled_delivery_semantics',
    'test_controlled_diagnostics',
    'test_controlled_image_pins',
    'test_controlled_notifications',
    'test_controlled_replay',
    'test_controlled_save_semantics',
    'test_controlled_semantics',
    'test_controlled_timestamps',
    'test_current_main_preparation',
    'test_current_image_inspection',
    'test_offline_cleanup_privacy',
    'test_offline_attempt_model',
    'test_current_qualification_boundaries',
    'test_controlled_v2_semantics',
    'test_kernel_causality',
    'test_kernel_runtime_queries',
    'test_observer',
    'test_zero_private_wake',
    'test_cleanup.CleanupTests.test_reaped_tracer_never_signals_late_group',
    'test_cleanup.CleanupTests.test_no_exitkill_fails_closed',
    'test_cleanup.CleanupTests.test_unsettled_preserves_directory',
)


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('non-live selection accepts no extra test names or arguments')
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(TESTS))
    raise SystemExit(0 if result.wasSuccessful() else 1)
