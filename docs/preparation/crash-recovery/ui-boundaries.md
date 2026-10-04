# Crash-recovery diagnostics: UI and bridge boundaries

Preparation for [#469](https://github.com/cschadewitz/Project_Orca/issues/469), within
[#416](https://github.com/cschadewitz/Project_Orca/issues/416). This is an integration map,
not an implemented screen, a consent grant, or an approved retention policy. The only
approved direction is configurable pre-trigger metadata with a five-minute default.
Casey and Cal must record outstanding crash, retention, consent, key and resource
decisions before those behaviors are built or described as guarantees.

## Existing ownership and source seams

| Owner / source | Reuse and boundary |
| --- | --- |
| [#438](https://github.com/cschadewitz/Project_Orca/pull/438), `docs/preparation/manual-diagnostics-implementation/` | Decision preparation for #436. Extend its questions with a crash addendum; its volatile-only recommendation is not a decision for #469. |
| [#441](https://github.com/cschadewitz/Project_Orca/pull/441), disabled app-main pre-trigger buffer and draft schema | Buffer/coverage/omission work belongs to that PR. Its `start()` has no production caller and is not consent; its frozen snapshot gives no save authority. Recheck its head before integration. |
| [#455](https://github.com/cschadewitz/Project_Orca/pull/455), synthetic benchmark | The 4,096-event burst retained 238.95 seconds. Five minutes is a configured horizon, not guaranteed coverage. Linux/tmpfs numbers prove neither native checkpoint latency nor durability. |
| `docs/preparation/manual-diagnostics-contract/` | Draft closed schema, privacy model, exact-byte preview, consent states and fixtures from #421/#430. Old rolling caps, volatile restart behavior and prose remain proposals; #469 must reconcile them. |
| `packages/app/renderer/src/App.tsx`, `routes.tsx`, `chrome/surfaces.ts` | Five existing surfaces and no diagnostics UI. The app chrome owns entry/navigation. Manual entry must remain reachable before daemon handshake and while offline. |
| `packages/app/renderer/src/config/preferences-section.tsx` | App-owned preferences are distinct from daemon configuration. A future rolling-capture disclosure/setting could be discoverable here, but immediate-save preference behavior is not consent and cannot imply automatic capture. Placement awaits UX review. |
| `packages/app/src/bridge.ts`, `src/preload/index.cts`, `src/main/index.ts` | The context bridge is the sole renderer-to-main path. Generic daemon handlers await `workspace.ready()` and reject stale target epochs; pre-handshake diagnostics need a narrow main-owned path that does not wait for the daemon. The #469 lead owns these shared files. |
| `packages/app/renderer/src/daemon-connection/boundary.tsx` | A target change unmounts or inerts the old child tree and may wait for draft disposal. Main must separately invalidate any preview/save authority; renderer unmount is not revocation. |
| `packages/app/renderer/src/layers-context.tsx`, `a11y/announce.ts`, `ui/` | Reuse the one layer stack, keyboard map, announcer, `Button`, `Text`, `StateView`, `ConfigField` and `Menu`; no second Escape handler, live region or popover focus system. |

The current bridge has no diagnostics API or local-save dialog. `src/main/index.ts` has an
open-store dialog, an example of main owning native UI rather than an export path.
`src/main/admission-intents.ts` has an unrelated encrypted journal. It offers publication
and test patterns but cannot supply diagnostics keys, payloads or failure semantics.
The renderer must never read execution stores, logs or raw daemon replies to construct a
report. #386 and #389 own onboarding/support wording; #390 owns physical acceptance.

## Alignment with the lead-owned interface draft

The shared seam is the lead-owned `docs/preparation/crash-recovery/integration-contract.md`.
The lead should freeze its narrow typed contract before UI code. These are **roles and
invariants**, not final method names or approved lifecycle behavior:

1. Main answers a safe availability read, including before handshake. It returns only
   typed status, supported actions, effective coverage and omission/unknown explanations.
   The renderer never infers retention from a failed daemon call or claims that a five-minute
   horizon contains five complete minutes of evidence.
2. Main accepts a specific, explicit grant after reviewed disclosure. One-shot preparation,
   any rolling capture, recovered-history access and local-save intent remain distinct.
   A prior export, saved preference or issue approval cannot stand in for a fresh tester
   choice. Main owns an unguessable grant identity and changing generation; queued work
   must fail its generation check after invalidation. Exact lifetime and restart rules are
   pending Casey and Cal.
3. Main prepares one frozen bounded canonical UTF-8 buffer. A bridge response may carry
   exact text, byte length and an opaque preview handle scoped to the renderer/grant
   generation, with a summary derived from those bytes. The renderer displays the entire
   read-only content without ellipsis; it cannot supply arbitrary export JSON. Repeated
   reads or destination changes cannot silently replace that preview.
4. Main owns the native destination picker and publication. The selected full path is
   displayed before a separate final Save action; picking a path is not permission to
   write. The path stays out of diagnostic content and daemon traffic. Main rechecks
   current authority, handle and destination immediately before publication, writes the
   same frozen bytes, and reports whether publication occurred. The exact opt-out/save
   race and publication semantics await the owner decision.
5. Main owns invalidation and deletion. Opt-out, expiry, restart, authority change,
   cancel/back and storage failure need explicit outcomes for retained history, held
   previews, queued writes and operation-owned temporary files. The UI renders a bounded
   safe status or fixed failure reason; it cannot claim secure erasure merely because its
   state cleared. Key and deletion semantics await platform/security review.

Do not reuse generic `handle()` daemon calls unchanged: `workspace.ready()` would hide
entry when startup is the failure being diagnosed, and its broad error translation can
carry free-form exception text. The lead must define closed non-content errors and
current-window/grant checks at the main boundary. No renderer path may start capture
without the reviewed grant or turn recovered records into execution actions.

## Policy-neutral UI state sketch

`off → disclosure → preparing → ready → saving → saved` describes a possible one-shot
path. `off → rolling disclosure → rolling` is separate. A recovered candidate after a
crash is conditional on approved survival and re-consent policy. `unavailable`, `expired`,
`deleting` and `cleanup pending` must be representable without inventing data. Recovery
discovery does not open, decrypt, preview, save or resume collection automatically.
Which candidate states are visible before renewed consent is still undecided. One-shot
collection can remain independent of rolling/recovered history; exact interaction awaits
the recorded decision.

The preview summary describes **the frozen bytes**, not a live feed: included categories,
literal `unknown` values, actual omission counts or saturation, effective coverage and
disclosed checkpoint tail loss. Main binds its opaque handle to exactly those bytes. New
events and destination changes cannot update the text in place. Reload, target switch,
expiry or opt-out may invalidate the handle; the UI then disables Save and explains the
state. Saved exports are separate user-controlled files, so deletion copy must distinguish
them from ORCA's retained history and from recipient copies. No upload/share action exists.

The existing draft in `manual-diagnostics-contract/preview-and-consent.md` illustrates
the full-content screen and local-save warning, including possible external sync. Its
numbers, restart copy and grant text need reconciliation. Draft support copy in
`failure-mapping.md` needs review with #389; uncertain admission cannot become an
automatic retry or repair through diagnostics.

## Interaction and acceptance sketch

- Disclosure starts with safe decline/cancel focused. Consent is an explicit action; no
  selected checkbox, cached preference, startup prompt or recovery banner silently grants
  it. Pre-handshake and offline paths use locally known facts and honest unknowns.
- Use `useTransientLayer` for a transient disclosure/preview, the existing keyboard map
  for commands, and `Menu` only for a menu of choices. Restore trigger focus on close.
  Use the one announcer for preparation/save/delete outcomes; never speak each retained
  event or JSON line. Assertive announcements need the app's permission-ask rules.
- The app window does not scroll. Bound a named keyboard-focusable exact-content region
  and preserve access to summary, destination and actions at 340px height and large text.
  Keep the full content in the accessibility tree; verify both themes, visible focus,
  VoiceOver and a Windows screen reader on real builds. A new surface needs the repository's
  scroll and accessibility sweeps; a dialog still needs measured overflow.
- Test exact identity across preview text, byte count, destination changes and local file,
  including the final newline. Inject new events during preview to prove immutability.
  Test cancel/back/retry, repeated Save, opt-out/deletion versus queued or in-flight Save,
  cancelled picker, disk failure and publication winning cancellation. Assert no plaintext
  temporary file, diagnostic network path or execution mutation. Use bounded workers and
  disposable synthetic profiles.
- Packaged Mac/Windows tests must verify actual picker, permissions, key access, restart
  and screen-reader behavior. Linux/mock tests and #455's tmpfs results cannot establish
  these claims; #390 still needs its own physical Mac acceptance.

## Decisions this note does not make

Casey and Cal must decide which crashes are covered, previous-session count, post-crash
retention, normal-exit and restart behavior, sleep/clock treatment, restart re-consent,
checkpoint cadence and truthful maximum tail-loss wording, encrypted key lifecycle and
deletion semantics, and byte/event/time/heap/latency limits. The five-minute default
answers none of those. The owner packet and recorded review also need to settle exact
recovery wording and supported producer metadata before implementation.
