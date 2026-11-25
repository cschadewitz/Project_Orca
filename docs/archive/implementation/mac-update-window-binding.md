# Mac draft lease Electron binding (#387)

This slice stacks on #533 at `b56bf3bcb3bc04b1eff554a405c4bb67c76ea56e`, preserving
#530 at `16da467644ed2c9c9ab9ce0effcd22604b6dbda6`. It supplies the real main/preload/
renderer composition missing from the [guard foundation](mac-update-guards.md).
It does not enable candidate offers, approval IPC, Mac installation, or recovery activation.

## Ownership and lifecycle

`MacUpdateWindows` is composed in main with `BrowserWindow.getAllWindows` and `ipcMain`.
All owned window constructors and `browser-window-created` events register document
lifecycle listeners. The boundary disables captured native windows before snapshot and
before asking any renderer about drafts. Keyboard/mouse input and renderer-initiated
main-frame navigation are prevented while held. `window.open` is denied while held.
App window-creation requests are deferred and coalesced until confirmed cleanup; the
constructor rechecks the current hold when the deferred request runs.

A captured document carries a main-owned generation and main-frame reference.
Cross-document navigation, crashes, closure, destruction, or unexpected window creation
invalidate the lease. A replacement document cannot acknowledge its predecessor's lease.
Main accepts acknowledgements only from the captured WebContents object and its captured,
current main frame. Lifecycle changes and missing acknowledgements retain the native
boundary and follow #533's unknown outcome path. Same-document navigation and subframe
navigation do not substitute a captured document.

The sandboxed CommonJS preload uses separate Mac prepare/prepared channels. It owns the
nonce, generation, and phase across renderer subscription replacement. A legacy null,
wrong nonce/generation, or old lease release cannot unlock an active Mac freeze. The
renderer must find its root and confirm draft readiness; it preserves any prior inert
state and positively confirms release separately from whether drafts remain dirty.
Unsubscribing never silently releases an owned lease.

Connection changes/store opening and Windows restart preparation share the main arbiter
with Mac leases. Legacy callers receive an owned release handle; failed or stale callers
cannot send an unlock for another owner. Existing Windows action/driver semantics stay
unchanged. Main resource IPC checks the window boundary both on entry and immediately
before dispatch after workspace readiness. Already-dispatched work still belongs to the
future authoritative daemon activity fence; this window guard does not certify it idle.

The Mac guard instance is exported from main only as an internal composition/testing
seam. There is no renderer-accessible Mac offer, approval, or install entrypoint.

## Validation and remaining gates

Integration fixtures execute the actual preload source with Electron at the boundary,
and exercise the actual main IPC composition. They cover frame/source authentication,
scoped release, stale/legacy unlocks, native freeze ordering, prior disabled/inert state,
new-window deferral, document replacement/crash/closure, listener replacement, drafts,
and resource/connection refusal. Renderer tests cover both themes and unavailable Mac UI.
These are Linux-hosted fixtures, not physical Electron/macOS acceptance.

`MacUpdateGuards.prepareAdmission` remains conservatively blocked. Authoritative attached
execution, queued dispatch, callback/renewal, and timer-recovery fencing are separate,
coordinated runtime work. RPC-only maintenance is never promoted into stronger proof.
The approved additive `maintenance.runtime` direction remains subject to independent
exact-schema review before release; this slice changes no protocol or grants.

Physical signed N→N+1, Keychain/intent-journal/TCC continuity from `dev.orca.desktop` to
`com.schadewitz.orca`, restart/reconnect coherence, complete protected-state plus
matching-binary recovery, and unassisted tester acceptance #390/#388 remain unrun.
No manifests/lockfile, shared engine/daemon runtime, native tooling, signing, distribution,
credentials, system settings, or real user updates are changed.
