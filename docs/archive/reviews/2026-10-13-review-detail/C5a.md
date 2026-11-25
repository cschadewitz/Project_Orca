# C5a — Electron main process (non-mac), preload, client, preferences, first-run, diagnostics, native addons, scripts

## Coverage

Reviewed at HEAD 0c75d01, read-only. I did not run any tests (Node 22 here, and `node_modules` is absent).

**Read in full**
- `packages/app/src/main/`: `index.ts`, `daemon-process.ts`, `deep-link.ts`, `workspace.ts`, `connection-state.ts`, `connection-target.ts`, `app-menu.ts`, `alerts.ts`, `admission-intents.ts`, `window-chrome.ts`, `update-ipc.ts`, `updates.ts`, `update-driver.ts`, `guided-checkout.ts`, `guided-intent-contract.ts`, `guided-launch.ts`, `guided-launch-adapter.ts`.
- `src/main/first-run/**`: `README.md`, `ipc.ts`, `setup.ts`, `directories.ts`, `ownership.ts`, `recovery.ts`, `agent-preflight.ts`, `sample-assets.ts`.
- `src/main/diagnostics/`: `initialize.ts`, `native-addon.ts`, `native-storage.ts` (first ~120 lines), `native-adapter.ts` (first ~120 lines), `native-clock.ts`, `windows-key-adapter.ts`, `profile.ts`, `payload-scope.ts`, `source-producers.ts`, `startup-producer.ts`, `report-work.ts`, `recovery-files.ts`.
- `src/preload/index.cts`.
- `src/client/`: `daemon-client.ts`, `subscription.ts`, `auth.ts`, `template-client.ts`, `workflow-draft-client.ts`.
- `src/preferences/`: `preferences-file.ts`, `schema.ts`.
- `src/*.ts` contracts: `daemon-connection.ts`, `first-run-contract.ts`, `template-bridge.ts`, `workflow-draft-bridge.ts`. I skimmed `bridge.ts`.
- `native/diagnostics/`: `clock.c`, `clock-math.h`, `storage.c`, `storage-windows.c`, `storage-windows-common.h`, `keys-windows.c`, `first-run-windows.c`, `windows-delay-load.c`, `binding.gyp`. I skimmed `linux-fixture.c`, which is a test fixture and is not shipped.
- `scripts/`: `dev.js`, `build-daemon.js`, `diagnostics-native-package.js`, `verify-diagnostics-native.js`.
- `package.json` and `electron-builder.yml`.

**Read for context only (not in this scope)**
- `src/main/mac-update-windows.ts`, because it installs the window-open handler on every window.
- `renderer/index.html` and `vite.config.ts` (CSP), `renderer/src/App.tsx` (deep-link consumer), `renderer/src/route-table.ts`, `renderer/src/palette/start-run.tsx`.
- `packages/protocol/src/first-run-fence.ts` and `first-run-windows.ts`.
- `packages/cli/src/commands/index.ts` (serve/SIGTERM), `packages/agents/src/hosts/local-host.ts` (agent environment).
- `packages/store/src` layout.
- Tests checked: `workspace.test.ts`, `first-run*.test.ts`, `admission-retry-intents.test.ts`, `deep-link.test.ts`.

**Skimmed only**
- `diagnostics/recovery-controller.ts` (951 lines) and `recovery-disk.ts` (1067 lines): I checked only the export, destination and publish paths.
- `pretrigger-buffer.ts`, `payload-memory.ts`, `snapshot.ts`, `report-validation.ts`, `recovery-contract.ts`. Diagnostics events are a closed vocabulary of codes, so the privacy risk there is very low.
- `scripts/native-mac-*.js`: these are build-time and use `execFileSync` with argument arrays; mac signing is owned by another reviewer.

**Not reviewed**
- `src/main/mac-*.ts`, which belongs to another reviewer.

## Findings

### C5a-01 — First-run workspace is refused permanently after any unclean exit that spans a reboot (no cross-boot recovery)
- **Category:** reliability
- **Severity:** High
- **Confidence:** High
- **Location:** `src/main/first-run/ownership.ts:327` (strict inspection refuses an unsettled attempt), `ownership.ts:347-400` (`reserveFirstRunOwnership`), `src/main/first-run/recovery.ts:70-77` (`reconcile` requires `claim.boot === fenceBoot()`), `src/main/index.ts:1330-1352` (`will-quit`), `src/main/daemon-process.ts:347`.
- **Issue:** Each bundled first-run daemon start appends an attempt (`claim.json`, `writer.json`, …). The attempt is settled (`terminal.json`) only when this process watches its own child exit, through `stopFirstRunOwned` → `complete()` or `onExit` → `recordFirstRunExit`. The next start runs `inspectFirstRunOwnership(path)` in strict mode and refuses any unsettled attempt. The only in-app repair is `FirstRunRecovery.reconcile`, and it refuses unless the claim's boot ID equals the current boot ID ("explicit-same-boot-fence"). `docs/implementation/first-run-same-boot-recovery.md` says "No reboot route is included". Once the machine reboots, nothing in the app can settle the attempt.
- **Scenario / evidence:**
  - **Windows restart or logout with ORCA open:**
    1. Electron does not emit `before-quit`/`will-quit` on Windows shutdown or logout (documented Electron behaviour), so `workspace.close()` never runs.
    2. The OS kills the daemon and no `terminal.json` is written.
    3. After reboot, `startFirstRunWorkspace` → `setup.connect` → `reserveFirstRunOwnership` → `refuse()` with "Local startup ownership requires reconciliation…".
    4. The user tries Prepare/Reconcile recovery; `reconcile` returns `refuse()` because the boot ID changed.
  - The same happens after a power loss or kernel panic.
  - It also happens after C5a-11 (quit during startup) or C5a-02 (Windows update) if a reboot follows before the user runs recovery.
  - "Open a store…" cannot show the old history either: `assertNoFirstRunOwnership` refuses any path that contains the ownership journal.
  - The user's only option is to pick a fresh empty workspace or hand-edit the evidence files.
