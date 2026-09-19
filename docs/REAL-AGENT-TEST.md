# Running ORCA against a real ACP agent

How this machine was set up to drive ORCA with **Claude Code as a real ACP agent**, and how to
reach that install from **Kepler on your desktop**. This is the setup half of issue #98 (*Run
ORCA end-to-end with a real ACP agent*); the run commands for its steps 2–3 are here too, so the
test itself is a copy-paste away once the agent is authenticated.

Everything below was executed on this box on 2026-09-18.

## 0. Where things live

| Path | What it is |
| --- | --- |
| `/srv/dev/worktrees/Project_Orca-98-…-81dde16f` | the ORCA checkout (git worktree of `Project_Orca`), built to `packages/*/dist` |
| `/srv/dev/orca-live/` | the *live install*: configs, wrappers, event store — deliberately outside the checkout |
| `/srv/dev/orca-live/orca` | `orca` wrapper: pinned node + built CLI + default config |
| `/srv/dev/orca-live/orca-acp` | what Kepler launches — `orca acp` with everything pinned |
| `/srv/dev/orca-live/orca.config.yaml` | single-repo config (`workspace: local` → the sandbox repo) |
| `/srv/dev/orca-live/orca.program.config.yaml` | same agents, `workspace: git-worktree` — for `orca submit` |
| `/srv/dev/orca-live/orca.kepler.config.yaml` | what `orca-acp` loads: same agents, its own store and plan key, so Kepler runs never collide with CLI runs |
| `/srv/dev/orca-live/.orca/` | event logs, artifacts, requests, work items, plan — for the CLI configs |
| `/srv/dev/orca-live/.orca-kepler/` | the same, for runs driven from Kepler (`orca runs --config …/orca.kepler.config.yaml`) |
| `/srv/dev/repos/orca-sandbox` | the throwaway repo real agents write to |
| `~/.local/share/mise/installs/node/24/bin/claude-code-acp` | the ACP adapter for Claude Code |

The live install sits outside the checkout on purpose: a worktree can be discarded, while the
event store is the thing you want to keep. The only link back to the checkout is two absolute
globs (`workflows`, `templates`) plus the CLI path in the two wrapper scripts — if you move or
replace the checkout, update those three places.

Add the wrappers to your PATH so the commands below work verbatim:

```bash
export PATH=/srv/dev/orca-live:$PATH      # put in ~/.bashrc to make it stick
orca agents                               # sanity check
```

## 1. Toolchain and build

Node and pnpm come from mise (`mise.toml` pins Node 24 + pnpm 12); neither is on the default
PATH, so either activate mise in your shell or call through `mise exec --`.

```bash
cd /srv/dev/worktrees/Project_Orca-98-run-orca-end-to-end-with-a-real-acp-agent-81dde16f
mise exec -- pnpm install
mise exec -- pnpm run build        # tsc -b → packages/*/dist, incl. packages/cli/dist/main.js
```

The build matters: Kepler launches ORCA as a plain command, so the CLI has to run from `dist`
under a pinned `node` rather than through `tsx`/pnpm scripts. Rebuild after every code change
you want the Kepler-facing install to pick up.

## 2. Install the ACP adapter

Claude Code does not speak ACP itself; Zed's adapter wraps it:

```bash
mise exec -- npm install -g @zed-industries/claude-code-acp    # v0.16.2 as installed here
ls -l ~/.local/share/mise/installs/node/24/bin/claude-code-acp
```

`orca.config.yaml` names that binary by absolute path, so it does not matter whether the
adapter is on anyone's PATH. It negotiates ACP protocol version 1 with ORCA's client
(`@agentclientprotocol/sdk` ^1.4.0 against the adapter's 0.14.1 — compatible).

The adapter bundles its own Claude Code (agent SDK 0.2.44 → Claude Code 2.1.44, and 0.16.2 is
still the latest adapter release), and the API now refuses that version for current models:

```
API Error: 400 … "Claude Code 2.1.44 does not support this model; version 2.1.251 or newer
is required" … "error_code":"claude_code_version_too_old"
```

The adapter honours `CLAUDE_CODE_EXECUTABLE` and hands it to the SDK as
`pathToClaudeCodeExecutable`, so point it at the native install instead — every live config
here does, under `agents[].env`:

```yaml
env:
  PATH: …
  CLAUDE_CODE_EXECUTABLE: /home/casey/.local/bin/claude     # 2.1.276 — `claude --version`
```

This bit only from Kepler: ORCA spawns agents with `{ ...process.env, ...agent.env }`
(`packages/agents/src/hosts/local-host.ts`), and a shell inside a Claude Code session already
exports `CLAUDE_CODE_EXECUTABLE`, which is why the §6 CLI run passed while the first Kepler
session failed at `decompose`. Keep the native `claude` updated (`claude update`); the pin is
a symlink that follows it.

## 3. Authenticate the agent

The adapter runs Claude Code underneath and inherits *its* credentials, and they are its own:
Kepler injects credentials into the sessions it starts itself, which does nothing for a Claude
Code that ORCA spawns. Unauthenticated, the handshake dies at `session/new` (this is what
happened here until `claude /login` was run):

```
error [AGENT_PROTOCOL]: ACP handshake with 'claude' failed: Internal error
  details: 'Unable to validate model: Could not resolve authentication method…'
```

Pick one:

**a) Log in once as your user** (subscription auth, no secrets in the repo):

