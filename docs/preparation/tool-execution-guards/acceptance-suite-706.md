# #706 enforcement acceptance suite

Owner: #706, under #699. This page covers the suite's synthetic half, the support-matrix
tiers, and the connected proof, which runs these same cases through a live Claude Code and
judges each call by what it did, not by what ORCA said.

| File | What it is |
| --- | --- |
| [cases.json](../../../tools/guard-qualification/cases.json) | The case catalogue: id, category, the [acceptance.md](acceptance.md) contract rows it exercises, the #706 scope bullet, and the capabilities a path needs to run it |
| [scenarios.js](../../../tools/guard-qualification/scenarios.js) | One function per case, written in provider-neutral actions (a shell command, a write, an MCP call, …) |
| [world.js](../../../tools/guard-qualification/world.js) | A throwaway config directory and workspace laid out like the daemon's, changed only through the daemon's own writers (`recordAlwaysDecision`, `replacePermissionPolicyFile`) |
| [paths.js](../../../tools/guard-qualification/paths.js) | The enforcement paths: each turns an action into what its route really receives and reports `allow`, `ask`, `deny` or `block` |
| [support-matrix.json](../../../tools/guard-qualification/support-matrix.json) | Per path: what it verifies, what it leaves unverified, capabilities and reasoned exclusions. Per agent: pinned tuple, tier, routes, receipts, unverified statements, uncovered routes, residual risks |
| [check-support-matrix.js](../../../tools/guard-qualification/check-support-matrix.js) | Refuses a tier not backed by passing installed or connected receipts for the exact pinned tuple, and a case neither run nor excluded |
| [enforcement-acceptance-706.test.js](../../../tools/test/enforcement-acceptance-706.test.js) | Runs every case on every path that can run it, in ordinary CI |
| [connected/](../../../tools/guard-qualification/connected/) | The connected path for Claude (`claude.js`), the model stand-in and the MCP recorder it runs against |
| [enforcement-connected-706.test.js](../../../tools/test/enforcement-connected-706.test.js) | Runs every case the connected path can run, in `claude-hook-acceptance.yml`, and writes the connected receipt |

```sh
pnpm vitest run tools/test/enforcement-acceptance-706.test.js
node tools/guard-qualification/check-support-matrix.js
# Receipts, one JSON file per path: cases run, results, exclusions
ORCA_ENFORCEMENT_RECEIPT_DIR=/tmp/receipts pnpm vitest run tools/test/enforcement-acceptance-706.test.js
```

The connected proof needs the pinned Claude ACP adapter and a Claude Code that is not the
pinned one, installed the way the workflow installs them:

```sh
ORCA_CLAUDE_ADAPTER=…/claude-agent-acp/dist/index.js ORCA_CLAUDE_OTHER_RUNTIME=…/claude \
  ORCA_ENFORCEMENT_RECEIPT_DIR=/tmp/receipts pnpm vitest run tools/test/enforcement-connected-706.test.js
```

## What a pass means

A case runs ORCA's real decision code for one route, against files the daemon's own writers
wrote, and checks ORCA's answer at decision time. It does **not** show:

- that the agent sends an ask, or runs the hook, for every call;
- that a hook's `ask` reaches ORCA as an ACP ask for the same call;
- that the agent obeys the answer: a denied call did not run, an allowed one ran with the same
  arguments, and what it touched;
- that events, logs and stored records about the call are redacted (the privacy cases check
  only the answer a route hands back to the agent);
- physical confinement: the files can change between the check and the agent's open, and
  the path tests do not run on Windows.

Each path lists these as `unverified` in the matrix. The connected proof (below) and
installed runs are where they get verified. A path that cannot be asked a
case says so in the matrix, with a reason; absence of a case is never counted as coverage, and
synthetic results never count toward a tier.

## The connected proof

`claude-connected` runs a real Claude Code (the pinned pair in `CLAUDE_HOOK_VERIFIED_PAIRS`)
through the real Claude ACP adapter, in a session opened by ORCA's own session factory with
the pre-tool hook installed, exactly as the daemon would open it. Claude Code's own settings
allow every tool without asking, the worst case of natively remembered grants, so anything
that stops a call is ORCA. A local stand-in for the model makes each case's tool calls, so no
account, key or model spend is involved. MCP calls go to recorder servers.

Each call's outcome is read from the world, separately from ORCA's decision:

| Outcome | Observed as |
| --- | --- |
| `allow` | The call took effect: the file holds what was written, the MCP recorder answered, the read or command returned |
| `ask` | A permission ask reached ORCA's human channel (and was refused, unless the case answers it) and the call did not take effect |
| `deny`, `block` | The tool result the model got back is ORCA's denial or block |

An `allow` wins over an ask: an ask answered in a way that let the call run is counted as
having run. The privacy cases search the tool results handed back to the model.

Claude Code refuses some calls itself before any hook runs: a tool it does not offer, an Edit
of a file that does not exist, a change to a file it has not read. For a change to an existing
file the path first reads it, as an agent would, with a person allowing that one read if ORCA
asks. A case that expects ask or deny accepts the agent's own refusal only where nothing could
have run anyway (the tool is not offered; Edit cannot create a file; ORCA denied the read), and
every such call is listed under `agentRefusals` in the receipt.

Cases that run on this path include the concurrency case (16 identical calls in one model
message), the timed grant (a real one-minute grant, waited out) and the unanswered,
cancelled and wrongly-answered asks. The cases it cannot run (raw hook input, the context
file, the installed settings, ACP options, a call from another working directory) are
excluded with reasons and run on the synthetic paths. The run also checks that a session
pointed at a Claude Code other than the pinned one is refused before any work
(`checks.uncoveredRoutesRefused`).

`claude-hook-acceptance.yml` runs it after the #704 acceptance tests and keeps the receipt as
an artifact. It is evidence for review: promotion stays disabled, so no tier changes on it.

## Support tiers

The same tiers the #705 and #709-#711 streams report in, defined once in
`support-matrix.json` and checked by `check-support-matrix.js`.

**Promotion is disabled.** The receipt checks below are structural only: a receipt file says
what it says, and nothing yet binds it to an independently trusted run (who ran it, on which
machine, and that the file was not written by hand). Until that binding exists, the checker
refuses every tier above `none`, whatever receipts a row lists (`PROMOTION_ENABLED = false`).

What a receipt must show once promotion is enabled: the row pins agent version, adapter
version, host and the exact 40-hex ORCA build. For **each route**, a committed
`orca-enforcement-receipt/1` must match that pin and route, list no case twice, pass every case
it lists, and carry `checks.connects` and `checks.uncoveredRoutesRefused` passing. Tiers are
cumulative: each needs the receipts of every tier below it. A file path, a workflow's existence
or a named residual risk is not proof.

| Tier | Claim | Receipts per route (cumulative) |
| --- | --- | --- |
| none | Nothing verified about policy coverage | — |
| A | Connects and fails closed | `installed`, with the two connectivity checks passing |
| B | Approvals validated | A, plus `installed` with every case the route can run passing against the real agent |
| C | Execution guard certified | B, plus `connected` from a connected path that proves the route (`proves` in the matrix), with every case that path can run passing; and that path excludes no lifecycle or bypass case |

Today every agent is `none`. Claude and Codex connect and are recognised by first-run
preflight, but no receipt backs that, so the matrix lists it as unverified. Each stream edits
only its own agent's row and adds its own path adapter.

## Adding a path

Write an adapter in `paths.js` with `id`, `capabilities` and `decide(world, action, opts)`
(plus `decideRaw` for `raw-input`/`context-file`, `settings` for `hook-settings`), add it to
`PATHS`, and add the same id and capabilities to the matrix's `paths`. The suite then runs
every case the path can run. Any case it cannot run must be excluded with a reason a reader
can check, or the checker fails.

A connected path runs a live agent instead. It is listed in the matrix with `connected: true`
and `proves: <route>`, is never itself an agent's route, and is checked by its own test file
rather than added to `PATHS`.

## Cases