- **Recommendation:** Add a supervised cross-boot settlement route.
  - A claim whose boot ID differs from the current boot cannot have a live writer from that boot. After acquiring the kernel fence, treat it as provably terminated and write a distinct `observation: "different-boot"` resolution.
  - On Windows, also handle `session-end`/`query-session-end` and settle attempts synchronously there.
  - Add tests for "unsettled attempt + new boot ID → recoverable".

### C5a-02 — Windows in-app update stops the first-run daemon without settling ownership; a failed install can never reconnect it
- **Category:** correctness
- **Severity:** High
- **Confidence:** High
- **Location:** `src/main/workspace.ts:881-888` (`stopForUpdate` calls `this.daemon.stop()` directly), `workspace.ts:907-918` (`cancelUpdate` → `connect()`), `workspace.ts:1050-1057` (`switchTo` → `assertNoFirstRunOwnership`), `src/main/daemon-process.ts:347` (`onExit` is suppressed when `stopping`), `src/main/index.ts:958-995`.
- **Issue:**
  - Every other stop path uses `stopFirstRunOwned`, which calls `ownership.complete()` after exit. `stopForUpdate` calls `daemon.stop()` directly.
  - Because `stop()` sets `stopping = true`, `onExit` (and with it `recordFirstRunExit`) never fires. The first-run attempt is left unsettled.
  - If the install fails, `cancelUpdate` → `this.connect()` → `switchTo(this.target)` → `assertNoFirstRunOwnership(path)` throws for every first-run workspace. The reconnect after a failed install therefore always fails, and the error is swallowed in `Updates.act`.
- **Scenario / evidence:** A packaged Windows user on the default first-run workspace clicks Update → Restart.
  1. `prepareDaemon` → `stopForUpdate` → daemon stopped, no `terminal.json`.
  2. `quitAndInstall` runs and the app relaunches.
  3. `startFirstRunWorkspace` → `prepareFirstRunConnection` → `reserveFirstRunOwnership` → strict inspection refuses the unsettled last attempt.
  4. The app comes up disconnected with the ownership-reconciliation refusal and needs manual recovery after every update. If the user reboots first, C5a-01 makes it permanent.
  - Separately: if the installer does not start within 10 s, `Updates` calls `resume` → `cancelUpdate` → `connect()` is refused, leaving the app with its daemon stopped.
- **Recommendation:**
  - In `stopForUpdate`, use `await this.stopFirstRunOwned(this.daemon)`.
  - In `cancelUpdate`, restore a first-run workspace through `FirstRunSetup.connect` (or `prepareFirstRunConnection`) instead of `connect()`/`switchTo`.
  - Add a Workspace test: first-run owner → `prepareUpdate` → `stopForUpdate` → `cancelUpdate`, asserting a settled journal and reconnection.

### C5a-03 — Ownership journal is capped at 256 attempts with no compaction, so the workspace stops working after ~255 launches
- **Category:** reliability (unbounded growth → hard failure)
- **Severity:** High
- **Confidence:** High
- **Location:** `src/main/first-run/ownership.ts:225-226` (`if (names.length >= 256) return refuse();`), `ownership.ts:372-376` (a new numbered attempt directory per reservation). Nothing in `first-run/**` or `first-run-fence.ts` ever removes attempts.
- **Issue:**
  - Every bundled start for the selected workspace creates `.orca-first-run-ownership/NNNNNN/`. That includes each app launch, each return after "Open a store", each reconnect after the daemon exits, and each failed start.
  - Settled attempts are kept for ever, and inspection reads every file of every attempt on every reservation and status call.
  - At 256 entries, `inspectFirstRunOwnership` refuses unconditionally. Both `status()`/`connect()` and recovery go through it, so there is no way back inside the app.
- **Scenario / evidence:** A user who launches the app about once a day, plus some File ▸ Open a store/Connect round trips, reaches 256 attempts within months. On the next launch, `reserveFirstRunOwnership` throws `FirstRunOwnershipRefusal` and the workspace can no longer be started. No test covers the cap (searched the `first-run*.test.ts` files for "256").
- **Recommendation:** Compact settled history. Fold every fully settled prefix into a single checkpoint record (hash chain head plus the last effective config hash), and keep only the newest N attempts. At minimum, refuse only when the unsettled tail is too long, not when the total count is. Add a test that creates 300 attempts.

