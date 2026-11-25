# M10 live exact-command evidence disposition

Reviewed 9 October 2026 against ORCA
`121c859e636bc304016928fe85b0982d41788b4e` (#589), preserving #584's
`6fcd543a368246c2156f86a225072a871c754435` ancestry. This is a fresh,
source/synthetic disposition for [#327](https://github.com/cschadewitz/Project_Orca/issues/327)
and [#237](https://github.com/cschadewitz/Project_Orca/issues/237), reusing
[#506](https://github.com/cschadewitz/Project_Orca/issues/506)'s completed preparation.

**Positive installed-provider / actual-Cal exact-command approval remains blocked.**
The reviewed released contracts cannot supply trustworthy exact command, scope and
native callback correspondence to ORCA's bounded operator surface. An ORCA-only
projection change cannot recover evidence erased upstream. No production code,
protocol, permission policy, redaction or authority check changes in this task;
this document and the linked handoff are the deliverables. M10 is not certified
complete and no issue acceptance criteria are changed.

## Exact supported-source boundary

The recorded profile is Codex 0.159.1 / codex-acp 2.1.1. Reviewed sources remain
native `8e68a98ef03cdde76d2e6800791ebdf1b3b95b24` and bridge
`68d7d2d5ddfc0ed5746f9f6130892dda685e65dd`; see the
[provenance map](../preparation/acp-command-conformance/source-map.md).
The installed executables, selected dependency, artifact hashes and effective
managed routing were not inspected. These conclusions apply to the pinned
contracts; version labels do not prove that the running installation matches.

| Boundary | Reviewed evidence | Consequence |
| --- | --- | --- |
| Native regular command approval | [Native emission](https://github.com/openai/codex/blob/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/app-server/src/bespoke_event_handling.rs#L667) emits a shell-quoted command-vector representation and cwd. The managed-network branch can omit command/cwd. | An eligible native branch has more evidence than ORCA receives. This is not structured argv/environment or proof of effects, nor a claim that every execution emits an ask. |
| Native request identity | [Native parameters](https://github.com/openai/codex/blob/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1476) distinguish thread, turn, item, callback approval ID, action kind and environment. Additional permissions can be stripped as experimental fields. | Item ID alone cannot distinguish all subcommand/stdin callbacks or establish complete requested permissions. Absence of optional permissions is not proof that no broader scope exists. |
| Bridge approval input | [CommandReporter.permission](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/tool-calls/reporters/CommandReporter.ts#L88) applies [stripShellPrefix](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CommandUtils.ts). It forwards selected input fields and uses item ID for the tool call. | Original shell, flags, native turn/callback/kind/environment and complete network context are not retained in this approval tool call. A plain command that happens to survive formatting does not prove native correspondence. |
| AIR / standard presentation | [Permission rendering](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/tool-calls/AcpToolCallRenderer.ts#L51) renders those same facts. [AIR permission metadata](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/permissions/metadata.ts#L17) adds presentation title/reason. | Neither supplies a lossless native approval envelope. Earlier tool-start input, parsed actions, terminal metadata and history are observations, not an authenticated binding to the pending callback. |
| Permission decision scope | [Bridge options](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/permissions/options.ts#L14) distinguish command decisions and permission-profile choices. [Response mapping](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/permissions/CodexApprovalHandler.ts#L130) maps profile `allow_once` choices to turn grants, including strict auto-review. | Remembered-option filtering does not narrow a turn grant to one command. Profile choice labels/IDs can warn a reviewer but cannot establish exact-command evidence. Strict auto-review remains a turn grant. |
| ACP → ORCA | [ACP session](../../packages/agents/src/acp-session.ts) mints an invocation within its active turn; [orchestrator](../../packages/engine/src/orchestrator.ts) stores the tool call and filters live choices by ACP kind. | ORCA's exact seven-field lifetime binding is supported. It does not reconstruct the native request, preserve request-level presentation metadata in context, or validate a provider-supplied command scope. |
| Protected events → operator | [Protected events](../../packages/store/src/protected-event-store.ts) retain sensitive originals privately; [input projection](../../packages/daemon/src/operator-read-model.ts) omits context. [Closed row schema](../../packages/protocol/src/operator-reads.ts) has no command-evidence contract. | The operator receives identity/state/question/options, not complete reviewable command/cwd/scope. Exporting context or adding arbitrary `rawInput` fields would weaken the existing privacy boundary. |

The loss is demonstrably irreversible. The pinned pure helper maps four distinct
synthetic strings to the same display string: a direct `printf orca-506`, and that
text wrapped by `/bin/bash -c`, `/bin/bash -lc`, or `/bin/zsh -c`. Shell startup
and interpreter semantics differ. These strings were only data; none was executed.
A prefix reconstruction, shell parser, title comparison or hash of the remaining
string cannot recover the omitted distinction.

## Concrete product decision needed

The owner must choose one of these outcomes before another positive case is planned:

1. **Keep this profile unsupported for exact-command operator acceptance.** Retain
   the disabled positive handoff and record the blocked M10 row. Existing durable
   gates and generic live callback delivery remain separate supported contracts;
   their passing evidence does not satisfy this row.
2. **Commission a supported, versioned provider evidence contract plus its ORCA
   privacy projection.** Agree which installed bridge/native pair supplies it and
   which authorized principal may privately review the allowed fields. This
   requires provider work; this PR neither replaces nor patches an installed
   adapter. A newer version label alone is insufficient.

For the second outcome, the minimum reviewable proposal must preserve the original
native command representation, cwd, request method/action kind, environment
identity, native thread/turn/item/distinct callback identity and authoritative
offered-decision mapping. It must distinguish a command decision from network,
stdin, subcommand, profile, turn/session and policy-amendment requests, and make
missing or experimentally omitted scope evidence explicit. The bridge must bind
those facts to the actual pending callback; arbitrary ACP `rawInput` or `_meta`
claims are not trusted merely because they have the right field names.

ORCA then needs a narrowly allowlisted, source-validated private review projection
and an answer-time check binding that review to the unchanged original live
invocation. Retain existing credential/current-authority checks, run scope,
original lease, one delivery, expiry and distinct standing-grant authority. Preserve
the current 12 KiB row and 256 KiB result bounds (including transport budgeting).
If exact decision-relevant fields cannot fit or cannot be safely disclosed, return
an explicit unavailable/incomplete state and refuse positive exact-command
selection. Redacted, truncated or oversized content cannot count as exact.
Do not expose full context, credentials, environment values or private payload
digests, or claim that a regular expression makes arbitrary shell text non-secret.

This is a required design decision, not an implemented or approved extension.
There is no supported capability switch in the pinned profile that resolves these
requirements. Changing sandbox, reviewer, AIR mode or native permissions is not a
repair. Rejecting every generic ACP `allow_once` would unnecessarily change other
supported callbacks without supplying the absent evidence.

## Focused validation and review

At the requested base, Node 24.19.0 ran the unchanged #506 fixture directly:

```sh
node node_modules/vitest/vitest.mjs run \
  packages/agents/test/acp-command-conformance-506.test.ts --maxWorkers=1
```

**31 passed, zero skipped.** This reuses production ACP framing, the original
orchestrator/lease/live registry, bounded operator reads and the answer alias with
in-memory stores/authority. Effects remain cooperative memory counters. These
tests explicitly demonstrate that the current generic seam can accept a synthetic
allow choice despite omitted command evidence; they are not a production
fail-closed exact-command verifier or installed-provider acceptance.

An isolated evaluation of the exact 300-byte public `CommandUtils.ts` at the bridge
pin verified four colliding command strings and one unstripped control. The source
SHA256 was `ca8042763f4bb36a2cbf9641beb647fed95338a4f4f827ddecaeb143b2628890`.
Only that pure helper was evaluated; no adapter, native executable, model or
command runner was started. This is synthetic source evidence, not native delivery.

To reproduce that check, retrieve only the public helper at the exact bridge pin
into a disposable directory and verify the length/digest above before importing
it. On Node 24, this isolated module check uses the retrieved TypeScript file;
the synthetic command strings are never passed to a shell or provider:

```js
import assert from "node:assert/strict";
import { stripShellPrefix } from "./CommandUtils.ts";
const cases = [
  "printf orca-506",
  "/bin/bash -c 'printf orca-506'",
  "/bin/bash -lc 'printf orca-506'",
  "/bin/zsh -c 'printf orca-506'",
];
assert.equal(new Set(cases).size, 4);
assert.equal(new Set(cases.map(stripShellPrefix)).size, 1);
assert.equal(stripShellPrefix(cases[1]), cases[0]);
const control = "/usr/bin/bash -c 'printf orca-506'";
assert.equal(stripShellPrefix(control), control);
```

The first `pnpm test` attempt triggered automatic dependency synchronization and
failed creating the unavailable pnpm home directory before tests. Direct invocation
used existing dependencies; no install completed and no tracked dependency or
lockfile changed. Safe-evidence schema/example and all 24 illustrative regression
samples, document links and whitespace/UTF-8/LF/fences were checked. No broad suite,
build, platform test, live provider, paid execution, approval, access change,
agent-01 mutation, CI dispatch, merge or main publication was performed.

Self-review found no safe ORCA-only path to recover exact evidence, and no newly
implemented runtime behavior to certify. It checked the native/bridge/source
distinction, non-injective transform, AIR and history alternatives, turn-grant
semantics, protected storage, projection bounds, authority/lifetime preservation
and source/synthetic separation. This is self-review, not independent security
acceptance. The exact prose commit and draft PR are recorded in the delivery report.

## Safe remaining live-test handoff

The [existing disabled handoff](../preparation/acp-command-conformance/live-test-handoff.md)
remains the sole positive-case plan. Before requesting that case, resolve the
product decision above, verify installed executable/artifact correspondence
privately, and verify that the supported evidence reaches the exact pending
operator decision unchanged and safely bounded. Then obtain scoped authorization
for the actual command including its shell wrapper, cwd, permitted effect, target,
profile, lifetime and budget. Submission, a fixture marker sentence, previous
approval or this draft is not that authorization.

If any correspondence, requested scope, routing, safe field or one-command native
choice is missing, stop and record blocked/unsupported/unknown without a positive
response. Preserve managed denials. Do not use alternate RPC/shell access, payload
exports or policy changes to force an ask. Report native request, ACP request,
operator selection, callback delivery and independently observed effect separately
using [safe evidence v1](../preparation/acp-command-conformance/evidence-format.md).
Disruptive negative cases still require their own separately scoped authorization.
