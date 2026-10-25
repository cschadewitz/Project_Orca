# C5b: macOS self-update, app replacement and Mac packaging tooling

Reviewed at HEAD `0c75d01`. This was a static review only: nothing was executed, because `node_modules` is absent and the repo requires Node 24+.

## Coverage

**Read in full**
- `packages/app/src/main/mac-*.ts` (all 25 files, about 5.6k lines):
  - `mac-candidate-{manifest,download,controller}`, `mac-update-candidates`, `mac-updates`
  - `mac-update-{guards,drain,restart,windows,namespace,application}`
  - `mac-replacement-{commit,journal,recovery,startup,storage}`, `mac-managed-{replacement-startup,update-application}`
  - `mac-fixed-path-{files,recovery}`, `mac-closed-window-{commit,validation}`, `mac-app-writer-barrier`
  - `mac-native-{handoff,providers}`
- `packages/app/src/mac-update-contract.ts`, `update-contract.ts`, `main/update-driver.ts`, `main/updates.ts`
- `tools/packaged-mac/{launch-environment,stage-native-addons,executor-preflight,acceptance-packet,packaging-plan}.js`, `archive-containment.py`, `native-containment.py`
- `tools/deploy/native-mac-{candidate,verify,runtime}.py`

**Read for context** (outside scope, but my scope consumes them)
- `packages/protocol/src/update-window.ts` and `first-run-fence.ts`: the durable window, anchors and kernel slots.
- `packages/app/src/main/index.ts`: production wiring, startup gate, `will-quit`.
- Relevant parts of `daemon-process.ts`, `workspace.ts`, `cli/src/update-bootstrap.ts` and `diagnostics/native-{adapter,addon}.ts`.
- `native/diagnostics/storage.c`: the provision/open root path only.
- `electron-builder.yml` and `.github/workflows/app-smoke.yml`.
- Test names and assertions in `packages/app/test/mac-*.test.ts`, `packages/protocol/test/update-window.test.ts` and `packages/app/test/daemon-connection-integration.test.ts`.

**Skipped**
- The native C addon beyond the provision/open-root path. It belongs to the diagnostics/native reviewer.
- The `tools/packaged-mac/tests` bodies: only their coverage was skimmed.
- The docs themselves: they were used for intent only, per instructions.

**What is live in production versus latent.** This matters for severity.

On every macOS launch, `index.ts` runs:
- `createManagedMacReplacementStartup().initialize()`: provisions the namespace, inspects the journal and takes the app writer slot.
- The `MacAppWriterBarrier` dispatch gate, plus `enrollProtectedRoots` during first-run.
- `ordinaryAllowed` checks on every IPC call.

The update, download, commit and restore path is constructed but inert. `authority` is never supplied, `activationAllowed: () => false`, and `MacUpdateApplication` has no session. Findings in that path are labelled **latent**. They become live the moment someone supplies the authority and flips the activation switch, and several of them would then brick installs in normal use.

## Findings

### C5b-01: Every Mac install permanently refuses startup after Migration Assistant, a restore or a home move
- **Live in production.** Changing the fence identity (path, dev, inode, uid), or a torn first-launch write, permanently closes protected startup.
- **Category:** reliability / data-integrity
- **Severity:** High. This is a bricked app in normal use, with no data loss. Live on every Mac install.
- **Confidence:** Medium-High
- **Location:**
  - `packages/app/src/main/mac-managed-replacement-startup.ts:65-100`
  - `packages/app/src/main/index.ts:1229-1237`
  - `packages/protocol/src/update-window.ts:94-147` (`write`, `state`, `anchor`) and `:207-215` (`enterUpdateWriter`)
  - `packages/protocol/src/first-run-fence.ts:56-68` (`fenceDirectory` = `{path, dev, ino, uid}`)
- **Issue:** On first launch, `provisionMacUpdateNamespace` records three files:
  - `enrolled.json` in `~/Library/Application Support/ORCA-native-replacement`, holding `control: fenceDirectory(control)`;
  - `.orca-update-window.json` in userData, holding `root: fenceDirectory(userData)`;
  - the same guard in each first-run workspace.

  Every later launch re-derives these identities and requires exact equality:
  - `state()` compares `enrolled.json.control` to the live `fenceDirectory(control)`;
  - `anchor()` compares the guard's `root` to the live `fenceDirectory(root)`.

  Any mismatch, or any unparsable file, throws. `initialize()` catches the throw, seals the bootstrap and returns `"unknown"`. `index.ts` then shows "Native replacement recovery is required" and refuses all protected IPC, connect, first-run and daemon start.

  The window is still `open` with `attempt: null`, so nothing exists to recover. Yet there is no re-anchor path, no in-app recovery and no documented manual step.
