# Phased ownership and acceptance handoff

Casey approved configurable rolling history with a five-minute default on 2026-10-03;
this supersedes the one-shot-only recommendation. Other policy details remain pending.
This is a proposed future division of work, not permission to implement or an assignment
of GitHub users. #416 integration owner freezes the accepted policy revision and rechecks
the current source before runtime work. MCP remains the priority; avoid its active files.

## Ordered slices

1. **Safe producers and authority contract.** Protocol/privacy reviewer freezes the closed
   observation DTO, enum provenance and pre-handshake unknown gates. App-main owner supplies
   startup/connection/platform facts; daemon/runtime owner supplies only already authorized
   typed outcomes. New producer modules/tests can be isolated; existing handshake, methods,
   auth/control, read-model, IPC/barrels and shared wiring remain integrator-owned.
   Do not name a future RPC as shipped, broaden permissions, scan stores or ingest logs.
2. **Protected ephemeral handling.** App-main/platform owner implements the reviewed rolling
   state machine: explicit session opt-in, configurable five-minute default, bounded
   volatile ring, expiry/omissions and separate immutable preview/save. No persistent
   history or keys for the proposed volatile profile. Persistent crash-surviving history
   would need its own reviewed storage/key lifecycle; never reuse execution keys.
3. **Immutable preview and local export.** App UX owner composes existing design primitives,
   keyboard map, layer stack, scroller and single live region. Main holds save authority;
   renderer receives exact safe preview text and fixed status. Save exactly reviewed bytes,
   user-chosen destination and explicit final confirmation. #386 integrates entry/first-run;
   #389/#422 consume approved disclosure/support wording.
4. **Focused platform acceptance.** #388/#403 owners use the exact #385/#402 candidate identity
   and isolated synthetic workloads; #390 records physical Mac walkthrough evidence.
   Windows privacy/filesystem/accessibility evidence is a separate required record, not
   inferred from Mac or Linux. No actual OS floor is selected by this packet.

Hard ordering: approved policy/technical contract → producers → protected handling →
preview/export → packaged evidence → #390 acceptance. Test design and UX/support wording
can proceed alongside producers. #390 is the consumer, never a prerequisite to building
the feature. #409 is related, not a blocker. #417/#418 remain outside first-beta scope.

## Runtime test obligations, all not run here

| Area | Required executable proof |
| --- | --- |
| Source exclusion | Seed nested/encoded/fragmented synthetic secrets, POSIX/Windows/UNC paths, free-form errors and huge newline-free output in excluded sources. Spies prove zero diagnostic reads even if secret scanning always returns clean. |
| Closed fields | Unknown fields at every level, unsupported schemas, duplicate keys, nonfinite/fraction values, invalid UTF-8, excessive nesting, oversized input and alias/order/window overflow reject without echoing data. |
| Facts and authority | Pre-handshake store/daemon claims remain unknown; handshake does not imply store health. Same current authority/resource scope, revoked credential, foreign resource, file/read-only mode, generation replacement and delayed handshake never leak stale facts. |
| Consistency | Producer mutation during collection cannot combine generations. Repeat current checks at publication; uncertain observations fail closed without claiming full atomicity or reading protected records. |
| Resource independence | Deadline/scan throw/hang, CPU/load, full disk and allocation pressure remain bounded. Paired execution oracle proves no altered run state, retries, gate answers, lease extension or blocked progression. Measure actual CPU/memory and peak temp bytes. |
| Consent | Default off, refuse, explicit rolling opt-in/out and one-shot consent, cancel/back/retry, repeated click, restart, sleep/wake and elapsed-time uncertainty. Collection requires explicit session consent; snapshot/save requires separate intent. Existing authorized rolling may continue while preview is open but cannot modify it; opt-out invalidates both. |
| Byte identity | Preview text, byte count, digest, immutable buffer and saved bytes match exactly, including final LF. Tampered IPC, changed destination, stale preview, double save and cancel/commit races cannot substitute content. |
| Filesystem | Native Mac and Windows two-account tests, restrictive initial permissions/DACL, inherited rights, symlink/reparse/ancestry swaps, existing-name collision, unsafe provider/filesystem, crash-at-write and cleanup failure. No execution-key access. |
| Network | Observe actual packaged app/daemon in off/refused/preparing/preview/save/failure states: zero external diagnostic traffic. Separate normal authorized runtime traffic from diagnostic evidence. |
| UX/support | Keyboard and screen-reader navigation, both themes, zoom/340px scroll reachability, readable complete JSON, destination/sync/identifiability warnings and uncoached target-like comprehension. Uncertain admission/resume/protected state escalates to Casey without repair/retry. |

Original R01–R11 remain authoritative inputs pending reconciliation with configurable
five-minute rolling and the proposed volatile profile. Add duration increase/decrease,
byte/event/alias eviction, high-rate omission, effective-window reporting and crash-loss
tests. Review matching buffer/preview/export caps before changing the old schema. If
volatile-only is accepted, identify persistent-key/storage rows as deferred by that
separate decision; never mark them passed or delete the expectations. Reviewer decisions, schema approval and synthetic checks do not satisfy runtime
or physical acceptance.

## Preparation checks and future evidence

The baseline contract directory was fetched at exact main commit and every downloaded blob
verified against its Git blob SHA. The unchanged offline command passed **11 tests**:

```sh
python3 -m unittest discover -s docs/preparation/manual-diagnostics-contract -p 'test_*.py' -v
```

An initial local materialization added an extra final newline; verification caught that
copying error. The downloaded bytes were restored to their exact source SHAs before the
passing run. No source contract change was made. Synthetic size calculations are recorded
in [budgets](budgets-and-lifecycle.md). Documentation whitespace/source-link checks and
remote publication verification belong in the draft PR record.

Repository runtime/build/lint, native ACL/key/network tests, UI tests, signing, physical
Mac/Windows execution and tester comprehension remain **not run** for this docs-only slice.
No test result here certifies M3–M5 devices or a minimum macOS/Windows version.

Future acceptance record must include exact candidate/source/artifact digests, actual
OS/model/architecture, consented isolated session, each test result (pass/fail/blocked/not
run), byte-equivalence/network/ACL evidence, unknowns and remaining decisions. Missing
hardware/candidate/enrollment is blocked, never replaced with fixture success.
