# Scripted-agent shared-counter correction

Base: freshly fetched main `f5680cfc996efc15bd0da019b9a32d06912a16ce`,
which contains the supplied `ec015d351db610dcd9ce4c689f2dcd4aca4c192b` checkpoint.
The correction is separate from [held PR #663](https://github.com/cschadewitz/Project_Orca/pull/663).

## Source contract and lock review

`packages/testing/src/scripted-agent/agent.ts` used to load the whole JSON state
before asynchronous deliverable work, then save the modified snapshot at the end.
A reviewer paused after reading empty state can overwrite a tester's committed
`test-report: 1`, so the next tester repeats its first failing playbook entry.
This affects different-kind as well as same-kind updates.

The correction uses the existing exported `@orca/store.withFileLock` around the
whole read/derive/work/commit callback, after creating the state parent directory.
Its awaited callback and `finally` cleanup cover notifications, permission responses,
file errors and normal cancellation. It uses the existing exact owner-token/PID
recovery rules, not age-based eviction. Testing adds one declared workspace dependency
and project reference; the frozen lockfile changes only that workspace link.
No provider, runtime activation, protection, workflow or playbook source changes.

The counter save stays after deliverable work. Errors before that save commit none
of the prompt's increments, even after an earlier file write. Cancellation observed
at the existing pre-write checkpoint leaves that entry unconsumed while saving earlier
entries. Skips and denied
permissions still consume entries; cancellation during a pending permission response
retains the existing consumption behavior. No-state prompts still reset counters.
This is not a crash-atomic artifact/counter transaction. A hung holder can delay other
turns until termination or the existing 60-second acquisition timeout. Cancelled
waiters reach the existing cancellation check after acquiring; ACP grace/termination
still applies. Unknown/live/empty/malformed owners fail closed. See the detailed
contract in [Development](../DEVELOPMENT.md#the-scripted-agent).

## Regression evidence

`packages/testing/test/scripted-agent-state.test.ts` uses real independent ACP
subprocesses, with an awaited permission response as a controlled post-read barrier.
On unmodified base source, both controlled overlap tests fail: the reviewer case
observes `false:1` instead of the next `true:2`; the same-kind case also repeats
`false:1`. Before correction, the original ten-case suite had four failures and six
passes, including duplicate occurrences `[1, 1, 2, 2]` in the eight-process case.
The corrected thirteen-case suite passes locally, including independent same/different
kind increments, absent-state initialization, write-error whole-prompt rollback,
failed state save, cancellation observed at the existing pre-write checkpoint, partial
completion, cancellation
while waiting, cancellation during permission response, skips/denials, no-state/no-
deliverables behavior and recovery after terminating a deliberately hung test child.

Reproduce: `pnpm exec vitest run packages/testing/test/scripted-agent-state.test.ts --maxWorkers=2`.
Tests are bounded and use only temporary fixtures; no provider credentials are used.

## Bounded corrected-source demo parity

[Machine-readable results](2026-10-25-scripted-agent-counter-parity.json) record two
sequential normal compiled demos and two sequential demos with the exact lifecycle
preload from PR #663 head `d3543733b05335b1629dc795404b031a53a7fc66`.
Its SHA-256 is `3081716b64e2ece587bf02486300fed401db826d1debabe4d6175fdc773a7cf4`.
The Node 24.19.0 Linux build used a fresh isolated pnpm 12.4.2 frozen install with
supply-chain policy checks enabled. Each child used the unchanged compiled command
`node packages/cli/dist/main.js demo --dir <fresh-temp-dir> --keep --quiet`, with
`--import <exact-preload>` only in preload mode. Each kept the 50-second CLI bound.
The dedicated fd 3 receipt was validated for exact keys, nonce, PID, cwd, entry,
preload digest, successful exit and positive child monotonic interval.

All four demos exited zero and produced exactly **29 artifacts**; both modes totaled
**58**. The existing PR #663 semantic oracle was reused unchanged: generated IDs,
provenance and times are normalized, while front matter, prose, kind, name and
multiplicity are retained. All four signatures equal
`ec72d1f4cd300ea6fd291cd29fc79179a48f91522ff16dce73a4dc3a34fea6ba`.
Work oracles match: `docs`, `login-api` and `schema` are all done.
Every final counter matches, including `test-report: 4`, `implementation: 4`,
`review: 3`, `spec: 3`, `plan: 4` and `intent: 3`. Playbook bytes and configs with
only their fresh root paths normalized also match. See JSON for all counter values,
configuration/playbook hashes and per-run timings (about 13–16 seconds).

This proves this corrected-source Linux comparison; it does not identify the exact
historical 32-artifact interleaving. It does not establish Windows acceptance,
complete execution-graph equivalence, memory budgets, elapsed/overhead gates, fault
cells or diagnostic overlap. PR #663 stays held. Its source/compiled provenance must
be deliberately updated only after this fix is reviewed and merged; no candidate
repin, Windows dispatch or relaxation of the original 29/58, semantic/work, memory,
timing or fault gates is included.

## Retained evidence and reconstruction limits

The JSON now includes each original run's normalized work-item and counter snapshots
and each preload run's parsed lifecycle receipt. These values were copied from the
existing report; no demo or broad experiment was rerun for this reconciliation.
The [evidence directory](evidence/2026-10-25-scripted-agent-counters) retains the
original report bytes as deterministic gzip, the exact executed bounded runner as
`parity-runner.mjs.txt`, and the exact preload as `cli-lifecycle-preload.mjs.txt`.
The `.txt` suffix preserves their original bytes and formatting as execution evidence;
they are not imported or run by the test suite. The JSON records their hashes,
original command/cwd, build command/worktree/commit and execution root. The original
build commit's agent implementation is byte-identical to `cc67cf19`; the reconciliation
changes only documentation and retained evidence.

The exact recorded command was
`node /tmp/orca-counter-parity.mjs > /tmp/orca-counter-demo-parity.log 2>&1`.
The retained runner contains its literal paths, four-run schedule, fresh-directory
creation, 50-second bound, fd 3 size/key/binding/exit/interval checks and unchanged
normalization/oracle. It is archived for inspection, not rerun by these checks.

Raw fd 3 byte streams and independent expected launch nonce/PID values were **not
separately persisted**. The runner records the live comparisons with its generated
binding and actual `child.pid`; the parsed receipts alone cannot independently
re-attest those two bindings. Their exact keys, nonce/PID shape, entry, cwd, preload
digest, exit and positive interval can be checked offline. Full artifact bodies,
compiled inventories and child stdout/stderr are not included in this compact archive;
no broader provenance/graph or C15 acceptance claim is added.

For example, the following offline check recomputes work/counter equality and checks
the retained receipt fields without launching a demo or trusting the equality flags:

```sh
python3 - <<'PY'
import gzip, hashlib, json, pathlib, re
p = pathlib.Path('docs/reviews/2026-10-25-scripted-agent-counter-parity.json')
s = json.loads(p.read_text())
e = s['retainedEvidence']
d = p.parent / e['directory']
archive = (d / e['rawReportArchive']).read_bytes()
assert hashlib.sha256(archive).hexdigest() == e['archiveSha256']
raw = gzip.decompress(archive)
assert hashlib.sha256(raw).hexdigest() == e['rawReportSha256']
assert hashlib.sha256((d / e['runner']).read_bytes()).hexdigest() == e['runnerSha256']
assert hashlib.sha256((d / e['preload']).read_bytes()).hexdigest() == s['preloadSha256']
r = json.loads(raw)
assert len(r['rows']) == len(s['rows']) == 4
for x, y in zip(r['rows'], s['rows']):
    assert (x['mode'], x['index']) == (y['mode'], y['index'])
    assert x['oracle']['workItems'] == y['workItems'] == s['sharedWorkItems']
    assert x['counts'] == y['counts'] == s['sharedFinalCounts']
    assert x['oracle']['artifactCount'] == y['artifactCount'] == 29
    assert x['exitCode'] == y['exitCode'] == 0
    if x['mode'] == 'normal':
        assert 'lifecycleReceipt' not in x and 'lifecycleReceipt' not in y
        continue
    a = x['lifecycleReceipt']
    assert a == y['lifecycleReceipt']
    assert set(a) == {'schema', 'nonce', 'entry', 'cwd', 'preloadSha256',
                      'pid', 'startedNs', 'endedNs', 'exitCode'}
    assert a['schema'] == 1 and a['exitCode'] == x['exitCode']
    assert re.fullmatch(r'[0-9a-f-]{36}', a['nonce'])
    assert isinstance(a['pid'], int) and a['pid'] > 0
    assert a['entry'] == e['buildWorktree'] + '/packages/cli/dist/main.js'
    assert a['cwd'] == e['originalExecutionRoot'] + '/preload-' + str(x['index'])
    assert a['preloadSha256'] == s['preloadSha256']
    assert 0 <= int(a['startedNs']) < int(a['endedNs'])
for mode in ('normal', 'preload'):
    assert sum(x['oracle']['artifactCount'] for x in r['rows'] if x['mode'] == mode) == 58
print('PASS: retained hashes, per-run work/counters, 29/58 and receipt fields')
PY
```