| ID | Category | Contract rows | What is checked |
| --- | --- | --- | --- |
| L01 | lifecycle | C04 | A remembered grant is decided again on every identical call; the call after a revocation is not allowed |
| L02 | lifecycle | C04 | A timed grant stops allowing the moment it expires |
| L03 | lifecycle | C01 | A recorded "always reject" denies the next identical call, ahead of the default allow, and nothing else |
| L04 | lifecycle | C04, C15 | An operator's policy edit between two identical calls decides the second |
| L05 | lifecycle | C14 | Identical concurrent calls are each decided; every call started after a revocation asks |
| L06 | lifecycle | C06 | An unreadable sidecar turns its grants and later allows into asks; configured denials still deny |
| L07 | lifecycle | C06 | A deleted sidecar takes its grants with it |
| L08 | lifecycle | C22 | An ask with nobody to answer, whose turn ends while waiting, or answered with an option never offered, runs nothing |
| F01 | failure | C09 | Malformed, mistyped or oversized tool-call input blocks |
| F02 | failure | C09 | A missing, unreadable, unknown-version or oversized session context blocks every call |
| F03 | failure | C09 | The hook is installed for every tool, without a shell, with a bounded timeout and block-on-failure |
| F04 | failure | C05 | A rule allow is delivered as a one-time answer only; an ask offering no one-time allow is refused, not widened |
| F05 | failure | C19 | Tools ORCA does not know, and malformed MCP names, are asked about |
| A01 | arguments | C13 | A grant for one MCP tool covers neither another tool nor the same tool on another server |
| A02 | arguments | C13 | A target outside the workspace, including through `..`, is a new decision |
| A03 | arguments | C13 | A denied command is denied in every spelling ORCA parses (`git -C repo push`, `a && git push`), and no other command is allowed |
| A04 | arguments | C07, C13 | A granted call running outside the workspace asks |
| B01 | bypass | C09 | Writes to ORCA's own files (config, sidecar, session state, credentials) are denied even under `default: allow` |
| B02 | bypass | C18 | A link inside the workspace does not open ORCA's files |
| B03 | bypass | C19 | No shell command is allowed by a standing grant, recorded or hand-written |
| B04 | bypass | C09 | A wildcard allow slipped into the sidecar allows nothing |
| B05 | bypass | C18 | A dangling link inside the workspace does not let a write create one of ORCA's files |
| P01 | privacy | C20 | Ask and deny answers never carry the call's command, content, arguments or path |
| P02 | privacy | C20 | Failure answers never echo the input or the session context |
| P03 | privacy | C20 | Every answer is short (512 bytes at most) and fixed-form, whatever the input's size |
| P04 | privacy | C20 | Credentials are unreadable under `default: allow`, directly or through a link |

### Found by the suite

**B05** failed on both routes when first run: `protectedPathFor` resolved a path physically
only as far as its deepest existing ancestor, so a link whose target did not exist yet was
taken as a new file in the workspace. A default-allowed write through
`work/innocent.json -> ../orca.permissions.json`, before anybody had answered "always", would
have created the sidecar. After review, `protectedPathFor` now:

- follows a link whose target does not exist yet (bounded, like the kernel's `ELOOP`);
- judges a read by where the path leads, a delete or rename by the directory entry itself
  (its directory resolved, its last name kept), and a write by both, since a write may open
  through the link or replace the entry by rename. A protected root is held in both forms;
- treats any error other than "not there yet" (a loop of links, no permission, a component
  that is a file) as protected.

Regression tests are in `packages/agents/test/permissions.test.ts`. They are decision-time
evidence on Linux and macOS, not physical confinement and not Windows qualification.

The Claude hook's own "is this cwd inside the workspace" check reused `protectedPathFor`, so
with fail-closed errors an unresolvable cwd would have counted as inside. It now uses
`existingDirectoryWithin`, which proves both are existing directories that resolve, and
answers no on any doubt.

## Not covered here, and where it goes

| #706 scope | Status |
| --- | --- |
| 1. Cached approvals, revocation, concurrency, changed arguments, epochs, expiry, owner death, missing hook, timeout, malformed replies | Synthetic here (L*, F*, A*). Restart and lost acknowledgement need #703's durable authorization record. Hook timeout and a hook that cannot start are installed evidence in #980's workflow |
| 2. Bypass attempts | Synthetic here (B*, F05). Interactive stdin, subagents and alternate MCP routes are per-agent installed evidence, listed as uncovered routes in the matrix |
| 3. Approval, delivery, dispatch and observed effect, separately | Connected proof for Claude (`claude-connected`): ORCA's answer, the ask reaching ORCA and the observed effect, per call. Other agents add their own connected paths |
| 4. Sensitive handling, safe projections, logging and retention | Synthetic here for what ORCA hands back (P*). Store-side redaction is #363 and #1000's |
| 5. Coverage tier, matched rule and revision on the existing Attention surfaces | #702 follow-up (rule and revision on `agent.permission`); the tier comes from this matrix |
| 6. Exact tested scope, receipts, residual risks | The matrix and the receipts here; latency measured only under an approved plan |
| Judge cases (#701) | Owned by G3's conformance tests, not duplicated here |

The earlier image-designation and observer preparation (draft PRs #785, #809 and the CI-only
#824) is separate; this suite does not depend on it.
