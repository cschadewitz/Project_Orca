# Code review — 13 October 2026

A full static review of the source, split into nine scopes and read in parallel. A separate
verifier then tried to refute every Critical and High finding. This is a dated record, not a
living spec. Its companion is the
[documentation and design variance review](2026-10-13-docs-code-variance.md), which compares
the docs and the design system against the same code.

- **Pin:** `0c75d01eb0cab389ad1cbff5d1fb9a60bfe64362` (main, "Fix the discard test's wait, and
  accept reviewed runner skips in selected PR runs (#628)").
- **Method:**
  - Static. Nothing was built, installed or run. The review container had Node 22 and no
    `node_modules`, and the repository requires Node 24.
  - Nine reviewers each read one scope in full, with its tests. They kept only findings that
    have a concrete path from a real caller or input to the failure.
  - All 31 findings rated Critical or High were re-read against the code by someone trying to
    refute them. Six verifiers (V1–V6) took 29; the lead checked C6-01 and C8-03 directly.
    - **None was refuted**, and one was found only plausible (C5a-06).
    - **15 stay High.** C7-01 is one of them, lowered from Critical.
    - **16 drop to Medium or Low.** The usual reasons were a fail-safe outcome, an easy
      recovery, or a path that is switched off today.
  - **Medium, Low and Info findings were not independently verified.** Each cites file and line
    and gives a scenario, but treat them as the reviewer's claim and confirm before acting.
- **Severity:**
  - **Critical:** exploitable escalation, code execution, secret exposure, or data loss in
    normal use.
  - **High:** a likely bug that affects correctness or safety in realistic use.
  - **Medium:** an edge-case bug, a meaningful performance issue, or a design flaw.
  - **Low:** minor robustness or maintainability.
  - **Info:** hardening or an observation.

  Severities below are after verification. Where one changed, the entry says what it was.
- **Categories:** each finding has one primary category, the first one its reviewer gave. The
  detail files keep any secondary categories.
- **Line numbers** are as of the pin and will drift. Most paths are relative to the repository
  root; some write-ups use package-relative paths.
- **Detail:** [`2026-10-13-review-detail/`](2026-10-13-review-detail/README.md) has the full
  write-up for each scope: coverage, issue, scenario and evidence, recommendation, and
  strengths. The verifiers' notes are there too, as V1–V6.

## Summary

| Scope | Area | Critical | High | Medium | Low | Info | All |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [C1](2026-10-13-review-detail/C1.md) | Daemon (`packages/daemon`) |  |  | 7 | 9 | 4 | 20 |
| [C2](2026-10-13-review-detail/C2.md) | Engine (`packages/engine`) |  | 1 | 11 | 7 | 1 | 20 |
| [C3](2026-10-13-review-detail/C3.md) | Core, store and protocol |  | 1 | 9 | 11 | 2 | 23 |
| [C4](2026-10-13-review-detail/C4.md) | CLI, agents, integrations, maintenance MCP, testing helpers |  | 1 | 9 | 12 | 4 | 26 |
| [C5a](2026-10-13-review-detail/C5a.md) | Desktop main process (except the Mac updater), preload, native addons |  | 4 | 10 | 8 | 3 | 25 |
| [C5b](2026-10-13-review-detail/C5b.md) | Mac update subsystem and Mac packaging tooling |  | 1 | 10 | 5 | 1 | 17 |
| [C6](2026-10-13-review-detail/C6.md) | Renderer: runs, step detail, attention, palette, lists, chrome |  | 5 | 12 | 11 |  | 28 |
| [C7](2026-10-13-review-detail/C7.md) | Renderer: config, plan, workflows, guided launch, templates, agents |  | 1 | 14 | 12 | 1 | 28 |
| [C8](2026-10-13-review-detail/C8.md) | CI, release and deploy tooling, build and dependencies |  | 1 | 6 | 12 | 4 | 23 |
|  | **Total** | **0** | **15** | **88** | **87** | **20** | **210** |

| Category | Critical | High | Medium | Low | Info | All |
| --- | --- | --- | --- | --- | --- | --- |
| correctness |  | 6 | 22 | 23 | 1 | 52 |
| security |  | 1 | 13 | 21 | 4 | 39 |
| reliability |  | 4 | 13 | 13 | 2 | 32 |
| performance |  | 1 | 14 | 9 | 1 | 25 |
| data-integrity |  | 1 | 11 | 6 |  | 18 |
| maintainability |  |  |  | 1 | 9 | 10 |
| accessibility |  |  | 2 | 5 |  | 7 |
| resource-leak |  |  | 3 | 2 | 1 | 6 |
| design |  | 1 | 4 | 1 |  | 6 |
| concurrency |  |  | 2 | 1 |  | 3 |
| configuration |  |  |  | 2 | 1 | 3 |
| testing |  |  | 2 | 1 |  | 3 |
| supply-chain |  |  | 2 |  | 1 | 3 |
| ci-cd |  | 1 |  | 1 |  | 2 |
| memory-safety |  |  |  | 1 |  | 1 |

There is nothing Critical after verification. The daemon's security model held up under a
full read:

- 256-bit tokens, stored hashed and compared in constant time.
- Host and Origin checks, deny-by-default operations, `--read-only` as a true omission, and
  0600/0700 files.
- The companion review found the permission table in `daemon-security.md` matches
  `auth/operations.ts` row for row.

The weaknesses are elsewhere:

- **What an agent can reach on the machine it runs on** (C4-01, C4-02).
- **Desktop state machines that fail closed with no way back** (C5a-01, C5a-03, C5a-04, C5a-05,
  C5b-01).
- **Attention keyboard paths that can answer the wrong thing** (C6-01, C6-02, C6-03).
- **A release pipeline that will not get through its next run** (below).

## Fix first

### The next release will not get through

Each of these fails the release workflows as they stand. D5-01 and D5-03 come from the
companion review, but they are build and test defects, not prose.

| ID | What fails | First step |
| --- | --- | --- |
| C8-03 (= D5-02) | `release-publish.yml:82-83` runs `pnpm test` before `pnpm run build`. On a clean checkout the compiled-MCP acceptance fixture throws "Acceptance requires a fresh compiled build" (`mcp-operator-production-fixture.ts:246`). `ci.yml` builds first, which is why CI is green. | Build before testing, and mirror `ci.yml`'s set: `design:check`, `ORCA_MCP_REQUIRE_PRODUCTION=1`, and the no-skip retry acceptance. |
| D5-01 (= D7-13) | App smoke gates publication. Its audited-surface table (`app-shell.spec.ts:131-149`) still presses ⌘4 for Agents and ⌘5 for Config. Since #610 those keys open Workflows and Agents, so the Agents and Config cases wait for content that never appears, and Workflows is never audited. | Derive the table from `SURFACE_IDS` and add a Workflows entry. |
| D5-03 | `changelog.d/daemon-handler-settlement.md` has no section suffix, so `tools/release.js notes --unreleased` and `prepare` exit 1. The reviewer confirmed this by running it. | Rename the fragment to `<issue>-daemon-handler-settlement.<section>.md`. |
| C5b-07 | Verifier V4 says the macOS legs of `app-smoke.yml` launch unpackaged Electron. The native storage addon only loads from a packaged app, so the startup gate never opens and the app never reaches `live`. | Give unpackaged runs an explicit, test-only way past the gate, or load the addon from the build output when unpackaged. |

### Security

| ID | Severity | Finding |
| --- | --- | --- |
| C4-01 | High | With no `workspace:` set, the agent's workspace is the config directory. That directory holds `orca.permissions.json`, `orca.config.yaml`, `.orca/` (with the store key) and `auth/local-client.token`, which is an owner credential. The default policy allows edits inside the workspace, and the sidecar is re-read on every ask. A prompt-injected agent can write `{"match":{},"decision":"allow"}` and every later `execute` is approved. Worktree isolation covers per-item runs only. **Fix:** keep the sidecar, `auth/` and the store out of every agent root, and refuse to start when a root contains them. A policy check alone is not enough, because agents' native tools can write without asking. |
| C7-01 | High (was Critical) | The Agents policy draft is a whole-file copy of the permission sidecar, saved against the newest revision the renderer has seen rather than the one it was built on. An "allow always" grant written in between is erased, and a grant revoked by another client can return. **Fix:** keep the draft as the agent's rule list and compose it onto the file on disk at save time. Sending the base revision alone still loses the grant on Reload-then-Save. |
| C6-01 | High | In a gate or permission card, Enter on any focused button submits the card's selected option. The card's Enter shortcut runs and calls `preventDefault()`, which cancels the button's own activation. So Tab to **Always deny**, press Enter, and **Allow once** is sent. **Fix:** fire the card's Enter only when the card element itself is the event target (a `when` predicate on the shortcut), so a focused button activates normally. |

Medium and Low findings in the same family:

- **Credentials in agent processes:** agents inherit the parent environment, including
  `ORCA_DAEMON_TOKEN` (C4-02, C5a-13, C8-17). The SSH host puts agent env values, including API
  keys, on the local `ssh` command line (C4-03).
- **Untrusted config and input:** config discovery imports plugins from any ancestor directory
  (C4-06). The ACP facade relabels forwarded permission options by position (C4-07). The CLI
  prints terminal escapes from agent text (C4-09).
- **Secrets and paths:** redaction runs after text has been truncated or split (C2-12). The
  workspace permission scope compares paths as text (C3-09).
- **CI and release:** C8-01, C8-02 and C8-04 to C8-07 cover a write token and the feed deploy
  key on the persistent homelab runner, tag-pinned `pnpm/action-setup`, dispatch from any ref,
  and unsigned desktop builds.
- **Electron hardening:** C5a-06 is defence in depth with no trigger at the pin. Add a navigation
  allow-list, deny-by-default window-open and permission handlers, and `senderFrame.url` checks
  on IPC.

### The desktop app locks itself out in ordinary use

Each of these is a fail-closed check with no supported way back. Each was confirmed by a
verifier.

| ID | Trigger | Effect |
| --- | --- | --- |
| C5a-01 | Any unclean exit followed by a reboot. Windows sends no quit events on shutdown, restart or logout. | The first-run workspace is refused for good, because recovery requires the same boot ID (`recovery.ts:72-77`). A cross-boot route needs the owner's sign-off: `first-run-same-boot-recovery.md:142-146` records a similar route (#577) as rejected. |
| C5a-03 | About 255 launches or reconnects. | The ownership journal refuses at 256 attempts and is never compacted (`ownership.ts:226`). |
| C5a-04 | Any commit, pull or branch switch in the selected project. | The saved selection pins HEAD and the branch, so startup falls back to "Choose a project…" and the old store is stranded. |
| C5a-05 | About 1000 app-started runs, across all workspaces. | The admission-intent journal refuses new records, because abandoned ones are never pruned, and the message wrongly points at the keychain. The workaround is to delete `userData/admission-intents.enc`. |
| C5b-01 | Migration Assistant, a Time Machine restore, a home-folder move, a crash during first-launch provisioning, or moving or renaming the first-run workspace folder. | Every Mac launch opens only the recovery shell, because stored directory identities must match exactly, and there is no reset. This is on `main` and ships with the next release; v0.6.0 predates it. |

C5a-02 (Medium) is related. The Windows updater stops the first-run daemon without settling
ownership, so a failed install cannot reconnect.

### Answering the wrong thing in Attention

C6-01 is above. Two related High findings:

- **C6-02:** palette answer and cancel rows act on whichever card is focused when they run, not
  the card they name. A new permission ask arriving is enough to shift the cards.
- **C6-03:** any push that changes the waiting list moves focus while a person is typing in a
  card, so their next keys act as card shortcuts and Enter can send a half-typed note.

C6-16 (Medium) is in the same family: a held Enter defeats the palette's two-press confirmation.

### The other High findings

- **C2-01:** with `parallel` and `plan-dispatch`, a later sibling sees artifacts from earlier
  finished siblings. With the shipped `program.yaml`, from the third item on, a build is handed
  another item's test report and review as things to fix. The docs say this cannot happen; the
  code is what's wrong.
- **C3-01:** every event append and read lists the whole `private-execution/` directory, which
  gains a file per protected event and is never pruned. The cost grows with the store's
  lifetime.
- **C6-05:** after following a run link, the Runs selection snaps back to that run on every App
  render.
- **C6-08:** keyboard, minimap and search moves don't release follow mode, so the next append
  pulls the view back to the end.

## Themes in the Medium findings

- **Whole-store scans and unbounded growth.** These are fine at demo scale and degrade a
  long-lived daemon or app.
  - Daemon: C1-02 to C1-06, C1-13.
  - Engine: C2-10, C2-11.
  - Store: C3-06, C3-08, C3-10, C3-11.
  - Desktop main process: C5a-12.
  - Renderer: C6-09, C6-13, C7-15.

  Most share one shape: a read path that projects the whole store or log on every call.
- **File-store durability.**
  - A stale lock whose PID was reused is never broken (C3-03).
  - A failed put stays visible to readers and is persisted by the next write (C3-04).
  - Blobs are overwritten in place with no fsync or hash check on read (C3-05).
  - Lows: C3-12, C3-21, C1-11.
- **Fan-out and work-item integrity in the engine.**
  - Child provisioning holds the parent's lease mutex (C2-04).
  - Losing the parent's lease cancels its children durably (C2-05).
  - Non-idempotent registration (C2-06) and duplicate slugs (C2-07).
  - `scope: plan` breaks with a `requestId` (C2-08).
  - Worktrees are keyed by slug only (C2-09).
- **Renderer state against pushes and reconnects.**
  - Reconnect resets screens to loading (C6-04).
  - Prepend and trim races in the timeline and output buffer (C6-10, C6-11).
  - Workflow edits addressed by index against a newer revision (C7-06).
  - Edits typed during a Save are lost (C7-08, C7-09).
  - Plan journal gaps (C7-10).
  - Guided-launch review resets (C7-11).
  - The editor unmounts on `workflows.changed` (C7-13).
  - A decision's rationale is cleared on refusal (C7-14).
- **Desktop lifecycle.**
  - Deep links are lost or crash main (C5a-07).
  - Open a store: a failed open keeps the old client (C5a-08), and a successful one stops
    in-flight runs (C5a-09).
  - First-run and daemon startup: a failed start leaves the session busy (C5a-10), and
    quitting during startup orphans the child (C5a-11).
  - Windows temp files are never cleaned up (C5a-14).
  - Large diffs break the checkout evidence (C5a-15).
- **Mac updater, latent until activation.**
  - C5b-02 to C5b-06, C5b-08 to C5b-10 and C5b-17.
  - They are unreachable while `activationAllowed` is `() => false` and no update authority is
    supplied. Several would brick installs once it is switched on, so treat them as blockers
    for activation, not for today.

## What held up

The reviewers called these out as done carefully:

- **Daemon authentication and transport:** hashed 256-bit tokens with a constant-time compare,
  generic auth errors, DNS-rebinding and Origin checks, and deny-by-default operations checked
  before params.
- **Engine write fencing and live permission handling:** writes go through the lease mutex;
  claims are taken before any await; answers are durable under the lease.
- **Owned-root worktrees:** an fsync'd receipt before any git effect, realpath checks on every
  path component, and `--end-of-options`.
- **Protected records:** AES-GCM with associated data bound to the record name, write-once
  publication, `O_NOFOLLOW`, and stat identity checks.
- **Protocol and wire validation:** runtime zod validation of every inbound message.
- **Electron baseline:** `contextIsolation`, `sandbox`, and a strict CSP. Connection epochs are
  fenced on every reply and notification.
- **Diagnostics privacy:** a closed vocabulary with no free text, and main-owned, handle-relative
  export.
- **Native C code:** length-checked copies, overflow-checked conversions, checked N-API statuses,
  `openat`/`O_NOFOLLOW` everywhere, and `-Werror`.
- **Mac update verification:** no TOCTOU gap between verify and install, a thorough codesign and
  notarization check, and a high-quality ZIP containment parser.
- **Renderer rendering:** no HTML sinks anywhere. Agent output, artifacts, diffs and YAML are
  all React text.
- **CI:** no `pull_request_target`. Event fields stay out of shell. Fork-reachable CI is on
  hosted runners with read-only tokens. Installs use `--frozen-lockfile` with an allowlist for
  lifecycle scripts.

## All findings

Grouped by scope, most severe first. Each entry gives severity (after verification) and
primary category, then where the problem is and the reviewer's recommendation. Verified
findings carry the verifier's note, and overlapping findings point at each other. The
scenario and evidence for every entry are in its scope's detail file.

### C1 — Daemon (`packages/daemon`)

Full write-up: [C1.md](2026-10-13-review-detail/C1.md).

- **C1-01** · **Medium** · resource-leak — Socket closing during `subscribe` leaks a permanently attached event-store listener
  - *Where:* `packages/daemon/src/socket.ts:172-232`, related `socket.ts:252-255`, `auth/guard.ts:627-640`, `auth/resources.ts:99-112`
  - *Recommendation:* After every await in the subscribe path, bail out if `ws.readyState !== ws.OPEN || principal === undefined`. Register the subscription in the map before the first await and have `stopAll` stop it, or keep a `closed` flag that `start()` checks. Cap subscriptions per connection.
- **C1-02** · **Medium** · resource-leak — No backpressure for slow or stalled socket subscribers: unbounded daemon memory
  - *Where:* `packages/daemon/src/socket.ts:116-118`, `socket.ts:192-203`, related `subscriptions.ts:301-305`
  - *Recommendation:* Before sending, check `ws.bufferedAmount` against a high-water mark. Past it, either drop to a "resync required" notification (clients already re-read via cursors) or close with a dedicated code.
- **C1-03** · **Medium** · performance — `OwnershipStore.owner()` copies the whole ownership map on every call; the file grows forever and is rewritten with two fsyncs per run
  - *Where:* `packages/daemon/src/auth/ownership.ts:23-30` (`owner`), `ownership.ts:115-131` (`readDisk`), `ownership.ts:80-115` (`persist`), related `auth/resources.ts:137-140`, `execution-runtime.ts:32-45`, `live-input-authority.ts:94,130-132`
  - *Recommendation:* Have `owner()` read from the cached map without copying it; return a single value.
- **C1-04** · **Medium** · performance — Restricted `runs.list` and `artifacts.list` cost quadratic full-store scans
  - *Where:* `packages/daemon/src/auth/guard.ts:499-521` (`runsList`), `guard.ts:528-575` (`artifactsList`), related `read-model.ts:442-466`
  - *Recommendation:* Call the read model once with no paging (an internal "all rows" entry point) and filter in memory. Better, push the scope filter (workflow allowlist and owner set) into the read model before it builds views. For artifacts, filter the artifact index by the visible run set in a single `artifacts.list` instead of one call per run.
- **C1-05** · **Medium** · performance — `operator.page` paging is quadratic in run length (rows re-projected from offset 0, and the log rescanned per 100-event chunk)
  - *Where:* `packages/daemon/src/operator-read-model.ts:200-207` (cursor skip), `operator-read-model.ts:532-567` (`eventSnapshot`), related `store/src/jsonl-event-store.ts:169-194`
  - *Recommendation:* Encode the last emitted `seq` in the cursor (it is already HMAC-bound) and restart `readRange` from that `seq` rather than from offset 0. Have the generator carry its own byte-offset or `seq` position instead of calling `readRange(after)` repeatedly, or add a seq→offset index to the JSONL store.
- **C1-06** · **Medium** · performance — `subscribe { runId, since }` replays the entire tail in one materialized read, coalescing all `agent.update` events into a single giant frame
  - *Where:* `packages/daemon/src/subscriptions.ts:255-271`, `subscriptions.ts:307-349`, related `protocol/src/subscriptions.ts:456`
  - *Recommendation:* Replay in bounded pages and await socket drain between them. Cap updates per coalesced `agent.update` frame and split oversized batches. If `lastSeq - since` exceeds a threshold, answer "cursor too old, page with `runs.events`" instead of replaying.
- **C1-07** · **Medium** · data-integrity — Plan writes are journalled under a fixed actor (`"daemon"`), not the authenticated principal
  - *Where:* `packages/daemon/src/plan-control.ts:68` (`this.origin = { kind: "human", actor: opts.actor ?? "daemon" }`), `methods.ts:683-705`, `cli/src/commands/index.ts:1039-1047` (no `actor` passed)
  - *Recommendation:* Pass `ctx.mutationActor` through the plan-control methods and build `PlanOrigin.actor` from the principal id per call (and the credential id where the schema allows it). Do the same for `claims.release`.
- **C1-08** · **Low** (confirmed) · security — Prototype pollution through `config.set` patch paths (`__proto__`), even with `validateOnly`
  - *Where:* `packages/daemon/src/config-model.ts:583-595` (`setInPlain`), called from `config-model.ts:446` and `config-model.ts:467`, reached from `config-model.ts:280` (`validateOnly`) …
  - *Recommendation:* Reject the segments `__proto__`, `prototype` and `constructor` in `splitPath`. Build plain objects with `Object.create(null)`, or use `Object.hasOwn` and `Object.defineProperty`. Add a test for both documents and for `validateOnly`.
  - *Verified (verifier V1):* Same finding as C3-02. Hardening: validate each patch segment as `ConfigEditPathSchema` does and walk own properties only in `setInPlain`.
  - *Related:* C3-02
- **C1-09** · **Low** · reliability — WebSocket inbound limits much weaker than `/rpc`: 100 MiB frames, unlimited subscriptions and in-flight requests per connection
  - *Where:* `packages/daemon/src/socket.ts:82-87` (no `maxPayload`), `socket.ts:145-250`; compare `server.ts:137-149` (`MAX_BODY_BYTES = 1_000_000`)
  - *Recommendation:* Set `maxPayload` to about 1 MB to match `/rpc`. Cap subscriptions per connection (for example, 32) and in-flight requests per connection, and refuse beyond the caps.
- **C1-10** · **Low** · security — `agents.ping` spawns agent processes in a caller-chosen, unconstrained `cwd`, with no concurrency limit (also on `--read-only`)
  - *Where:* `packages/daemon/src/agent-model.ts:89-116` (`const cwd = params.cwd ?? host.spec.workspaceRoot ?? ...`), schema `protocol/src/agents.ts:96-103` (`cwd: z.string().min(1).optional()`) …
  - *Recommendation:* Ignore or validate `cwd`: restrict it to the host's `workspaceRoot` or the config directory, or drop the parameter. Serialize pings per agent and rate-limit them.
- **C1-11** · **Low** · data-integrity — Audit trail durability: records are not flushed on shutdown, and long-running mutations are only audited when they finish
  - *Where:* `packages/daemon/src/auth/audit.ts:106-130` (async queue), `server.ts:1031-1047` (`close()` never flushes the audit sink), `auth/guard.ts:307-321` …
  - *Recommendation:* Add `flush()` to the `AuditSink` contract and await it in `DaemonHandle.close()`.
- **C1-12** · **Low** · security — Raw messages of non-`OrcaError` exceptions are returned to any authenticated caller
  - *Where:* `packages/daemon/src/server.ts:199,217,960`, `socket.ts:168,183,231`; `core/src/errors.ts:84-88` (`if (e instanceof Error) return { code: "INTERNAL", message: e.message }`)
  - *Recommendation:* In `dispatch` and the socket handlers, map non-`OrcaError` and non-`ProtocolFault` exceptions to a generic `INTERNAL` message with a correlation id, and log the full error server-side.
- **C1-13** · **Low** · performance — `inputs.answer` without `runId` scans every run's full state, up to three times per call
  - *Where:* `packages/daemon/src/control.ts:149-173` (`findInput`: `ids = runId ? [runId] : await orc.listRuns()`, then `getState` for each), called at `control.ts:281`, `control.ts:298` (when `always` is set) and `control.ts:103` (`answerAndResume`)
  - *Recommendation:* Resolve the request once with `pendingInputs()` or an index (the guard already has `resolver.inputRun`), then pass the found `runId` into the later steps.
- **C1-14** · **Low** · reliability — Credential-file robustness: no fsync, an unvalidated `expiresAt` fails open, revoked bootstrap records accumulate
  - *Where:* `packages/daemon/src/auth/credentials.ts:104-110` (`writePrivateFile`: write, chmod, rename, no fsync), `credentials.ts:50,276`, `credentials.ts:206-214`
  - *Recommendation:* fsync the temp file and the directory in `writePrivateFile`.
- **C1-15** · **Low** · reliability — HTTP body-limit path cannot actually deliver its 413, and client aborts are reported as 413
  - *Where:* `packages/daemon/src/server.ts:139-149` and `server.ts:956-961`
  - *Recommendation:* Check `content-length` up front and answer 413 before reading. On overflow, stop consuming, send 413 with `connection: close`, then destroy. Distinguish `aborted` from oversize.
- **C1-16** · **Low** · correctness — An IPv6 host yields malformed `url` and `socketUrl`
  - *Where:* `packages/daemon/src/server.ts:996` (`` const url = `http://${host}:${port}` ``), `server.ts:1030`
  - *Recommendation:* Bracket IPv6 literals when formatting (`net.isIPv6(host) ? \`[${host}]\` : host`).
- **C1-17** · **Info** · security — `TransportGate.current()` falls back to the owner principal when `credentialId` is undefined, even in token mode
  - *Where:* `packages/daemon/src/auth/transport.ts:204-207`
  - *Recommendation:* In token mode, return `{ ok: false, reason: "unavailable" }` when `credentialId` is undefined, and fail closed.
- **C1-18** · **Info** · maintainability — Literal NUL bytes embedded in `read-model.ts`
  - *Where:* `packages/daemon/src/read-model.ts:276,282` (`` `${e.from}<NUL>${e.to}` ``)
  - *Recommendation:* Use the `\u0000` (or `\0`) escape, or a printable separator.
- **C1-19** · **Info** · maintainability — Cross-package relative type imports into sibling packages' `src/`
  - *Where:* `packages/daemon/src/admission-retry.ts:5-14`, `request-submission.ts:3`, `revision-input.ts:3` (`../../core/src/model/admission-retry.js`, `../../engine/src/...`)
  - *Recommendation:* Export these types from `@orca/core` and `@orca/engine`, and import them by package name.
- **C1-20** · **Info** · performance — Per-notification synchronous filesystem work and per-subscriber serialization
  - *Where:* `packages/daemon/src/socket.ts:131-141,193-203`, `auth/credentials.ts:266-272,290-308`
  - *Recommendation:* Cache the credential stamp check for a short TTL, or use `fs.watch` with a periodic fallback. Serialize each notification once per projection variant: with artifacts, without artifacts, and with the subscription id spliced in.

### C2 — Engine (`packages/engine`)

Full write-up: [C2.md](2026-10-13-review-detail/C2.md).

- **C2-01** · **High** (confirmed) · correctness — Fan-out "earlier sibling" visibility leaks one work item's artifacts into another's prompts
  - *Where:* `packages/engine/src/run-context.ts:209-258`: `visibleArtifacts`, `earlierSiblings`
  - *Recommendation:* Restrict sibling visibility to `loop` steps, where iteration N−1 is the intended predecessor.
  - *Verified (verifier V1):* A code bug, not intended behaviour. Do not restrict visibility to `loop` only (that breaks `protected-execution-boundaries.test.ts:224-268`); exclude earlier siblings with a different `workItemId` or spawned by a fan-out, and update WORKFLOWS.md and DATA-MODEL.md to match.
  - *Related:* D2-01
- **C2-02** · **Medium** (confirmed, was High) · reliability — Malformed YAML front matter in a deliverable crashes the turn instead of triggering the bounded follow-up
  - *Where:* `packages/engine/src/executors/agent-step.ts:117-159`: `collect`, especially lines 139-140
  - *Recommendation:* Catch parse errors per deliverable in `collect()`.
  - *Verified (verifier V1):* Fails loudly and is resumable; nothing is corrupted. The cost is the lost follow-up attempt.
- **C2-03** · **Medium** (confirmed, was High) · concurrency — `void self.cancel(child)` races child attachment: unhandled `RUN_LEASED` and a child that is never cancelled
  - *Where:* `packages/engine/src/orchestrator.ts:1725-1733`: `onAbort` / `onOwnAbort`
  - *Recommendation:* Make `cancel()` aware of `this.running` without `live`: record a pending cancellation that `executeLeased` checks right after `live.set`, and abort the fresh `rc` then.
  - *Verified (verifier V1):* Narrow window; recoverable with `resume`. Also check `signal.aborted` before starting a branch or child.
- **C2-04** · **Medium** · concurrency — Child workspace provisioning runs inside the parent's lease mutation mutex, starving heartbeats and sibling writes
  - *Where:* `packages/engine/src/orchestrator.ts:1685-1708`: `rc.withOwnership(() => self.startRun(...))`
  - *Recommendation:* Provision the workspace outside `withOwnership`.
- **C2-05** · **Medium** · data-integrity — Losing the parent's lease cancels its live children durably
  - *Where:* `packages/engine/src/orchestrator.ts:1725-1726`: `onAbort` → `self.cancel(childId, "parent cancelled")`
  - *Recommendation:* In `onAbort`, skip child cancellation when `rc.leaseLost` is set, since the new holder re-attaches to the children.
- **C2-06** · **Medium** · data-integrity — `custom:plan-register` and `materialize-work-items` are not idempotent on re-attempt and duplicate work items
  - *Where:* `packages/engine/src/plan/executors.ts:117-195`
  - *Recommendation:* Make registration idempotent per `(requestId, decomposition artifact id)`, for example with keyed IDs like risks and decisions use (`keyedId`).
- **C2-07** · **Medium** · correctness — Duplicate slugs within one decomposition corrupt dependency registration
  - *Where:* `packages/engine/src/plan/service.ts:351-392`, `batch.set(item.slug, wi)` at 377
  - *Recommendation:* Reject duplicate slugs in `DecompositionSchema` (superRefine). The `ARTIFACT_INVALID` that results lets an agent follow-up or a human fix it.
- **C2-08** · **Medium** · correctness — `plan-dispatch` with `scope: plan` fails every item from another request when the dispatcher run carries a `requestId`
  - *Where:* `packages/engine/src/orchestrator.ts:1701`: the child inherits `rc.state.run.requestId`
  - *Recommendation:* When `options.workItemId` is set, pass the item's own `requestId`, or omit the parent's when they differ.
- **C2-09** · **Medium** · data-integrity — Git worktree directory and branch are keyed by slug only, so different plans' items share a checkout
  - *Where:* `packages/engine/src/workspace/git-worktree.ts:33-49`
  - *Recommendation:* Include the plan key (or work-item id) in the directory and branch name.
- **C2-10** · **Medium** · performance — `visibleArtifacts` re-reads and decrypts every related run log on every evaluation (cache regression)
  - *Where:* `packages/engine/src/orchestrator.ts:1293`: `loadState: (id) => this.executionState(id)`
  - *Recommendation:* Cache terminal execution states, keyed by run and invalidated by the existing store subscription, as `getState` does.
- **C2-11** · **Medium** · performance — `pendingInputs()` without a run id reduces every run in the store, and the 256-entry FIFO cache thrashes
  - *Where:* `packages/engine/src/orchestrator.ts:647-669, 689-691` (`answer` without `runId`), `2081`
  - *Recommendation:* Skip terminal runs using `getSummary` (cheap `readTypes`) before reducing.
- **C2-12** · **Medium** · security — Truncating or splitting text before value-based redaction leaks partial secrets to the public log
  - *Where:* `packages/engine/src/executors/agent-step.ts:334`: `prompt.slice(0, 400)`
  - *Recommendation:* Redact before truncating or splitting: the engine can apply `redactExecutionValue` with the run's secrets, which the `rc.logger` already does.
- **C2-13** · **Low** · correctness — Resume re-executes a step that already failed non-retryably
  - *Where:* `packages/engine/src/orchestrator.ts:1474-1480, 1512-1521`
  - *Recommendation:* On resume, if the last step is `failed`, check `willRetry` (carry it in the reduced step, or read the last `step.failed` event). If it is false, emit `run.failed` instead of re-attempting.
- **C2-14** · **Low** · data-integrity — `protectExecutionInputs` over-collects secrets (whole objects, keys, numbers, every enum value)
  - *Where:* `packages/engine/src/execution-inputs.ts:17-38`
  - *Recommendation:* Push only the sensitive leaf values, walking the declaration in parallel with the value. Do not seed enum alternatives that were not selected.
- **C2-15** · **Low** · security — Rendered artifact paths are not confined to the workspace, and deliverables are read without size or symlink checks
  - *Where:* `packages/engine/src/plan/executors.ts:386-405`: `artifactPath` (default `.orca/plans/{{ vars.plan }}/schedule.md`), then `mkdirp` and `writeFile`
  - *Recommendation:* Resolve rendered paths and require them to stay under `workspace.cwd`.
- **C2-16** · **Low** · performance — Container results copy every child's full execution vars into the parent's `step.completed`
  - *Where:* `packages/engine/src/executors/containers.ts:36-49`, `:460` (`childVars`)
  - *Recommendation:* Record only child id, status and outcome, plus vars the child set itself (diffed against the inherited vars), or make the vars opt-in.
- **C2-17** · **Low** · reliability — Lease release is not guarded in `executeLeased`, and `execute()`'s `finally` can mask a terminal result
  - *Where:* `packages/engine/src/orchestrator.ts:1350-1353` (compare the guarded `878-885`)
  - *Recommendation:* Mirror the nested try/finally from `executeContinuationLeased`.
- **C2-18** · **Low** · correctness — `artifact-present` mode cancels on mere existence, so a deliverable still being written can be recorded truncated
  - *Where:* `packages/engine/src/executors/agent-step.ts:250-290, 342-351, 387`
  - *Recommendation:* Require two consecutive polls with an unchanged size and mtime, or a completion marker, before cancelling.
- **C2-19** · **Low** · correctness — `parallel` forEach `dependsOn` cycles are not detected and are misreported as failFast skips
  - *Where:* `packages/engine/src/executors/containers.ts:217-227, 264-276, 389-404`
  - *Recommendation:* After the loop drains with no parked prerequisite, mark the remaining held branches `skipped: dependency` and report the cycle (reuse `findCycles` from core).
- **C2-20** · **Info** · maintainability — Engine imports core's source files by relative path, bypassing the package boundary
  - *Where:* `packages/engine/src/admission-retry.ts:17, 347-349`
  - *Recommendation:* Import from `@orca/core`. Export `revision-input` and `continuation-admission` types there if they are missing.

### C3 — Core, store and protocol

Full write-up: [C3.md](2026-10-13-review-detail/C3.md).

- **C3-01** · **High** (confirmed) · performance — Every event append and read rescans the flat `private-execution/` directory, which grows by one file per protected event
  - *Where:* packages/store/src/protected-event-store.ts:214-215 (`append` → `getInputs` unconditionally), :241-243, :355-369 (`read*` → `requireSafeLegacy`/`requireIntegrity`)
  - *Recommendation:* Shard the directory per run (`private-execution/<encoded runId>/…`) so overlays are found with a per-run listing or a manifest record.
- **C3-03** · **Medium** · reliability — A stale lock is never broken while its owner's PID is "alive", including the current process's own PID after a container restart
  - *Where:* packages/store/src/file-lock.ts:74-97 (`removeDeadOwner`), :173-180 (`processAlive`)
  - *Recommendation:* Keep a process-local `Set` of tokens this process holds. A token naming `process.pid` that is not in the set is provably stale.
- **C3-04** · **Medium** · data-integrity — `JsonFileDocumentStore` keeps mutations whose write failed before the lock; readers see them and a later write persists them
  - *Where:* packages/store/src/document-store.ts:147-195 (`enqueue`). The `queue.splice` sits in a `finally` inside the `withFileLock` callback (:181-185).
  - *Recommendation:* On any failure of the scheduled write, remove that batch from the queue (wrap the whole `p` body, not just the callback). Alternatively, keep failed mutations out of `view()` and reject them explicitly. Add a test for a write that hits `STORE_LOCK_TIMEOUT`.
- **C3-05** · **Medium** · data-integrity — Content-addressed blobs are overwritten in place, with no fsync and no hash check on read
  - *Where:* packages/store/src/artifact-store.ts:104-108 (`put`), :123-127 (`blob`)
  - *Recommendation:* Write to a temp file in `blobs/`, fsync it, then `link()` into place, treating EEXIST as success. If the target exists, skip the write.
- **C3-06** · **Medium** · reliability — Replay opens every private payload at once and reports resource exhaustion as "record unreadable"
  - *Where:* packages/store/src/protected-file.ts:501-517 (`Promise.all(names.map(privateBytes…))`), :354-357 (any error → `unreadable()`)
  - *Recommendation:* Bound the concurrency (for example 32-64 in flight) or read sequentially in chunks. Let transient OS errors (EMFILE, ENFILE, EAGAIN, ENOMEM) propagate as retryable rather than as `RUN_STATE` "invalid record". Consider replaying a page at a time.
- **C3-07** · **Medium** · design — Closed enums in hello and event schemas break the protocol's own rule that minor versions are compatible
  - *Where:* packages/protocol/src/handshake.ts:178,189 (`capabilities: z.array(z.enum(DAEMON_CAPABILITIES))`)
  - *Recommendation:* Parse `capabilities` as `z.array(z.string())` and filter to known names.
- **C3-08** · **Medium** · performance — Unbounded `runs.events` filters allow CPU denial of service, and forward pages re-parse the log from the start
  - *Where:* packages/protocol/src/runs.ts:236 (`types: z.array(z.string().min(1))`, no `.max`)
  - *Recommendation:* Bound `types` (for example `.max(64)`, string `.max(128)`) and make it a `Set`.
- **C3-09** · **Medium** · security — The "workspace" permission scope compares paths as text, so Windows relative or rooted paths and symlinks escape it
  - *Where:* packages/core/src/model/agent.ts:313-352 (`normalizePermissionPath`, `workspaceRelativePath`)
  - *Recommendation:* When the workspace is a Windows path, normalise backslashes in every location and treat a leading `\` or `/` as absolute.
- **C3-10** · **Medium** · performance — Every artifact `get`, `content` or `list` re-reads and zod-parses the entire `artifacts/index.jsonl`
  - *Where:* packages/store/src/artifact-store.ts:98-103 (`load`), :109-130
  - *Recommendation:* Cache the parsed index under a size, inode and mtime fingerprint (as `JsonlLogDir` and `JsonFileDocumentStore` already do), append newly put artifacts in memory, and keep `id`→entry and `runId`→ids maps.
- **C3-11** · **Medium** · reliability — The admission-retry quota counts every admission ever made and never resets; the recovery poll fsyncs every 5 s even when idle
  - *Where:* packages/store/src/admission-retry-store.ts:151-155, :168-170 (counters only increase), :259-271 (`batch` republishes `cursor.json` on every call)
  - *Recommendation:* Until #399 ships, make the quota a sliding window or release counts when operations settle. Skip the `cursor.json` publish when the cursor value is unchanged.
- **C3-02** · **Low** (confirmed, was High) · security — A `config.set` patch path of `__proto__` pollutes `Object.prototype` in the daemon
  - *Where:* packages/protocol/src/config.ts:325-328 (`ConfigPatchEntrySchema.path: z.string().min(1)`), :356 (`patch` has no `.max()`)
  - *Recommendation:* Apply the `ConfigEditPathSchema` unsafe-key refinement to each segment of `ConfigPatchEntrySchema.path`, and bound `patch` with `.max(…)` and a path length limit.
  - *Verified (verifier V1):* Real pollution, not a privilege escalation: `config.set` needs `config.read` + `config.write`, held only by unrestricted principals that can already write the files. Same finding as C1-08.
  - *Related:* C1-08
- **C3-12** · **Low** · data-integrity — Collection files are rewritten in full through each process's own schema, so mixed versions drop fields
  - *Where:* packages/store/src/document-store.ts:113-131, :160-178
  - *Recommendation:* Use `looseObject`/passthrough for persisted documents, or write a per-document file. Record a collection schema version and refuse writes from older versions. Consider one file per document or an append log for status projections.
- **C3-13** · **Low** · security — Gaps in the expression sandbox
  - *Where:* packages/core/src/expr/evaluate.ts:224, :238, :245-252, :269-271, :312-319
  - *Recommendation:* Use `Object.hasOwn(fns, name)` and `Object.hasOwn(obj, key)` for member and `in` lookups, or build the function table and contexts with null prototypes.
- **C3-14** · **Low** · security — The launch-input `pattern` regex still runs on values that already failed `maxLength`
  - *Where:* packages/core/src/workflow/inputs.ts:314-322
  - *Recommendation:* Return after a length failure, cap string inputs before testing the regex, and consider a linear-time engine (RE2) or a pattern-complexity lint at load.
- **C3-15** · **Low** · security — `JsonlLogDir` puts keys into file paths without encoding or validating them
  - *Where:* packages/store/src/jsonl-log.ts:98-100 (`join(dir, \`${key}.jsonl\`)`), :303-305 (lock directory `…jsonl.lock` created via `mkdir`)
  - *Recommendation:* Validate keys (for example `/^[A-Za-z0-9_:-]{1,128}$/`) in `JsonlLogDir.file` and constrain run, plan and request id formats in protocol params.
- **C3-16** · **Low** · correctness — `scanLinesBackward` ignores `bytesRead` on a `Buffer.allocUnsafe` buffer
  - *Where:* packages/store/src/jsonl-log.ts:534-549 (also `lastSeq`, the `before` pages of `readRange`, and every `requireIntegrity`)
  - *Recommendation:* Use `bytesRead`: slice the buffer or stop when it is short. The forward scan already does this correctly at :495-498.
- **C3-17** · **Low** · reliability — Durability helpers fsync every ancestor directory up to `/` on each call
  - *Where:* packages/store/src/jsonl-log.ts:267-283 (`syncDirectories`, called by each `appendDurableUnique`, `synchronizeExisting` and `readObservation`)
  - *Recommendation:* Fsync only the directories this process created, once per process (as `privateDirectory` does), and tolerate EACCES on ancestors above the store root.
- **C3-18** · **Low** · security — CLI-created stores are world-readable under the default umask
  - *Where:* packages/store/src/jsonl-log.ts:103, document-store.ts:156,171, artifact-store.ts:99-106, claim-store.ts:110-114, lease-store.ts:344,460,475 (default modes)
  - *Recommendation:* Create the store root 0700 (and files 0600) from `fileStores`, or warn when the store root is group- or world-readable.
- **C3-19** · **Low** · correctness — Workflow validation does not detect recursive subworkflow references, and the engine has no depth limit
  - *Where:* packages/core/src/workflow/validate.ts:142-147, :259-262 (`checkRef` checks only that a reference exists)
  - *Recommendation:* Detect cycles over workflow references at load or registry time (warn on conditional cycles, error on unconditional ones), and enforce a maximum run-ancestry depth when spawning children.
- **C3-20** · **Low** · design — Node-only lifetime fences live in the wire-contract package and use guessable loopback TCP ports
  - *Where:* packages/protocol/src/first-run-fence.ts:142-200
  - *Recommendation:* Move these modules to an app/cli-side package. Use per-user `flock`/advisory locks or Unix domain sockets inside an owner-only directory instead of global TCP ports. Document or extend the supported filesystem list.
- **C3-21** · **Low** · data-integrity — Ordinary appends are not fsynced, contrary to the `EventStore` contract
  - *Where:* packages/store/src/event-store.ts:4-6 (contract: "fan out … *after* the event is durable"), :162-171; jsonl-log.ts:374-389 (`appendJsonl` with no fsync)
  - *Recommendation:* Either fsync (perhaps group-committed per tick) before `publish`, or correct the contract wording and add a log incarnation id (for example the inode plus a creation nonce) to cursors so clients can detect a rewind.
- **C3-22** · **Info** · maintainability — Small maintainability issues
  - *Where:* packages/store/src/admission-retry-store.ts:8-15 and continuation-admission-store.ts:6 import types from `../../core/src/model/admission-retry.js`, although `@orca/core` re-exports them (core/src/index.ts:121)
  - *Recommendation:* Import from `@orca/core`. Use `OrcaError("PLAN_INVALID")`. Make listings report per-record errors instead of failing. Guard `decodeURIComponent`.
- **C3-23** · **Info** · resource-leak — Per-key in-memory maps grow for the life of a long-running daemon
  - *Where:* packages/store/src/jsonl-log.ts:77-79 (`tails`, `chains`), lease-store.ts:258 (`InMemoryLeaseStore.chains`)
  - *Recommendation:* Delete a `chains` entry once its promise settles and is still the tail, and cap `tails` with an LRU.

### C4 — CLI, agents, integrations, maintenance MCP, testing helpers

Full write-up: [C4.md](2026-10-13-review-detail/C4.md).

- **C4-01** · **High** (confirmed) · security — Default configuration puts ORCA's own policy, credential and store files inside the agent's workspace, where the default permission policy auto-allows read/edit/delete (agent can grant itself allow-all)
  - *Where:* `packages/cli/src/bootstrap.ts:204` (local provider root = `configDir` when `workspace.root` unset); `packages/core/src/config.ts:90` (default `workspace: { provider: "local" }`) …
  - *Recommendation:* Add a non-overridable protected-path check in `decidePermission`/`resolvePermission` (and in the `fs/*` client handlers) that forces `ask`/`deny` for the config file, the sidecar, `auth/`, `storeDir`, `.git/hooks`/`.git/config`, regardless of configured or sidecar rules. Separately, refuse or warn at bootstrap when the resolved workspace root contains `configDir`/`storeDir`/`auth`, and/or default the local provider to a sub-directory. Consider failing the sidecar load if it contains a rule with an empty `match` (a hand-written wildcard is better placed in config).
  - *Verified (verifier V1):* A protected-path check in the policy is necessary but not enough, because agents' native tools can write without asking. Keep the sidecar, `auth/` and the store out of every agent root (e.g. default runs to a sub-directory or `isolateRoots: true`) and refuse to start when a root contains them.
- **C4-02** · **Medium** · security — Local agents inherit the full ambient environment of the CLI/daemon, including ORCA bearer tokens and integration API keys
  - *Where:* `packages/agents/src/hosts/local-host.ts:50` (`env: { ...process.env, ...agent.env, ...options.env }`); env consumers: `packages/cli/src/daemon-client.ts:49` (`ORCA_DAEMON_TOKEN`), `packages/cli/src/commands/mcp.ts:120` (`ORCA_MCP_TOKEN`) …
  - *Recommendation:* Build the agent environment from an allow-list (PATH, HOME, locale, TERM, provider keys explicitly named in `agents[].env`/`agents[].inheritEnv`), or at minimum strip `ORCA_*` credentials (`ORCA_DAEMON_TOKEN`, `ORCA_DAEMON_TOKEN_FILE`, `ORCA_MCP_TOKEN`, `ORCA_MAINTENANCE_TOKEN`, `ORCA_ADMISSION_FILE`) and integration secrets (`TYPESAFE_API_KEY`) before spawn. Apply the same policy to `mcpServers[].env` delivery.
  - *Related:* C5a-13, C8-17
- **C4-03** · **Medium** · security — SSH host puts agent environment values (including API keys) on the local `ssh` command line for the life of the session
  - *Where:* `packages/agents/src/hosts/ssh-host.ts:66-73,89-93`
  - *Recommendation:* Send the environment over stdin instead of argv (e.g. remote script `IFS= read -r … ; export …; exec agent` fed a NUL/length-prefixed preamble before ACP traffic), or use `ssh -o SendEnv` with `AcceptEnv` on the server, or write a 0600 env file via the existing `writeFile` path and `set -a; . file; rm file`. Validate env keys against `^[A-Za-z_][A-Za-z0-9_]*$` in `AgentSpecSchema`.
- **C4-04** · **Medium** · reliability — Host file reads are unbounded and SSH file operations have no timeout or cancellation (daemon memory blow-up / permanently hung step)
  - *Where:* `packages/agents/src/hosts/local-host.ts:23` (`readFile(p, "utf8")`); `packages/agents/src/hosts/ssh-host.ts:84-87,98-106` (`cat` with no `timeoutMs`); `packages/agents/src/host.ts:185-216` (`stdout += d` unbounded, no `AbortSignal`) …
  - *Recommendation:* Add `maxBytes` to `HostFileSystem.readFile` (stat + regular-file check locally with `O_NOFOLLOW`/`lstat` policy; `head -c N` + `test -f` remotely) and to the ACP read handler; add a default `timeoutMs` and an `AbortSignal` to `exec`/`collectChildProcess`, cap collected stdout, add `-o ServerAliveInterval=15 -o ServerAliveCountMax=3` to `baseArgs()`, and batch reads into one ssh process (as `existsMany` already does).
- **C4-05** · **Medium** · correctness — `orca ping` silently falls back to a local in-process handshake when the daemon's `agents.ping` takes longer than 2 s or returns 5xx
  - *Where:* `packages/cli/src/daemon-client.ts:84-92,110` (`AbortSignal.timeout(2000)`, `catch { return undefined }`, `!response.ok → undefined`); `packages/cli/src/commands/index.ts:203-206,442-460` …
  - *Recommendation:* Use a per-method timeout (≥ handshake timeout + cleanup grace for `agents.ping`), and once `hello` succeeded treat any later failure as an error (`AGENT_TRANSPORT`, "daemon did not answer agents.ping") rather than `undefined`. Add a test with a slow `agents.ping` responder.
- **C4-06** · **Medium** · security — Config discovery walks to the filesystem root with no ownership check, and every bootstrap (including `orca validate`/`status`) imports the discovered config's plugins
  - *Where:* `packages/cli/src/bootstrap.ts:146-163` (`findConfig` upward walk), `:170-189` (`loadConfig`), `:345`, `:585` (`await import(importUrl)`), `packages/cli/src/commands/index.ts:319` (`validate` loads plugins) …
  - *Recommendation:* During discovery, stop at (and refuse) config files/directories not owned by the current uid or writable by group/others (POSIX), and stop the walk at `$HOME`/filesystem boundaries; print which config was used. Make read-only commands (`validate` without `--plugins`, `status`, `events`, `runs`) not import plugins, or require an explicit opt-in for plugin execution on discovered configs.
- **C4-07** · **Medium** · security — ACP facade rewrites the kinds of forwarded permission options (index 0 → `allow_once`, all others → `reject_once`)
  - *Where:* `packages/integrations/src/acp-facade/upstream-human-input.ts:76-82`; kind dropped upstream at `packages/engine/src/orchestrator.ts:1976` (`options: offered.map((o) => ({ id: o.optionId, label: o.name || o.optionId }))`).
  - *Recommendation:* Carry `kind` through `HumanInputOption` for `kind: "permission"` questions and forward the real ACP kinds; only use positional kinds for workflow gate decisions. Consider filtering `allow_always`/`reject_always` for upstream forwarding (as the live path already does) unless the facade can honour the standing grant.
- **C4-08** · **Medium** · data-integrity — JEV evaluation silently drops inputs whose aliases collide while still recording them as judged
  - *Where:* `packages/integrations/src/jev/executor.ts:80-82` (`inputAlias`), `:172-189` (`artifacts[alias] = a.content` overwrites; `inputs.push(...)` keeps both); `:311-322` (`onError: record` writes `inputs: []`).
  - *Recommendation:* Reject duplicate effective aliases in `parseNode` (validation time) and at execute time; require `as:` when names collide. In `onError: record`, keep the resolved `inputs`/`missingInputs` when the failure occurred after resolution.
- **C4-09** · **Medium** · security — CLI prints agent/repository-controlled text to the terminal without stripping control characters (prompt spoofing in `humanInput.mode: cli`)
  - *Where:* `packages/cli/src/human-input-cli.ts:61-66` (question + option labels written raw); `packages/cli/src/format.ts:38-47,59` (agent message chunks, tool titles, permission titles) …
  - *Recommendation:* Sanitise all untrusted strings before terminal output (replace C0/C1 controls except `\n`/`\t`, e.g. with `\u{2400}`-style escapes or `JSON.stringify` slices) in `formatEvent`, `formatRunState`, `formatPendingInput` and `cliHumanInput`.
- **C4-10** · **Medium** · reliability — Agent process cleanup only signals the direct child; over SSH the remote agent keeps running after cancel/timeout
  - *Where:* `packages/agents/src/process-cleanup.ts:226-272`; `packages/agents/src/hosts/ssh-host.ts:90-93` (`ssh -T`, no pty, no remote process-group handling); `packages/agents/src/hosts/local-host.ts:48-52` (no `detached`/process group).
  - *Recommendation:* Run the remote command under a small wrapper that puts the agent in its own process group and kills it when stdin closes (e.g. `setsid` + a watchdog loop on the stdin pipe, or `ssh -tt` with care for ACP framing); locally spawn with `detached: true` and signal `-pid`. Before retrying a step in the same workspace, require a confirmed exit or a fresh workspace.
- **C4-11** · **Low** · correctness — Windows: `LocalHost.exec` runs POSIX-quoted strings through `cmd.exe`
  - *Where:* `packages/agents/src/hosts/local-host.ts:63-70` (`shell: true`); `packages/agents/src/host.ts:88-92` (`shellQuote` single-quote escaping, leaves `%` unquoted); caller `packages/engine/src/workspace/git-worktree.ts:41-48,64`.
  - *Recommendation:* Make `exec` take argv (`execFile` style) for local hosts, or use a host-specific quoter (`cmd`-aware quoting / PowerShell) and keep POSIX quoting for SSH only.
- **C4-12** · **Low** · data-integrity — `orca demo --dir <existing dir>` overwrites `README.md` and `orca.config.yaml` without checking
  - *Where:* `packages/cli/src/commands/index.ts:759-763,902-907`
  - *Recommendation:* Refuse a non-empty `--dir` (or one containing either file) unless `--force`, or write into `<dir>/orca-demo-<id>`.
- **C4-13** · **Low** · correctness — MCP operator reports an already-committed write as an error when re-discovery differs after the call
  - *Where:* `packages/integrations/src/mcp/server.ts:205-219`
  - *Recommendation:* For `write: true` operations, never convert a successful backend result into a plain failure: return the (possibly withheld) result with an explicit `committed: true, authorityChanged: true, inspect: <operationId>` marker, or an error whose text states the write may have committed and names the retained key/operation ID.
- **C4-14** · **Low** · reliability — Permission rule matching robustness: unvalidated `titlePattern`, empty `pathPrefix` wildcard
  - *Where:* `packages/agents/src/permissions.ts:99` (`new RegExp(m.titlePattern)` per rule per ask), `:104-107`; schema `packages/core/src/model/agent.ts:63,72`.
  - *Recommendation:* Validate `titlePattern` with `new RegExp` in the schema (`refine`), compile once per policy load, cap the tested title length; reject `pathPrefix` values that normalise to empty (or treat them as "workspace" scope explicitly).
- **C4-15** · **Low** · security — JEV HTTP provider persists provider error bodies and has no transport hardening
  - *Where:* `packages/integrations/src/jev/http-provider.ts:26-56`; `packages/integrations/src/jev/executor.ts:146-147,219-220,309-322`.
  - *Recommendation:* Apply the restoration path's sanitisation to the default provider (status code only, or a fixed-charset excerpt with the key literal redacted), require `https:` unless an explicit loopback override is set, and bound response size.
- **C4-16** · **Low** · security — T3 Code session adapter (exported groundwork) defaults to `full-access` and has lifecycle bugs
  - *Where:* `packages/integrations/src/t3code/session.ts:38` (`runtimeMode ?? "full-access"`), `:62-74`, `:104-125`, `:130-135`.
  - *Recommendation:* Default to `approval-required` and route T3 approvals through `askPermission`; clear `turnWaiter` on dispatch failure; remove listeners in `finally`; reject the waiter on close; map `error` to a failure; correlate idle events with the started turn id.
- **C4-17** · **Low** · reliability — Read-only CLI commands run the full writer bootstrap
  - *Where:* `packages/cli/src/commands/index.ts:606-646` (`runs`, `status`, `events`), `commands/claims.ts:18`, `commands/leases.ts:88`, `commands/plan.ts:39-41`; `packages/cli/src/bootstrap.ts:233-253,345,386-395,452-461`.
  - *Recommendation:* Give read commands a light bootstrap (config + `fileStores` + orchestrator read paths), downgrade workflow validation problems to warnings there, and skip plugin import/generation persistence.
- **C4-18** · **Low** · security — SSH `host`/`user` not validated against option injection
  - *Where:* `packages/agents/src/hosts/ssh-host.ts:44-58`; schema `packages/core/src/model/agent.ts:12-28`.
  - *Recommendation:* Reject `host`/`user` starting with `-` or containing whitespace/`@` (user) in `SshHostSchema`; pass the destination after `--`, i.e. `[...options, "--", dest, ...remote]`.
- **C4-19** · **Low** · correctness — CLI file-path handling inconsistencies
  - *Where:* `packages/cli/src/commands/index.ts:376` (`graph`: `join(ctx.cwd, target)`), `:539-541` (`submit --body-file` read relative to process cwd, not `--cwd`).
  - *Recommendation:* Use `resolve(ctx.cwd, target)` in both.
- **C4-20** · **Low** · concurrency — ACP facade session bookkeeping: concurrent prompts clobber `active`, sessions never released
  - *Where:* `packages/integrations/src/acp-facade/orca-acp-agent.ts:154-165,377-379,404-409`
  - *Recommendation:* Reject a prompt while one is active on the session (ACP allows one turn at a time), or track active runs per prompt; drop sessions on connection close and cap `runIds`.
- **C4-21** · **Low** · security — `beta-first-job` fixture runs git in an agent-writable repository without neutralising repo-local config
  - *Where:* `examples/beta-first-job/fixture.js:99-115,129-135,146-163`
  - *Recommendation:* Add `-c core.fsmonitor=false -c core.untrackedCache=false -c diff.external= -c core.pager=cat` (and `GIT_CONFIG_PARAMETERS`-style overrides for any other executing keys), or verify `.git/config` bytes against the baseline before running git.
- **C4-22** · **Low** · reliability — MCP Streamable HTTP handler maps any discovery failure to 401 and triples daemon round trips
  - *Where:* `packages/integrations/src/mcp/transport.ts:185-194`; `server.ts:183-212`
  - *Recommendation:* Return 503 for `AGENT_TRANSPORT` failures and 401 only for `AUTH_*`; reuse the pre-flight discovery result as the first discovery of the request's server.
- **C4-23** · **Info** · maintainability — Testing helpers ship in the production CLI and bundled daemon
  - *Where:* `packages/cli/package.json:22` (`@orca/testing` as runtime dependency); `packages/cli/src/commands/index.ts:88,886-892`; `packages/testing/src/index.ts:24-59`, `child-bundle.ts:133-145`.
  - *Recommendation:* Move the demo to a dev-only entry or make `@orca/testing` an optional/dev dependency resolved lazily with a clear "demo unavailable in this build" error.
- **C4-24** · **Info** · security — CLI sends the workspace bearer token over plaintext loopback TCP to whoever owns port 6722
  - *Where:* `packages/cli/src/daemon-client.ts:46-60,84-92`; `commands/index.ts:163-169`.
  - *Recommendation:* Prefer a 0700-directory Unix socket for local clients, or have the CLI verify the daemon's `identity.workspaceId` from an unauthenticated `hello` against the local store before sending the token.
- **C4-25** · **Info** · correctness — Kepler default worktree choice depends on `readdir` order
  - *Where:* `packages/integrations/src/kepler/workspace-provider.ts:36-46,74-77`
  - *Recommendation:* Sort worktrees by name, and log/require an explicit `repo` when a task has more than one.
- **C4-26** · **Info** · reliability — ACP stdio framing relies entirely on the SDK for size limits
  - *Where:* `packages/agents/src/host.ts:117-122` (`acp.ndJsonStream` over child stdio), `:94-107` (`StderrTail`).
  - *Recommendation:* Wrap the child stdout in a byte-limited line splitter (e.g. 16 MiB) that fails the session with `AGENT_PROTOCOL` on overflow; cap each stderr tail line.

### C5a — Desktop main process (except the Mac updater), preload, native addons

Full write-up: [C5a.md](2026-10-13-review-detail/C5a.md).

- **C5a-01** · **High** (confirmed) · reliability — First-run workspace is refused permanently after any unclean exit that spans a reboot (no cross-boot recovery)
  - *Where:* `src/main/first-run/ownership.ts:327` (strict inspection refuses an unsettled attempt), `ownership.ts:347-400` (`reserveFirstRunOwnership`), `src/main/first-run/recovery.ts:70-77` (`reconcile` requires `claim.boot === fenceBoot()`) …
  - *Recommendation:* Add a supervised cross-boot settlement route.
  - *Verified (verifier V5):* The suggested cross-boot settlement is close to #577's route, which `first-run-same-boot-recovery.md:142-146` records as rejected by the owner. Any cross-boot route needs owner sign-off and should be explicit and user-confirmed.
- **C5a-03** · **High** (confirmed) · reliability — Ownership journal is capped at 256 attempts with no compaction, so the workspace stops working after ~255 launches
  - *Where:* `src/main/first-run/ownership.ts:225-226` (`if (names.length >= 256) return refuse();`), `ownership.ts:372-376` (a new numbered attempt directory per reservation). Nothing in `first-run/**` or `first-run-fence.ts` ever removes attempts.
  - *Recommendation:* Compact settled history. Fold every fully settled prefix into a single checkpoint record (hash chain head plus the last effective config hash), and keep only the newest N attempts. At minimum, refuse only when the unsettled tail is too long, not when the total count is. Add a test that creates 300 attempts.
  - *Verified (verifier V5):* Compaction must preserve the claim hash chain and `effectiveHash` lineage; it needs an owner-reviewed archival authority.
- **C5a-04** · **High** (confirmed) · design — The saved first-run selection pins the project's HEAD commit and branch, so any commit or pull invalidates the workspace
  - *Where:* `src/main/first-run/setup.ts:157-168` (`verify`: `project.baseCommit !== receipt.project.baseCommit || project.branch !== …` → `selectionFailure`), `setup.ts:123-156` (`readReceipt` swallows the failure and returns `undefined`) …
  - *Recommendation:* Pin the project's directory identity (dev/inode/owner) and the repository toplevel, not HEAD and branch. If the base matters for the sample, record it as advisory evidence, or re-check it only at guided-launch time (guided checkout already captures fresh evidence per launch). Offer an explicit "rebind project" action instead of forcing a fresh workspace.
- **C5a-05** · **High** (confirmed) · reliability — The admission-intent journal never prunes abandoned records; launches are refused permanently after 1000 records
  - *Where:* `src/main/admission-intents.ts:53` (reading refuses more than 1000 rows), `:138` (`retain`: "journal is full"), `:171` (`retainGuided`: `throw refusal()`), `:213-220` (`abandon` only flips `state`).
  - *Recommendation:* On `write`, drop abandoned records (or keep only the newest K abandoned per scope). Bound retained records per scope/workflow. Give the guided "full" case its own error. Add a test that cycles 1100 start/abandon pairs.
  - *Verified (verifier V5):* Workaround: delete `userData/admission-intents.enc`. The in-app message wrongly points at the keychain.
- **C5a-02** · **Medium** (confirmed, was High) · correctness — Windows in-app update stops the first-run daemon without settling ownership; a failed install can never reconnect it
  - *Where:* `src/main/workspace.ts:881-888` (`stopForUpdate` calls `this.daemon.stop()` directly), `workspace.ts:907-918` (`cancelUpdate` → `connect()`), `workspace.ts:1050-1057` (`switchTo` → `assertNoFirstRunOwnership`) …
  - *Recommendation:* In `stopForUpdate`, use `await this.stopFirstRunOwned(this.daemon)`.
  - *Verified (verifier V5):* Only Windows packaged builds with an operator-set update feed; repairable on the same boot.
- **C5a-07** · **Medium** · correctness — Deep links are lost or crash main: the global subscriber defeats `DeepLinkQueue`'s hold
  - *Where:* `src/main/index.ts:1031-1034` (`deepLinks.subscribe(...)` at module load), `index.ts:1020-1029` (`focusWindow` → `createWindow`), `index.ts:1041-1050`, `src/main/deep-link.ts:62-69` …
  - *Recommendation:* Do not subscribe globally. Have main offer to the queue and drain it per window on `did-finish-load` (or when the renderer calls `take()`). Only `send` directly to windows whose renderer has registered. Do not create windows before `app.isReady()`; defer `focusWindow` until `whenReady`.
- **C5a-08** · **Medium** · correctness — A failed read-only "Open a store" keeps the previous client and epoch, so reads are served by another daemon under the new store's banner
  - *Where:* `src/main/workspace.ts:1094-1106` (read-only failure path returns before `clientNow`/`source`/`epoch` change), `index.ts:313-341` (`callInConnection` only checks the epoch).
  - *Recommendation:* On read-only start failure, swap in an inert client (`new DaemonClient("")`), set `source = "store"`, clear `identity`, increment the epoch and call `onTarget`, so outstanding and future calls fail closed. Add a test with `explicitUrl` set.
- **C5a-09** · **Medium** · design — "Open a store" stops the active bundled daemon and interrupts in-flight runs, contrary to the parking model
  - *Where:* `src/main/workspace.ts:1065-1073` (`performSwitch` calls `stopFirstRunOwned(this.daemon)`), `workspace.ts:983-993` (`open`) …
  - *Recommendation:* Park the bundled daemon in `open()` the same way `makeConnection.activate` does, and reuse it in `connectLive`/`connect(null)`. Alternatively, warn and require confirmation when the daemon reports active work (`maintenance prepare` already exposes `active`).
- **C5a-10** · **Medium** · reliability — A failed first-run daemon start leaks `firstRunHold`, leaving the session "busy"
  - *Where:* `src/main/workspace.ts:730-741` (catch: `if (!startupAttempted || (daemon && …)) release();` — with `startupAttempted` true and `daemon` undefined the hold is never released).
  - *Recommendation:* Have `startBundledDaemon` surface terminal evidence on failure, for example by attaching the child or `exit` to `DaemonStartError`. Release the hold once exit is proven, and settle the attempt with `complete()`. If exit is uncertain, keep the reservation but release the in-memory hold for unrelated targets (read-only store, remote URL).
- **C5a-11** · **Medium** · resource-leak — Quitting during daemon startup orphans the spawned child
  - *Where:* `src/main/index.ts:1328-1352` (10 s `SHUTDOWN_DEADLINE_MS`), `src/main/workspace.ts:1009-1022` (`close()` stops only `daemon`, `parkedDefault` and existing `candidates`) …
  - *Recommendation:* Track in-flight starts (an `onChild` callback is already available) in a set that `close()` SIGTERMs/awaits.
- **C5a-12** · **Medium** · reliability — `verifyRuntimeDirectories` caps `.orca` + `auth` at 8192 entries, so history growth eventually breaks startup (also O(n) per call)
  - *Where:* `src/main/first-run/directories.ts:69-125` (`let remaining = 8192`), called from `setup.ts:168` in every `verify()`. `verify()` runs from `status()`, `connect()` (twice), `prepareRecovery`, `reconcileRecovery` …
  - *Recommendation:* Do not walk the whole store. Verify the identity of `.orca`/`auth` and their immediate children (or a fixed set of control files), and let the daemon's own store validation handle content. If a deep walk is needed, make it incremental or bound it by depth rather than by count.
- **C5a-13** · **Medium** · security — The bundled daemon inherits the app's full environment, including explicit daemon credentials, which then reaches agent processes
  - *Where:* `src/main/daemon-process.ts:269, 303-311` (`env = process.env` spread into the child); `index.ts:583-599` (`{...process.env, …}` on macOS); downstream `packages/agents/src/hosts/local-host.ts:50` (`env: { ...process.env, ...agent.env }`).
  - *Recommendation:* Spawn the bundled daemon with an allow-listed environment: PATH, HOME, locale, proxy variables and what agents need. Strip `ORCA_DAEMON_TOKEN*`, `ORCA_UPDATE_*`, `ORCA_RENDERER_URL`, `ELECTRON_*` (except `ELECTRON_RUN_AS_NODE`) and `NODE_OPTIONS`.
  - *Related:* C4-02
- **C5a-14** · **Medium** · reliability — Windows `selection.json` replace uses a fixed exclusive temp name that is never cleaned up
  - *Where:* `native/diagnostics/first-run-windows.c:193-213` (`wcscpy(temporary, L"selection.json.tmp")`, then `NT_CREATE`; no delete on the failure paths). Callers: `setup.ts:319` and `:456` (`windowsWrite(receiptPath, …, true)`).
  - *Recommendation:* Use a random temp name (validated by `filename()`), or open the temp with `NT_OPEN_IF` plus truncate after checking ownership and ACL. Set `FileDispositionInfo` to delete the temp on every failure path.
- **C5a-15** · **Medium** · correctness — Guided-launch checkout evidence fails on large working-tree diffs (1 MiB `maxBuffer`, 5 s timeout)
  - *Where:* `src/main/guided-checkout.ts:47-61` (`execFile` with `timeout: 5000, maxBuffer: 1024*1024`; `git diff --no-ext-diff --no-textconv --binary HEAD --` and `git status --porcelain -z`).
  - *Recommendation:* Stream `git diff` stdout into the SHA-256 hash with `spawn` instead of buffering it, or hash with `git diff --binary | git hash-object --stdin` (or `git write-tree` on a temporary index). Raise or remove `maxBuffer` for streamed output, and use a size-independent timeout.
- **C5a-06** · **Low** (plausible, was High) · security — No navigation, new-window or permission restrictions, so the privileged preload bridge reaches any document loaded into the app window
  - *Where:* `src/main/index.ts:1172-1222` (`createWindow`: no `will-navigate`/`will-redirect` handler, no `setPermissionRequestHandler`), `src/main/mac-update-windows.ts:99` (`setWindowOpenHandler(() => held ? deny : allow)` …
  - *Recommendation:* Add `web-contents-created` hardening:
  - *Verified (verifier V5):* The drag-and-drop path is refuted (Electron 44 defaults `navigateOnDragDrop` to false) and no other trigger exists at the pin. Keep as defence in depth: a renderer-URL allow-list on navigation, deny-by-default window-open and permission handlers, and `senderFrame.url` checks on IPC.
- **C5a-16** · **Low** · configuration — Electron hardening configuration gaps: no fuses, `ORCA_RENDERER_URL` honoured in packaged builds, `file://` renderer
  - *Where:* `electron-builder.yml` (no `electronFuses`, and the `afterPack` hook does not flip fuses), `src/main/index.ts:154, 1216-1218`.
  - *Recommendation:* Ignore `ORCA_RENDERER_URL` unless `!app.isPackaged`.
- **C5a-17** · **Low** · security — The auto-discovered local-owner token is sent to user-entered loopback URLs, which are documented SSH-tunnel endpoints
  - *Where:* `src/client/auth.ts:54-61` (`file = … ?? (workspace && isLoopbackDaemon(url) ? localDaemonTokenFile(workspace) : undefined)`), `src/main/workspace.ts:841` ( …
  - *Recommendation:* Do not auto-discover token files for dialog/saved targets. Use discovery only for app-spawned bundled children, which already pass `tokenFile`; require an explicit token or file for every user-entered endpoint.
- **C5a-18** · **Low** · data-integrity — Preferences: one invalid field resets everything, and the next write erases the saved endpoint and unknown keys
  - *Where:* `src/preferences/preferences-file.ts:21-36` (whole-file `safeParse` → `DEFAULT_PREFERENCES`), `:54-58` (`write` merges over `read()`), `:46-51` (no fsync).
  - *Recommendation:* Parse per field (`catch()` per key) so one bad entry falls back alone. Preserve unknown keys with `.passthrough()` on read and merge. Write with a unique temp file, `fsync`, then rename.
- **C5a-19** · **Low** · reliability — A malformed deep link crashes the renderer on cold start
  - *Where:* `src/main/deep-link.ts:62-69` (only the scheme prefix is checked), `renderer/src/route-table.ts` (`segments.map(decodeURIComponent)`, which can throw `URIError`) …
  - *Recommendation:* In main, validate with `new URL()` and a `decodeURIComponent` probe (or at least cap length and require a known host) before queueing. In the renderer, wrap `decodeURIComponent` in try/catch and return `undefined`. Add a root error boundary.
- **C5a-20** · **Low** · memory-safety — `storage.c` `pair_copy` recurses with about 72 KiB of stack per level on libuv worker threads
  - *Where:* `native/diagnostics/storage.c:247-296` (`unsigned char buffer[65536]`, `char target[PATH_MAX]`, `char copy[PATH_MAX]` per frame; recursion depth up to 64), `storage.c:214-216` (`pair_metadata`: 2 × 32 KiB arrays).
  - *Recommendation:* Allocate the copy buffer and xattr lists once on the heap (per job) and pass them down; or iterate with an explicit stack. Add `-fstack-protector-strong` and `-Wframe-larger-than=` to the build.
- **C5a-21** · **Low** · security — `orca:workspace.open` accepts an arbitrary renderer-supplied path (unused API surface)
  - *Where:* `src/main/index.ts:798-821` (`openStore(params.path)`), `src/preload/index.cts:334`, `bridge.ts:494`.
  - *Recommendation:* Remove `path` from the bridge and IPC contract. Always pick the directory through the main-owned dialog.
- **C5a-22** · **Low** · reliability — Ordinary daemon RPCs and the subscribe acknowledgement have no timeout
  - *Where:* `src/client/daemon-client.ts:232-268` (no signal unless a caller passes one; only `hello` uses `AbortSignal.timeout(10_000)`), `src/client/subscription.ts:250-259` (no timer on `pendingSubscribe`).
  - *Recommendation:* Give reads a default timeout (for example 30 s), while keeping the intentionally long-polling `inputs.answer`/`runs.resume` without one. Add a subscribe-acknowledgement timer that closes and reconnects with backoff.
- **C5a-23** · **Info** · reliability — Alerts: unbounded `unfocusedEscalationMs` overflows `setTimeout`; `AlertsUpdate` is unvalidated
  - *Where:* `src/preferences/schema.ts` (`z.number().int().positive()` with no maximum), `src/main/alerts.ts:197-204`, `src/main/index.ts:1128-1130`.
  - *Recommendation:* Clamp the preference to ≤ 24 h in the schema, and `safeParse` the IPC payload.
- **C5a-24** · **Info** · maintainability — Windows native storage holds destination-directory handles without `FILE_SHARE_DELETE`; exports to existing files or other volumes are refused
  - *Where:* `native/diagnostics/storage-windows.c:174-186` (`destination_ancestry` is kept until the next selection or `closeRoot`), `storage-windows-common.h:190-191` (`FILE_SHARE_READ|FILE_SHARE_WRITE` only) …
  - *Recommendation:* Close the destination chain after publish or cancel, and add `FILE_SHARE_DELETE` (identity is re-verified at publish anyway). Tell the user why an existing file or another volume is refused.
- **C5a-25** · **Info** · security — Windows updater: no Authenticode verification (unsigned builds) and the feed URL comes from the environment
  - *Where:* `src/main/update-driver.ts:5-27`, `electron-builder.yml` (Windows build is unsigned, no `publisherName`).
  - *Recommendation:* Sign the NSIS installer and set `publisherName` (or `verifyUpdateCodeSignature`) before enabling the updater broadly. Consider pinning the feed URL in `app-update.yml` instead of an environment variable.

### C5b — Mac update subsystem and Mac packaging tooling

Full write-up: [C5b.md](2026-10-13-review-detail/C5b.md).

- **C5b-01** · **High** (confirmed) · reliability — Every Mac install permanently refuses startup after Migration Assistant, a restore or a home move
  - *Where:* `packages/app/src/main/mac-managed-replacement-startup.ts:65-100`
  - *Recommendation:* If the durable window is `open`, `attempt === null` and the journal is empty, treat an identity mismatch or a torn non-attempt file as "re-provision". Rewrite the anchors to the current identities after acquiring all slots, rather than locking out. Keep refusal only for non-open phases.
  - *Verified (verifier V4):* Wider than reported: a moved, renamed or deleted first-run workspace folder also locks the app out. Not in any shipped build yet (v0.6.0 predates the gate); it ships with the next release. Needs a supported reset and re-anchoring while no attempt is in flight.
- **C5b-02** · **Medium** (confirmed (latent), was High) · design — Admission closes durably at approval with no reopen path, so any non-deferred outcome locks the app
  - *Where:* `packages/app/src/main/mac-update-application.ts:79-103`
  - *Recommendation:* Do not durably close admission until the irreversible boundary (`beginStop`). During download and drain, use a process-local, non-durable closure.
  - *Verified (verifier V4):* Unreachable today: no update authority is supplied and `activationAllowed` is false.
- **C5b-03** · **Medium** (confirmed (latent), was High) · correctness — The commit step can never back up a running Electron profile, and fails only after the daemon is stopped
  - *Where:* `packages/app/src/main/mac-closed-window-commit.ts:51-61`
  - *Recommendation:* Before `beginStop`, run a dry-run feasibility pass:
  - *Verified (verifier V4):* Behind the same two switches as C5b-02.
- **C5b-04** · **Medium** · correctness — Retrying after a "refused" native activation turns into "unknown" and freezes the app
  - *Where:* `packages/app/src/main/mac-native-handoff.ts:105-113`
  - *Recommendation:* Cache only attempts that reached a native call (`setFeedURL`), or that are not `"refused"`. Clear the cache entry on `"refused"`.
- **C5b-05** · **Medium** · reliability — Mac startup is closed for a whole launch whenever the Keychain is slow, denied, or diskutil/ioreg stall
  - *Where:* `packages/app/src/main/mac-replacement-journal.ts:77-90`
  - *Recommendation:* Check `replacement.enc` existence first, and require keys only when a record exists. An empty journal needs no key.
- **C5b-06** · **Medium** · correctness — Inconsistent manifest size limits let a valid candidate fail after the daemon is already stopped
  - *Where:* `packages/app/src/main/mac-candidate-manifest.ts:87,116` (64 KiB, up to 128 evidence records)
  - *Recommendation:* Define one shared constant and enforce the tightest one (derived from `startup.json` capacity) at `offer()` time. Alternatively, store the manifest as its own file in the pair directory instead of base64-embedding it.
- **C5b-07** · **Medium** (confirmed) · testing — Unpackaged macOS runs (dev mode, Playwright smoke) can never pass the startup gate
  - *Where:* `packages/app/src/main/index.ts:82-89`
  - *Recommendation:* Mount the replacement gate only when `app.isPackaged`, or fall back to the repo `build/Release` addon in dev as other addon loads do.
  - *Verified (verifier V4):* The macOS legs of `app-smoke.yml` launch unpackaged Electron, so the next release's macOS verification leg will fail.
  - *Related:* D8-02
- **C5b-08** · **Medium** · performance — Commit-time copying spawns several processes per file and needs about seven full passes while the UI is frozen
  - *Where:* `packages/app/src/main/mac-fixed-path-files.ts:120-129, 213-287`
  - *Recommendation:* Read ACLs and xattrs in-process through the existing native addon (`listxattr`/`getxattr`/`acl_get_file`), or batch them.
- **C5b-09** · **Medium** · design — Mac updates only work on machines with Xcode Command Line Tools installed
  - *Where:* `packages/app/src/main/mac-native-providers.ts:137-150`
  - *Recommendation:* Do the verification in-process or in a bundled signed helper using the `Security.framework` APIs: `SecStaticCodeCheckValidity` with the requirement, `SecCodeCopySigningInformation`, and `SecAssessment`/`syspolicy` for notarization. Do not depend on developer tooling. At minimum, preflight CLT before closing admission.
- **C5b-10** · **Medium** · security — Nothing in the app stops a downgrade to an older signed ORCA build
  - *Where:* `packages/app/src/main/mac-update-candidates.ts:220-291`
  - *Recommendation:* Add a local floor: refuse a candidate whose `releaseVersion` is ≤ the running version, or whose `builtAt` is ≤ the previous identity's. Leave explicit rollback to a separately authorized recovery path. Keep the catalog check as an additional layer.
- **C5b-17** · **Medium** · testing — The riskiest Darwin-only paths have no test coverage
  - *Where:* `packages/app/test/mac-fixed-path-*.test.ts`
  - *Recommendation:* Add focused fixture tests for each case above. Add a macOS CI job that runs a packaged (or addon-staged) app through startup → ordinary.
- **C5b-11** · **Low** · security — Python verifier runs without isolation and can be hijacked by user site-packages
  - *Where:* `packages/app/src/main/mac-native-providers.ts:150-153`
  - *Recommendation:* Run with `-I -B` (isolated mode drops user site, `PYTHON*` environment variables and the script directory). Keep the explicit `importlib` sibling loads, which already use absolute bundle paths.
- **C5b-12** · **Low** · resource-leak — Candidate downloads and inspection scratch are never cleaned up
  - *Where:* `packages/app/src/main/mac-update-candidates.ts:125-137, 220-291, 344-351`
  - *Recommendation:* Discard `owned` whenever `MacUpdates` reaches `failed` with `verified = false`, and before replacing a binding.
- **C5b-13** · **Low** · reliability — Any local process can exhaust the handoff server's request cap
  - *Where:* `packages/app/src/main/mac-native-handoff.ts:209-218`
  - *Recommendation:* Count only requests whose path matches the capability, or drop non-matching connections without counting them.
- **C5b-14** · **Low** · reliability — Python verifier reports crashes and cleanup failures as a known "refused"
  - *Where:* `tools/deploy/native-mac-runtime.py:57-58`
  - *Recommendation:* Emit `{"outcome":"unknown"}` for anything other than an explicit policy or signature mismatch (raise a dedicated exception type for those). Map `unknown` from `image` to `"unknown"` in `revalidate`.
- **C5b-16** · **Low** · performance — Every IPC call re-reads the fence files synchronously on the main thread
  - *Where:* `packages/app/src/main/mac-managed-replacement-startup.ts:31-49`
  - *Recommendation:* Cache the decision and invalidate it on this process's own window writes, plus a cheap mtime or inode check.
- **C5b-15** · **Info** · maintainability — Two parallel recovery designs are maintained, and the startup gate reads a journal nothing writes
  - *Where:* `packages/app/src/main/mac-replacement-commit.ts`
  - *Recommendation:* Delete or clearly quarantine the unused design.

### C6 — Renderer: runs, step detail, attention, palette, lists, chrome

Full write-up: [C6.md](2026-10-13-review-detail/C6.md).

- **C6-01** · **High** (confirmed) · correctness — Enter on any focused control inside a gate or permission card sends the default option (permission inversion)
  - *Where:* `attention/use-card-keys.ts:71-86` registers `Enter` and `Shift+Enter` in the `card` scope.
  - *Recommendation:* Register the card's `Enter` so it only fires when the event target is the card section itself, for example `event.target === section`, or a `when` predicate on the shortcut.
  - *Verified (lead):* `KeyboardMap.handle` (`keyboard-map.ts:338-345`) dispatches the card-scope Enter for any non-text target and calls `preventDefault()`, so the focused button never activates; `defaultSelection` picks the first non-destructive option.
- **C6-02** · **High** (confirmed) · correctness — Palette answer and cancel rows act on whatever card is focused when they run, not the card they name
  - *Where:* `attention/attention-surface.tsx:451-528` (`useCardWrites`). The actions at `:490-493`, `:509-512` and `:519-522` read `current.current.input`.
  - *Recommendation:* Capture the input in the row: use `held`, or compare `now?.id === held.id` and no-op or announce otherwise.
  - *Verified (verifier V2):* Easier to hit than reported: a new permission ask sorts to the top and shifts every card. At run time, have the palette check that the row is still registered.
- **C6-03** · **High** (confirmed) · correctness — Any change to the waiting list moves focus to a different card while the person is working in a card
  - *Where:* `attention/attention-surface.tsx:103-113`, with `inList` set at `:213-216` and cleared only at `:196-198`.
  - *Recommendation:* Advance focus only after this surface's own `answered(id)` for the card that held focus. For example, record `answeredFocusId` in `onAnswered` and consume it in the effect.
  - *Verified (verifier V2):* Worse than reported: even when the card keeps its place, a push moves focus from the note field to the card, so typed letters become card shortcuts.
  - *Related:* D6-02
- **C6-05** · **High** (confirmed) · correctness — After following any run link, the Runs selection snaps back to the linked run on every App render
  - *Where:* `App.tsx:321-331`: `open={…}` is built as a fresh object literal on each render.
  - *Recommendation:* Pass a stable key: memoise `open` on `route`, or pass `route` and key the effect on `[open?.runId, open?.nodeId, open?.attempt, navigationSerial]`.
  - *Verified (verifier V2):* Also undoes a step selection inside the linked run.
- **C6-08** · **High** (confirmed) · correctness — Following is not released by keyboard, minimap or search moves, so the next append pulls the view back to the end
  - *Where:* `list/virtual-list.tsx:211-219` (`move` calls `select` and `reveal`) and `:236-238` (the follow effect).
  - *Recommendation:* in `move` and the minimap's go-to, when `follow` is set and the target is not the last row, call `onHold`. The simplest place is inside `reveal`: if `follow` and the index is less than `count − 1`, call `leave`.
- **C6-04** · **Medium** (confirmed, was High) · correctness — Every transport reattachment, even a silent blip, resets surfaces to loading: Runs loses its selection and gate cards lose typed notes
  - *Where:* `packages/app/src/main/connection-state.ts:180-185` and `:333-338`: on every link re-arrival, `generation` is bumped and published even while `state` stays `live`.
  - *Recommendation:* On a generation bump, keep the last snapshot and re-read in the background (stale-while-revalidate).
  - *Verified (verifier V2):* Reattachments are rare with the bundled local daemon; what is lost is on-screen context and small drafts. `reconciliation.test.tsx:204` currently expects the reset.
  - *Related:* D6-01
- **C6-06** · **Medium** (confirmed, was High) · correctness — The step detail's tool-call list never updates while the step runs
  - *Where:* `step/step-detail.tsx:79` computes `foldToolCalls(log.events)`.
  - *Recommendation:* In the `agent.update` handler, also fold tool-call updates into a separate `toolUpdates` state, or append synthetic `agent.update` events to `events`.
  - *Verified (verifier V2):* A stale secondary panel: the output pane and permission waits still update live.
- **C6-07** · **Medium** (confirmed, was High) · correctness — `VirtualList` ignores its in-scroller header, so the selected or newest row sits just below the fold
  - *Where:* `list/virtual-list.tsx:256-283`: the header is rendered inside `.orca-list__scroller`, above `.orca-list__rows`.
  - *Recommendation:* Measure the header and include it as an offset (`rowsTop`) in `ListMetrics`, then use it in `revealScrollTop`, `isAtBottom`, `shiftScrollTop` and `listWindow`.
  - *Verified (verifier V2):* Also affects `plan/schedule-table.tsx`. Measure the header with the same `ResizeObserver` as the scroller.
- **C6-09** · **Medium** (confirmed, was High) · performance — Timeline entries grow without bound, every append costs O(n), and live batches diverge from replay
  - *Where:* `runs/timeline/use-run-events.ts:150-157`: one append per `agent.update` and per `event.appended`.
  - *Recommendation:* In `append`, extend the last row when it is an `agent.update` for the same `stepRunId` with `fromSeq = last.seq + 1`, which is what replay does.
  - *Verified (verifier V2):* Growth is per selected live run and resets on a run change; the fix must merge by sequence range and keep row ids stable.
- **C6-10** · **Medium** · correctness — `shiftBy` runs before the prepended rows commit, and timeline `loadEarlier` overwrites state from a stale snapshot
  - *Where:* `runs/timeline/use-run-events.ts:191-205`: `setState({...held, entries…})`, then `prepend.current?.(prepended)` synchronously.
  - *Recommendation:* Queue the shift and apply it in a `useLayoutEffect` after `items.length` changes, for example `pendingShift.current += n`, consumed on commit.
- **C6-11** · **Medium** · correctness — Output buffer at its cap: front trims are not compensated, and a just-loaded earlier page is trimmed straight away
  - *Where:* `step/line-buffer.ts:272-294` (`prepend` does not trim) and `:356-365` / `:412-422` (`drain`, then `trim`); `step/use-step-log.ts:110-116`.
  - *Recommendation:* Have `trim()` report how many rows were dropped, and let the hook call `shiftBy(-dropped)` when the person is held.
- **C6-12** · **Medium** · accessibility — Output-pane search: Enter leaves focus in the field, so `n` and `⇧N` type letters
  - *Where:* `step/output-pane.tsx:222-228` (`onSearchKey`) and `:155-158` (`goTo`, which does not move focus).
  - *Recommendation:* after `goTo(first)`, focus the list element (expose `focus()` on `VirtualListHandle`), and hold following.
- **C6-13** · **Medium** · performance — Feed publishes recompute from scratch on every notification, O(C·n log n), and the held maps grow for the session
  - *Where:* `runs/use-runs.ts:63-81`: a `mergeRun`, which is a full `orderRuns` sort with `localeCompare`, for every resolved run *and* every changed run, on every `run.changed`.
  - *Recommendation:* Maintain the derived list incrementally: patch one row, then re-insert it by binary search.
- **C6-14** · **Medium** · performance — Synchronous IPC on the render path of the always-mounted chrome
  - *Where:* `attention/use-revisions.ts:101-112` (`currentScope()`), called at `:151` on *every render*, and again in `active()` closures and in `answerDraft` (`:690-699`).
  - *Recommendation:* derive `scope` from the already-subscribed `useConnection()` and `useWorkspace()` values. Reserve synchronous reads for the few guard checks that need one, outside render.
- **C6-15** · **Medium** · correctness — Two route kinds are resolved but their payload is dropped: artifact links never open the panel, and gate links don't focus the card
  - *Where:* `route-table.ts:131-141` parses `{name, version, runId}`. `App.tsx:328-330` uses only `runId`, and nothing calls `useArtifactPanel().open`.
  - *Recommendation:* Handle the `artifact` route in App by calling `panel.open({runId, name, version})` (resolving `version` from `artifacts.list` when it is absent).
  - *Related:* D6-12
- **C6-16** · **Medium** · correctness — A held Enter defeats the palette's two-press confirmation of destructive rows
  - *Where:* `palette/command-palette.tsx:141-149` and `:167-170`. `keyboard-map.ts:334-348` also never checks `event.repeat`.
  - *Recommendation:* Ignore `event.repeat` when confirming an armed row, and ideally for every write action in `KeyboardMap.handle`.
- **C6-17** · **Medium** · accessibility — Controls nested inside listbox options (timeline copy menu, "Load earlier output")
  - *Where:* `runs/timeline/timeline.tsx:299-302` and `:320-354`: each row has a `Menu` trigger button, while the list role is the default `listbox`.
  - *Recommendation:* Use `role="grid"` with `gridcell`s for the timeline and output pane, give in-row controls `tabIndex={-1}`, and reach them via a row key.
  - *Related:* D7-04
- **C6-18** · **Low** · resource-leak — Error paths leave `reading` set, so pending notification buffers grow without bound
  - *Where:* `runs/timeline/use-run-events.ts:121-127`: on error, `reading.current` stays `true`. The `append` handler at `:151` keeps pushing.
  - *Recommendation:* set `reading.current = false` and clear the pending arrays on error, and offer a retry in the step pane's error view.
- **C6-19** · **Low** · correctness — Output-pane reconnect seams are lost in a real reconnect
  - *Where:* `step/use-step-log.ts:101` (a new buffer per `generation`) and `:215-223` (`mark`).
  - *Recommendation:* keep the buffer across generations and merge the re-read page by `seq`, which `take`'s `highest` already dedupes. Mark the seams in that buffer.
- **C6-20** · **Low** · correctness — A finished step opens with "↓ N new lines" counting every line loaded
  - *Where:* `step/use-step-log.ts:93`, `:137` and `:257`.
  - *Recommendation:* set `heldAt` to `buffer.linesAppended` after the initial `load`.
- **C6-21** · **Low** · accessibility — Free-text gate: Enter in the Answer field does nothing
  - *Where:* `attention/answer-card.tsx:320-333`, with no `onKeyDown`, and `keyboard-map.ts:233-235`, where bare Enter is not dispatched from a text entry.
  - *Recommendation:* add the same `onKeyDown` Enter-to-`send()` handler that the note field has.
- **C6-22** · **Low** · accessibility — The live region announces every step start across the whole store, and repeated sentences are swallowed
  - *Where:* `a11y/announcements.ts:144-153` (`running` is announced) and `a11y/announcer.tsx:46-59` (store-wide, with no run filter).
  - *Recommendation:* Announce starts only for the selected run, or drop `running` from `ANNOUNCED_STEP`.
- **C6-23** · **Low** · correctness — A running step's "Produced" chips and the panel's version list never refresh
  - *Where:* `artifacts/use-artifacts.ts:130-133` and `:158-185`; `step/step-detail.tsx:210-211`.
  - *Recommendation:* re-read `artifacts.list`, or append from the event, when an `artifact.recorded` arrives for this step or run.
- **C6-24** · **Low** · accessibility — Smaller chrome and focus issues
  - *Where:* `chrome/docked-panel.tsx:50-54`, `palette/use-command-palette.ts:106-110`, `chrome/connection-banner.tsx:137-166`, `daemon-connection/boundary.tsx:61-78`, `runs/timeline/timeline.tsx:340`, `ui/object-header.tsx:494-499` …
  - *Recommendation:* Five small fixes: label the panel shortcut with `shortcutLabel(TOGGLE_PANEL_KEY, platform)`; make `openPalette` a no-op while open so `returnTo` survives; contain focus and make the background `inert` under `aria-modal` dialogs; handle clipboard-write rejections; re-read after subscribing in `update-control.tsx`.
- **C6-25** · **Low** · performance — The step detail re-renders the whole tool-call list on every 100ms output commit
  - *Where:* `step/step-detail.tsx:139-148`. `ToolCallRow` is not memoised, and `Step` re-renders whenever `log.rows` changes.
  - *Recommendation:* wrap `ToolCallRow` in `memo`, or split `Output` so that only it subscribes to `rows`.
- **C6-26** · **Low** · correctness — `useRuns` over-counts `total` for resolved runs already in the store
  - *Where:* `runs/use-runs.ts:67-69`.
  - *Recommendation:* only add to `total` for runs created after the snapshot's `asOf`, or re-read the count lazily.
- **C6-27** · **Low** · performance — The palette search cache is dropped on every `run.changed`, costing 21 IPC reads per keystroke on a busy store
  - *Where:* `palette/object-sources.tsx:111-124` and `:185-192`.
  - *Recommendation:* Invalidate only the run whose `runId` changed, and only on status transitions that alter steps.
- **C6-28** · **Low** · accessibility — Every Attention card is an assertive alert, so all of them are announced again on each mount
  - *Where:* `ui/card.tsx:98`, `attention/answer-card.tsx:295`.
  - *Recommendation:* announce a card only when it is *newly opened* while the surface is mounted, through the one announcer or a single assertive region. Do not make each card an alert.

### C7 — Renderer: config, plan, workflows, guided launch, templates, agents

Full write-up: [C7.md](2026-10-13-review-detail/C7.md).

- **C7-01** · **High** (confirmed, was Critical) · data-integrity — Permission-sidecar draft is a whole-file copy, saved against the *latest* revision, so it silently reverts other writers' grants
  - *Where:* `config/use-config.ts:153-162` (every `config.changed` re-reads), `config/use-config.ts:191-210` (`expectedRevision: view.revision`) …
  - *Recommendation:* Record `baseRevision` on the `DocumentDraft` when it is first created and send that as `expectedRevision`, so the daemon answers `CONFIG_STALE`.
  - *Verified (verifier V3):* Lowered from Critical: the common trigger (a dropped "allow always") fails safe. Sending the base revision is not enough, because Reload-then-Save resends the same stale copy; keep the draft as this agent's rule list and compose it onto the file on disk at save time (`withRules(onDisk, agentId, rules)`).
- **C7-02** · **Medium** (confirmed, was High) · correctness — Structured Config form records one edit per keystroke; past 1000 edits the draft can never be validated or saved
  - *Where:* `config/structured-form/structured-form.tsx:369-373` (`change(text)` on every `onChange`); `config/structured-form/editor-session.ts:80` (`this.edits = [...this.edits, ...edits]`, no coalescing) …
  - *Recommendation:* In `StructuredEditorSession.edit`, coalesce a `set` whose path equals the previous intent's path, and drop a `set` that restores the original base value.
  - *Verified (verifier V3):* Nothing on disk is harmed; the draft has to be discarded.
- **C7-03** · **Medium** (confirmed, was High) · data-integrity — Workflow inspector shows the previous node's uncommitted text on the newly selected node and can write it there
  - *Where:* `workflow/editor/editor-inspector.tsx:178-186` (`<NodeInspector …/>` and `<EdgeInspector …/>` have no `key`); `:310` (`FieldEditor key={spec.key}`); `:818` (`CommitInput`: `useEffect(() => setText(value), [value])`)
  - *Recommendation:* Key the inspector bodies by identity: `<NodeInspector key={`${path key}:${node.id}`}>` and `<EdgeInspector key={edge.index + from + to}>`. Alternatively key `CommitInput` by its YAML `path`.
  - *Verified (verifier V3):* Only the draft is affected and Review shows the diff. Key each field editor by node id and field rather than the whole inspector, or renaming with Enter drops focus.
- **C7-04** · **Medium** (confirmed, was High) · reliability — Guided launch wedges permanently after a launch is refused before main retains it
  - *Where:* `guided-launch/controller.ts:311-326` (`unresolvedReview: review` set before `launch()`, cleared only on success); `:343-371` (recover: `if (!intent) throw new LaunchPortFailure("unavailable")`) …
  - *Recommendation:* Treat `resolveIntent` returning `undefined`, under the same scope with current authority, as "confirmed nothing retained": clear `unresolvedReview` and return to editing with the draft intact.
  - *Verified (verifier V3):* Fails closed; an app restart clears it.
- **C7-05** · **Medium** · performance — Config form checks access with synchronous IPC and full-document re-projection, many times per field per render, on every keystroke
  - *Where:* `config/configuration-studio.ts:163-193, 315-327` (`value` getter and `reason()` → `currentEditorTarget(this.bridge)` and `bridge.connection.read()`); preload `src/preload/index.cts:177, 314` (both reads are `ipcRenderer.sendSync`) …
  - *Recommendation:* Compute the target and connection snapshot once per render, from `useConnection` or the existing subscriptions, and pass them in.
- **C7-06** · **Medium** · correctness — Workflow draft queue sends index-addressed operations against a newer revision than they were composed for; a held or doubled Delete removes the wrong edges and then cascades into nodes
  - *Where:* `workflow/editor/use-workflow-draft.ts:100-113, 115-124, 142-160` (each queued call reads `latest.current.revision` when it runs; a `CONFIG_STALE` reloads and the queue continues); `workflow/editor/workflow-editor.tsx:180-205` …
  - *Recommendation:* Capture `draft.revision` when the gesture is composed and send that for index-addressed ops (or for all ops). Let the daemon refuse with `CONFIG_STALE` instead of chaining.
- **C7-07** · **Medium** · correctness — Inspector shows a bare-string agent selector (an agent id) as "role" and rewrites it to `{role: …}` on edit
  - *Where:* `workflow/editor/editor-inspector.tsx:729` (`kind = record && typeof record.id === "string" ? "id" : "role"`), `:751` (`onCommit({ [kind]: text })`) …
  - *Recommendation:* Treat `typeof value === "string"` as `kind = "id"`. Preserve the bare-string form on a text edit (commit a string), and only switch shape when the user explicitly chooses "Agent by".
- **C7-08** · **Medium** · data-integrity — Sidecar edits typed while a Save is in flight are silently discarded; Discard during a Save does not stop the write
  - *Where:* `config/use-config.ts:257-264` (`setDrafts(... [document]: undefined)` unconditionally on success), `:181-184` (discard resets `busy`); `config/policy-editor.tsx:191` (`editable = canSet && held !== undefined`, with no `save.busy`) …
  - *Recommendation:* Snapshot the draft (or its sequence) that was sent. On success, clear the draft only if it is unchanged; otherwise keep the newer draft, rebased on the new revision. Disable the editors and Discard while `busy`.
- **C7-09** · **Medium** · data-integrity — Config studio: an edit made while Save is in flight becomes an unreconcilable "retained" draft
  - *Where:* `config/configuration-studio.ts:226-238` (save port: `if (sequence changed) this.stale = true` and no `acceptSaved`); `config/structured-form/editor-session.ts:253-256` ("Reviewed changes saved. Newer edits are retained …
  - *Recommendation:* When the save is acknowledged with newer edits, rebase in place: set the session revision to the saved one, drop the saved prefix (`edits.slice(review.editCount)`) and update `this.data`. Or simply make inputs read-only while busy.
- **C7-10** · **Medium** · correctness — Plan journal forward reads never follow `hasMore`; bursts or an early push leave missing or unloadable entries
  - *Where:* `plan/use-plan.ts:301-319` (single page of `JOURNAL_PAGE=50` after the held tail); `:261-295` (initial load); `:321-337` (`loadEarlier` uses `earliestSeq`)
  - *Recommendation:* Loop the forward read while `result.hasMore`. Do not run the forward read until the initial load has resolved, or have the initial load supersede it. Make `loadEarlier` page backwards from the lowest seq of the newest contiguous run, not from the global minimum.
- **C7-11** · **Medium** · reliability — Guided launch resets the review on every `config.changed` and `workflows.changed`, including sidecar writes, and fences away in-flight acknowledgements
  - *Where:* `guided-launch/launch-context.tsx:51-62, 82, 115-120` (each push → `refresh()` → `contextChanged()` twice; clears `retained` and `selection`) …
  - *Recommendation:* Only invalidate when the snapshot actually differs in fields the review depends on: generation, workflow revision, target or roots. A permissions-document change does not qualify.
- **C7-12** · **Medium** · correctness — Workflow viewer: nested graphs share node-id space with the outer graph (DOM ids, selection, overlay)
  - *Where:* `workflow/workflow-canvas.tsx:293-319` (nested `Graph` with the same `selected`/`overlay`), `:343-414`, `:417` (`nodeDomId = orca-wfnode-${nodeId}`); `workflow/layout.ts` `findNode` (first match) …
  - *Recommendation:* Qualify selection and DOM ids by graph (`${nested.id}::${node.id}`). Carry a graph id through `onSelect` and `findNode`. Only apply the overlay to the graph the traversal belongs to.
- **C7-13** · **Medium** · reliability — A `workflows.changed` push for the workflow being edited unmounts the editor
  - *Where:* `workflow/use-workflow.ts:66-91` (definition push → `setState({phase:"loading"})`); `workflow/workflow-surface.tsx:146, 166-180` (the loading return comes before the `editing` branch)
  - *Recommendation:* Keep the last `ready` state while re-reading (a stale-while-revalidate phase), and render the editor whenever `editing` is set, independently of the viewer's read.
- **C7-14** · **Medium** · data-integrity — Decision rationale is cleared when the daemon refuses a decide
  - *Where:* `plan/decision-mode.tsx:219-232` (`setPending(undefined); setRationale("")` regardless of `result.ok`), `:324` (Decide is disabled only on `busy`)
  - *Recommendation:* Clear `pending` and `rationale` only when `result.ok`. Disable Decide with `disabledReason` while not writable.
- **C7-15** · **Medium** · performance — Run overlay re-reads the whole run, traversal included, on every `run.changed` and `step.changed`, without coalescing
  - *Where:* `workflow/use-workflow.ts:103-136`
  - *Recommendation:* Coalesce: throttle the bump (for example `requestAnimationFrame` or 250 ms trailing), or skip a new read while one is in flight and re-read once afterwards.
- **C7-16** · **Low** · correctness — `setWire` updater has a side effect; StrictMode double-invocation adds duplicate edges in dev
  - *Where:* `workflow/editor/editor-canvas.tsx:349-356`; `main.tsx:47` (`<StrictMode>`)
  - *Recommendation:* Read `wire` from a ref or the closure, call `onConnect` outside the updater, then `setWire(undefined)`.
- **C7-17** · **Low** · correctness — Structured form number input cannot be cleared
  - *Where:* `config/structured-form/structured-form.tsx:363-373`
  - *Recommendation:* Keep local text state (as `CommitInput` does) and commit on valid text or blur.
- **C7-18** · **Low** · correctness — Union variant review card disappears on any re-render
  - *Where:* `config/structured-form/structured-form.tsx:486` (`pending.value === form.value`); `config/configuration-studio.ts:163-165` (`value` is a fresh projection on every render)
  - *Recommendation:* Compare by `pathLabel(form.path)` plus a stable sequence (`studio.state.sequence`), or deep-equal the current value.
- **C7-19** · **Low** · accessibility — Focus drops to the page body when arming Waive and Reopen confirmations
  - *Where:* `plan/relationship-inspector.tsx:129-152`; `plan/decision-mode.tsx:350-375`
  - *Recommendation:* Focus Keep or Cancel in a layout effect when the row arms, and return focus to the trigger on disarm.
  - *Related:* D7-02
- **C7-20** · **Low** · correctness — Undo, Redo and Tidy stay enabled while the workflow Review panel is open
  - *Where:* `workflow/editor/workflow-editor.tsx:308-348, 386-394`
  - *Recommendation:* Disable the mutators while `review` is set, or drop `review` when `draft.revision` changes.
- **C7-21** · **Low** · correctness — Workflow draft change count double-counts nested edits
  - *Where:* `workflow/editor/draft-model.ts:101-153`
  - *Recommendation:* When computing the parent's state, compare containers excluding their nested graphs, or skip counting a container whose only difference is inside its graphs.
- **C7-22** · **Low** · performance — Graph layout and model have quadratic hot spots, re-run on every plan push
  - *Where:* `workflow/layout.ts:198-200` (`nodes.some` per DFS root → O(N²)), `:252`; `plan/graph-model.ts:106-131` (`dependencies.filter` per item and per target → O(I·D)); `plan/plan-surface.tsx:225-231` (recomputed on every `held` change)
  - *Recommendation:* Use `Set` and `Map` lookups (`ids.has(root)`) and pre-index dependencies by `from` and by target.
- **C7-23** · **Low** · performance — Workflows list re-reads list and per-workflow draft facts once per `workflows.changed`
  - *Where:* `workflow/workflows-surface.tsx:72-104`
  - *Recommendation:* Debounce reloads in a microtask or animation frame, or fold all pushes in one tick into a single read.
- **C7-24** · **Low** · performance — Template studio provider re-subscribes and re-reads on every config feed state change
  - *Where:* `template-authoring/context.tsx:33-141` (effect deps `[source, stream]`)
  - *Recommendation:* Depend on the target or generation only. Rely on the `config.changed` listener.
- **C7-25** · **Low** · correctness — Dragged node stays drawn at the drop point when `place` is refused without a draft change
  - *Where:* `workflow/editor/editor-canvas.tsx:309-327`
  - *Recommendation:* Clear `override` when `onPlace` resolves with `ok === false`; `onPlace` would need to return the `apply` promise.
- **C7-26** · **Low** · correctness — Pushed journal entries are prepended to a newest-first list without `shiftBy`
  - *Where:* `plan/journal.tsx:205` (`newestFirst`); `plan/use-plan.ts:301-319`
  - *Recommendation:* After a forward fold, call `listRef.current?.shiftBy(added)` while the user is scrolled away from the top.
- **C7-27** · **Low** · correctness — Plan palette "Release claim" row uses a claim read once per item
  - *Where:* `plan/use-plan-writes.ts:281-301`
  - *Recommendation:* Add `item.claim.runId` and `feed.itemsRevision` to the dependencies.
- **C7-28** · **Info** · maintainability — The legacy Config write path is dead in production but still tested as the main path
  - *Where:* `config/config-surface.tsx:77-89` (always dispatches to `ConfigurationStudioSurface` when `window.orca.daemonConnection` exists, which preload always provides: `src/preload/index.cts:176`) …
  - *Recommendation:* Retire the legacy surface, or confine it to the preview harness. Move its tests' intent onto `ConfigurationStudio`, and update AGENTS.md's Config paragraph.

### C8 — CI, release and deploy tooling, build and dependencies

Full write-up: [C8.md](2026-10-13-review-detail/C8.md).

- **C8-03** · **High** (confirmed) · ci-cd — The release verification job runs `pnpm test` before `pnpm run build`, so compiled-MCP acceptance tests will fail on the clean checkout and block the next release after it merges
  - *Where:* `.github/workflows/release-publish.yml:82-83`; `packages/integrations/test/mcp-operator-production-fixture.ts:239-248`; `tools/test/m10-owned-plugin.test.js:23`; compare `ci.yml:156-159`
  - *Recommendation:* Make the release `check` job match the CI code lane: build before test, plus `design:check`, `ORCA_MCP_REQUIRE_PRODUCTION: "1"`, the retry-acceptance step and the compiled smoke.
  - *Verified (lead):* `release-publish.yml:82-83` runs `pnpm test` before `pnpm run build`; `ProductionFixture.create` throws without `dist/` (`mcp-operator-production-fixture.ts:246`); `ci.yml` builds first.
  - *Related:* D5-02
- **C8-01** · **Medium** (confirmed, was High) · security — Release workflow gives every job a `contents: write` token, including the one that runs dependency code on the self-hosted runner with stored credentials
  - *Where:* `.github/workflows/release-publish.yml:42-43` (workflow-level `permissions: contents: write`), `:46-99` (`check` job), `:56-59` (checkout without `persist-credentials: false`), `:68` (third-party action), `:75-83` (`pnpm install`, lint …
  - *Recommendation:* Set `permissions: contents: read` at workflow level and grant `contents: write` only on the `publish` job.
  - *Verified (verifier V4):* Private, single-owner repository, but `main` is unprotected and assets unsigned. Scoping `contents: write` to `publish` is not enough on its own: `publish` shares the persistent homelab runner with jobs that run dependency code.
- **C8-02** · **Medium** (confirmed, was High) · supply-chain — The third-party action `pnpm/action-setup` and all other actions are pinned by mutable tag, including in jobs with a write token on the self-hosted runner
  - *Where:* `pnpm/action-setup@v6` at `release-publish.yml:68`, `ci.yml:59`, `ci-shadow.yml:120`, `app-smoke.yml:92,205` and `desktop.yml:74`. Also tag-pinned: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6` …
  - *Recommendation:* Pin every action to a full commit SHA with a `# vX.Y.Z` comment. Dependabot updates SHA pins.
  - *Verified (verifier V4):* `pnpm/action-setup` is the only third-party action. SHA-pin it or replace it with corepack (`packageManager: pnpm@12.4.2`).
- **C8-04** · **Medium** · security — Release publication can be dispatched from any ref, with no environment approval and no check that the commit is on `main`
  - *Where:* `.github/workflows/release-publish.yml:30-36,47-58,116-208`
  - *Recommendation:* In `check`, require `git merge-base --is-ancestor "$sha" origin/main` unless an explicit, logged override is given.
- **C8-05** · **Medium** · security — The feed deploy key is a repository-wide secret with unrestricted shell on the feed host, and the job overwrites the self-hosted runner's `known_hosts`
  - *Where:* `.github/workflows/release-publish.yml:186-208`; `tools/deploy/publish-feed.py`; `docs/UPDATING.md:99-108`
  - *Recommendation:* Make the secret environment-scoped (see C8-04).
- **C8-06** · **Medium** · supply-chain — Desktop artifacts and Windows auto-updates are unsigned, so feed-host or pipeline compromise means code execution on every client (known, documented gap)
  - *Where:* `packages/app/electron-builder.yml` (`mac.identity: null`, `notarize: false`, no `win` signing); `.github/workflows/desktop.yml:200-218`; `tools/deploy/release-assets.py:21-37`; `docs/RELEASING.md` "Signing and notarisation are not done" …
  - *Recommendation:* Before wider rollout, add Windows Authenticode signing (Azure Trusted Signing) and set `publisherName` so `electron-updater` verifies signatures.
- **C8-07** · **Medium** · security — One self-hosted `homelab` runner serves release builds and publishing as well as jobs that can run arbitrary refs; it is exposed if the repository goes public
  - *Where:* Release jobs on the runner: `release-publish.yml:51,119` (`check` and `publish`, the latter holding the feed key), `release-prepare.yml:32`, `desktop.yml:51` (Linux packaging)
  - *Recommendation:* Make the homelab runner ephemeral (JIT or `--ephemeral`, fresh VM or container per job).
- **C8-08** · **Low** · testing — The feed publisher has no tests, and two of the Debian updater's Python suites never run
  - *Where:* `tools/deploy/publish-feed.py` (no test references it); `tools/deploy/test_auth.py` and `tools/deploy/test_operator_compatibility.py` (not invoked by any `tools/test/*.test.js` or workflow) …
  - *Recommendation:* Run all deploy suites from `deployment.test.js`, for example by looping over `tools/deploy/test_*.py` except the opt-in integration suite.
- **C8-09** · **Low** · correctness — Version math skips the final release after a prerelease, and accepts pinned versions that go backwards or come from unintended text
  - *Where:* `tools/release.js:46-74,170-174`; `.github/workflows/release-prepare.yml:78-79`
  - *Recommendation:* If the current version has a prerelease part, a bump to the same base should give the base: `0.7.0-rc.1` with patch becomes `0.7.0`.
- **C8-10** · **Low** · security — An unvalidated version string is spliced into shell scripts in `desktop.yml`
  - *Where:* `.github/workflows/desktop.yml:105` (`version="${{ inputs.version }}"`), `:261` (`cp … "orca-daemon-${{ steps.version.outputs.version }}.mjs"`); source `release-publish.yml:90-99` (no semver check)
  - *Recommendation:* Validate `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` in the `check` job's "The version being released" step.
- **C8-11** · **Low** · security — Predictable temp paths on shared hosts, and the feed host never verifies installer hashes
  - *Where:* `release-publish.yml:155` (`/tmp/notes.md`), `:206-208` (`/tmp/orca-feed.tgz`, remote `/tmp/orca-feed-$VERSION.tgz`); `tools/deploy/publish-feed.py:63-75`
  - *Recommendation:* Use `$RUNNER_TEMP` on the runner.
- **C8-12** · **Low** · reliability — A feed activation failure after the GitHub release is published cannot be retried through the workflow
  - *Where:* `release-publish.yml:139-208`
  - *Recommendation:* Split feed activation into its own idempotent job or workflow keyed on an existing published release, which downloads its assets and re-verifies them. Alternatively, make the tag guard skip release creation when the release already exists with identical assets.
- **C8-13** · **Low** · ci-cd — Concurrency settings contradict their comments and can drop queued runs
  - *Where:* `release-publish.yml:27-40`, `desktop.yml:35-39`, `ci.yml:14-16`
  - *Recommendation:* Move release concurrency to job level on `check` and `publish`, or compute the group as `release-publication` only for qualifying events and `noop-${{ github.run_id }}` otherwise.
- **C8-14** · **Low** · performance — Long jobs have no `timeout-minutes`, so a hang holds the single homelab runner for up to 6 hours
  - *Where:* `ci.yml` `check` job (only the retry step has a 3-minute bound); every job in `release-publish.yml`, `desktop.yml`, `app-smoke.yml` (`smoke`, `changes`, `type-proof` jobs), `release-prepare.yml` and `changelog.yml`
  - *Recommendation:* Add job-level `timeout-minutes` sized from observed durations, roughly 1.5–2× typical.
- **C8-15** · **Low** · maintainability — The design-token lint has easy false negatives that contradict the "no literal sizes or radii" rule
  - *Where:* `tools/eslint-config/rules/design-tokens-only.js:24-42,88-93`; `tools/eslint-config/css-tokens.js:18,23-24,37,43,146-151`
  - *Recommendation:* TSX: flag non-zero numbers on every CSS property React suffixes with px (React's `isUnitlessNumber` list, inverted), and handle `zIndex`.
- **C8-16** · **Low** · security — `plugin-release.js` labels bundles "closed", but its syntax audit is trivially bypassed
  - *Where:* `tools/plugin-release.js:16-75,192-195`
  - *Recommendation:* Add `process` and `Reflect` to the denylist and refuse computed `ElementAccessExpression` on identifiers.
- **C8-17** · **Low** · security — `orca-release.py stage` passes the operator's whole environment, including any daemon token, to dependency install and build scripts
  - *Where:* `tools/deploy/orca-release.py:222-235,240-241`
  - *Recommendation:* Build the staging environment from an allowlist (`PATH`, `HOME`, `LANG`, mise variables, proxy and CA variables) and strip `ORCA_*` and `GH_*`/`GITHUB_*`, as `exec_release` already does for the admission variables.
  - *Related:* C4-02
- **C8-18** · **Low** · correctness — `design:check` falsely reports stale tokens on CRLF checkouts
  - *Where:* `packages/design/build-tokens.js:384-402`; `.gitattributes` (no `eol=lf` rule for `packages/design/css/tokens.css` or `src/tokens.ts`)
  - *Recommendation:* Add `packages/design/css/tokens.css text eol=lf` and `packages/design/src/tokens.ts text eol=lf`, or normalise `\r\n` in check mode.
- **C8-19** · **Low** · configuration — `.gitignore` has no patterns for key material while signing and feed keys are planned
  - *Where:* `.gitignore`
  - *Recommendation:* Add those patterns, and consider a pre-commit or CI secret scan (see C8-21).
- **C8-20** · **Info** · security — Internal infrastructure details are committed
  - *Where:* `.github/workflows/selfhosted_runner_smoketest.yml:16` — LAN Proxmox endpoint `192.168.50.233:8006`, "pve1"
  - *Recommendation:* Before any visibility change, move host-specific values into private deployment configuration or repository variables, and keep templates generic.
- **C8-21** · **Info** · supply-chain — No SAST, dependency review, secret scanning, CODEOWNERS or Dependabot cooldown
  - *Where:* `codeql.yml:158-166` (dispatch-only); `.github/` (no CODEOWNERS); `dependabot.yml` (no `cooldown`)
  - *Recommendation:* Add CODEOWNERS for `.github/`, `tools/deploy/`, `tools/ci-shadow/`, `pnpm-*.yaml` and `package.json`.
- **C8-22** · **Info** · maintainability — Docs and dead code have drifted from the workflows
  - *Where:* `docs/RELEASING.md` "The artifacts"; `docs/DEVELOPMENT.md:332`; `app-smoke.yml:50-80`
  - *Recommendation:* Correct the docs, and remove the dead classifier or reinstate the trigger it was written for.
- **C8-23** · **Info** · configuration — The toolchain pins float in release builds
  - *Where:* `mise.toml` (`node = "24"`, `pnpm = "12"`)
  - *Recommendation:* Pin `24.21.0` in `mise.toml` and in every workflow, consistently.