### C5a-04 — The saved first-run selection pins the project's HEAD commit and branch, so any commit or pull invalidates the workspace
- **Category:** design
- **Severity:** High
- **Confidence:** High (the mechanism is certain; the README documents "branch/base" rechecks)
- **Location:** `src/main/first-run/setup.ts:157-168` (`verify`: `project.baseCommit !== receipt.project.baseCommit || project.branch !== …` → `selectionFailure`), `setup.ts:123-156` (`readReceipt` swallows the failure and returns `undefined`), `src/main/first-run/directories.ts:127-147` (`preparedProject`).
- **Issue:** Startup (`status()` → `readReceipt()`) and Connect both re-run `git rev-parse --verify HEAD` and `symbolic-ref` on the project and compare them with the values captured at selection time. Any commit, pull, rebase or branch switch in the project — exactly what coding agents and their users do — fails verification.
- **Scenario / evidence:**
  1. The user completes first-run setup, then makes one commit (or an agent run commits on the branch).
  2. Next launch: `status()` returns `selection-required`, and `startFirstRunWorkspace` falls through to `workspace.connect()`, which reports "Choose a project and empty app workspace in Config".
  3. `prepare()` requires a new empty app workspace (`emptyDirectory`), so all run history in the old workspace is orphaned.
  4. The old store cannot be opened read-only either, because `assertNoFirstRunOwnership` refuses it.
- **Recommendation:** Pin the project's directory identity (dev/inode/owner) and the repository toplevel, not HEAD and branch. If the base matters for the sample, record it as advisory evidence, or re-check it only at guided-launch time (guided checkout already captures fresh evidence per launch). Offer an explicit "rebind project" action instead of forcing a fresh workspace.

### C5a-05 — The admission-intent journal never prunes abandoned records; launches are refused permanently after 1000 records
- **Category:** reliability (unbounded growth → hard failure)
- **Severity:** High
- **Confidence:** High
- **Location:** `src/main/admission-intents.ts:53` (reading refuses more than 1000 rows), `:138` (`retain`: "journal is full"), `:171` (`retainGuided`: `throw refusal()`), `:213-220` (`abandon` only flips `state`).
- **Issue:**
  - The palette start deliberately keeps its intent after success, so the next run of the same workflow requires an explicit Abandon (`start-run.tsx` says "abandon it explicitly to start another run"). A new guided launch likewise retains a new record and the old one is abandoned.
  - Every run therefore leaves one record behind, abandoned records are never deleted, and the cap is 1000.
- **Scenario / evidence:**
  - After about 1000 started-then-abandoned runs (across all workflows and targets), `retain` throws "Run-intent journal is full" and `retainGuided` throws `refusal()`. Every new palette start and guided launch is then refused for ever.
  - The guided path's message is wrong and points the user at the OS keychain: "Secure run-intent storage is unavailable… restore the OS keychain".
  - Each call also decrypts and re-parses the whole journal (up to 1000 × 64 KiB guided reviews).
- **Recommendation:** On `write`, drop abandoned records (or keep only the newest K abandoned per scope). Bound retained records per scope/workflow. Give the guided "full" case its own error. Add a test that cycles 1100 start/abandon pairs.

### C5a-06 — No navigation, new-window or permission restrictions, so the privileged preload bridge reaches any document loaded into the app window
- **Category:** security
- **Severity:** High
- **Confidence:** Medium (the Electron behaviour is well established; exploitation needs a user drag/drop or a future link)
- **Location:** `src/main/index.ts:1172-1222` (`createWindow`: no `will-navigate`/`will-redirect` handler, no `setPermissionRequestHandler`), `src/main/mac-update-windows.ts:99` (`setWindowOpenHandler(() => held ? deny : allow)`, applied to every window via `index.ts:874`), `src/preload/index.cts:353`, `src/main/index.ts:313-341` (generic `handle()` does not check `event.senderFrame` or the sender URL).
- **Issue:**
  - The preload runs on every main-frame load of the window's webContents, whatever the origin.
  - The renderer installs no global `dragover`/`drop` prevention; only the workflow editor canvas handles drops.
  - Nothing in main blocks top-level navigation away from `file://…/renderer/index.html`.
  - The window-open handler returns `allow` for any URL while no update hold is active.
  - CSP cannot stop top-level navigation.
- **Scenario / evidence:**
  1. A user drags a link from a browser or chat (for example "drag this workflow into ORCA") or an `.html` file onto the ORCA window. Chromium navigates the main frame to it.
  2. The foreign page now has `window.orca` with a valid epoch (the preload calls `sendSync("orca:daemon.read")`).
  3. It can call `config.set` (rewrite `orca.config.yaml` agents/commands), `runs.start`, `inputs.answer` (approve pending agent permission asks), `daemonConnection.connect` and so on. That is a path to code execution through the agent runtime.
  - Side effects of the allow-all window-open handler: any `window.open` creates extra windows. Those break the single-window diagnostics gate (`index.ts:211`) and the all-window draft acknowledgement (`prepareDrafts` waits for a popup that never acknowledges → 5 s timeout → "Save or discard pending edits").
- **Recommendation:**
  - Add `web-contents-created` hardening:
    - Handle `will-navigate`/`will-redirect` and call `preventDefault()` unless the URL equals the app's renderer URL (or the dev-server origin).
    - Use `setWindowOpenHandler(() => ({ action: "deny" }))`, opening vetted http(s) links with `shell.openExternal` only after allow-listing.
    - Deny `will-attach-webview`.
    - Install `session.setPermissionRequestHandler`/`setPermissionCheckHandler` that deny everything except `notifications`.
  - Add a renderer-level `dragover`/`drop` `preventDefault` outside the editor.
  - In the generic `handle()`, verify that `event.senderFrame.url` is the app's renderer URL.

