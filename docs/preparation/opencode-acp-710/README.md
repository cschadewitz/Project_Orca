# #710 OpenCode native ACP — inactive, version-pinned preparation

26 October 2026. Baseline `890eb71847e4c38533ab8f5b2d35f14076b8f923` (origin/main).
Issue: [#710](https://github.com/cschadewitz/Project_Orca/issues/710).

**This packet supports source review and offline fixtures only.** OpenCode was not
installed, launched or authenticated. No API key was used and no model call was made.
Nothing here registers OpenCode with ORCA or changes an ORCA default. The launch profile
is a document that no loader reads. No provider/tool/version/host tuple is
connectivity-tested, approval-tested or execution-guard certified. Mac acceptance is
not claimed.

Read next: [setup and preflight](setup-preflight.md) ·
[bounded installed-test plan](installed-test-plan.md) ·
[isolated OpenCode config](opencode.isolated.json) ·
[inactive ORCA launch profile](orca.opencode.example.yaml) ·
[pins and excerpt digests](source-pins.json).

## Evidence levels

Every claim below carries one of these labels. They are not interchangeable, and a lower
level never implies a higher one.

| Label | Meaning | Present in this packet |
| --- | --- | --- |
| **documented** | Stated in OpenCode's docs at the pinned tag (`packages/web/src/content/docs/*.mdx`). The live opencode.ai pages were refused by this environment's proxy. | yes |
| **source-reviewed** | A control-flow read of the pinned revision `148842ef…`. | yes |
| **source-function-tested** | A digest-checked upstream excerpt run with synthetic dependencies ([`opencode-acp-source-710.test.ts`](../../../packages/agents/test/opencode-acp-source-710.test.ts)). | yes |
| **fixture-simulated** | ORCA's unchanged ACP session run against an in-memory OpenCode-shaped peer ([`opencode-acp-fixture-710.test.ts`](../../../packages/agents/test/opencode-acp-fixture-710.test.ts)). The peer's option list and reply mapping are OpenCode's own excerpts; the rest of its behaviour is simulated. | yes |
| **installed-tested** | Behaviour observed from a verified installed binary. | **none** |
| **approval-tested** | Real offered options and independently observed effects or denials on an installed provider. | **none** |
| **execution-guard certified** | #700 contract and #706 acceptance for an exact tuple. | **none — NO-GO** |

## Pins

The full record, with npm integrity for every platform package and the excerpt digests, is
in [source-pins.json](source-pins.json).

| Item | Pin |
| --- | --- |
| Release | OpenCode **v1.19.4**, `anomalyco/opencode@148842ef7cb1bc34192b3fff57d0f9721ab9c801`, tagged 2026-10-22. This is the GitHub "Latest" release and the npm `latest` tag. `sst/opencode` resolves to the same repository. |
| npm wrapper | `opencode-ai@1.19.4`, `sha512-O3rTc9OC…yECiFA==`. Its postinstall selects a platform package and, if that package is missing, runs `npm install` itself. Do not use the wrapper; see preflight. |
| macOS arm64 artifact | `opencode-darwin-arm64@1.19.4`, `sha512-31sy6eA8…ykbDJg==`, `os: darwin`, `cpu: arm64`. This is **published metadata only**: registry metadata has no `gitHead`, so binary-to-source correspondence is unknown. |
| Runtime | A single Bun-compiled executable with Bun 1.4.4 embedded (source-reviewed: `script/build.ts`, root `packageManager`). It needs no Node or Bun at runtime. |
| ACP revision | Provider SDK `@agentclientprotocol/sdk` **0.21.0**. `initialize` returns `protocolVersion: 1`. ORCA's client SDK is **1.8.0** and requests protocol 1. |
| OpenCode 2 | `@opencode/cli@2.1.4` (tag `v2.1.4`, `68bc26b7…`) is a separate package with a rewritten ACP agent on SDK 1.6.0. `opencode upgrade --major` switches a v1 install to it. It is a **different, unreviewed tuple**: nothing here transfers to it. |

## Launch, transport and hosts

- **Command (documented + source-reviewed):** `opencode acp` speaks newline-delimited
  JSON-RPC over stdio.
- **Internal HTTP server:** before serving ACP, the process starts an internal HTTP server
  (`Server.listen`) and drives itself through it. That server is **unauthenticated unless
  `OPENCODE_SERVER_PASSWORD` is set** (source-reviewed: `server/auth.ts`,
  `…/middleware/authorization.ts`). Any local process that finds the port can then call
  the API, including permission replies.
  - The profile pins `--hostname 127.0.0.1 --port 0`, so the server stays on loopback at a
    random port.
  - ORCA's configuration cannot generate a per-launch secret, and a static one would be a
    credential in a config file. The profile therefore leaves the password unset. This is a
    residual risk (see follow-up proposal F2).
- **Flags:** `--cwd` is declared but never read; the working directory comes from each
  `session/new`. Global flags `--pure`, `--log-level` and `--print-logs` exist. Nothing in
  the ACP command skips permissions. The `--dangerously-skip-permissions` / `--yolo` /
  `--auto` flags belong to `run` and the TUI only.
- **Hosts (documented):** Linux and macOS are supported; on Windows, WSL is recommended.
  Build targets are darwin arm64/x64, linux arm64/x64 (glibc, musl, baseline) and windows
  x64/arm64. **None was executed here.** The macOS arm64 row in the matrix is
  "artifact pinned, unverified".

## Authentication and the one backend chosen for validation

- **ACP authentication is a no-op (source-reviewed).** `initialize` advertises one method,
  `opencode-login` ("Run `opencode auth login` in the terminal"), and `authenticate`
  returns `{}` without doing anything. ORCA never calls `authenticate`; the fixtures assert
  this.
- Credentials come from OpenCode's own store (`$XDG_DATA_HOME/opencode/auth.json`, written
  by `opencode auth login`) or from provider environment variables.
