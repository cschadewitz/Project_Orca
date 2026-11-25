# #705 residual contract proposals — Gemini, Pi, Codex

27 October 2026, base `origin/main` `4d5176c8d57c37f974517900935e6e28ea234082`. **Proposal and
offline counterexamples only.** No upstream contact, provider install, live execution, credential,
activation or merge. The examined strict routes stay as the [#713 packet](README.md) left them:
Gemini projected approval, Pi early-hook/generic-UI and Codex hook/exact-command are **NO-GO**;
nothing here qualifies an installed route. These are findings about routes, not provider-wide
defect or exploit claims.

This addendum takes the residuals the merged [Gemini proposal and #761 challenge](gemini-patch-proposal.md)
and [Pi proposal and challenge](pi-patch-proposal.md) left open, plus the Codex rows of the
[#713 matrix](README.md), and turns each into a small contract a maintainer could accept or reject.
It does not repeat the provider survey or the merged adversarial tests, and it does not change
#594's acceptance scope or take over its native/bridge evidence obligations
([#594 contract](../../archive/implementation/594-command-evidence-v1.md)).

## Evidence and pins

Every quoted line is in [`residual-705/`](../../../tools/test/fixtures/provider-enforcement-704-705/residual-705/README.md)
with revision, line range, whole-file Git blob, excerpt SHA-256 and licence. Sources were read as raw
files at the exact revisions; tags were resolved with `git ls-remote` to their peeled commits.

| Source | Pin | Use here |
| --- | --- | --- |
| Gemini CLI 0.65.0 | `google-gemini/gemini-cli@6006c14a4decfe4b891c6263ad6ad5992e404b5b` (unchanged #713 pin) | policy store, message bus, sandbox approval store: **pinned, run with stubs** |
| Pi 1.4.0 | `earendil-works/pi@4a080252f06caf63a525d7873c5d94d3c23887e0` (unchanged) | merged `bash.ts` post-image plus a new addendum diff: **pinned, run with stubs** |
| Codex 0.164.0 | `openai/codex@6aaac694803004a63c6f393d153c96d22521a6b9` = peeled `rust-v0.164.0` | hooks crate and tool dispatch: **source-reviewed** (Rust, not executed) |
| codex-acp 2.2.2 | `202e66e63343ec4f5a5e35ab590251d813d129ca` (unchanged research pin, `^0.160.1`) | compared with 2.3.0 |
| codex-acp 2.3.0 | `344a520632e4c8c02f781a7a20490dfac52d4d0a` = `v2.3.0`, declares `@openai/codex ^0.164.0` | **drift recorded only**; source-reviewed |

Three labels are kept apart in the text and the test: **pinned** (unmodified upstream text run
with labelled synthetic stubs), **source-reviewed** (read, not run), and **proposed** (an
ORCA-written reference model of a contract no upstream has reviewed). Installed-tested: none.
Observed live effects: none. A stub that records "`updatePolicy` was called" is not a stored
policy; the Gemini section separates those two on purpose.

## Decisions at a glance

| Residual | Options compared | Recommended minimal contract | Honest fallback |
| --- | --- | --- | --- |
| Gemini remembered grant wider than the exact action | once-only / per-option projection / staged commit | ORCA: once-only via native `disableAlwaysAllow` plus #743 checks. Upstream: staged commit, then projection from the staged data | Never select an always option; route unsupported |
| Gemini remembered sandbox permissions | project them / split read-write / disable overrides | Project `getCommandPermissions(root)` with the request; keep read and write apart when persisting | Treat dispatched resources as unknown → indeterminate |
| Gemini cancellation during policy mutation | check-between (merged #743) / staged commit / commit on start | Staged commit: one check, then both stores in one synchronous step | Treat any always answer as committed even if the call is cancelled |
| Pi environment values vs privacy | names / values / plain digest / keyed digest / refuse changes | Per-session keyed HMAC per variable, client-held key; refuse names envp cannot carry | Environment fact unknown → indeterminate |
| Pi effective cwd | resolve vs process cwd / vs session cwd / refuse | Refuse non-absolute or non-normalized cwd at the final check ([addendum diff](../../../tools/test/fixtures/provider-enforcement-704-705/residual-705/pi/pi-bash-cwd-addendum.diff)) | Strict route refuses relative cwd anyway |
| Pi negotiation without coverage | unconditional success (merged) / coverage derived from registry | Reply lists covered tool definitions with an epoch; contradictions refused | No coverage statement → unsupported |
| Codex hook failure and final action | Claude-style ask (rejected) / required fail-closed handler | Required managed PreToolUse handler fails closed; re-run after rewrite; effective exec facts in input | Strict Codex route unsupported |

## Gemini

### What the pinned code actually stores (new evidence)

These run the pinned `updatePolicy` → `handleStandardPolicyUpdate` → `MessageBus.publish` →
`createPolicyUpdater` subscriber and the pinned `SandboxPolicyManager` methods with in-memory stubs.

1. **The in-memory rule is stored synchronously, before `updatePolicy` yields.** `updatePolicy` has
   no await before `publish`; `publish` emits through `EventEmitter.emit`; the subscriber's
   synchronous prefix calls `policyEngine.addRule`. The test schedules an abort as a microtask
   before the call and sees the rule already present when it runs. So the #761 residual "a cancel
   during `updatePolicy` still commits" is, in pinned code, "a cancel after the commit": no check
   placed after entry to `updatePolicy` can stop the session rule.
2. **A stub call is not an effect.** `proceed_once` and `cancel` reach `updatePolicy` (and the merged
   tests log `updatePolicy:<outcome>`), yet store nothing. Only always answers store a rule.
3. **Persistence is queued, not awaited.** For `proceed_always_and_save` the file write runs on the
   updater's own queue after `updatePolicy` has resolved; a failed write (synthetic `EACCES`) only
   emits feedback, and the in-memory grant stays for the session. "Saved" and "effective" are two
   different states with no acknowledgement between them.
4. **An always answer on an edit tool also switches the session to `AUTO_EDIT`**, a remembered
   effect outside the rule store. Outside the shell route; noted so it is not mistaken for covered.
5. **Persisted sandbox approvals lose the read/write split.** `addPersistentApproval` merges read and
   write paths into `allowed_paths`; `getCommandPermissions` returns `allowed_paths` as both. A
   persisted read grant therefore comes back as a write grant. Session approvals keep the split.
6. **Remembered sandbox scope is keyed by the command's base name.** `normalizeCommand` keys
   `/usr/bin/npm`, `npm`, `NPM`, `C:\tools\npm.exe` and `/opt/other/npm` the same, so a grant made
   for one `npm install` applies to every `npm` invocation the sandbox prepares. The Linux (merged
   #761 extract), macOS and Windows managers merge it the same way (macOS/Windows source-reviewed).
7. **The sandbox callback commits on invocation.** The pinned `onConfirm` calls the store
   synchronously, and `saveConfig` uses `writeFileSync`. Under the #743 ordering (callback, then
   check, then `updatePolicy`), a cancel landing in the await gap leaves the sandbox grant stored
   and no policy rule: a **partial commit** across two stores (test counterexample).
8. **A native once-only switch exists.** With `getDisableAlwaysAllow()` the pinned
   `toPermissionOptions` offers only `proceed_once`/`cancel` (run), and the policy engine skips
   always-allow-priority rules at check time (source-reviewed). It does not touch the sandbox store:
   a grant persisted earlier still merges.

Not claimed: that a later call skips confirmation (that depends on `shouldConfirmExecute` and
policy-engine ordering outside these extracts), or that a cancelled shell runs (the pinned
pre-start abort still holds).

### Three contracts compared

**A. Once-only exact authorization.** Offer and accept only `proceed_once`/`cancel` when a client
asks for exact authorization. Upstream already has `disableAlwaysAllow`; combined with #743's
offered-ID membership and cancellation checks it needs no new native code for the policy store.

- *Accept:* no new wire contract; existing setting; easiest to review. *Reject:* more prompts;
  users lose "allow for session"; does not cover the sandbox store or grants persisted earlier.
- *Compatibility:* none for clients; a session setting. *Security:* removes the widening path for
  new grants. *Privacy:* none. *Incentive fit:* weak for general users (friction), strong for
  managed or audited deployments, which is who would set it.
- *Residual:* needs an attestation that no earlier always rule or sandbox approval applies, which
  pinned source does not supply.

**B. Explicit per-option scope projection.** Next to the action projection, state what each offered
option will remember: `_meta.authorization.options[optionId].remembers = { toolName,
commandPrefix | argsPattern, persist, persistScope, sandbox: { read, write, network } } | null`.
It must be computed by the same code that will commit (the test computes it by dry-running the
pinned `updatePolicy` against a capturing bus) and committed from that same object.

- *Accept:* keeps always options; lets any client refuse a prefix it did not mean; helps UI
  honesty ("Allow this command" currently stores `git…`). *Reject:* exposes internal policy shapes
  (`commandPrefix`, regex) as a contract upstream must keep stable.
- *Compatibility:* additive `_meta`; old clients ignore it. *Security:* only as good as
  projection/commit equality, hence it needs C. *Privacy:* paths in sandbox grants go to the client
  that already sees the command. *Incentive fit:* moderate; benefits every ACP client.

**C. Staged policy commit.** Compute the policy message and the sandbox approval as data, run one
final ownership/cancellation check, then apply both in one synchronous step (no await between).
Optionally commit only when the action actually starts.

- *Accept:* fixes the partial commit (item 7 above) for all clients without UI change; small, local to
  `acpSession.ts` plus a "plan" form of `onConfirm`. *Reject:* `onConfirm` is a tool-owned
  callback; splitting it into plan/apply touches every tool's confirmation details.
- *Compatibility:* internal only. *Security:* cancellation means "neither store"; a cancel after
  commit still leaves a grant for an action that never ran unless commit-on-start is chosen.
  *Privacy:* none. *Incentive fit:* good; it removes an inconsistent state upstream would want gone.

Recommendation: for ORCA, A now (setting plus #743 checks) with the sandbox residual stated; for
upstream, C first and B built on C's staged data. For remembered sandbox scope specifically: keep
read and write apart when persisting (a `sandbox.toml` schema change; existing `allowed_paths`
entries keep meaning both), and project `getCommandPermissions(root)` with the request, or report
`additionalPermissions: unknown` whenever overrides are allowed.

**Fallback (unsupported, honest):** ORCA never selects a Gemini `allow_always` option; a projection
without remembered-scope attestation maps to `required-fact:resources` (merged #761 mapping); the
route stays NO-GO.

## Pi

The merged final-action binding (frozen action after `commandPrefix`, context cwd and `spawnHook`;
one decision per frozen object) and the generic-elicitation distinction (select/confirm never
authorize) are preserved; the test re-runs the transformed-action positive control on the addendum.

### Environment values versus privacy

The merged request sends variable names only, so two actions that differ in `PATH` or `BASH_ENV`
values are indistinguishable (#761 residual 1).

| Option | Binds values | Privacy | Cost |
| --- | --- | --- | --- |
| Names only (merged) | no | best | environment fact stays unknown |
| Send values | yes | worst: secrets in transcripts and relays | none |
| Plain SHA-256 per value | yes | poor: low-entropy values fall to a guess list (test) | small |
| **Keyed HMAC per variable** | yes | a relay or log without the key learns names only; digests unlinkable across sessions | client supplies a key at negotiation |
| Refuse any `spawnHook` env change | n/a | best | breaks extensions that set env |

Proposed contract: the client sends a fresh 32-byte `envDigestKey` with
`enable_final_action_authorization`; each `authorize_final_action` carries `env: { names, hmac }`
where `hmac[name] = HMAC-SHA256(key, len‖name ‖ len‖value)`. Names that `envp` cannot carry
unambiguously (`=` or NUL in a name, NUL in a value; `{"A":"B=C"}` and `{"A=B":"C"}` both become
`A=B=C`) are refused in strict mode, never digested. The client holds its expected values, computes
the same digests, and treats an unexpected name as indeterminate and a mismatch as deny.

- *Accept:* no values leave Pi; small; deterministic. *Reject:* key management on the client;
  digests still confirm a client's guess (acceptable: the client is the authority).
- *Compatibility:* new optional fields; the pi-acp adapter must forward and type-check them, and a
  strict client treats their absence as names-only. *Incentive fit:* moderate; useful beyond ORCA
  for any client that pins the environment.
- *Limit:* binds the object passed to `spawn`, not what the shell computes from startup files.

### Absolute effective cwd after transformations

`spawn` resolves a relative cwd against Pi's process cwd, not the session cwd (#761 residual 2).
Resolving against the process cwd freezes a truthful but surprising path; resolving against the
session cwd changes dispatch; normalizing `..` can name a different directory than the kernel
reaches through a symlink. The [addendum diff](../../../tools/test/fixtures/provider-enforcement-704-705/residual-705/pi/pi-bash-cwd-addendum.diff)
(+6 lines, applied strictly after the merged `pi-bash.diff`, post-image blob `0a7d9f9e…`) refuses,
inside `checkedDispatch` only, any cwd that is not absolute and already normal. It runs only when a
final check is bound, so unopted sessions are untouched.

- *Accept:* tiny; no behaviour change outside strict sessions. *Reject:* an extension returning a
  relative cwd now fails in strict sessions instead of running.
- *Security:* removes the process-cwd ambiguity; it still binds a string, not a physical target,
  so `resources` stays the capture owner's fact (test). *Untested:* Windows (`node:path` win32);
  the stub is POSIX.

### A negotiation reply that carries coverage

The merged reply is `{ type: "response", command: "enable_final_action_authorization", success: true }`
whatever bash tool is active (#761 residual 3). Proposed: the reply carries
`data: { contract, coverageEpoch, tools: [{ toolName, definition: builtin|replaced|absent,
executor: local|custom, finalCheck: bound|unbound }] }`, computed from the session's active tool
definitions; Pi bumps the epoch on any rebind (extension reload, `baseToolsOverride`), and every
`authorize_final_action` echoes it; the adapter refuses a mismatch. A client accepts only one
builtin, local, bound bash row; a row claiming `bound` on a custom executor or replaced definition
is a contradiction and is refused rather than believed. A generic select/confirm answer is never
coverage.

- *Accept:* makes "negotiated" mean something; cheap to compute. *Reject:* commits Pi to a
  registry vocabulary. *Compatibility:* additive `data`; an old client ignores it, an old Pi gives
  no coverage and stays unsupported. *Incentive fit:* aligned with Pi's own extension model.

## Codex

### Pinned contracts re-verified

- `codex-rs/hooks/src/events/pre_tool_use.rs` at 0.164.0 is still blob `7613c15b…`, the #713 pin.
- **Drift:** codex-acp **2.3.0** (`344a5206…`) declares `@openai/codex ^0.164.0`, so the hook
  candidate now has a declared bridge pair. [`source-pins.json`](source-pins.json) is unchanged;
  a declared range is not an installed selection or a qualification.
- 2.2.2 → 2.3.0 on the approval path (source-reviewed): `CommandUtils.ts` blob `08774387…` and
  `command-decision-contract.ts` blob `302ba4cc…` are identical; `CommandReporter.permission` still
  applies `stripShellPrefix`; native approval dispatch still passes parsed params only (no JSON-RPC
  request id); profile options still mark turn grants `allow_once`. One fail-closed improvement:
  any non-`selected` ACP outcome now maps to no decision (`cancel`). New: `_codex/hooks/list` and
  `_codex/hooks/trust` (AIR extension) list and trust **session-flag hooks only**, re-checking the
  hash before writing `hooks.state.<key>.trusted_hash`. #594's evidence gaps are unchanged.

### Final action, cwd and scope (0.164.0, source-reviewed)

- `exec_command`'s PreToolUse input is `{ "command": args.cmd }` only. `workdir`, `shell`, `login`,
  `environment_id`, `sandbox_permissions`, `additional_permissions` and `prefix_rule` are not in it,
  and the hook's `cwd` is the environment/turn cwd, not the call's `workdir`. Two calls differing
  only in `workdir` or escalation present identical hook input.
- `write_stdin` emits no PreToolUse (documented in source).
- A rewrite (`updatedInput`) is applied after all hooks complete, latest completion wins, and the
  hooks are not re-run on the rewritten input.

### Supported failure semantics (0.164.0, source-reviewed)

- Failed run, non-zero exit, timeout, invalid JSON, `ask`, exit 2 without a reason, and bare `allow`
  (without `updatedInput`, an upstream test calls it fail-open) all continue. PreToolUse has no
  positive allow; it is deny-or-rewrite.
- Non-managed hooks must have a trusted hash; untrusted or modified ones are listed but never
  become handlers. Managed hooks bypass trust and user disablement.
- Required managed hooks that fail to **load** reject `Hooks::new`, so the session does not start:
  an existing fail-closed seam. `reconfigured` does not re-check it, and disabling hooks clears the
  required load errors (what sets that switch was not traced).

### Smallest unresolved changes

Native (Codex), none of them on #594's approval-evidence path:

1. **Required PreToolUse fails closed.** For a required managed handler, every outcome except a
   clean run or a block blocks: timeout, crash, invalid output, `ask`, bare `allow`, exit 2 without
   reason, not admitted. `ask` blocks; it does not pause for a person (Claude's ask semantics do
   not apply). *Accept:* extends the existing load-time "required" concept to run time.
   *Reject:* a flaky hook now stops tools. *Fallback:* none in-provider; route unsupported.
2. **Final input.** If any handler rewrites, required handlers run again on the final input (one
   round), or rewrites are refused while required handlers are present.
3. **Effective exec facts in hook input.** Resolved absolute `workdir` after environment selection,
   `shell`, `login`, environment id, sandbox and additional permission requests, `prefix_rule`.
   *Privacy:* paths go to a local hook already trusted with the command. *Compatibility:* additive.
4. **Reload cannot drop a required handler.** `reconfigured` re-checks required load errors and
   refuses the reload; disabling hooks does not remove required managed handlers.
5. **Coverage visible to the client.** Hook listing reports the required flag and known exclusions
   (`write_stdin`, hosted/specialized tools). Bridge side, the only change proposed here: let
   `_codex/hooks/list` pass managed/required entries through read-only (2.3.0 filters to session
   flags).

#594 keeps native approval evidence capture, request-id/callback binding, shell-prefix loss and
profile-grant semantics; nothing above duplicates or replaces them. *Incentive fit:* 1, 2 and 4
match Codex's own managed-hook direction; 3 and 5 are additive.

**Fallback:** without 1–4 the strict Codex hook route stays NO-GO; ORCA does not read "no block"
as authorization and does not fall through to the native approval or a remembered grant.

## Offline regressions

[`tools/test/residual-contracts-705.test.js`](../../../tools/test/residual-contracts-705.test.js),
42 tests. It checks every excerpt's bytes, SHA-256, line count and revision; that shared files'
blobs agree with the #713 and #761 records; and that the Pi chain (pinned → merged proposal →
addendum) applies strictly to the expected blobs.

| Area | Kind | What it shows |
| --- | --- | --- |
| Gemini stub call vs stored effect (6) | pinned | once/cancel store nothing; always stores synchronously before yield; save queued, failure leaves the grant; edit always switches mode |
| Gemini sandbox store (4) | pinned / source-reviewed | read becomes write when persisted; base-name keying; synchronous commit; three platform merges |
| Gemini contracts (4) | pinned + proposed | #743-order partial commit; staged commit both-or-neither and equal to the real message; projection by dry run; `disableAlwaysAllow` offers once/reject but leaves sandbox grants |
| Pi cwd (6) | pinned + addendum | relative, `..`, `.`, empty refused before check and spawn; transformed-action binding intact; physical target still unknown |
| Pi environment (4) | proposed | names-only collision; unkeyed digest guessable, keyed not, unlinkable; envp-ambiguous names refused; canonical fact complete only with a verdict |
| Pi negotiation (9) | proposed + merged diff text | merged reply has no coverage; registry-derived rows; asserted contradictions refused; elicitation never coverage; epoch mismatch refused |
| Codex (7) | source-reviewed + proposed | hook input/cwd/stdin gaps; fail-open outcomes; load-only required check; 2.3.0 gaps; fail-closed table; rerun after rewrite; effective facts distinguish actions |
| Provenance (2) | — | pins, drift recorded but not adopted |

Five mutation probes, each weakening one proposed safeguard (withholding the cwd addendum, dropping
the envp-name refusal, the contradiction rule, the staged-commit check, or the HMAC key), each
turned 1–4 tests red and were reverted.

```sh
pnpm exec vitest run tools/test/residual-contracts-705.test.js --maxWorkers=1
```

## Decision points

1. Gemini: is ORCA's strict route allowed to require `disableAlwaysAllow` on the managed session,
   and who attests that no earlier always rule or sandbox approval applies?
2. Gemini: should staged commit commit at confirmation or only when the action starts?
3. Gemini: is a `sandbox.toml` schema change (separate read and write) acceptable upstream?
4. Pi: is a client-held HMAC key the right privacy line, or should strict mode refuse any
   environment change instead?
5. Pi: refuse a relative `spawnHook` cwd (proposed) or resolve it against the session cwd?
6. Pi: is the negotiation epoch per session or per tool registry change, and who bumps it?
7. Codex: is "required managed PreToolUse fails closed" a setting upstream wants, and is a single
   re-run after rewrite acceptable latency?
8. Codex: does codex-acp 2.3.0 + 0.164.0 become the next research pair, replacing 2.2.2 + 0.160.1?
   Not decided here; `source-pins.json` is unchanged.

## Limitations and untested stages

Not run: full suite, coverage, build, Gemini/Pi/Codex upstream test suites, any Rust, any installed
provider or adapter, shells, hooks, sandboxes, ACP clients, app smoke. Gemini stubs reduce the
policy engine, message validator, file system, TOML and path keying; Pi stubs replace every
`bash.ts` import with recorders and POSIX `node:path`; Codex outcomes are restatements of pinned
text. Reference models are ORCA's, not upstream behaviour, and are not adapters. Installed
qualification for #705, #704's cached/revocation proof and #594's owner obligations remain open.