```bash
export PATH=~/.local/bin:$PATH
claude /login            # prints a URL; paste the code back — works over SSH
claude -p "say pong"     # must answer without complaining
```

**b) Use a token/key in the agent's environment** — add to `agents[].env` in *both* configs:

```yaml
env:
  PATH: /home/casey/.local/share/mise/installs/node/24/bin:/home/casey/.local/bin:/usr/local/bin:/usr/bin:/bin
  ANTHROPIC_API_KEY: sk-ant-…          # console key, billed per token
  # or, for subscription auth without an interactive login on this box:
  # CLAUDE_CODE_OAUTH_TOKEN: …          # from `claude setup-token` on a machine you can log in on
```

Option (a) is the cheaper habit: one login serves every agent ORCA spawns, and the config stays
free of secrets. Whichever you choose, verify with `orca ping` (§5) before running a workflow —
a failed handshake at run time costs you a half-finished run.

## 4. The sandbox repo

A real agent edits files, runs tests and commits. Point it at something disposable:

```
/srv/dev/repos/orca-sandbox      git repo, branch main, one commit
  package.json                   ESM, `npm test` → node --test
  src/strings.js                 one small helper
  src/strings.test.js            its test
  AGENTS.md                      house rules the agent is told to read
  .gitignore                     node_modules/, .orca/
```

`AGENTS.md` is not decoration: the `partials/work-item-context` template tells every agent to
read `CLAUDE.md` / `AGENTS.md` before acting, so it is the cheapest lever on agent behaviour
during the test.

## 5. Verify the wiring

```bash
orca agents          # hosts, agents, roles — claude fills all seven roles
orca validate        # OK ai-sdlc (16 nodes) / plan-resume / program
orca ping claude     # spawn claude-code-acp, complete the ACP handshake, close
```

`ping` is the one that touches the real agent. A good run looks like:

```
DEBUG initialized {"agent":"claude","protocolVersion":1,"agentInfo":{"name":"@zed-industries/claude-code-acp","version":"0.16.2"}}
OK claude on local: ACP session <id> in NNNms
```

If you want to prove the engine end of things without spending tokens, the scripted agent still
works from the built CLI (this passed here, three work items dispatched):

```bash
orca demo --dir /srv/dev/orca-live/demo
```

## 6. Issue #98 step 2 — one `ai-sdlc` run with a real agent