- **Scenario / evidence:**
  - **New Mac via Migration Assistant, or a Time Machine restore.** `~/Library/Application Support/ORCA` and its `-native-replacement` sibling are recreated with new inode numbers. `state()` then throws on the `enrolled.json` comparison, so every launch takes the same path: `initialize` → `catch { bootstrap.seal(); return "unknown"; }` → error box. The app is unusable.
  - **Manual recovery fails unless you know every file.** Deleting only the control dir does not work: `provisionMacUpdateNamespace` throws when `!existing && guards.some(Boolean)`. Stale guards left in workspace directories also make the CLI/daemon `enterUpdateWriter` and re-enrollment refuse.
  - **Same outcome after a rename or copy:**
    - renaming the macOS account or home folder (the path changes);
    - copying or restoring the userData profile.
  - **Same outcome after a crash or power loss mid-write.** This covers:
    - `window.json`, `enrolled.json` and the guard during first-launch provisioning. These use `write(..., replace=false)`: an `O_EXCL` create plus write directly to the final name, so a torn file cannot be parsed.
    - `enrollUpdateWindowRoots` during first-run, between `window.json` and `enrolled.json`, or leaving `window.json.tmp` behind. `state()` throws whenever `window.json.tmp` exists.

  Tests assert these refusals (`update-window.test.ts`: "refuses lost control identity…", "refuses incomplete writes…"). None of them covers an open, idle window after a benign identity change.
- **Recommendation:**
  - If the durable window is `open`, `attempt === null` and the journal is empty, treat an identity mismatch or a torn non-attempt file as "re-provision". Rewrite the anchors to the current identities after acquiring all slots, rather than locking out. Keep refusal only for non-open phases.
  - Make first-provision writes use temp + fsync + rename, like `replace=true`.
  - Ship a documented, supported reset (a CLI or menu item) that removes the control namespace and all enrolled guards together when the window is open.
  - Add tests that copy the profile to new inodes and re-launch.

### C5b-02: Admission closes durably at approval with no reopen path, so any non-deferred outcome locks the app
- **Latent.** Admission is durably closed at approval (before download and drain), and nothing in production ever reopens it. A transient "unknown", a quit or reboot while waiting, or even a successful install leaves every later launch in the recovery shell.
- **Category:** design / reliability
- **Severity:** High (latent)
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-update-application.ts:79-103`
  - `packages/app/src/main/mac-managed-replacement-startup.ts:89` (`if (enrolled.phase !== "open") return "closed"`)
  - `packages/app/src/main/mac-updates.ts:361-397`
  - `packages/app/src/main/mac-update-candidates.ts:140-150`
  - `packages/app/src/main/mac-update-drain.ts:55-57`
  - `packages/protocol/src/update-window.ts:617`
- **Issue:** `act("approve")` calls `closedWindow.closeAdmission()`, which durably commits `window.json` phase `draining`, before `session.approve()` has downloaded anything. From that point the only way back to `open` is:
  - `beginDefer` + `finishDefer` within the same process, and only while `MacUpdates` is not sealed; or
  - `reopen()` after `validated` or `restored`.

  There is no production caller of `reopen()`, `captureClosedRecovery`, `verifyClosed`, `finishAfterCleanChildExit`, `restoreClosed` or `MacUpdates.reconsider()` (I grepped all packages).
- **Scenario / evidence:**
  1. **Transient catalog or drain uncertainty.** After approval, `observeDrain` → `approvalCurrent` → catalog `macBounded(operationMs)`. A network timeout gives `"unknown"`, so `drainUnknown()` seals and goes `recovery-required`. A drain RPC slower than the hard-coded 5 s in `boundedRead` does the same.

     Defer is now impossible: `MacUpdates.defer` returns false when `sealed`. Worse, `act` has already durably committed `deferring` (`beginDefer` runs before `session.defer` at lines 79-81). The next launch sees phase ≠ `open` and returns `"closed"` permanently.
  2. **Approve while runs are active.** The update goes to `waiting` / activity. Nothing calls `reconsider()`, so it waits forever with new admissions closed. If the user quits at the end of the day, the next launch is closed forever.

     This is compounded by `Workspace.close()` not stopping a reserved daemon (`workspace.ts:1016`), which leaves an orphaned draining daemon.
  3. **Successful Squirrel install.** ShipIt relaunches the new app with the window `closed`, so it lands in the recovery shell. Validation and reopen are never wired.

  The docs accept "fresh owners cannot infer … safely deferred". The consequence, though, is an unrecoverable app with no product surface to recover it.
- **Recommendation:**
  - Do not durably close admission until the irreversible boundary (`beginStop`). During download and drain, use a process-local, non-durable closure.
  - Alternatively, persist enough to let a fresh process prove "no stop attempted" (no `stopping` marker, no pair directory) and reopen automatically.
  - Wire `reconsider` to activity notifications, and wire validate → reopen before allowing `activationAllowed` to return true.
  - Add a construction-time assertion that refuses an authority without these owners.
  - Reorder `act("defer")` so it checks `session.defer` is possible before `beginDefer`.

### C5b-03: The commit step can never back up a running Electron profile, and fails only after the daemon is stopped
- **Latent.** Commit feasibility is checked only after the irreversible steps (`beginStop`, daemon SIGTERM, `pauseAppWriters`). Ordinary conditions (a running CLI process, Electron's userData layout, real macOS xattrs) turn into a permanent lock.
- **Category:** correctness / reliability
- **Severity:** High (latent)
- **Confidence:** Medium. The CLI slot path is certain. Electron's SingletonSocket and the `#PS` xattr reflect platform behaviour I believe is standard but could not run here.
- **Location:**
  - `packages/app/src/main/mac-closed-window-commit.ts:51-61`
  - `packages/app/src/main/mac-fixed-path-files.ts:120-154`
  - `packages/app/src/main/mac-fixed-path-recovery.ts:213-268`
  - `packages/protocol/src/update-window.ts:549-566`
  - `packages/cli/src/update-bootstrap.ts:109-123`
