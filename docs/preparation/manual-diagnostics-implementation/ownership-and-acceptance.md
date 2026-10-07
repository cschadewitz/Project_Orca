# Phased ownership and acceptance handoff

#469 decisions 1–9 settle the product bounds described in [README](README.md).
#470 at `a174e33c307ef9348412eaad69bc0df9399ad684` owns disabled storage/controller/IPC/UI implementation and
semantic adoption of #441, with no Git merge of #441. This is the reconciled preparation
handoff, not a new implementation assignment. Recheck main
`c1eba301702fef0466b2d3481c36d62331ee7d48` and the exact
accepted integration contract before later work; avoid competing diagnostics/MCP edits.

## Ordered slices

1. **Safe producers and authority contract.** Protocol/privacy reviewer freezes the closed
   observation DTO, enum provenance and pre-handshake unknown gates. App-main owner supplies
   startup/connection/platform facts; daemon/runtime owner supplies only already authorized
   typed outcomes. New producer modules/tests can be isolated; existing handshake, methods,
   auth/control, read-model, IPC/barrels and shared wiring remain integrator-owned.
   Do not name a future RPC as shipped, broaden permissions, scan stores or ingest logs.
2. **Protected capture/recovery handling.** #469/#470 own persistent default-off opt-in,
   five-minute-default bounded ring, encrypted same-boot recovery and separate immutable
   preview/save. Extend only their reviewed interfaces after coordinated assignment;
   do not rebuild storage/key/controller/IPC/UI. Separate diagnostics key only, no
   plaintext checkpoint fallback. Production authority remains disabled pending acceptance.
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
| Consent | Default off, refuse, explicit rolling opt-in/out and one-shot consent, cancel/back/retry, repeated click, restart, sleep/wake and elapsed-time uncertainty. Collection requires persistent explicit opt-in for the approved scope; snapshot/save requires separate intent. Existing authorized rolling may continue while preview is open but cannot modify it; opt-out invalidates both. |
| Byte identity | Preview text, byte count, digest, immutable buffer and saved bytes match exactly, including final LF. Tampered IPC, changed destination, stale preview, double save and cancel/commit races cannot substitute content. |
| Filesystem | Native Mac and Windows two-account tests, restrictive initial permissions/DACL, inherited rights, symlink/reparse/ancestry swaps, existing-name collision, unsafe provider/filesystem, crash-at-write and cleanup failure. No execution-key access. |
| Network | Observe actual packaged app/daemon in off/refused/preparing/preview/save/failure states: zero external diagnostic traffic. Separate normal authorized runtime traffic from diagnostic evidence. |
| UX/support | Keyboard and screen-reader navigation, both themes, zoom/340px scroll reachability, readable complete JSON, destination/sync/identifiability warnings and uncoached target-like comprehension. Uncertain admission/resume/protected state escalates to Casey without repair/retry. |

Original R01–R11 remain historical acceptance inputs, read with the accepted #470
contract/test matrix. Duration changes, 8,192/byte eviction, coverage/lost tail,
persistent consent, crash/boot/age uncertainty, key isolation, unknown Save and cleanup
races need exact implementation evidence. Do not defer persistent-key/storage rows under
the superseded volatile-only proposal. #470 reports focused/Linux evidence with explicit
native/privacy/network/paired-load/combined-memory gaps and missed 4 ms target; preserve
those limits and its Node 22 CI failure. #436 closes only after reconciled exact-head
review; #416/#469 and physical acceptance stay open. #441 closure waits for #470 merge;
#455 superseded disposition belongs to the parent after original evidence retention.
Reviewer decisions/schema fixtures do not satisfy packaged or physical acceptance.

## This reconciliation's validation boundary

Only these four Markdown files change. Owned-path, UTF-8/LF/fences, relative-target
and diff-whitespace checks are appropriate. The unchanged offline contract run below
belongs to the original preparation head; reuse its result as historical evidence,
not an executed new-head runtime pass. No broad runtime/native tests are needed for
this prose delta. Exact published SHA/check results are recorded in the PR handoff.

## Historical preparation checks and future evidence

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