### C5a-07 — Deep links are lost or crash main: the global subscriber defeats `DeepLinkQueue`'s hold
- **Category:** correctness
- **Severity:** Medium
- **Confidence:** Medium-High
- **Location:** `src/main/index.ts:1031-1034` (`deepLinks.subscribe(...)` at module load), `index.ts:1020-1029` (`focusWindow` → `createWindow`), `index.ts:1041-1050`, `src/main/deep-link.ts:62-69`, `renderer/src/App.tsx:450-455` (the renderer relies on `take()`).
- **Issue:** `DeepLinkQueue.offer` queues only when there are no listeners. Main subscribes a process-wide listener right after offering argv, so every later URL is pushed through `focusWindow()` plus `send()` and never queued.
- **Scenario / evidence:**
  1. **macOS cold start** from an `orca://` link: `open-url` fires before `ready`. The listener calls `focusWindow()` → `createWindow()` → `new BrowserWindow` before ready, which throws ("Cannot create BrowserWindow before app is ready"). The error surfaces as a main-process error dialog and the URL is dropped.
  2. **macOS with no windows open** (app in the dock): a link creates a new window and immediately `send`s to a renderer that has not loaded, so the message is dropped and `take()` returns undefined.
  3. **Windows/Linux:** a `second-instance` while the window is still loading loses the link the same way.

  `deep-link.test.ts` only exercises the queue in isolation.
- **Recommendation:** Do not subscribe globally. Have main offer to the queue and drain it per window on `did-finish-load` (or when the renderer calls `take()`). Only `send` directly to windows whose renderer has registered. Do not create windows before `app.isReady()`; defer `focusWindow` until `whenReady`.

### C5a-08 — A failed read-only "Open a store" keeps the previous client and epoch, so reads are served by another daemon under the new store's banner
- **Category:** correctness
- **Severity:** Medium
- **Confidence:** Medium-High
- **Location:** `src/main/workspace.ts:1094-1106` (read-only failure path returns before `clientNow`/`source`/`epoch` change), `index.ts:313-341` (`callInConnection` only checks the epoch).
- **Issue:** Per #269, a failed store open "must not fall back to the live daemon". The code drops the stream, but `clientNow`, `source`, `identity` and the epoch stay as they were and no `onTarget` is sent. Renderer IPC that still carries the old epoch passes `assertEpoch` and is dispatched to the previous client.
- **Scenario / evidence:**
  1. App on `ORCA_DAEMON_URL` (or a saved external endpoint).
  2. File ▸ Open a store on a USB store whose read-only daemon fails to start.
  3. The snapshot becomes `{path: /media/usb/store, readOnly: true}` and the banner names that store, but `workspace.client` is still the env/saved daemon and the epoch is unchanged.
  4. Opening a run calls `runs.get`/`runs.list`, which the other daemon answers, so wrong-store data appears under the read-only banner.

  The test "does not fall back to the live daemon when a chosen store will not open" asserts `workspace.client.url` is unchanged and only passes because the old daemon in the rig was bundled and already stopped.
- **Recommendation:** On read-only start failure, swap in an inert client (`new DaemonClient("")`), set `source = "store"`, clear `identity`, increment the epoch and call `onTarget`, so outstanding and future calls fail closed. Add a test with `explicitUrl` set.

### C5a-09 — "Open a store" stops the active bundled daemon and interrupts in-flight runs, contrary to the parking model
- **Category:** design
- **Severity:** Medium
- **Confidence:** High
- **Location:** `src/main/workspace.ts:1065-1073` (`performSwitch` calls `stopFirstRunOwned(this.daemon)`), `workspace.ts:983-993` (`open`), `index.ts:798-819`. Docs: `docs/daemon-connection.md` ("…remains alive when switching… so changing the view does not stop its work").
- **Issue:** Switching to an external endpoint parks the bundled daemon (`parkedDefault`). Opening a read-only store, which is also just a view change, SIGTERMs it (SIGKILL after 5 s). The CLI's SIGTERM handler closes `liveRuntime` and the daemon, so running agent turns are interrupted. The user is only asked about drafts, never about running work.
- **Scenario / evidence:** An agent run is executing on the first-run bundled daemon. The user picks File ▸ Open a store to look at an old store. The bundled daemon is stopped mid-run, and returning later starts a new attempt (C5a-03). `workspace.test.ts` "opens a chosen store read-only…" encodes `stop http://127.0.0.1:6001`.
- **Recommendation:** Park the bundled daemon in `open()` the same way `makeConnection.activate` does, and reuse it in `connectLive`/`connect(null)`. Alternatively, warn and require confirmation when the daemon reports active work (`maintenance prepare` already exposes `active`).