- **Issue:** The commit sequence is: `beginStop()` (durable `stopping`) → `stopOwned` (SIGTERM to the daemon) → `pauseAppWriters` (seals all app IPC) → `window.capture()` → `backupPrevious()`. Any `false` or throw after `beginStop` yields `"unknown"`, which means a permanent closed window (see C5b-02). The following all fail at capture or backup, and none is pre-checked:
  - **CLI writer slots.** `ClosedUpdateWindow.capture()` needs all 8 kernel slots per root. CLI commands hold a slot on the enrolled workspace root until process exit (`update-bootstrap.ts:123`: "Kernel slots survive until process exit"). A user running any long-lived `orca` CLI command at update time makes `capture()` return `false` (EADDRINUSE). That function is documented as retryable ("Busy callers retain draining; they may retry capture"), yet commit maps it to `"unknown"`.
  - **userData is always a protected root** (`index.ts` passes `appWriterRoot`). `inventory()`:
    - rejects absolute symlink targets. Electron's `requestSingleInstanceLock` (`index.ts:295`) creates `SingletonSocket` in userData, which points to an absolute `/var/folders/.../SingletonSocket`;
    - rejects any entry whose mtime or ctime changes during hashing. Chromium keeps writing Cookies, Local Storage, Preferences and caches. Those writes are not participating writers and are not paused;
    - caps the tree at 65,536 entries and 1 GiB. Chromium's HTTP cache can exceed this.
  - **xattr name filter** `/^[A-Za-z0-9._-]{1,256}$/` (line 124) rejects:
    - `com.apple.lastuseddate#PS`, set by LaunchServices on bundles launched from Finder or the Dock;
    - `com.apple.metadata:_kMDItemUserTags` (Finder tags) and other `metadata:` names.
  - **Ownership and location.** Every inventoried entry must be owned by `getuid()`, which fails for an admin-installed `/Applications/ORCA.app` used by a standard user. Nothing checks for App Translocation or a read-only bundle location (`binaryRoot()` only checks the suffix `/ORCA.app`), so Squirrel later fails with `"unknown"`.
- **Scenario / evidence:**
  - With the update approved and `orca` CLI running in a terminal: the daemon is SIGTERMed, app IPC is sealed, `capture()` returns false, the result is `"unknown"`, and every relaunch is a recovery shell.
  - Even with no CLI running, `backupPrevious` → `capture("previous")` → `trees.digest(userData)` throws on `SingletonSocket`, with the same outcome.
  - No test covers an Electron-shaped userData, CLI-held slots at commit time, or Darwin xattr names. Tests use `posix-fixture`.
