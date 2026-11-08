"""Fixed budgets for the guard-qualification preparation modules.

The first group mirrors limits already documented for the controlled owned-read
lane (draft PR #809, tools/owned-read-proof): they are copied, never widened, and
BoundsTests in test_reasons.py pin the values. The second group consists of new bounds that only
restrict this preparation code; none of them extends an existing owner, run,
trace, metadata, process or cleanup budget.
"""

NS = 1_000_000_000

# Mirrored existing limits (controlled_timestamps.py / controlled_supervisor.py /
# offline_cleanup.py / check_nonlive.py on prep/706-current-main-nonlive).
OWNER_NS = 55 * NS
RUN_NS = 60 * NS
RUNTIME_ASSET_LIMIT = 256 * 1024 * 1024
MAX_RUNTIME_ASSETS = 32
REPORT_LIMIT = 1024 * 1024
ORIGINAL_METADATA_LIMIT = 1024 * 1024
CLOCK_PROBE_TRACE_LIMIT = 1024 * 1024
MAX_CLEANUP_RESOURCES = 1 + 32 + 2 * 3
NONLIVE_OUTER_SECONDS = 180
MODULE_OUTER_SECONDS = 60
WORKER_JOIN_SECONDS = 1

# New, restrictive bounds for this preparation only.
JOURNAL_LINE_LIMIT = 4096
JOURNAL_RECORD_LIMIT = 4096
JOURNAL_BYTES_LIMIT = REPORT_LIMIT
AUTHORIZATION_MAX_LIFETIME_MS = 10 * 60 * 1000
AUTHORIZATION_STATEMENT_LIMIT = 16 * 1024
PRIVATE_EVIDENCE_LIMIT = REPORT_LIMIT + CLOCK_PROBE_TRACE_LIMIT
LOADER_MODULE_LIMIT = MAX_RUNTIME_ASSETS
PREFLIGHT_SECONDS = 5
SNAPSHOT_MAX_FILES = LOADER_MODULE_LIMIT + 2  # reviewed modules plus loader and manifest
SNAPSHOT_BYTE_LIMIT = RUNTIME_ASSET_LIMIT
PROCESS_KILL_WAIT_SECONDS = WORKER_JOIN_SECONDS
MAX_OWNED_PROCESSES = 8
OBSERVER_MAX_SILENCE_NS = WORKER_JOIN_SECONDS * NS  # longest allowed gap between observer records
