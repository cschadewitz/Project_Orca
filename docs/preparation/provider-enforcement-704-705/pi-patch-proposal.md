# #705 Pi slice — final-action binding and typed authorization proposal

26 October 2026. Base `46ce182308e8d5b59c4fdbabd49232b4cf4cdbdc` (the handoff
main, equal to `origin/main` when this branch was cut). **Proposal and offline
regressions only.** Nothing is submitted upstream, installed, launched, negotiated
or activated. The examined Pi route — the early `tool_call` hook plus generic ACP
select/confirm — stays **NO-GO** until this proposal is separately reviewed and
qualified. That is a finding about one route, not a rejection of Pi.

This consumes the merged [#713 packet](README.md), its [source record](source-pins.json)
and [validation](validation.md), the #724 canonical reconciliation and the
[canonical admission fixtures](../../../packages/agents/test/provider-qualification-704-705.test.ts).
It does not repeat the provider survey or change any #713 classification, manifest,
excerpt, canonical contract or runtime adapter.

## Pins verified

Native Pi **1.4.0** `earendil-works/pi@4a080252f06caf63a525d7873c5d94d3c23887e0`
and community **svkozak/pi-acp 0.0.34** `@b0581c9c1d675e634234674484247008b03d69b4`
were reread at those exact revisions. Both manifests carry those versions. Every
Git blob the #713 record names for Pi (`bash.ts` `4620e246…`, `runner.ts`
`77712e67…`, `agent-session.ts` `3a9174cf…`, pi-acp `session.ts` `1c97b24f…`)
matched, and all five existing Pi excerpts matched their recorded line ranges
byte for byte. Newly read at the same pins: `modes/rpc/rpc-mode.ts` `1c0995d3…`,
`extensions/types.ts` `60388c0e…`, `utils/shell.ts`, and pi-acp
`src/pi-rpc/process.ts` `160cc90e…`. Which Pi an external pi-acp launch selects
is still **unknown**; no safeguard from another fork is attributed to this tuple.

## What the pinned source does

Line numbers are at the Pi pin unless marked pi-acp.

1. `tool_call` runs in `_beforeToolCall` (agent-session.ts 658–685) on one mutable
   `event.input`; `ToolCallEventResult` documents that handlers modify arguments
   by mutating it (types.ts 1454–1462). A block or a throw stops the call.
2. The bash tool then builds a *different* action inside `execute`
   (bash.ts 268–275): `commandPrefix` is prepended, the cwd becomes `ctx?.cwd ||
   cwd` (`ctx.cwd` is a live getter, runner.ts 901–904), and `spawnHook` may
   return any command, cwd and environment.
3. Dispatch is `ops.exec(spawnContext.command, spawnContext.cwd, { env })`
   (bash.ts 364–369). It re-reads the spawn context object after an `onUpdate`
   callback, so a holder of that object can still change it.
4. `ops` is `options.operations` or Pi's local shell (bash.ts 248). The local
   executor resolves the shell inside `exec` (bash.ts 104), checks abort once
   (101–103), then awaits a working-directory check (105–109) before `spawn`
   (112). An abort during that await still starts the shell and kills it after.
5. RPC mode already has a one-shot dialog channel (rpc-mode.ts 79–131, 766–780):
   random UUID per request, entry deleted on the first response, on abort and on
   timeout; unknown ids are ignored; abort and timeout resolve to the dialog's
   default. Unknown RPC commands return `success: false` (713–716).
6. pi-acp maps that channel's `select` to ACP options that are all `allow_once`,
   named by arbitrary text, on a synthetic `pi-ui-<id>` tool call of kind `other`,
   and answers with the selected *text*; `confirm` answers a boolean for option
   `yes` (pi-acp session.ts 957–1029). It does not recheck cancellation after the
   permission await.

So an early check sees an input that is not what runs, and the only interactive
path back is generic UI whose answer is a label.

## Proposed change

Five small diffs in [`pi-proposal/proposed`](../../../tools/test/fixtures/provider-enforcement-704-705/pi-proposal/proposed),
each against the pinned blob named in its `index` line. About 250 added lines in all.

### A. Native final check — `pi-bash.diff`, `pi-agent-session.diff`

- `BashToolOptions.finalCheck?: () => BashFinalCheck | undefined`, resolved per
  call. Unbound, `execute` takes the original code path with no added await.