- **Recommendation:**
  - Before `beginStop`, run a dry-run feasibility pass:
    - acquire, then release, all slots;
    - inventory every root and the binary with the same filters (accepting that the live profile may differ slightly);
    - check that the bundle location is writable, not translocated, and owned by the user;
    - check the manifest size (C5b-06).
  - Treat `capture() === false` as a retryable `waiting` state, not `"unknown"`.
  - Exclude Chromium-managed ephemera (`Singleton*`, caches, `Crashpad`) from the protected userData set, or protect only ORCA-owned files.
  - Accept `#` and `:` in xattr names (hash them; never parse them).

### C5b-04: Retrying after a "refused" native activation turns into "unknown" and freezes the app
- **Latent.** Native activation is single-use per process, so a retry after a safe `"refused"` becomes `"unknown"`, freezing the UI and holding admission.
- **Category:** correctness / concurrency
- **Severity:** Medium (latent)
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-native-handoff.ts:105-113`
  - `packages/app/src/main/mac-closed-window-commit.ts:33-35`
  - `packages/app/src/main/mac-updates.ts:469-478`
  - `packages/app/src/main/mac-managed-update-application.ts:127-169`
- **Issue:** `MacUpdates` treats activation `"refused"` as "old app/state untouched and lease resumable". It releases the leases, sets `sealed = false` and `failed`, and lets the user approve the same offer again (`approved` is false and the offer is not retired).

  The managed owner reuses one `MacNativeHandoff`, which caches attempts per Electron `autoUpdater` singleton, and one `MacClosedWindowCommit`, which caches `this.attempt`. A retry builds a new admission lease object, so:
  - `previous.lease === request.lease` is false and `handoff.activate` returns `"unknown"`;
  - the commit also returns `"unknown"` for any request other than the first.

  `MacUpdates.prepare` then calls `this.unknown()` without releasing the draft or admission leases. All windows stay `setEnabled(false)`, the daemon stays in maintenance `prepared`, and the durable window stays non-open.
- **Scenario / evidence:**
  1. `authorize()` returns `undefined` because the catalog is momentarily not `trusted`, or `draftsValid()` flips. The commit and handoff return `"refused"`, and the UI shows `failed`.
  2. The user clicks Approve again on the same offer. The handoff sees `previous.key` equal but a different lease and returns `"unknown"`. The UI is now frozen and unrecoverable until restart (then see C5b-02).

  No test covers a retry after refused (`mac-native-handoff.test.ts` covers only in-flight reuse).
- **Recommendation:**
  - Cache only attempts that reached a native call (`setFeedURL`), or that are not `"refused"`. Clear the cache entry on `"refused"`.
  - Otherwise, make `MacUpdates` retire the offer after a refused activation so the UI must obtain a fresh offer, and construct a fresh commit owner per attempt.

### C5b-05: Mac startup is closed for a whole launch whenever the Keychain is slow, denied, or diskutil/ioreg stall
- **Live.** The journal read requires Keychain availability even when the journal is empty, and the whole check is bounded to 5 s. Synchronous `diskutil`/`ioreg` calls have 2 s timeouts.
- **Category:** reliability
- **Severity:** Medium. It is live and recurs per launch, but self-heals on relaunch.
- **Confidence:** Medium
- **Location:**
  - `packages/app/src/main/mac-replacement-journal.ts:77-90`
  - `packages/app/src/main/mac-replacement-recovery.ts:282-304` (5000 ms)
  - `packages/app/src/main/diagnostics/native-adapter.ts:46-47`
  - `packages/protocol/src/first-run-fence.ts:119-164` (`execFileSync` diskutil/ioreg/sysctl with a 2000 ms timeout, called from `enterUpdateWriter` and from `port()` on each `hold()`)
- **Issue:**
  - **Keychain.** `MacReplacementJournal.acquire()` calls `keys.available()` → `safeStorage.isAsyncEncryptionAvailable()` before even checking whether `replacement.enc` exists. On macOS this can trigger, or wait on, a Keychain ACL prompt. The current Mac lane is unsigned (`identity: null`), so the code requirement changes every build and every upgrade prompts. Clicking Deny, or taking longer than 5 s, makes the read fail. The bootstrap then becomes `"unknown"` and this launch shows "Native replacement recovery is required" with all IPC closed and no retry.
  - **Disk and boot identity.** `assertFenceVolume` (`diskutil info -plist`) and `fenceBoot` (`ioreg`, `sysctl`) run synchronously on the main thread on every launch. Each has a 2 s timeout, which diskutil can exceed under login-time load. Any timeout has the same effect.
- **Recommendation:**
  - Check `replacement.enc` existence first, and require keys only when a record exists. An empty journal needs no key.
  - Do not bound the human-interactive Keychain step with a short timer. Alternatively, show a retry UI instead of the recovery message.
  - Cache `fenceBoot()` per process.
  - Use `statfs` (`f_fstypename`, `MNT_LOCAL`) or a cached diskutil result instead of a 2 s synchronous subprocess on every launch.

### C5b-06: Inconsistent manifest size limits let a valid candidate fail after the daemon is already stopped
- **Latent.** The three size limits disagree. A valid candidate manifest of about 11.5–16 KiB passes download, inspection and revalidation, then fails at commit.
- **Category:** correctness
- **Severity:** Medium (latent)
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-candidate-manifest.ts:87,116` (64 KiB, up to 128 evidence records)
  - `packages/app/src/main/mac-native-providers.ts:228` (16 KiB)
  - `packages/app/src/main/mac-closed-window-commit.ts:69` (12,288 bytes)
  - `packages/app/src/main/mac-fixed-path-recovery.ts:34,163` (`startup.json` ≤ 16,384 bytes, including base64 manifest + `storeDir` ≤ 4096)
