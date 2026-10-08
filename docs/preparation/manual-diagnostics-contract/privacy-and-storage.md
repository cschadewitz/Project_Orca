# Privacy, storage and trust model

Proposed requirements for later #416 implementation; none is a claim about current
runtime enforcement. Schema checks alone cannot establish consent, provenance, isolation,
anonymity, key protection or file permissions.

## Assets, actors and boundaries

Protected assets are user/workplace content, credentials and execution material, identity,
the integrity of running work, and the tester's choice to collect/save/share. Legitimate
actors are the tester, app main process, an authenticated authorized local daemon, and a
recipient deliberately selected by the tester outside this product flow. Threats include
accidental developer overcollection, malicious payloads/errors, another local account,
untrusted renderer/IPC input, disk tampering, retention failures, cloud-folder replication
and recipient correlation. A compromised OS, administrator or already authorized reader
may access a deliberately saved plaintext export; this proposal promises neither anonymity
nor protection against a fully compromised machine.

| Threat | Required control | Later evidence |
| --- | --- | --- |
| Nested/encoded/fragmented secrets evade regexes | Never acquire content-bearing sources; construct a new closed typed record, do not sanitize whole logs/payloads | Source-access spies stay at zero for all excluded sources; adversarial fixtures rejected |
| Schema-valid field becomes a covert content channel | Provenance review for each producer; public build identity only; independent random IDs and per-export aliases | Real producer tests reject forged version/identity data; entropy/no-cross-bundle-linkage tests |
| Renderer requests broader data or suppresses preview | Main process owns scoped grant, authorized safe snapshot, immutable bytes and local file write; renderer cannot pass arbitrary export data/path authority | IPC trust/permission tests; preview tampering and stale-generation tests |
| Daemon RPC/audit projection leaks private fields | Current authentication and resource authorization remain in force; narrowly reviewed safe local projection; no whole RPC/error forwarding | Unauthorized, revoked, read-only and foreign-resource fixtures; never bypass via direct store reads |
| Small cohort metadata identifies a tester | Explicit warning; no wall time, hardware model, hostname, stable user/project IDs or private revision | Review with target-like participant; versions and relative timings still acknowledge residual correlation |
| Diagnostic fault changes work or exhausts resources | Separate bounded worker/queue/storage; no execution locks, retries, repairs or control RPCs; deadline and backpressure | Fault/hang/disk/load injection plus unchanged execution oracle |
| Crash/restart leaks buffer or extends consent | Persistent explicit current-scope opt-in defaults off; private encrypted minimized buffer only, expiry check before every access; orphan cleanup and key revocation | Crash/restart/sleep/clock tests with actual files and keys |
| Other user reads diagnostic cache/export | Owner-only creation, verified POSIX permissions or Windows DACL; refuse unsupported destination | Two-account tests, inherited ACL denial, symlink/reparse/race probes on both platforms |
| Cached plaintext or temporary save survives cancellation | Do not persist raw or pre-allowlist data; bound preview in memory; operation-owned temporary files with cleanup state | Cancel/opt-out/crash-at-each-write tests; inspect temp/cache/export locations |
| File saved into a synced folder is replicated | Show complete local destination and sync warning before final save; no implicit upload/share | UI test plus network observation of ORCA; do not claim control over external sync clients |
| Recipient retains a copy | Clear irreversible-sharing explanation; no false remote revocation promise | Consent/runbook review; no “recall” API offered |

Normal execution may still use its own authorized network connections. This stage must
make **zero external diagnostic requests/transmissions**: no upload endpoint, analytics,
crash reporter, remote request listener, service setup or automatic issue/email attachment.
Future authorized local app/daemon projection IPC is not an upload, but must be separately
observed and reviewed so private data cannot cross it. Test offline startup and no-daemon
cases without a network fallback. Neither this contract nor Casey's request is tester consent.

## Local storage and keys

1. Minimize and validate before retention. No raw buffer, debug dump, exception log or
   spill file is permitted in the diagnostic pipeline. Keep the one-shot snapshot in
   bounded main-process memory until explicit save; no persisted one-shot history.