- Bound, immediately before `exec` and after every transformation, Pi freezes a
  `BashFinalAction`: the original `toolCallId`, tool name, executor (`local` only
  for Pi's own local shell, otherwise `custom`), the shell config resolved once
  for this call, final command, cwd, a frozen environment copy, timeout and the
  list of transformations that applied (`commandPrefix`, `contextCwd`,
  `spawnHook`).
- The check returns `{ outcome: "allow", action }` naming **that frozen object**,
  or anything else. Anything else — block, a copy, another call's action, a
  throw — becomes a thrown tool error, exactly how a `tool_call` block or failure
  already surfaces. After the await, abort is rechecked.
- Dispatch reads only the frozen action, and the local executor runs with the
  shell it was checked with. The local executor also rechecks abort after its
  working-directory await (one added `if`).
- `AgentSession` gains a `finalActionCheck` binding slot beside `uiContext`,
  passed to the built-in bash tool. Only the run mode binds it.

### B. Typed transport — `pi-rpc-mode.diff`

- Off by default. A client opts in with `enable_final_action_authorization`; the
  success reply is the negotiation evidence. An older Pi answers "Unknown
  command", so a strict client sees no negotiation and stays unsupported.
- When on, the final check sends `extension_ui_request` with method
  `authorize_final_action` over the pinned one-shot channel: tool call id, final
  command and cwd, executor and shell, timeout, transformations, environment
  *names* only, and exactly two options, `final-allow-once` (`allow_once`,
  effect `this-invocation`) and `final-reject-once`.
- The response allows only `{ authorization: { toolCallId: <this call>,
  optionId: "final-allow-once" } }` without `cancelled`. A `value`, a
  `confirmed`, the offered reject, another call's id or an unknown option blocks.
  The channel's existing rules make replayed, unknown, late and post-abort
  responses inert. An older pi-acp cancels the unknown method, which blocks.

### C. Adapter — `pi-acp-session.diff`, `pi-acp-process.diff`

- A separate handler for `authorize_final_action`; generic select/confirm stay
  as they are and are never consulted.
- Before asking: refuse (answer `cancelled`) unless the request is fully typed,
  offers exactly Pi's two options with the stated effect, uses Pi's own tool
  call id that pi-acp is tracking as open (never `pi-ui-*`), and the turn is
  live and not cancelled. "Fully typed" covers every forwarded field; the merged
  version checked only some of them (see the challenge review below).
- The ACP request uses that original tool call id, kind `execute`, the final
  command/cwd in `rawInput` and fixed option ids.
- After the await: the same turn, not cancelled, tool call still open, and the
  selected id is one of the offered ids. Only then is the typed answer sent;
  anything else is `cancelled`. `process.ts` adds the response variant and an
  `enableFinalActionAuthorization()` request.

### Canonical mapping (no new vocabulary)

| Proposal field | #700/#716 vocabulary |
| --- | --- |
| `toolCallId`, frozen action identity | `InvocationV1.invocationId`, `ActionEvidenceV1.bindingRef`; one decision per frozen action |
| final command / cwd, `transformations` | `dispatch`, `effectiveCwd`, `transformations`; required unknown facts stay indeterminate |
| `executor`, `shell` | `executableAndInterpreter`; `custom` leaves `coverageAndState` unavailable |
| negotiation reply, protected binding | `CoverageV1.negotiatedHook`, `protectedConfiguration` |
| offered option and its effect | `NativeChoiceV1` with `effect`/`grantScopeAndLifetime` from a reviewed qualification of the adapter revision, never from wire `kind` or text; `selectStrictPermissionOption` |
| cancellation, open-call and turn rechecks | capture owner's `StrictPermissionState.coverageAndState` precondition |

No support flag, production default, permit or policy is added. Even if every
diff landed, `verified-per-execution` would still need installed evidence and
independently observed effects.

## What a command check does not cover

A check of the final command string authorizes that string at that cwd through
that executor. It does **not** confine what the shell then does: descendants,
background and detached children, network and remote effects, files the command
reaches, interpreters it starts, or `PATH`/environment-driven resolution inside
the shell. OS sandbox, network, filesystem and credential ceilings stay
necessary. Also outside this proposal and unsupported:

- `custom` operations (SSH or any `options.operations`) — named, not qualified;
- extension-registered tools that replace `bash`, `baseToolsOverride`, and other
  built-in tools (read/edit/write/grep/find/ls, PowerShell);
- nested calls (`<parent>/<n>` ids are never announced as tool calls, so the
  adapter refuses them) and codemode scripts;
- the user `!` path (`executeBash`, `user_bash` operations) and RPC `bash`;
- interactive stdin, subagents, MCP and client filesystem routes;
- launcher/binary correspondence, RPC stream integrity, and agent-writable
  configuration, extensions or checker files.

## Regressions

[`tools/test/pi-final-authorization-705.test.js`](../../../tools/test/pi-final-authorization-705.test.js)
with [fixtures](../../../tools/test/fixtures/provider-enforcement-704-705/pi-proposal/README.md).
The test recomputes byte length, SHA-256 and Git blob of each vendored upstream
file, cross-checks them with the #713 record, strictly applies each executable
diff (every context and removed line must match) and checks the post-image blob.
It then imports the whole pinned `bash.ts` — and the patched one — with every
import replaced by an in-memory stub whose `spawn` only records. The pinned RPC
channel and pi-acp handlers run on synthetic connections.

| Required case | Covered by |
| --- | --- |
| prefix / context cwd / spawnHook | pinned witness of the changed dispatch; patched check receives and dispatches the final values |
| mutation after checking | pinned dispatch re-reads a mutated spawn context; patched dispatch ignores mutation during the check; a checker writing the frozen action fails closed |
| unsupported custom operations | executor named `custom`, canonical admission indeterminate, executor never called |
| distinct invocations, identical input | a decision for call A cannot release call B; RPC id/tool-call binding |
| arbitrary select text | pinned pi-acp maps label text to `allow_once` on `pi-ui-*`; canonical selection is empty; the typed parser rejects it |
| recognized-but-unoffered options | `yes`, `choice-0`, `allow_always`, `final-allow-always`, empty id, offered reject |
| cancellation during await | abort during the check, during the local cwd await (pinned starts the shell, patched does not), custom executor; adapter cancel, turn change, call closed, client failure |
| late / replayed responses | replay, unknown id, response after abort, cross-call id |
| checker failure | throw, no decision, copy, block, unknown outcome; client-side failure in the chain |
| bounded synthetic positive control | patched bash → RPC → pi-acp → canonical reduced model → dispatch to the recording stub; a spawnHook cwd change in the same chain is not matched |

The canonical step is an ORCA test-side reduced model over the existing
`actionFixture`/`stateFixture`: option effects come from a synthetic table keyed by
option id, labelled unreviewed. It certifies nothing about a real provider.

Evidence levels: `bash.ts` pinned and patched — **source-function-tested** with
stubs; RPC channel/parser and pi-acp handlers — **source-function-tested** for the
extracted functions; `agent-session.ts` and `process.ts` diffs — apply to the
pinned blobs, **source-reviewed** only. Installed-tested: none. Live effects:
none. Patched files parse with Node's TypeScript stripper; none was type-checked
against Pi or pi-acp dependencies.

Fifteen mutation probes, each weakening one safeguard in a diff (dispatching the
spawn context, dropping the identity check, either abort recheck, re-resolving the
shell, dropping the tool-call or cancel check in the parser, accepting any offered
option, sending environment values, dropping the adapter's post-await recheck,
membership, open-call or `pi-ui-*` guard or effect check, defaulting negotiation
on), each turned at least one test red, then were reverted.

## Validation

Node 22.22.0 (the repository asks for ≥24; only 22 was available), pnpm 12.4.2,
Vitest 5.0.5. Setup `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
--frozen-lockfile`; no lockfile or dependency change.

```sh
pnpm exec vitest run tools/test/pi-final-authorization-705.test.js --maxWorkers=1
pnpm exec vitest run \
  tools/test/pi-final-authorization-705.test.js \
  tools/test/provider-enforcement-source-704-705.test.js \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/provider-qualification-704-705.test.ts \
  packages/agents/test/command-evidence-v1-594.test.ts \
  packages/agents/test/strict-permission.test.ts \
  packages/agents/test/permissions.test.ts --maxWorkers=2
pnpm exec eslint tools/test/pi-final-authorization-705.test.js
pnpm exec prettier --check tools/test/pi-final-authorization-705.test.js \
  tools/test/fixtures/provider-enforcement-704-705/pi-proposal/manifest.json
pnpm run typecheck
pnpm run lint
git diff --check origin/main
```

Results are in the draft PR description. Not run: full suite, coverage, build,
Node 24 lane, upstream Pi/pi-acp test suites or typecheck, any installed or live
provider, network judge, hooks or app smoke.

## Review questions

1. Is a per-call resolver on `BashToolOptions` plus an `ExtensionBindings` slot
   acceptable upstream, or should the check live in agent-core's tool loop so
   every built-in tool gets it? This proposal covers bash only.
2. Can any extension reach `AgentSession.bindExtensions` or rebind the run mode?
   The slot is only protected if not.
3. Should `enable_final_action_authorization` be refused once a turn has started,
   and be one-way? As written it is one-way and accepted at any time.
4. Is the channel's no-timeout default acceptable, with deadlines owned by the
   client, or should Pi impose one?
5. Does pi-acp always announce a tool call (`currentToolCalls`) before Pi's
   `execute` reaches the final check? If not, the adapter fails closed and the
   ordering needs a protocol guarantee.
6. Who calls `enableFinalActionAuthorization()` and how is the result exposed to
   the ACP client as negotiation evidence (`_meta` on session creation)?
7. Is sending environment names, not values, the right privacy line, given that
   strict admission then lacks complete environment facts?
8. Should `custom` executors be refused by Pi in strict mode rather than named and
   left to the checker?

## Not done

No upstream issue, PR or contact; no Pi, pi-acp or provider launch; no hooks,
settings, credentials or access changes; no new dependency or lockfile edit; no
production support flag, default or activation. #704's cached/revocation proof,
#705's installed qualification and #594's separate obligations remain open.

## Challenge review (follow-up on #747)

26 October 2026, on `origin/main` `890eb71847e4c38533ab8f5b2d35f14076b8f923`. Nothing here
changed between #747 and that head. The vendored upstream files, licences and every #713
record are unchanged. `runner.ts` (`77712e67…`), `agent-session.ts` (`3a9174cf…`) and
`utils/shell.ts` (`fbe81f96…`) were reread at the Pi pin with `git hash-object` checked.
**The route stays NO-GO.**

### Fixed in this proposal: the adapter now checks every field it forwards

Section C says the adapter refuses unless the request is "fully typed". The merged
`finalActionPermissionRequest` checked only the tool call id, command, cwd, executor and
options. It forwarded `shell`, `envKeys`, `timeout` and `transformations` unchecked, and still
asked the client when they were missing (`null`), the wrong type, or contradicted the
executor. Twelve requests the adapter should have refused were put to the client: missing or
non-string `envKeys`; missing or unknown `transformations`; a string shell; a `local`
executor with no shell; a `custom` executor naming a shell; non-string shell `args`; an
unknown `commandTransport`; an extra shell key; a non-numeric `timeout`; a non-string
`toolName`.

`pi-acp-session.diff` now refuses all of these. A `local` executor must carry exactly Pi's
`ShellConfig` shape (`shell`, string `args`, optional `argv`/`stdin` transport; utils/shell.ts
6-10) and a `custom` one must carry `null`. `envKeys` must be strings. `transformations` must
come from Pi's three. `timeout` must be a finite number or `null`. `toolName` must be a
string. The forwarded `rawInput` is built from those checked values. The pre-image, every
other hunk and the other four diffs are unchanged; the manifest records the new digest and
post-image blob `a4d331f3…`. Every shape Pi's own `finalActionRequest` produces is still
asked (a positive test). Six mutation probes, each removing one new guard, each turned a test
red and were reverted.

### Residuals pinned by tests (not fixed; new contract or native change needed)

1. **Environment values are not authorized.** Pi sends names only (question 7). Two final
   actions differing only in the value of `PATH` or `BASH_ENV` produce identical RPC and ACP
   requests, so no answer can bind the values. Alternatives: send values, with the privacy
   cost; send a per-key digest the client can match against a policy it holds; or have strict
   mode refuse any spawnHook environment change.
2. **A relative cwd is checked and dispatched as the same unresolved string.** A spawnHook
   may return `relative/dir`. Check, adapter and `spawn` all see that string, and `spawn`
   resolves it against Pi's process cwd, not the session cwd. Alternatives: resolve against
   the session cwd before freezing (changes native dispatch), or refuse a non-absolute cwd in
   strict mode.
3. **Negotiation success is unconditional.** `enable_final_action_authorization` replies
   `success: true` whatever bash tool is active. With `baseToolsOverride`
   (agent-session.ts 3674-3683) or an extension tool replacing `bash`, the proposed
   `finalCheck` is not wired, yet the reply is the same (source-reviewed). Until the reply
   names the covered tool definitions, a client must not treat it as coverage.

Re-checked and holding in the offline scope: binding after `commandPrefix`, context cwd and
`spawnHook`; mutation of the retained spawn context during the check; concurrent identical
calls (bound by tool call id and frozen object identity); cancellation during the check and
during the local cwd await; late, replayed and cross-call replies; generic select/confirm
never producing a typed authorization; and `custom` executors staying unqualified.
`ctx.cwd` is a getter for a value fixed at runner construction (runner.ts 412, 901-904).
Reading it a second time for the `contextCwd` label does not change the cwd. After a reload
the getter's `assertActive()` throws, which fails closed.

### Challenge validation

`pnpm exec vitest run tools/test/pi-final-authorization-705.test.js`: **67 passed** (51
before plus 16 new). With the adapter diff and manifest restored to their #747 bytes,
**12 fail**: exactly the twelve refusal cases. The positive control and the three residual
tests pass on both.