- **Issue:** The manifest is parsed under 64 KiB and the policy record is limited to 16 KiB, but `MacClosedWindowCommit` refuses a manifest over 12,288 bytes. Worse, `retainStartupIdentity` must fit `base64(manifest)` plus up to 4 KiB of `storeDir` and the target into a 16 KiB `startup.json`, so the effective ceiling is about 9–11.9 KiB. Both checks run after `beginStop`, the daemon stop, `pauseAppWriters`, capture and the full `backupPrevious`.
- **Scenario / evidence:** The fixture manifest is 3,545 bytes for 6 evidence entries, with pretty-printed records of about 150 bytes each. A real manifest with about 55 or more evidence files (Python allows 64, TS allows 128) passes every pre-stop check. The commit's `stat.size > 12288` (or the `startup.json` write) then throws, the result is `"unknown"`, and the app is permanently closed.
- **Recommendation:** Define one shared constant and enforce the tightest one (derived from `startup.json` capacity) at `offer()` time. Alternatively, store the manifest as its own file in the pair directory instead of base64-embedding it.

### C5b-07: Unpackaged macOS runs (dev mode, Playwright smoke) can never pass the startup gate
- **Category:** testing / maintainability (developer experience)
- **Severity:** Medium
- **Confidence:** Medium-High. I could not observe CI.
- **Location:**
  - `packages/app/src/main/index.ts:82-89`
  - `packages/app/src/main/diagnostics/native-addon.ts` (`diagnosticsAddonPath`, `runtime.electron` → `process.resourcesPath`)
  - `packages/app/src/main/mac-update-namespace.ts:41-50`
- **Issue:** The gate is mounted whenever `process.platform === "darwin"`, regardless of `app.isPackaged`. Under unpackaged Electron, `resourcesPath` is `node_modules/electron/dist/Electron.app/Contents/Resources`, which has no `native/diagnostics/darwin-*/diagnostics_storage.node`. So `provisionMacUpdateNamespace` throws and `initialize` returns `"unknown"` on every run.
- **Scenario / evidence:**
  - `pnpm dev` on a Mac shows "Native replacement recovery is required" and refuses connect and first-run.
  - The macOS legs of `app-smoke.yml` (`app:admission-intents`, `app:revision-workflow`) launch unpackaged Electron and drive production IPC. They should hit the same closed gate.
- **Recommendation:**
  - Mount the replacement gate only when `app.isPackaged`, or fall back to the repo `build/Release` addon in dev as other addon loads do.
  - Document how macOS developers and CI obtain the addon.
  - Add a smoke assertion that ordinary startup is allowed.

### C5b-08: Commit-time copying spawns several processes per file and needs about seven full passes while the UI is frozen
- **Latent.** The tree digest spawns 2 or more subprocesses per file and runs about 7 full inventories per root inside the frozen commit window. Revalidation also repeats the full native DMG/ZIP inspection while drafts and admission are held.
- **Category:** performance / reliability
- **Severity:** Medium (latent)
- **Confidence:** Medium
- **Location:**
  - `packages/app/src/main/mac-fixed-path-files.ts:120-129, 213-287`
  - `packages/app/src/main/mac-fixed-path-recovery.ts:213-268`
  - `packages/app/src/main/mac-managed-update-application.ts:98-117`