2. Rolling history, only after separate opt-in, lives in a dedicated diagnostics directory
   outside execution/authentication stores. Encrypt already minimized safe records with
   authenticated encryption using a **new independent diagnostic key** and unique nonces.
   Key/domain/session separation, algorithm/version and rotation policy require D4 review.
   Never read, derive from, reuse, wrap with or delete `.execution-key`, auth tokens, agent
   credentials or existing store encryption keys. Export contains no ciphertext or keys.
3. Protect the diagnostic key with platform-appropriate user-bound key storage (proposed:
   macOS Keychain, Windows user-bound OS key protection). No plaintext adjacent key file,
   fallback to execution keys or silent weakening when the facility is locked/unavailable.
   Stop rolling if protection fails; disclose the failure without secret-bearing details.
4. POSIX proposal: newly created cache directories `0700`, files `0600`, verify actual owner
   and effective permissions before use, reject symlinks/non-regular files and unsafe
   ancestry/races. Recheck at opens/publication; changing a string path is not validation.
   Do not silently chmod unrelated user-selected directories or overwrite unrelated files.
5. Windows needs an explicitly protected owner-only DACL, not a Node mode-bit claim.
   Verify owner SID, disabled broad inherited access and effective read/write rights at
   creation/open/rename. No `Everyone`, `Users` or `Authenticated Users` grants. Any SYSTEM
   allowance needs a documented platform requirement and D4 approval. Reject unverified
   FAT/network/synced-provider semantics, reparse points and unsafe ownership/races;
   test deny rules, inherited ACLs, another ordinary account and a relocated directory.
6. Use one private app-owned plaintext staging slot only after explicit final Save,
   with durable content-free intent/identity before plaintext and same-filesystem native
   no-replace publication. Refuse unsupported destinations; no destination-adjacent or
   copy/delete fallback. Preserve previous user exports. Failed cleanup may leave plaintext;
   show that honestly and block new Saves until safely resolved.
7. Remember actual explicit rolling opt-in for the approved scope across restarts;
   invalid/missing scope is off. Use same-boot suspend-inclusive elapsed age with no
   wall-clock fallback, strict snapshot-origin 24-hour recovery limit and five-minute
   default configurable lookback. Clean exit revokes/removes current checkpoint; preserve
   one eligible prior crash candidate until original expiry/discard. Reopening never renews age.
8. Opt-out stops acquisition first, invalidates all preparation/save grants, revokes the
   diagnostic key, then removes owned rolling/temp artifacts. A disabled/invalid setting forces startup cleanup; valid unchanged opt-in may recover
   one prior crash candidate. Never delete a user-selected exported file automatically.
   Display “Deletion incomplete” when cleanup/key revocation is blocked and keep capture
   off; retry cleanup only for owned diagnostics. Do not claim deletion succeeded simply
   because a key was removed, or key revocation succeeded because deletion was attempted.
   Secure physical erasure on SSDs/backups is not promised. Recipient and saved-file copies
   are outside this deletion flow.

A diagnostic full disk, locked key store, permission failure, sanitizer/scan failure or hang
must not interrupt work. Do not wait on diagnostics during execution or app shutdown.
Best-effort cleanup failures are visible locally using fixed messages and retried under a
bounded cleanup policy; they never authorize raw fallback, repairs or widening retention.
A separate cleanup-pending state records only fixed categories, no private source paths.
At-rest encryption and owner-only permissions protect the temporary history, not a report
that its owner deliberately gives to another person.

## Validation obligations

The checked-in [privacy fixtures](fixtures/privacy-cases.json) test schema rejection at
would-be output fields; source-access counts, runtime projection correctness and hang
handling are unrun expectations. A future test must seed synthetic adversarial data into
every excluded source and prove the producer never reads it, even when scans are stubbed
as permissive. Then independently test canary scan rejection, throw and timeout. No
“scan passed” result substitutes for these source-boundary tests.

Observe actual packaged Mac and Windows filesystem/ACL/key behavior and network traffic.
Exercise default-off, refusal, one-shot and rolling consent, cancel/back/retry, deadline,
expiry, clock changes, suspend/wake, crash/restart, full disk and broken key protection.
Pair every fault with a normal run progression test: no altered state, duplicate admission,
answered gate, resume/agent restart or execution-key access. Record the exact candidate,
actual platform and tests as pass/fail/blocked/not-run; never promote fixture checks into
packaged or physical-hardware evidence.