### C5a-10 — A failed first-run daemon start leaks `firstRunHold`, leaving the session "busy"
- **Category:** reliability
- **Severity:** Medium
- **Confidence:** High
- **Location:** `src/main/workspace.ts:730-741` (catch: `if (!startupAttempted || (daemon && …)) release();` — with `startupAttempted` true and `daemon` undefined the hold is never released).
- **Issue:** When `deps.start()` throws, `daemon` stays undefined, so neither branch releases the hold, even when the child provably exited (`died(exit)`) or was SIGKILLed on timeout. Every entry point that checks `firstRunHold` then reports busy for the rest of the session: `prepareConnection`, `connect`, `open`, `connectLive`, `prepareFirstRunConnection`, `prepareUpdate`, `captureMacUpdateTarget`.
- **Scenario / evidence:** At launch the bundled daemon fails to answer `hello` within 30 s (slow disk, a config error, or a port collision on the fence port). After that, File ▸ Open a store reports "Update restart or connection preparation is in progress", the Connect dialog reports "Workspace is busy", and the Retry button reports busy. Only an app restart clears it.
- **Recommendation:** Have `startBundledDaemon` surface terminal evidence on failure, for example by attaching the child or `exit` to `DaemonStartError`. Release the hold once exit is proven, and settle the attempt with `complete()`. If exit is uncertain, keep the reservation but release the in-memory hold for unrelated targets (read-only store, remote URL).

### C5a-11 — Quitting during daemon startup orphans the spawned child
- **Category:** resource-leak
- **Severity:** Medium
- **Confidence:** Medium (the daemon writes to stdout only at startup, so EPIPE is unlikely to kill an orphan)
- **Location:** `src/main/index.ts:1328-1352` (10 s `SHUTDOWN_DEADLINE_MS`), `src/main/workspace.ts:1009-1022` (`close()` stops only `daemon`, `parkedDefault` and existing `candidates`), `workspace.ts:622-635` (the first-run start is not tracked until it resolves), `src/main/daemon-process.ts:270` (30 s start timeout × up to 3 attempts).
- **Issue:**
  - A first-run start in progress is neither `pending` nor in `candidates`, so `close()` returns immediately and the app exits while the child is still starting.
  - A non-first-run `switchTo` start is awaited through `pending`, but the 10 s deadline is shorter than the 30–90 s start window.
  - In both cases the `node:child_process` child (ELECTRON_RUN_AS_NODE) survives the parent.
- **Scenario / evidence:**
  1. The user launches ORCA and quits within the first seconds (Cmd+Q).
  2. The bundled daemon keeps running, holds the store's fence and port, and the attempt is unsettled.
  3. Next launch: "ownership requires reconciliation". Reconcile returns `surviving-owned-daemon` until the user kills the process by hand, and a reboot instead leads to C5a-01.

  The test "an interrupted spawn stops the late owned child" only passes because the test process lives on.
- **Recommendation:**
  - Track in-flight starts (an `onChild` callback is already available) in a set that `close()` SIGTERMs/awaits.
  - Make the shutdown deadline cover owned children explicitly (kill them before leaving).
  - Consider `detached: false` plus a parent-death watchdog in the daemon (exit when the stdin pipe closes, for example by using `stdio: ["pipe", …]`).

### C5a-12 — `verifyRuntimeDirectories` caps `.orca` + `auth` at 8192 entries, so history growth eventually breaks startup (also O(n) per call)
- **Category:** reliability / performance
- **Severity:** Medium
- **Confidence:** Medium-High
- **Location:** `src/main/first-run/directories.ts:69-125` (`let remaining = 8192`), called from `setup.ts:168` in every `verify()`. `verify()` runs from `status()`, `connect()` (twice), `prepareRecovery`, `reconcileRecovery`, `reviewConfiguration` and `bindConfiguration`.
- **Issue:**
  - The walk counts every directory and file under the store. The store grows per run: `runs/<id>.jsonl`, `artifacts/<runId>.jsonl` plus one blob per artifact, leases, claims and private-execution files.
  - Once the total passes about 8190, `verify` throws, `readReceipt` returns undefined and the workspace reads as `selection-required`, the same end state as C5a-04.
  - Each `status()` call also runs 3 `git` processes and two lstat/access/readdir walks of up to 8192 entries.
- **Scenario / evidence:** After a few thousand runs (fewer if runs produce many artifacts), the next launch refuses the workspace with the generic selection failure.
- **Recommendation:** Do not walk the whole store. Verify the identity of `.orca`/`auth` and their immediate children (or a fixed set of control files), and let the daemon's own store validation handle content. If a deep walk is needed, make it incremental or bound it by depth rather than by count.

### C5a-13 — The bundled daemon inherits the app's full environment, including explicit daemon credentials, which then reaches agent processes
- **Category:** security
- **Severity:** Medium
- **Confidence:** Medium
- **Location:** `src/main/daemon-process.ts:269, 303-311` (`env = process.env` spread into the child); `index.ts:583-599` (`{...process.env, …}` on macOS); downstream `packages/agents/src/hosts/local-host.ts:50` (`env: { ...process.env, ...agent.env }`).
- **Issue:**
  - The app deliberately keeps credentials main-only and forces `env: {}` for bundled clients.
  - The bundled daemon, however, gets the app's entire environment: `ORCA_DAEMON_TOKEN` (the explicit credential for a remote daemon), `ORCA_DAEMON_TOKEN_FILE`, `ORCA_UPDATE_TOKEN_FILE`, `ORCA_RENDERER_URL`, `NODE_OPTIONS` and so on.
  - The daemon strips only the first-run and update variables, and LocalHost passes `process.env` on to every agent subprocess.