- **Issue:** `attributes()` runs `/bin/ls -lde` and `/usr/bin/xattr -s`, plus one `xattr -px` per attribute, for every entry. Each root and the binary are inventoried about 7 times:
  - `capture` before and after;
  - `copy` before;
  - `flush`;
  - source and destination after;
  - `verify`.

  An Electron bundle (thousands of entries) plus userData plus the store easily reaches tens of thousands of process spawns, all inside a single `operationMs` budget that also covers authorization, stop and native verification. Separately, `revalidateBounded` re-runs `providers.inspect` (hdiutil attach, ditto, codesign `--deep`, syspolicy_check on both copies) with all windows disabled and the daemon admission-frozen.
- **Scenario / evidence:** A timeout anywhere gives `"unknown"` after `beginStop`, which means a permanent closed window (C5b-02 and C5b-03). Before that point the UI is unusable for minutes.
- **Recommendation:**
  - Read ACLs and xattrs in-process through the existing native addon (`listxattr`/`getxattr`/`acl_get_file`), or batch them.
  - Compute one digest per root and reuse it; do not re-inventory the source after a native copy whose own result carries a digest.
  - Re-check only the digest of the candidate bytes at revalidation instead of a full re-mount.

### C5b-09: Mac updates only work on machines with Xcode Command Line Tools installed
- **Latent.** The update pipeline hard-requires Xcode Command Line Tools on the end user's Mac.
- **Category:** design
- **Severity:** Medium (latent)
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-native-providers.ts:137-150`
  - `tools/deploy/native-mac-candidate.py:51-53, 237, 256`
- **Issue:** Native inspection runs `/Library/Developer/CommandLineTools/usr/bin/python3` and `/usr/bin/xcrun stapler`. On the typical consumer Mac without CLT:
  - `executeNative` returns `"unknown"`;
  - `downloadMacCandidate` returns `"unknown"`;
  - `MacCandidateSession.uncertain = true`, sealing the session for the process.

  Every update attempt fails, and per C5b-02 the approval has already durably closed admission. If CLT is partially present, `/usr/bin/xcrun` may also pop the CLT installer dialog.
- **Recommendation:** Do the verification in-process or in a bundled signed helper using the `Security.framework` APIs: `SecStaticCodeCheckValidity` with the requirement, `SecCodeCopySigningInformation`, and `SecAssessment`/`syspolicy` for notarization. Do not depend on developer tooling. At minimum, preflight CLT before closing admission.

### C5b-10: Nothing in the app stops a downgrade to an older signed ORCA build
- **Latent.** There is no local downgrade or rollback floor. Freshness and replay are fully delegated to the unimplemented catalog port.
- **Category:** security
- **Severity:** Medium (latent)
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-update-candidates.ts:220-291`
  - `packages/app/src/main/mac-candidate-download.ts:202-253`
  - `tools/deploy/native-mac-candidate.py:90-117`
- **Issue:** No code compares `manifest.identity.releaseVersion`, `bundleVersion` or `builtAt` with the running app (`app.getVersion()`) or with the previous manifest's identity (`authority.previousManifestSha256`). Squirrel.Mac checks only the designated requirement (Team and identifier), not version monotonicity.

  An older, legitimately signed and notarized ORCA build with known vulnerabilities passes every native check: Developer ID OIDs, Team OU, leaf certificate pin (the same certificate across versions), staple and syspolicy. It needs only a catalog or delivery compromise, or a buggy catalog. This also lets same-user malware use ORCA's App Management entitlement to roll ORCA back (see C5b-11).
- **Recommendation:** Add a local floor: refuse a candidate whose `releaseVersion` is ≤ the running version, or whose `builtAt` is ≤ the previous identity's. Leave explicit rollback to a separately authorized recovery path. Keep the catalog check as an additional layer.

### C5b-11: Python verifier runs without isolation and can be hijacked by user site-packages
- **Latent.** The verifier runs without `-I`, so user site-packages `.pth` and `usercustomize` code executes inside it.
- **Category:** security
- **Severity:** Low (latent)
- **Confidence:** Medium
- **Location:** `packages/app/src/main/mac-native-providers.ts:150-153`
- **Issue:** `spawn(python3, ["-B", helper], { env: {PATH, LANG, LC_ALL, PYTHONDONTWRITEBYTECODE} })`. Clearing the environment does not disable the user site directory. Python resolves `~` from the passwd database when `HOME` is unset, so `~/Library/Python/3.x/lib/python/site-packages/*.pth` and `usercustomize` run before the verifier.

  Same-user code (for example a malicious `pip install --user`) can make the verifier print a forged `verified` proof. Squirrel's requirement check still limits installs to Team-signed bundles, but combined with C5b-10 this enables a silent downgrade or App Management bypass.