> **Known bug, found by this test (2026-09-18, filed as #135).** `--var workItem={…}` does *not*
> reach the prompt. `evalContext` (`packages/engine/src/run-context.ts`) builds `workItem` only from
> `run.workItemId` — a stored `WorkItem` record — so with a plain `orca run` the context block
> renders empty and `{{ workItem.slug }}` in every deliverable path collapses
> (`.orca/work//intent.md` → `.orca/work/intent.md`). The agent is handed "turn the work item
> below into intent.md" with nothing below. The README quick start documents exactly this
> command, and the scripted e2e tests pass a work item the same way without noticing, because a
> scripted agent never reads its prompt. Until it is fixed, drive real single-item runs through
> `orca submit` (§7), which creates real `WorkItem` records and binds each child run to one.

```bash
orca run ai-sdlc --var 'workItem={"slug":"slugify","title":"Add a slugify helper",
  "description":"Add slugify(input) to src/strings.js with tests, mirroring titleCase.",
  "acceptanceCriteria":["lowercases and hyphenates","strips punctuation","has a unit test"]}'
```

What to expect: `plan` → `design` → `spec-gate` (auto-approves unless the spec says
`risk: high`) → `await-deps` (pass-through, the item is not in a plan) → `build` → `test` →
`review` → `deploy`, each stage a fresh ACP session (`sessionMode: per-step`) prompted from
`templates/sdlc/*.md` and ending with a file ORCA reads back:
`.orca/work/slugify/intent.md`, `spec.md`, `plan.md`, `implementation.md`, `test-report.md`,
`review.md`, `deploy-report.md` — inside the sandbox repo, since that is the workspace.

Front matter is the contract. ORCA appends a **Deliverables** block to every prompt (path,
required front-matter fields, allowed values) and validates what comes back; a missing or
invalid artifact triggers a bounded follow-up prompt (`completion.maxFollowUps`), then a step
failure. That validation is exactly what has never met a real agent, so expect the first
findings here (§10).

Inspect afterwards:

```bash
orca runs                      # every run and its status
orca status <runId>            # steps, artifacts, pending questions
orca events <runId> --json     # the event log the run is derived from
```

What the event log holds of a session (`.orca/runs/<runId>.jsonl`): every `session/update` as an
`agent.update` event — message and thought text coalesced into blocks of up to ~4 000 characters,
tool calls and tool-call updates reduced to id, title, kind, status and file paths — plus one
`agent.permission` per `session/request_permission` with the decision. It is *not* a transcript:
raw ACP payloads, tool inputs and outputs, and the agent's stderr are not kept (`summarizeUpdate`
in `packages/agents/src/session.ts`; the recorder in `packages/engine/src/executors/agent-step.ts`).
That is enough to reconstruct what each agent said and which commands it ran, not what those
commands printed.

**The `artifact-present` variant.** The default is `turn-end` (read files when the agent's turn
ends). Step 2 of the issue also wants `artifact-present`, where ORCA watches the filesystem and
cancels the turn the moment every required deliverable exists. Flip it on one node in the
checkout's `workflows/ai-sdlc.yaml` and rerun:

```yaml
  plan:
    …
    completion: { mode: artifact-present, maxFollowUps: 1 }
```

Deliverables are `required: true` by default, so nothing else needs changing. Watch for two
things: whether the agent gets killed mid-sentence after writing the file (`cancelGraceMs`
governs the kill), and whether it writes the file before it is really done.

## 7. Issue #98 step 3 — a program run into git worktrees

Use the second config so each dispatched work item gets its own branch and worktree under
`/srv/dev/orca-live/worktrees` instead of all of them fighting over one checkout:

```bash
orca --config /srv/dev/orca-live/orca.program.config.yaml \
  submit "Add a small text-utils module" \
  --body "Three helpers in the sandbox: slugify, truncate, wordCount. Each pure, each tested."
```

