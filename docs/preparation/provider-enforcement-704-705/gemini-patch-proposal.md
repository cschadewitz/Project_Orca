# Gemini ACP permission route — pinned-source corrective patch proposal (#705)

26 October 2026; base `46ce182308e8d5b59c4fdbabd49232b4cf4cdbdc` (the handoff main head).
**Proposal and offline regressions only. The examined Gemini strict projected-approval
route stays NO-GO** until a reviewed change is separately qualified. This is not a
provider-wide judgment, a live integration, an upstream submission or a claim of an exploit.

This consumes the [#713 packet](README.md) and its [#724 canonical reconciliation](validation.md):
the Gemini row there names the smallest change as "projection from owned invocation plus
actual offered-ID membership and cancellation/pending check before confirmation/policy
mutation". Below is that change as a diff against the pinned source, with tests that run the
pinned route before and after it. Existing manifests, excerpts, vectors, canonical contracts,
runtime adapters, the #742 producer and the positive observer are unchanged.

## Pins

Gemini CLI **0.65.0**, `google-gemini/gemini-cli@6006c14a4decfe4b891c6263ad6ad5992e404b5b`,
the revision [source-pins.json](source-pins.json) records. Blobs were reread at that revision
and hashed with `git hash-object`:

| Upstream file | Blob | Matches #713 pin |
| --- | --- | --- |
| `packages/cli/src/acp/acpSession.ts` | `471e265a865d60d7da67dbd0cdc0265c86782d3a` | yes (`gemini-permission`) |
| `packages/core/src/tools/shell.ts` | `59ec724c99fbdd2951a339fc473449878687046f` | yes (`gemini-abort`) |
| `packages/cli/src/acp/acpUtils.ts` | `a0a4ae7a475364d9133039f13497e81f9fcddec7` | new extract |
| `packages/core/src/tools/tools.ts` | `ab2870984aba77e77fc5bacb25009cd47698582e` | new extract |

The #713 excerpts still reproduce byte-for-byte from those blobs: `gemini-permission.txt`
SHA256 `2dd84941…df26` (3869 bytes, lines 694-815) and `gemini-abort.txt` `ead9cfd2…f31`
(291 bytes, lines 540-551). New extracts, their digests and the diff's digest are in the
[fixture manifest](../../../tools/test/fixtures/provider-enforcement-704-705/gemini-proposal/manifest.json),
with attribution in the [fixture README](../../../tools/test/fixtures/provider-enforcement-704-705/gemini-proposal/README.md).
The upstream `LICENSE` blob is 11357 bytes; the new directory carries it exactly. (The
existing `license-gemini.txt` has one extra trailing newline; it is left unchanged.)

## The route's precise gaps (source-reviewed)

`runTool` builds the invocation, asks `shouldConfirmExecute`, sends a `tool_call` update and
an ACP `requestPermission`, then applies the answer
([acpSession.ts L694-L840](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpSession.ts#L694-L840)).
The invocation, its confirmation details and their `onConfirm` callback stay in that one
closure; the gaps are in what crosses the wire and what comes back.

1. **Projection is presentation only.** The request's `toolCall` is `toolCallId`, `status`,
   `title`, `content`, `locations`, `kind`. For the shell tool the title is the raw command
   (`getDisplayTitle`), but nothing structured states it; other tools fall back to
   `getDescription()`, so a title is not an identity. `content` carries a diff for `edit`
   details and an explanation, nothing else. `dir_path` and the cwd `execute()` resolves
   (`path.resolve(getTargetDir(), dir_path)` or `getTargetDir()`) are absent. A
   `sandbox_expansion` confirmation's `additionalPermissions` are not projected, and the
   `exec` details built when a security warning is present omit the
   `additional_permissions` parameter that `execute()` still unions into the sandbox request
   ([shell.ts L433-L519](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/tools/shell.ts#L433-L519),
   [L728-L745](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/tools/shell.ts#L728-L745)).
2. **A recognized option ID is not an offered one.** The answer's `optionId` is parsed with
   `z.nativeEnum(ToolConfirmationOutcome)`, not compared with this request's `options`.
   [`toPermissionOptions`](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpUtils.ts#L98-L200)
   offers `proceed_always_and_save` only with `enablePermanentToolApproval`, no
   always-options under `disableAlwaysAllow`, only once/cancel for `sandbox_expansion`, and
   never `modify_with_editor`. Each of those still parses and reaches `onConfirm` and
   `updatePolicy` — for `proceed_always_and_save`, a persisted policy rule
   ([policy.ts L114-L184](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/scheduler/policy.ts#L114-L184))
   and, for sandbox expansion, `addPersistentApproval`.
3. **No cancellation or ownership check after the await.** The signal is the prompt's
   `pendingSend` controller, aborted by `cancelPendingPrompt` or a superseding `prompt`;
   `dispose()` aborts only `disposeController`. Nothing is checked between
   `requestPermission` resolving and `onConfirm`/`updatePolicy`.

What already holds and is preserved: the native closure keeps the original invocation and
callback; unknown option strings fail the enum parse before any effect; and the shell tool
checks `signal.aborted` before starting
([shell.ts L540-L551](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/tools/shell.ts#L540-L551)),
so source does not show a cancelled turn's shell starting. Gap 2 needs a client to send an
unoffered ID and gap 3 a late answer; neither is shown here to be reachable from a released
client, and neither is evidence that a cancelled shell executes.

## Proposed diff

[`proposed-upstream.diff`](../../../tools/test/fixtures/provider-enforcement-704-705/gemini-proposal/proposed-upstream.diff)
(three files, +96/−11) applies cleanly to the pinned blobs with `git apply --check` and
`patch --dry-run -p1`, and is formatted with the upstream Prettier settings.

- **`tools.ts`** — an optional `ToolInvocation.getAuthorizationProjection(details)` and its
  `ToolAuthorizationProjection` shape: `command`, `dirPath`, `resolvedCwd`,
  `additionalPermissions`. Optional, so tools that cannot state these facts exactly do not
  pretend to.
- **`shell.ts`** — the shell invocation implements it from its own state: the stored
  `params.command` unchanged, raw `dir_path`, the same cwd expression `execute()` uses, and
  every grant `execute()` unions (`additional_permissions`, a sandbox-expansion request,
  previously confirmed proactive permissions), once each. Comments say what it does not
  attest: `execute()` later strips a shell wrapper, adds a background-PID wrapper and
  validates the path.
- **`acpSession.ts`** — computes `options` once; sends `_meta.authorization`, which is
  `{ status: 'projected', …projection }` from the invocation that owns the call or
  `{ status: 'unknown' }`, never an empty scope; after the await, throws if the prompt was
  cancelled, superseded or the session disposed; maps a selected ID only through an option
  this request offered, throwing otherwise; checks again between `onConfirm` and
  `updatePolicy`. A throw takes the existing `catch`: failed `tool_call_update`, error
  recorded, no `execute()`.

The offered-option set, the outcome switch, the callback owner and the invocation are
untouched; an offered answer produces exactly the upstream effect order.

## Offline regressions

[`tools/test/gemini-authorization-705.test.js`](../../../tools/test/gemini-authorization-705.test.js)
verifies every extract's bytes and SHA256, that the #713 Gemini pins still match and that
their blob SHAs agree, and that each diff hunk's context matches an extract. It then applies
the `acpSession.ts` hunks to the 694-840 extract in memory and runs **both** versions of the
same pinned route, with the real `toPermissionOptions` extract, the real sandbox-expansion
`onConfirm` extract and the #713 pre-start abort extract.

| Test | Upstream excerpt | With proposal |
| --- | --- | --- |
| Request fields | presentation only; no resolved cwd or extra scope on the wire | adds the owner projection; presentation fields identical |
| Exact bytes (4 command/cwd cases: absent, `""`, `..`, spaces, non-ASCII, CR/LF, `\`-newline) | — | command bytes equal after JSON round-trip; cwd equals `execute()`'s expression |
| Additional scope | — | each unioned grant listed once |
| Tool with no projection | — | `{ status: "unknown" }` |
| Same title, different command; same command, different cwd | requests equal except `toolCallId` | projections differ |
| Recognized but unoffered (7 cases: exec ×5, sandbox ×2) | `onConfirm` and `updatePolicy` run; sandbox approval recorded | no effect; "not offered" error |
| Unrecognized ID | rejected before any effect | rejected before any effect |
| Positive control: every offered option (exec with permanent approval, sandbox) | — | identical effect log to upstream |
| Original owner | — | one `build()`; projection, `onConfirm`, `updatePolicy`, `execute` all on the same invocation/details |
| Response replayed from an invocation where its option was offered into one where it was not | applied, including persistent sandbox approval | rejected |
| Late selected answer after cancel / superseding prompt / dispose | confirms and updates policy | no effect |
| Late cancelled answer after abort | `onConfirm(cancel)`, `updatePolicy(cancel)` | no effect |
| Abort during `onConfirm` | policy updated; shell pre-start abort | policy not updated; callback's own effect is residual |
| Abort after the last check | shell pre-start abort | same shell pre-start abort |
| Canonical mapping of a complete projection | — | `coverage-or-state-unavailable`; with owner claim, `insufficient-coverage`; no option |
| Canonical mapping of unknown cwd / additional scope | — | `required-fact:effectiveCwd` / `required-fact:resources` |
| Synthetic control | — | allow only with synthetic owned coverage and complete facts |

**Failing-before / passing-after:** with the patch withheld (the "after" module replaced by
the unpatched excerpt in a throwaway copy of the test), 25 of 30 tests fail. The 5 that still
pass are the ones meant to: unrecognized-ID rejection, offered-option positive control,
shell pre-start abort, the static-ID residual and the shell projection method alone.

Reduced models, labelled in the test: the enum mirror (checked against the pinned enum
text), a zod-shaped enum parser, the two-branch response schema, the runTool frame and its
`catch`, `exec` confirmation details, the sandbox owner's approval store, `updatePolicy`, the
connection, `os`, and a `ReducedShellInvocation` holding only the proposed method. The
canonical mapping is a test input mapping, not a provider adapter. A projection is evidence
about the request: ORCA owns neither Gemini's later rewrite nor its dispatch, so the capture
owner cannot supply final provenance or cancellation state and pinned source is not
per-execution coverage. That keeps strict admission indeterminate even for a complete
projection — the route remains NO-GO with or without this diff until qualified on an
installed artifact.

## Validation

Node 24.21.0, pinned pnpm 12.4.2, Vitest 5.0.5. Frozen install of the existing lockfile
(`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --no-trust-lockfile`); no
dependency, lockfile, hook or settings change.

```sh
pnpm exec vitest run tools/test/gemini-authorization-705.test.js
pnpm exec vitest run tools/test/gemini-authorization-705.test.js \
  packages/agents/test/provider-qualification-704-705.test.ts \
  tools/test/provider-enforcement-source-704-705.test.js \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/command-evidence-v1-594.test.ts \
  packages/agents/test/strict-permission.test.ts \
  packages/agents/test/permissions.test.ts \
  packages/agents/test/live-input-session.test.ts \
  packages/engine/test/live-input.test.ts \
  packages/daemon/test/live-input-authority.test.ts --maxWorkers=2
pnpm run lint
pnpm run format:check
pnpm run typecheck
```

Results: focused file **30 passed**; the ten-file set **354 passed** (the earlier 324 plus
these 30), zero skipped; repository lint, format check and typecheck passed. The first
`pnpm run lint` ran out of Node's default heap in this container; it passed when rerun with
`NODE_OPTIONS=--max-old-space-size=8192`. `git apply
--check` and `patch --dry-run` of the diff against the pinned blobs passed, and the applied
result equals the reviewed patched files. `git diff --check` passed.

Not run: the full suite, coverage, build, Gemini's own test suites, any installed Gemini
CLI, ACP client or shell, live judges, app smoke, hooks. No upstream contact.

## Questions for maintainer review

1. Is `_meta.authorization` the right carrier, or should exact facts use ACP `rawInput` or a
   named extension key? Should the `tool_call` update carry it too?
2. Should an unoffered ID fail the call (proposed, matching the Claude adapter's decoder) or
   be treated as a cancel? Treating it as cancel still invokes `onConfirm(cancel)`.
3. Option IDs are static enum strings, so a stale answer naming an ID this request also
   offered is accepted here; binding it to one request rests on ACP JSON-RPC correlation
   outside the excerpt. Are per-request option IDs wanted?
4. An abort during `onConfirm` stops `updatePolicy` but not the callback's own effect (the
   sandbox store). Should approvals be staged and committed after the last check?
5. The direct absolute-path read permission in `#resolvePrompt`
   ([acpSession.ts L1078-L1140](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpSession.ts#L1078-L1140))
   uses the same enum parse; it is outside this route and untested here. Same treatment?
6. Should `dispose()` abort the pending prompt rather than each consumer checking both signals?
7. Which other tools should implement the projection, and is `resolvedCwd` before
   `validatePathAccess` and symlink resolution the fact a client should authorize?

Next proofs, each separately authorized: maintainer review of this diff; an installed
artifact carrying it; observed cached-grant, revocation and late-answer effects; and the
every-dispatch, subagent, MCP and client-filesystem exclusions the [#713 matrix](README.md)
keeps open. None is started here.

## Challenge review (follow-up on #743)

26 October 2026, on `origin/main` `890eb71847e4c38533ab8f5b2d35f14076b8f923`. Nothing in this
directory or its fixtures changed between #743 and that head. The proposed diff and every
existing extract, digest and licence byte are unchanged. Upstream text was reread at the same
`6006c14a…` pin, and each blob was checked with `git hash-object` before it was quoted.
**The route stays NO-GO.** Each finding below says whether it is pinned-upstream
behaviour or a defect in this proposal or its fixture.

New pinned extracts, each listed in the [fixture manifest](../../../tools/test/fixtures/provider-enforcement-704-705/gemini-proposal/manifest.json):

| Extract | Upstream lines | Blob |
| --- | --- | --- |
| `shell-policy-update-options.txt` | `packages/core/src/tools/shell.ts` 285-305 | `59ec724c…` |
| `scheduler-standard-policy-update.txt` | `packages/core/src/scheduler/policy.ts` 207-242 | `71c5640d…` |
| `policy-utils-escape-regex.txt`, `policy-utils-args-patterns.txt` | `packages/core/src/policy/utils.ts` 10-12, 56-90 | `3c7bd4d1…` |
| `sandbox-linux-merge.txt` | `packages/core/src/sandbox/linux/LinuxSandboxManager.ts` 245-268 | `793ac47b…` |

### Findings

1. **A narrower-looking answer is remembered as a broader grant (upstream behaviour; the
   proposal does not project it).** For an `exec` request, `toPermissionOptions` offers
   `proceed_always` ("Allow for this session") and, with permanent approval on,
   `proceed_always_and_save` ("Allow this command for all future sessions").
   `getPolicyUpdateOptions` turns either answer into `commandPrefix: <root commands>`, and
   `handleStandardPolicyUpdate` publishes it. `buildArgsPatterns` then makes an open-prefix
   rule: approving `git status` stores `"command":"git…`, which also matches
   `git push --force origin main`. When the command is tainted or touches modified build
   files, `getPolicyUpdateOptions` returns `undefined`. The exec fallback in
   `handleStandardPolicyUpdate` then sets `commandPrefix` from the details' `rootCommands`
   anyway. The proposal's projection states the exact command but says nothing about what
   an always answer will remember, so a client that reads it as the scope of the grant is
   misled. Source-reviewed but not tested here: `policy/config.ts` 721-750 turns the message
   into an `ALLOW` rule. The policy engine (`policy-engine.ts` 215-225, 540-665) matches each
   compound sub-command separately and applies its own downgrades (redirection, outside
   workspace, untrusted git, dangerous command). No exploit is claimed: whether a later call then
   skips confirmation depends on `shouldConfirmExecute` ordering outside these extracts.
2. **An empty projected `additionalPermissions` does not mean no extra sandbox scope
   (upstream behaviour; this fixture's canonical mapping was wrong, now fixed).**
   The projection correctly lists what `execute()` unions. But the Linux sandbox manager's
   `prepareCommand` also merges `policyManager.getCommandPermissions(commandName)` (the
   remembered per-command session and persistent approvals) into the dispatched sandbox,
   alongside the request's `additionalPermissions`. The macOS (116) and Windows (235)
   managers make the same call at the cited lines; their merges were not extracted here.
   The test's canonical mapping treated an empty list as complete resources. It now
   requires a separate synthetic attestation that no remembered sandbox scope applies.
   Nothing in Gemini source or the projection supplies that attestation.
3. **A cancel during `updatePolicy` still commits the remembered rule (residual,
   documented).** The second check sits between `onConfirm` and `updatePolicy`. A cancel
   that arrives while `updatePolicy` is publishing lets the rule commit, and the call then
   stops at the shell's pre-start abort. No check can sit inside `updatePolicy`; staging and
   committing after the last check (question 4) is the alternative.
4. **Cancellation before the request (covered; client residual).** If the turn is cancelled
   before `requestPermission` is sent, the client is still asked. Upstream then confirms,
   updates policy and reaches `execute()`. With the proposal, the answer has no effect.
5. **Unexpected response fields (covered, reduced parser).** The pinned
   `RequestPermissionResponseSchema` (`acpUtils.ts` 37-45) is a non-strict `z.object`, which
   drops unknown keys. With the proposal, extra keys beside an offered `proceed_once`, or an
   `optionId` on a `cancelled` outcome, cannot widen the answer. Zod itself is not run.
6. **Late and duplicate answers.** The existing tests cover late answers after cancel,
   superseding prompt and dispose. A duplicate JSON-RPC response for one request is for
   the ACP SDK's request map to drop; that code is outside these extracts and untested here.
   Static option IDs remain the residual described in question 3.

### Alternatives for findings 1-3 (not chosen here; each needs maintainer review)

- Project each offered option's effect next to the action:
  `_meta.authorization.options[optionId] = { remembers: { toolName, commandPrefix, persist,
  persistScope } | null }`. Build it from the same `getPolicyUpdateOptions` call plus the
  exec fallback, so a client can refuse a prefix it did not mean. This is a new upstream
  contract, not a fix to the current one.
- Offer only `proceed_once`/`cancel` whenever the client asks for exact-command
  authorization. This changes native semantics.
- Keep it on ORCA's side: never select an `allow_always` Gemini option until a reviewed
  qualification states its grant scope and lifetime. The canonical mapping in this test
  already sets `grantScopeAndLifetime` to unknown, so admission selects nothing.
- For finding 2, project `getCommandPermissions(root)` as remembered scope, or report
  `additionalPermissions` as `unknown` whenever the sandbox is enabled.

### Challenge validation

`pnpm exec vitest run tools/test/gemini-authorization-705.test.js`: **39 passed** (30 before
plus 9 new). With the mapping fix withheld, 1 fails: the remembered-scope attestation test.
The other new tests pin pinned-upstream behaviour or proposal coverage and pass on both.