- A provider failure during a prompt reaches ORCA as an ordinary prompt error, and ORCA
  reports it as `AGENT_PROTOCOL` (fixture-simulated).

**Chosen backend for the installed-test plan: Anthropic, with an API key entered by the
operator through `opencode auth login` into the profile's isolated data directory.** The
isolated config sets `enabled_providers: ["anthropic"]`, and the profile blanks inherited
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENCODE_API_KEY`. OpenCode ignores an empty
provider variable (source-reviewed: `provider.ts:1641`, `.find(Boolean)`).

The choice is for a plan, not a call. Reasons:

- Anthropic is listed in the provider documentation.
- It has an explicit payer and budget owner.
- It is the provider ORCA already has operator experience with.
- Restricting to it removes the keyless fallback described next.

**Every other backend is unverified**, including:

- OpenCode Zen and OpenCode Go.
- OpenAI, GitHub Copilot and GitLab Duo.
- Bedrock, Azure, Vertex and OpenRouter.
- Custom OpenAI-compatible endpoints.
- **Local models** (Ollama, LM Studio, llama.cpp).

Two backend facts to keep in mind:

- **Keyless Zen fallback (source-reviewed):** with no credentials at all, OpenCode enables
  its hosted **Zen** provider with `apiKey = "public"` and only free models
  (`packages/core/src/plugin/provider/opencode.ts`). An unconfigured launch can therefore
  make hosted model calls with no sign-in. The isolated config prevents this through
  `enabled_providers`.
- **Claude subscriptions:** the docs state that Anthropic prohibits using Claude Pro/Max
  subscriptions through plugins, and that OpenCode stopped bundling them in 1.3.0. They are
  not used here.

## Native permission defaults

Source-function-tested against `agent/agent.ts` defaults and `permission/index.ts`
`evaluate`:

| Native permission | ACP kind ORCA sees | 1.19.4 default | Isolated profile |
| --- | --- | --- | --- |
| `bash` | `execute`, title = command, **no location** | allow | ask |
| `edit` (edit, write, apply_patch) | `edit`, location = file | allow | ask |
| `read` | `read` | allow; `*.env`, `*.env.*` ask | ask |
| `glob`, `grep` | `search` | allow | ask |
| `list`, `todowrite`, `lsp`, `skill`, `websearch`, `doom_loop`, MCP tools | `other` | allow (`doom_loop` ask) | ask, or deny for `lsp`, `skill`, `websearch`, `doom_loop` |
| `webfetch` | `fetch` | allow | deny |
| `task` (subagent launch) | **`think`**, title `task` | allow | deny |
| `external_directory` | `other` | ask, except OpenCode tmp, truncation, skill and reference dirs | deny (the truncation dir is re-allowed; see below) |
| `question`, `plan_enter`, `plan_exit` | — | deny (`build` allows `question`, `plan_enter`) | deny; `question` is also disabled under ACP |

The documentation says `.env` reads are *denied* by default. The source says **ask**; this
packet follows the source.

### Matching and precedence

- **Last match wins** (`findLast`), in written key order. A `"*"` written *after* a key
  overrides it. The isolated config writes `"*"` first, and the test asserts this.
- Wildcards: `*`, `?`, and a trailing `" *"` that makes arguments optional.
- An agent's ruleset is `defaults → built-in agent extras → top-level permission →
  agent.<name>.permission`. The truncation-directory allow is then appended **after
  everything**, unless that exact glob is denied (`agent-user-override` excerpt).
- A session's ruleset is `merge(agent.permission, session.permission)`.
- Within one ask, any `deny` pattern fails the call, and any `ask` pattern asks.

Configuration layers, lowest first (source-reviewed: `config/config.ts`, `config/paths.ts`),
and what the profile does about each:

| # | Layer | Isolated profile |
| --- | --- | --- |
| 1 | Remote `.well-known/opencode` for "wellknown" auth entries | No such entry in a fresh isolated data dir (preflight check) |
| 2 | Global `$XDG_CONFIG_HOME/opencode/{config.json,opencode.json,opencode.jsonc}` | `XDG_CONFIG_HOME` → empty profile dir |
| 3 | `OPENCODE_CONFIG` file | → reviewed `opencode.isolated.json` |
| 4 | Project `opencode.json[c]`, walking up to the worktree | `OPENCODE_DISABLE_PROJECT_CONFIG=1` |
| 5 | `.opencode/` directories (project walk, **`~/.opencode` always**, `OPENCODE_CONFIG_DIR`). These also load agents, commands and JS **plugins**, and run `npm install` for them. | `HOME` → profile dir; `OPENCODE_CONFIG_DIR=""`; `--pure` / `OPENCODE_PURE=1` |
| 6 | `OPENCODE_CONFIG_CONTENT` | `""` (OpenCode ignores empty) |
| 7 | Active console org config | No console login in the isolated data dir (preflight check) |
| 8 | Managed dir: `/etc/opencode`, `/Library/Application Support/opencode`, `%ProgramData%\opencode` | **Cannot be isolated.** Preflight requires it absent. |
| 9 | macOS MDM `ai.opencode.managed` | **Cannot be isolated.** Preflight requires it absent. |
| 10 | `OPENCODE_PERMISSION` (deep-merged into `permission`) | Exactly the isolated file's `permission`; the test enforces equality |

Layer 10 overrides the top-level `permission` of layers 8 and 9. It does **not** override
an `agent.<name>.permission` set there, which is applied later per agent. That is why
preflight refuses any managed configuration rather than relying on layer 10.

**ORCA cannot remove inherited environment variables.** `LocalHost` spawns with
`{ ...process.env, ...agent.env }`. The profile can blank or replace variables, but any
other variable ORCA inherited (cloud credentials, `GITHUB_TOKEN`, …) reaches OpenCode and
every shell child it starts. See F2.

### Remembered approvals, reload and session scope

- **"Always allow" is held in memory, keyed by directory, and shared by every session in
  that directory for the life of the process.** It is not persisted (source-reviewed;
  documented as "the rest of the current OpenCode session").
- The remembered scope is the ask's `always` list:
  - edit, webfetch, task and MCP tools record `["*"]`, so one "Always allow" on one edit
    approves **every** edit;
  - bash records the command's arity prefix plus `" *"`.
- **A remembered approval outranks a configured pattern deny for the same permission.**
  `ask` evaluates `ruleset` then `approved`, last match wins (source-function-tested).
- A native `reject` also rejects every other pending ask of that session and, by default,
  stops the turn.
- ORCA forwards a human "always" unchanged and also writes its own exact sidecar rule. The
  two grants differ in scope: ORCA's is one file or one exact command; OpenCode's is all
  edits, or a command prefix. The difference is invisible to ORCA after the fact
  (fixture-simulated).
- **Reload (source-reviewed, installed unverified):** no configuration file watcher was
  found. Global config is cached until `updateGlobal` or instance disposal. Treat any edit
  to the isolated config as requiring a restart.
- **Session-level permission:** ACP-created sessions carry none from ORCA. Whether any
  other path sets one is not established.

### Subagents, shell, filesystem, MCP and other execution routes

- **Subagents:**
  - A `task` ask reaches ORCA as kind `think` with title `task`, and ORCA's #140 defaults
    **allow `think` without asking** (fixture-simulated). The profile denies it natively
    and with an ORCA rule.
  - A child session inherits only the parent's denies and `external_directory` rules, **not
    its asks** (source-function-tested).
  - The ACP bridge **drops every ask from a session it does not track**. Subagent children
    are untracked, so their asks are never forwarded and never answered, and the subagent
    hangs (source-function-tested; upstream
    [#48232](https://github.com/anomalyco/opencode/issues/48232), "Fixed on v2").
  - A user `@agent` mention bypasses the task ask (`bypassAgentCheck`). Whether ACP prompt
    text produces one is unverified.
- **Shell:**
  - The ask carries only the command: no working directory and no location
    (source-reviewed; fixture-simulated). ORCA cannot bind or compare cwd, and an exact
    title rule approves the same command in any directory.
  - Children run with stdin ignored (non-interactive), the full process environment and
    **no sandbox**.
  - Out-of-directory detection is a tree-sitter heuristic over arguments, not containment.
- **Filesystem:**
  - Every tool reads and writes in-process. ORCA's `fs/*` handlers and `protectedPaths` see
    only what OpenCode chooses to send: asks with locations, and the `fs/write_text_file`
    mirror of an approved edit.
  - That mirror is sent even though OpenCode never reads the client capability, and the
    native tool writes the file as well (a duplicate write).
  - A shell command can touch any file the process can.
- **MCP:**
  - MCP tool asks arrive as kind `other` and are allowed by default.
  - Client-supplied servers are registered instance-wide by name and visible to other
    sessions ([#40978](https://github.com/anomalyco/opencode/issues/40978), open).
  - The profile passes no MCP servers and the isolated config defines none.
- **Formatters and LSP:**
  - After an approved edit, OpenCode runs configured **formatters without an ask**.
  - LSP servers are downloaded and spawned.
  - Both are disabled in the isolated config.
- **Plugins:** JS plugins run in-process and can hook tool execution. They are excluded by
  `--pure`, the isolated directories and the disabled project config.
  This does not suppress dependency installation: the pinned
  [config loader](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/config/config.ts#L434-L471)
  schedules `@opencode-ai/plugin` installation in every config directory, including fresh
  writable profile directories, independently of `--pure`. Registry downloads and
  config/cache writes require separate installed-test authorization; the profile is not
  proof of dependency or network isolation. See the
  [installed plan's effects](installed-test-plan.md#scope-and-effects).

### What can execute without asking the ACP client

| Route | Native defaults (1.19.4) | Isolated profile | Evidence |
| --- | --- | --- | --- |
| Shell, edits, fetch, web search, MCP tools, glob/grep/list | **No ask** | Asks (shell, edits, glob/grep/list, MCP tools) or native deny (fetch, web search) | source-function-tested |
| Repeat of an "always"-approved permission | **No ask**, directory-wide, process lifetime | Same. Only a human "always" creates one; ORCA's rule path never selects it with OpenCode's options. | source-function-tested; fixture-simulated |
| Shell child effects (subprocesses, network, files) | One ask for the parsed command; children unmediated | Same | source-reviewed |
| Subagent tools | Subagent's own rules; its asks dropped over ACP | `task` denied natively and by ORCA rule | source-function-tested |
| Formatters after edit; LSP servers | **No ask** | Disabled | source-reviewed |
| Plugins, project/global `.opencode` agents and commands | **No ask** | Excluded by isolation | source-reviewed |
| Truncation-directory access | Allowed | Still allowed (appended last) | source-function-tested |
| Internal HTTP API on loopback | Unauthenticated | Unauthenticated (F2) | source-reviewed |
| Managed/MDM-delivered agent rules | Applied | Preflight refuses their presence | source-reviewed |

## What ORCA does — and is not

ORCA's generic ACP session ([`acp-session.ts`](../../../packages/agents/src/acp-session.ts)),
unchanged, against OpenCode's option set (fixture-simulated):

- A rule-matched allow answers `once` and a deny answers `reject`.
- An `ask` with no answerer, an answer outside the offered set, a stale ask, an ask for
  another session id, or an ask held across cancellation all answer `cancelled`. OpenCode
  maps `cancelled` to `reject`.
- A failed human-input callback fails the turn. OpenCode reads the resulting JSON-RPC error
  as `reject`.
- `terminal/*` is refused as method-not-found. ORCA advertises `terminal: false`.
- `fs/*` outside the session roots, or on ORCA's protected files, is refused.
- Two asks with one tool-call id are two invocations, each answered once.
- A cancelled turn ends with `stopReason: "cancelled"`; a late human answer changes nothing.

ORCA's permission handling is **an answer to the asks OpenCode chooses to send. It is not a
sandbox, not every-execution enforcement, and not a guard over shell children, plugins,
formatters, or remembered native grants.**

## Support and limitations matrix

| Capability | Source reviewed | Fixture-simulated (ORCA side) | Connectivity tested | Approval tested | Execution-guard certified |
| --- | --- | --- | --- | --- | --- |
| `initialize` (protocol 1, `loadSession`, auth method) | yes | yes | no | — | — |
| `session/new` with cwd, no MCP | yes | yes | no | — | — |
| `session/load` / resume / list / fork / close | advertised | not exercised (ORCA uses load only on explicit resume) | no | — | — |
| Streaming `session/update`, turn identity | yes | partial (prompt / turn ids) | no | — | — |
| `session/cancel` → `cancelled` | yes | simulated | no | no | no |
| `authenticate` | no-op | ORCA never calls it | no | — | — |
| Permission options once/always/reject | yes | yes (real option list and mapping) | no | **no** | **no** |
| Shell / stdin / cwd binding | gaps recorded | gap reproduced | no | no | **NO-GO** |
| Client fs (`fs/*`) | mirror only | yes | no | no | no |
| Terminal (`terminal/*`) | never called | refused | no | — | — |
| Subagents | asks dropped | task denied | no | no | **NO-GO** |
| MCP | instance-wide | none passed | no | no | no |
| Config options (model/effort/mode) | advertised | error path only | no | — | — |
| macOS arm64 | artifact pinned | — | **no** | no | no |
| macOS x64, Linux x64/arm64 | artifact pinned | — | no | no | no |
| Windows | WSL recommended | — | no | no | no |
| OpenCode 2 (`@opencode/cli`) | skimmed only | — | no | no | no |

Unknown or unlisted paths are **unsupported**.

## Fixtures and tests

- [`opencode-acp-source-710.test.ts`](../../../packages/agents/test/opencode-acp-source-710.test.ts)
  is **source-function-tested**. It covers:
  - excerpt digests and pins;
  - the offered options and the outcome-to-reply mapping;
  - bridge behaviour: untracked session dropped; missing client, client error and cancelled
    answered `reject`; `always` forwarded; edit mirror;
  - tool-kind mapping;
  - defaults, last-match-wins, the isolated config's effective actions, the appended
    truncation allow, per-agent override precedence, a remembered approval outranking a
    configured deny, and subagent derivation;
  - shell stdin and ask payload, and configuration layer order.
- [`opencode-acp-fixture-710.test.ts`](../../../packages/agents/test/opencode-acp-fixture-710.test.ts)
  is **fixture-simulated**. It covers:
  - profile parsing and isolation, and that the profile is not referenced by loaded
    defaults;
  - handshake, identity and unsupported methods;
  - offered-option membership and scope (including one **counterfactual**, labelled, for
    F1);
  - changed arguments and cwd;
  - cancellation, stale and duplicate replies, and errors.
- Excerpts and the MIT licence are in
  [`tools/test/fixtures/opencode-acp-710`](../../../tools/test/fixtures/opencode-acp-710/README.md).

## Follow-up proposals (shared code — not changed here)

- **F1 — never let a rule match select a remembered option.** Done in #702:
  `resolvePermission` selects only `allow_once` for a rule-matched allow and answers
  `cancelled` (`allow:no-one-time-option`) when none is offered. The counterfactual test
  now records that refusal.
- **F2 — spawn environment control.**
  - Gaps: `LocalHost` can only add or replace variables, and there is no per-spawn secret.
  - Proposal: an opt-in `envPolicy` on `AgentSpec` (an allowlist and an ephemeral generated
    secret exposed as a named variable). That would let this profile scrub inherited
    credentials and set `OPENCODE_SERVER_PASSWORD` per launch. It is a schema change in
    `@orca/core` and `@orca/agents`, so it needs its own review.
- **F3 — `think` in the #140 defaults.**
  - Gap: `DEFAULT_PERMISSION_POLICY` allows every `think` ask, and OpenCode reports a
    subagent launch as `think`.
  - Proposal: either drop the `think` allow, or document a provider-profile rule (as this
    profile does) as required for any provider that maps a side-effecting tool to `think`.
- **F4 — cwd in execute asks.**
  - Gap: ORCA decides `execute` by title only.
  - Proposal: binding or displaying `rawInput.cwd`/`workdir` when a provider supplies it
    belongs to the #700 action contract, not to this provider.

Upstream observations are recorded here only; **nothing was submitted upstream**:

- the v1 subagent ask drop (fixed in v2 per the maintainer);
- remembered approvals outranking a configured deny;
- the unauthenticated internal server;
- the documentation/source mismatch on `.env`.

## Residual risks

- Behaviour of the installed binary is unknown: its correspondence to the source is
  unverified, as is how Bun-compiled builds differ from source.
- Shell children are unmediated and inherit ORCA's environment (F2).
- The internal HTTP server is unauthenticated (F2).
- Remembered native grants are directory-wide and invisible to ORCA.
- No installed observation of whether a denied action executes.
- No mechanism prevents a managed/MDM configuration installed *after* preflight.
- OpenCode 2 is a separate tuple; `opencode upgrade --major` would change the binary behind
  a pinned path unless the path is a verified, read-only copy.
- Excerpts are fragments. A function run with synthetic dependencies can differ from the
  composed program.