- **Scenario / evidence:** A user sets `ORCA_DAEMON_TOKEN` to reach a shared remote daemon through the Connect dialog and also runs local work on the bundled daemon. Every local coding agent (LLM-driven and prompt-injectable) can read the remote daemon's bearer token from its environment and send it out.
- **Recommendation:** Spawn the bundled daemon with an allow-listed environment: PATH, HOME, locale, proxy variables and what agents need. Strip `ORCA_DAEMON_TOKEN*`, `ORCA_UPDATE_*`, `ORCA_RENDERER_URL`, `ELECTRON_*` (except `ELECTRON_RUN_AS_NODE`) and `NODE_OPTIONS`.

### C5a-14 — Windows `selection.json` replace uses a fixed exclusive temp name that is never cleaned up
- **Category:** reliability
- **Severity:** Medium
- **Confidence:** High
- **Location:** `native/diagnostics/first-run-windows.c:193-213` (`wcscpy(temporary, L"selection.json.tmp")`, then `NT_CREATE`; no delete on the failure paths). Callers: `setup.ts:319` and `:456` (`windowsWrite(receiptPath, …, true)`).
- **Issue:** `replace` creates `selection.json.tmp` with an exclusive create disposition. If `WriteFile`, `FlushFileBuffers` or the rename fails, the temp file is left behind. Rename fails, for example, when antivirus or indexing holds `selection.json` without `FILE_SHARE_DELETE`; a crash between create and rename does the same. Every later `replace` then fails with EEXIST. POSIX uses `randomUUID()` temp names, so this is a Windows-only divergence.
- **Scenario / evidence:** On Windows, a transient sharing violation during first-run Prepare or Bind leaves `%APPDATA%\ORCA\first-run\selection.json.tmp`. All later Prepare/Bind attempts fail with the generic "Project setup could not verify…" until the user deletes the file by hand.
- **Recommendation:** Use a random temp name (validated by `filename()`), or open the temp with `NT_OPEN_IF` plus truncate after checking ownership and ACL. Set `FileDispositionInfo` to delete the temp on every failure path.

### C5a-15 — Guided-launch checkout evidence fails on large working-tree diffs (1 MiB `maxBuffer`, 5 s timeout)
- **Category:** correctness
- **Severity:** Medium
- **Confidence:** High
- **Location:** `src/main/guided-checkout.ts:47-61` (`execFile` with `timeout: 5000, maxBuffer: 1024*1024`; `git diff --no-ext-diff --no-textconv --binary HEAD --` and `git status --porcelain -z`).
- **Issue:** The full binary diff is buffered in memory only to be hashed. Any tracked change over 1 MiB fails `execFile` with ERR_CHILD_PROCESS_STDIO_MAXBUFFER, which is caught and returned as `unavailable`. A regenerated lockfile, a modified binary asset or a large refactor is enough. A `git status` slower than 5 s on a large repository fails the same way.
- **Scenario / evidence:** A prepared checkout with a regenerated `pnpm-lock.yaml` or a changed image: `snapshot()`/`preflight()` returns checkout `unavailable` ("Check its path, Git availability and attached branch"), so guided launch cannot be submitted. The message points at the wrong cause.
- **Recommendation:** Stream `git diff` stdout into the SHA-256 hash with `spawn` instead of buffering it, or hash with `git diff --binary | git hash-object --stdin` (or `git write-tree` on a temporary index). Raise or remove `maxBuffer` for streamed output, and use a size-independent timeout.

### C5a-16 — Electron hardening configuration gaps: no fuses, `ORCA_RENDERER_URL` honoured in packaged builds, `file://` renderer
- **Category:** configuration
- **Severity:** Low
- **Confidence:** High
- **Location:** `electron-builder.yml` (no `electronFuses`, and the `afterPack` hook does not flip fuses), `src/main/index.ts:154, 1216-1218`.
- **Issue:**
  1. **Fuses are not configured.** `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` and `GrantFileProtocolExtraPrivileges` are all at their defaults. `RunAsNode` must stay on because the daemon is spawned through `ELECTRON_RUN_AS_NODE`, which also lets any local process run the ORCA binary as Node.
  2. **`ORCA_RENDERER_URL` is read even when `app.isPackaged`.** A packaged app launched with it (a leftover developer shell variable, or a launcher that sets it) loads that URL with the full preload bridge and opens DevTools. On a shared machine that URL could point at a port another user controls.
  3. **The renderer is loaded from `file://`** with `GrantFileProtocolExtraPrivileges` on. Any future renderer XSS could `fetch('file:///…')` local files, because CSP `default-src 'self'` covers `file:`.
- **Recommendation:**
  - Ignore `ORCA_RENDERER_URL` unless `!app.isPackaged`.
  - Add `@electron/fuses` in `afterPack`: NodeOptions off, NodeCliInspect off, asar integrity on, OnlyLoadAppFromAsar on, GrantFileProtocolExtraPrivileges off.
  - Serve the renderer through a `protocol.handle("app", …)` custom scheme.
  - Document why RunAsNode stays enabled, or ship the daemon with a separate Node.