That drives `program`: decompose → register in the plan → assess risks → one decision matrix per
open decision → schedule → plan gate (auto-approves for ≤ 12 items with no critical risk and
nothing unschedulable) →
dispatch 2–3 `ai-sdlc` children → summary. Follow it with `orca plan show sandbox`,
`orca plan schedule sandbox`, `orca plan journal sandbox`, and `orca claims` (who owns which
item; `orca claims release <id>` frees a dead run's claim).

With `humanInput.mode: auto` (both configs) gates take their first option and `ask` permissions
are allowed — unattended, as the issue's "done when" requires. Switch to `mode: pause` if you
want the run to park at every gate and resume with `orca answer <requestId> approve`.

## 8. Drive it from Kepler on your desktop

Kepler on this box is a **server install** (`~/.kepler-server`, listening on 127.0.0.1:45077,
tasks under `~/kepler/tasks`) that your desktop connects to. Agent processes belong to that
server — the sessions Kepler runs for you already execute here — so a custom agent pointed at a
path on this box should be reachable from the desktop with no tunnelling and no copy of ORCA
there. (If it turns out your desktop launches custom agents locally instead, the fix is an
`ssh <this-box> /srv/dev/orca-live/orca-acp` wrapper on the desktop: ACP is just line-delimited
JSON-RPC over stdio, which survives an `ssh -T` hop — that is how ORCA's own SSH host works.)

### Register ORCA as a custom agent

In Kepler on your desktop, open the **Agents** settings page; its **Custom agent servers**
section ("Add one to use your own ACP-compatible agent") has an **Add** button with three
fields:

| Field | Value |
| --- | --- |
| Name | `ORCA` |
| Command | `/srv/dev/orca-live/orca-acp` |
| Args (one per line) | *(leave empty)* |

`orca-acp` is a three-line shell script that pins node, the built CLI, `--config`, and the PATH
the spawned coding agents need — the registration form offers only a command and args, so the
process inherits whatever environment Kepler happens to hand it, which will not have mise
activated. To point Kepler at a different ORCA config later, edit that script (or add
`--config /path/to/other.yaml` in Args).

Verified here with a bare-bones ACP client (`/srv/dev/orca-live/acp-smoke.mjs`, which is what
Kepler does: `initialize` → `session/new` → `session/prompt`):

```
initialize: {"protocolVersion":1,"agentCapabilities":{"loadSession":false,
             "promptCapabilities":{"embeddedContext":true,…}},"agentInfo":{"name":"orca","version":"0.1.0"}}
session/new: {"sessionId":"sess_01M2SZ4D650QEHEQ79MMGDP32X"}
< No runs in this session yet.          ← response to the /status prompt
```

Re-run it any time the Kepler side misbehaves, to tell "ORCA is broken" apart from "Kepler is
not launching it":

```bash
~/.local/share/mise/installs/node/24/bin/node /srv/dev/orca-live/acp-smoke.mjs "/status"
```

### Using it

Open (or create) a Kepler task with a worktree, start a session, pick **ORCA** as the agent,
then prompt it:

| Prompt | What ORCA does |
| --- | --- |
| free text | a **Request**: first line is the title, the rest the body → the `program` workflow |
| `/run ai-sdlc workItem=…` | run one workflow in the session's cwd |
| `/status` | list the runs started in this session |

What streams back into the Kepler session:

- the workflow as a **plan**, one entry per node, updated live;
- agent output as message chunks, each node announced with `▶ <node>`, child runs prefixed with
  their chain (`[program › ai-sdlc]`);
- every recorded artifact as a completed **tool call** with its file location — click through to
  `intent.md`, `spec.md`, the test report;
- **gates and `ask` permissions as Kepler's own approval prompts** (`session/request_permission`),
  routed to the session that started the run, so two sessions never see each other's questions;
- stopping the session (`session/cancel`) cancels the whole run tree.

Two things to know about where the work happens: the facade uses the **session's cwd** — the
Kepler task worktree — and ignores the configured workspace provider, so ORCA edits the task's
own worktree and child runs inherit it. If you want ORCA to pick per-repo worktrees inside a
multi-repo task instead, set `workspace: { provider: kepler }` in the config the script points
at. And the event store is whatever that config names — `/srv/dev/orca-live/.orca-kepler` for
`orca.kepler.config.yaml` — so `orca runs --config /srv/dev/orca-live/orca.kepler.config.yaml`
in a shell here inspects exactly what you just drove from the desktop.

Registered and exercised from the desktop on 2026-09-19: a free-text prompt became a Request,
the program workflow ran to completion, and one work item went through the full `ai-sdlc` child
run (§10, second run). The first attempt died at `decompose` on the Claude Code version gate
in §2, which is what put `CLAUDE_CODE_EXECUTABLE` into every config.

If you would rather stay beside Kepler than inside it, `orca kepler ~/kepler/tasks/<task-id>`
prints what ORCA sees of a task (id, title/body from `AGENTS.md`, worktrees) and
`orca submit "$(head -1 AGENTS.md)" --body-file AGENTS.md` runs the task through the program
workflow from a shell in the task folder.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ACP handshake … Internal error` + "Could not resolve authentication method" | §3 — the agent has no Claude credentials |
| `WORKFLOW_INVALID: no agent fills role …` | the role is missing from `agents[].roles`, or you ran without `--config` |
| `spawn … ENOENT` | `command:` path wrong, or `claude-code-acp` reinstalled under a different Node version |
| First prompt fails: `Claude Code 2.1.44 does not support this model` (`claude_code_version_too_old`) | §2 — the adapter ran its bundled Claude Code; set `CLAUDE_CODE_EXECUTABLE` in `agents[].env`. Runs from a Claude Code shell hide this because the variable is inherited |
| Kepler shows the agent but sessions never start | the launcher is not executable, or it printed something on stdout — stdout is the protocol channel, logs must go to stderr |
| Step fails with "front matter field 'x' is missing" | the agent wrote prose instead of the contract; tune `templates/sdlc/*.md` and refile as a #98 follow-up |
| Step hangs, then `turn timeout` | `turnTimeoutMs` (30 min here); the agent is then cancelled and, after `cancelGraceMs`, killed |
| A work item is "claimed" by a run that died | `orca claims` then `orca claims release <workItemId>` |
| Run died mid-way | `orca resume <runId>` — it replays from the event log |

## 10. Status against issue #98

| Step | State |
| --- | --- |
| 1. config with a real local ACP agent, `orca ping` | **done** — `OK claude on local: ACP session … in 3699ms` |
| 2. `orca run ai-sdlc` with a real agent | **done in `turn-end` mode** — see below; `artifact-present` not yet exercised |
| 3. `orca submit` through the program workflow | config + command ready (§7), not yet executed |
| 4. the same over SSH to a second machine | not started — needs a second host (see INTEGRATIONS.md → "Remote agents over SSH") |
| 5. drive it once from Kepler via `orca acp` | **done** — a desktop prompt ran the program workflow and one `ai-sdlc` child to completion (second run below); no gate reached a human because every gate auto-approved on `risk: low` |
| — engine/transport/CLI on this box | verified with the scripted agent: `orca demo` completes a program run with three items |

### First real run (2026-09-18)

`run_01M2SZNSQ5NXST6WM2N5DVHAMS`, ai-sdlc against the sandbox, ~13 minutes, **completed/success**.
All 14 nodes on attempt 1: no follow-up prompts, no build retries, no review round. Seven
artifacts recorded and validated, `spec-gate` auto-approved on `risk: low`, `tests-passed` and
`review-verdict` both routed off real front matter (`passed: true`, `verdict: approve`). The agent
committed `656bdb1 Add slugify string helper` in the sandbox — `slugify()` plus seven tests, 8/8
passing, verified independently afterwards.

What that run says about the untested surface:

- **Front-matter compliance was perfect** across all seven artifacts, including constrained fields
  (`risk`, `verdict`) and list/object fields (`touches`, `risks`, `commits`). On this evidence the
  shipped `templates/sdlc/*.md` need no tuning, and `completion.maxFollowUps` never fired.
- **The work-item bug in §6** is the one real defect (the planner noticed it itself and recorded
  `status: needs-clarification` with an accurate diagnosis in `questions`).
- **`deploy` ended `status: blocked`** — correctly: no git remote, no CI, and it declined to create
  a GitHub repo unprompted. Worth deciding what the deploy stage should do in a sandbox, and
  whether `status: blocked` should route somewhere other than `done`.
- **Permissions:** `default: allow` meant the agent ran wide-ranging shell commands unattended,
  including reads outside the workspace (it found this very document that way, in another
  directory, and used it to reconstruct the missing work item). Tighten `pathPrefix` rules before
  running this against anything that isn't a sandbox.

### Second real run, from Kepler (2026-09-19)

Prompt typed into a Kepler desktop session with ORCA as the agent: *"create a new file that
contains a poem. And save it to the test repo you are in."* Store: `/srv/dev/orca-live/.orca-kepler`.

| Run | What | Result |
| --- | --- | --- |
| `run_01M2VHYT32PB17R5X5CT6ZZEPA` | program: `decompose` → `materialize` → `assess-risks` → `schedule` → gate → `dispatch` → `summarize` | **completed/success**, 00:44–00:54 |
| `run_01M2VJ3XKDV6KV9HCRP099JR3S` | the one dispatched item, `add-poem-file`, through `ai-sdlc` | **completed/success** in 6.5 min, every node attempt 1, no follow-ups |

What it adds to the first run's evidence:

- **The work-item context works when a real `WorkItem` is bound.** Dispatched through the
  program, the child's prompts carried the item and every artifact landed under
  `.orca/work/add-poem-file/` — the §6 bug (#135) is specific to `--var`.
- **Decomposition, risk register and schedule all parsed on the first try** (one item, two risks,
  one external dependency on `slugify` recorded with a warning because that item was never in the
  plan). The gate auto-approved and dispatch bound the item and released it as `done`.
- **The tester and reviewer re-ran the spec's checks themselves** rather than trusting the earlier
  reports, which is the behaviour the templates ask for.
- **Same `deploy` outcome**: `status: blocked`, no remote, no repo created — and the run still
  ended `success`, the item `done`, the summary "delivered" (#136).
- **Stale artifacts leaked**: every stage read the first run's flat `.orca/work/*.md` as "prior"
  context while exploring the repo (#137).
- **Branching drifted**: this build agent cut `feat/poem`, the first committed to `main`, and the
  shared sandbox checkout is now left on `feat/poem` (#139).
- **In Kepler**, the plan re-sent identical snapshots and a failed step showed as `pending` (#138).

Filed from these two runs: #135 (work-item context from `--var`), #136 (`deploy` `blocked`
routing), #137 (stale `.orca/work` leakage), #138 (facade plan view), #139 (branching on a local
workspace), #140 (permission defaults for unattended runs). Not exercised, so not filed:
`terminal: false` (the adapter runs its own shell and never asked), `session/load` on retried
steps (no step was retried), and the wedged-agent kill path (no turn timed out).