- **Recommendation:** Run with `-I -B` (isolated mode drops user site, `PYTHON*` environment variables and the script directory). Keep the explicit `importlib` sibling loads, which already use absolute bundle paths.

### C5b-12: Candidate downloads and inspection scratch are never cleaned up
- **Latent.**
- **Category:** resource-leak
- **Severity:** Low (latent)
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-update-candidates.ts:125-137, 220-291, 344-351`
  - `packages/app/src/main/mac-candidate-download.ts:287`
  - `tools/packaged-mac/native-containment.py:221-229`
- **Issue:** Leaks occur in four places:
  - **Stale reference on a new offer.** After a `failed` outcome with a verified download (revalidate refused, `approvalCurrent` refused, activation refused), `this.owned` keeps the old directory. A new `offer()` then `approve()` overwrites `this.owned` with the new download, and the old DMG+ZIP (hundreds of MB) is orphaned.
  - **Committed downloads** are never removed.
  - **Crashes** mid-download or mid-inspection leave `mac-candidate-*`, `inspection/orca-*`, and possibly an attached DMG (when detach is unconfirmed). There is no startup sweeper.
  - **The fixed-path backup** of the full app plus userData plus the store is retained in the control namespace per attempt, with no retention policy.
- **Recommendation:**
  - Discard `owned` whenever `MacUpdates` reaches `failed` with `verified = false`, and before replacing a binding.
  - Sweep orphaned `mac-candidate-*` and `orca-*` scratch at startup under the namespace lock.
  - Define a retention policy for pair directories once an attempt is validated or reopened.

### C5b-13: Any local process can exhaust the handoff server's request cap
- **Latent.** The loopback handoff server counts every request, including 404s, toward its 16-request cap.
- **Category:** reliability / security
- **Severity:** Low (latent)
- **Confidence:** High
- **Location:** `packages/app/src/main/mac-native-handoff.ts:209-218`
- **Issue:** `const accepted = ++requests <= 16 && …` increments before checking the capability path. Any local process, including another user's, can connect to `127.0.0.1:<port>` and send 16 junk requests during the handoff. Squirrel's feed or ZIP GET then gets a 404, `native.on("error")` fires, the result is `"unknown"`, and the commit is already `"ready"`, so the app ends permanently closed.
- **Recommendation:** Count only requests whose path matches the capability, or drop non-matching connections without counting them.

### C5b-14: Python verifier reports crashes and cleanup failures as a known "refused"
- **Latent.** The runtime helper collapses verifier crashes and cleanup failures into a known `"refused"`, and TS interprets that differently per operation.
- **Category:** reliability / maintainability
- **Severity:** Low (latent)
- **Confidence:** High
- **Location:**
  - `tools/deploy/native-mac-runtime.py:57-58`
  - `packages/app/src/main/mac-native-providers.ts:276-307`
  - `packages/app/src/main/mac-managed-update-application.ts:113-114`
- **Issue:** `except Exception: result = {"outcome": "refused"}` covers tool timeouts, `hdiutil detach` failures ("detach remains unconfirmed", which leaves a mount under the control namespace), and verifier bugs. TS then interprets that `"refused"` differently by operation:
  - for `candidate`, a non-`verified` result fails to parse and becomes `"unknown"`, which seals the session;
  - for `image`, `verifyBinary` becomes `false`, which `revalidate` reports as a known `"refused"`.

  An environmental failure therefore masquerades as an authoritative negative in one path and as uncertainty in the other.
- **Recommendation:** Emit `{"outcome":"unknown"}` for anything other than an explicit policy or signature mismatch (raise a dedicated exception type for those). Map `unknown` from `image` to `"unknown"` in `revalidate`.

### C5b-15: Two parallel recovery designs are maintained, and the startup gate reads a journal nothing writes
- **Category:** maintainability / design
- **Severity:** Info
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-replacement-commit.ts`
  - `mac-replacement-recovery.ts` (`MacReplacementRecovery`)
  - `mac-candidate-controller.ts`
  - `mac-replacement-journal.ts`
  - `mac-managed-replacement-startup.ts:23-26, 90`