### C5a-17 — The auto-discovered local-owner token is sent to user-entered loopback URLs, which are documented SSH-tunnel endpoints
- **Category:** security
- **Severity:** Low
- **Confidence:** Medium
- **Location:** `src/client/auth.ts:54-61` (`file = … ?? (workspace && isLoopbackDaemon(url) ? localDaemonTokenFile(workspace) : undefined)`), `src/main/workspace.ts:841` (`deps.client(url, { workspace: path, bundled: false })` with `path = ORCA_WORKSPACE`), `index.ts:617-648`.
- **Issue:** The docs say the user should "Enter the local end of the supported SSH tunnel, such as http://127.0.0.1:6722" and that "automatically discovered local-owner credentials are never forwarded to remote hosts". With `ORCA_WORKSPACE` set and no explicit token variables, any loopback URL receives `<workspace>/auth/local-client.token`, including a tunnel whose far end is a remote host.
- **Scenario / evidence:** A developer with `ORCA_WORKSPACE=~/proj` connects to `http://127.0.0.1:7000`, an `ssh -L` tunnel to a shared build host. The local daemon's owner bearer token is sent to whoever answers on the remote side.
- **Recommendation:** Do not auto-discover token files for dialog/saved targets. Use discovery only for app-spawned bundled children, which already pass `tokenFile`; require an explicit token or file for every user-entered endpoint.

### C5a-18 — Preferences: one invalid field resets everything, and the next write erases the saved endpoint and unknown keys
- **Category:** data-integrity
- **Severity:** Low
- **Confidence:** High
- **Location:** `src/preferences/preferences-file.ts:21-36` (whole-file `safeParse` → `DEFAULT_PREFERENCES`), `:54-58` (`write` merges over `read()`), `:46-51` (no fsync).
- **Issue:** One field outside the schema makes `read()` return defaults: a density value or pane id from a newer build, or a hand edit. The next `preferences.write` (any pane drag or density change) persists defaults plus the patch, silently dropping `daemonUrl`, theme and alerts. The strip-unknown parse also discards forward-compatible keys on every write. The temp-then-rename sequence has no `fsync`.
- **Scenario / evidence:** Downgrade after a newer version stored `density: {runs: "dense"}`. The old app reads defaults, the user drags a splitter, and `preferences.json` is rewritten without the saved daemon endpoint. Next launch connects somewhere else (bundled/first-run).
- **Recommendation:** Parse per field (`catch()` per key) so one bad entry falls back alone. Preserve unknown keys with `.passthrough()` on read and merge. Write with a unique temp file, `fsync`, then rename.

### C5a-19 — A malformed deep link crashes the renderer on cold start
- **Category:** reliability
- **Severity:** Low
- **Confidence:** Medium-High (the fix belongs partly to the renderer scope)
- **Location:** `src/main/deep-link.ts:62-69` (only the scheme prefix is checked), `renderer/src/route-table.ts` (`segments.map(decodeURIComponent)`, which can throw `URIError`), `renderer/src/App.tsx:450-455` (`navigate(waiting)` inside `useEffect`). The renderer has no error boundary.
- **Issue:** `orca://run/%E0%A4%A` passes main's filter. In the renderer, `resolveRoute` throws inside the first-pass effect, the error propagates to React, and the root unmounts, leaving a blank window until reload.
- **Scenario / evidence:** A link in chat or on a web page with a malformed percent-escape launches ORCA on Windows/Linux (the URL is in argv). The app opens blank.
- **Recommendation:** In main, validate with `new URL()` and a `decodeURIComponent` probe (or at least cap length and require a known host) before queueing. In the renderer, wrap `decodeURIComponent` in try/catch and return `undefined`. Add a root error boundary.

### C5a-20 — `storage.c` `pair_copy` recurses with about 72 KiB of stack per level on libuv worker threads
- **Category:** memory-safety
- **Severity:** Low
- **Confidence:** Medium
- **Location:** `native/diagnostics/storage.c:247-296` (`unsigned char buffer[65536]`, `char target[PATH_MAX]`, `char copy[PATH_MAX]` per frame; recursion depth up to 64), `storage.c:214-216` (`pair_metadata`: 2 × 32 KiB arrays).
- **Issue:** The worst case is about 64 × 72 KiB + 64 KiB ≈ 4.7 MiB of stack on a threadpool thread. libuv sizes these stacks from `RLIMIT_STACK` and falls back to its default when the limit is unlimited, which can be well below that. Overflow of a worker stack crashes the whole Electron main process. The bound is enforced and real trees are shallow, so this is hardening rather than a demonstrated crash.
- **Recommendation:** Allocate the copy buffer and xattr lists once on the heap (per job) and pass them down; or iterate with an explicit stack. Add `-fstack-protector-strong` and `-Wframe-larger-than=` to the build.

### C5a-21 — `orca:workspace.open` accepts an arbitrary renderer-supplied path (unused API surface)
- **Category:** security / design
- **Severity:** Low
- **Confidence:** High
- **Location:** `src/main/index.ts:798-821` (`openStore(params.path)`), `src/preload/index.cts:334`, `bridge.ts:494`.
- **Issue:** The renderer never passes a path (verified; only the menu and banner call it, without one). Main still accepts one and starts `orca serve --read-only --cwd <path>` on it without a dialog. The first-run README explicitly says "Never accept a renderer-supplied path". Combined with C5a-06, foreign content can spawn daemons on arbitrary directories and read their stores.
- **Recommendation:** Remove `path` from the bridge and IPC contract. Always pick the directory through the main-owned dialog.