- **Issue:** Production composes `MacClosedWindowCommit` + `MacFixedPathRecovery`. The older ledger design (`MacReplacementCommit`, `MacReplacementRecovery`) and `createMacCandidateSession` are referenced only by tests.

  `MacReplacementJournal` is still read on every launch as a startup gate, yet nothing in production ever commits to it. Its only effect today is the Keychain, native-addon and 5 s failure modes in C5b-05.
- **Recommendation:**
  - Delete or clearly quarantine the unused design.
  - If the journal is kept as a legacy-attempt detector, read it only when `control/journal/replacement.enc` exists.

### C5b-16: Every IPC call re-reads the fence files synchronously on the main thread
- **Live.**
- **Category:** performance
- **Severity:** Low
- **Confidence:** High
- **Location:**
  - `packages/app/src/main/mac-managed-replacement-startup.ts:31-49`
  - `packages/app/src/main/index.ts:90-136`
  - `packages/protocol/src/update-window.ts:126-168`
- **Issue:** `ordinaryAllowed` / `existingWorkAllowed` run `lease.check()` plus `updateAdmissionOpen()`. Each calls `anchor()` → `state()`: about 5 opens, 10 stats and 3 realpaths, all synchronous. This happens for every renderer IPC, and twice in some paths. During first-run enrollment, the atomic rename of `window.json` also causes transient false negatives, so concurrent IPC calls are refused.
- **Recommendation:** Cache the decision and invalidate it on this process's own window writes, plus a cheap mtime or inode check.

### C5b-17: The riskiest Darwin-only paths have no test coverage
- **Category:** testing
- **Severity:** Medium
- **Confidence:** High
- **Location:**
  - `packages/app/test/mac-fixed-path-*.test.ts`
  - `mac-native-handoff.test.ts`
  - `mac-native-providers.test.ts`
  - `daemon-connection-integration.test.ts`
  - `packages/protocol/test/update-window.test.ts`
- **Issue:** Tests run on Linux with `posix-fixture` trees and fake ports. Nothing covers:
  - Darwin `attributes()` (ls/xattr output, `#`/`:` names);
  - an Electron-shaped userData (Singleton symlinks, concurrent Chromium writes);
  - `capture()` returning false because a CLI holds a slot after `beginStop`;
  - retry after a refused activation (C5b-04);
  - manifest size at the commit and `startup.json` boundaries (C5b-06);
  - fence identity change with an open idle window (C5b-01);
  - Keychain unavailable or a slow `isAsyncEncryptionAvailable` at bootstrap (C5b-05);
  - unpackaged Darwin startup (C5b-07);
  - the absence of any reopen/reconsider wiring (C5b-02).

  The docs acknowledge that physical Mac gates are unrun. These specific cases, however, are reproducible with fixtures.
- **Recommendation:** Add focused fixture tests for each case above. Add a macOS CI job that runs a packaged (or addon-staged) app through startup → ordinary.

## Strengths

- **No time-of-check/time-of-use gap between verification and install.**
  - The handoff reads the exact ZIP into memory and re-hashes it against the catalog-bound manifest digest *before* stopping anything.
  - It serves only those bytes over a 256-bit capability URL on loopback.
  - Squirrel still enforces the designated requirement.
- **The native verifier is thorough.**
  - Developer ID requirement with Team OU, leaf certificate pin, secure timestamp and hardened-runtime flags.
  - Per-Mach-O identifier and entitlement policy coverage, and arm64-only checks via `lipo`.
  - Staple, syspolicy_check and DMG `spctl`; pre- and post-hash pinning of every artifact.
  - DMG and ZIP copy equivalence.
- **The ZIP containment parser is high quality.**
  - It bounds the central directory before `ZipFile`, rejects ZIP64, split and encrypted archives, and checks local/central consistency.
  - It requires contiguous member coverage and rejects competing Unicode-path extras and case/NFC collisions.
  - It resolves symlinks component by component with hop limits, and bounds DEFLATE output per call.
  - It bounds binary plists against amplification.
- **Download hygiene is good.**
  - HTTPS-only base, no credentials, query or fragment, per-component encoding, manual redirect refusal and response-URL equality.
  - Streaming SHA-256 with byte bounds.
  - Strict JSON tokenizer: duplicate and escaped-equivalent keys, BOM, non-integer numbers, depth.
  - Abort-safe late-result handling (`macAbortable`), and every write awaited before cleanup.
- **Subprocess execution is safe.** It uses absolute tool paths, no shell, minimal environments, bounded output and time, and absolute path arguments, so `-`-prefixed injection is impossible. `-B` avoids writing `.pyc` into the signed bundle.