### C5a-22 — Ordinary daemon RPCs and the subscribe acknowledgement have no timeout
- **Category:** reliability
- **Severity:** Low
- **Confidence:** High
- **Location:** `src/client/daemon-client.ts:232-268` (no signal unless a caller passes one; only `hello` uses `AbortSignal.timeout(10_000)`), `src/client/subscription.ts:250-259` (no timer on `pendingSubscribe`).
- **Issue:** A daemon (or tunnel) that accepts TCP but stalls leaves reads such as `runs.list`, `config.get` and `operator.*` pending for ever. The IPC invoke never settles, and guided snapshot loops over workflows serially. A socket that opens but never acknowledges `subscribe` stays `connecting` for ever, so the machine never reaches `disconnected`.
- **Recommendation:** Give reads a default timeout (for example 30 s), while keeping the intentionally long-polling `inputs.answer`/`runs.resume` without one. Add a subscribe-acknowledgement timer that closes and reconnects with backoff.

### C5a-23 — Alerts: unbounded `unfocusedEscalationMs` overflows `setTimeout`; `AlertsUpdate` is unvalidated
- **Category:** reliability
- **Severity:** Info
- **Confidence:** High
- **Location:** `src/preferences/schema.ts` (`z.number().int().positive()` with no maximum), `src/main/alerts.ts:197-204`, `src/main/index.ts:1128-1130`.
- **Issue:** Values above 2^31−1 ms make Node fire the timer after 1 ms, so gates escalate immediately when focus is lost. An `orca:alerts.update` payload is used without schema checks; a non-array `items` throws inside an `ipcMain.on` listener, which shows the main-process error dialog.
- **Recommendation:** Clamp the preference to ≤ 24 h in the schema, and `safeParse` the IPC payload.

### C5a-24 — Windows native storage holds destination-directory handles without `FILE_SHARE_DELETE`; exports to existing files or other volumes are refused
- **Category:** maintainability
- **Severity:** Info
- **Confidence:** Medium
- **Location:** `native/diagnostics/storage-windows.c:174-186` (`destination_ancestry` is kept until the next selection or `closeRoot`), `storage-windows-common.h:190-191` (`FILE_SHARE_READ|FILE_SHARE_WRITE` only), `storage.c:346-358` / `storage-windows.c:81-98` (same-device and must-not-exist checks).
- **Issue:** After the user chooses a save destination, every ancestor directory (drive root → Documents) stays open without delete sharing, so the user cannot rename or move those folders while the app runs. Saving over an existing file, which the OS dialog itself offers, or to another volume returns a generic "refused".
- **Recommendation:** Close the destination chain after publish or cancel, and add `FILE_SHARE_DELETE` (identity is re-verified at publish anyway). Tell the user why an existing file or another volume is refused.

### C5a-25 — Windows updater: no Authenticode verification (unsigned builds) and the feed URL comes from the environment
- **Category:** security
- **Severity:** Info
- **Confidence:** Medium
- **Location:** `src/main/update-driver.ts:5-27`, `electron-builder.yml` (Windows build is unsigned, no `publisherName`).
- **Issue:** Without `publisherName`, electron-updater skips signature verification, so installer integrity rests only on the `latest.yml` sha512 from the same HTTPS feed plus a bearer token. `ORCA_UPDATE_URL`/`ORCA_UPDATE_TOKEN_FILE` are read from the process environment. An attacker who controls the environment already has user-level execution, but anyone who compromises the feed host can push arbitrary installers.
- **Recommendation:** Sign the NSIS installer and set `publisherName` (or `verifyUpdateCodeSignature`) before enabling the updater broadly. Consider pinning the feed URL in `app-update.yml` instead of an environment variable.

## Strengths
- Sound baseline window security: `contextIsolation: true`, `sandbox: true`, Node integration off (the default), CommonJS sandboxed preload, and a strict production CSP with no `unsafe-inline`.
- Connection epochs are fenced before dispatch and after completion (`callInConnection`, preload epoch filtering on notifications and connection pushes), so old-target replies cannot cross into a new target. Credentials stay main-only, redirects are refused, and remote tokens require HTTPS.
- Diagnostics privacy is very strong: closed `phase`/`code` vocabulary, no free text, paths or tokens; exports go through a main-owned save dialog with handle-relative, no-replace publication; sender frame, document generation and window are checked on diagnostics IPC.
- The native C code is careful:
  - Strings are length-checked before every `strcpy`/`wcscpy`, and UTF-8↔UTF-16 conversions use fail-on-overflow APIs.
  - N-API statuses are checked, handles are type-tagged and reference-counted, and a per-root busy flag serialises worker jobs.
  - Every path walk uses `openat`/`O_NOFOLLOW` (`OBJ_DONT_REPARSE` on Windows) with ACL and owner checks.
  - `-Wall -Wextra -Werror` (`/W4 /WX` on Windows).
- The first-run code fails closed throughout: exclusive creates, identity re-checks, the fence and the journal are rigorous against concurrent tampering. The defects above are about lifecycle and recoverability, not unsafe acceptance.
- `startBundledDaemon` bounds its output tail, retries port races, escalates SIGTERM → SIGKILL and suppresses `onExit` for intentional stops. Subscription reconnect uses capped backoff with a single bounded auth refresh.
