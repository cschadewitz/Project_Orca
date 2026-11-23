# What ORCA's pre-tool hook covers, per agent

`nativeToolHook: on` (see [WORKFLOWS.md](WORKFLOWS.md#calls-the-agent-does-not-ask-about))
puts ORCA's permission policy in front of every tool call an agent hooks, not only the calls
the agent asks about (#704, #705). This page lists, per agent and pinned version, which calls
the hook sees, how the agent treats each answer and failure, and what stays outside. For an
agent ORCA installs no hook in, it lists which calls reach ORCA as permission requests and
which the agent runs on its own. Every entry says how it is known:

- **installed**: observed on the real agent by ORCA's acceptance tests, which run unattended in
  CI against a scripted stand-in for the model (`claude-hook-acceptance.yml`,
  `codex-hook-acceptance.yml`, `gemini-acp-acceptance.yml`, `pi-acp-acceptance.yml`);
- **source**: read in the agent's source at the pinned version, not exercised;
- **unknown**: not established, and treated as not covered.

An agent, version or platform not listed here is refused while `nativeToolHook: on`.

Support levels, lowest first: **source reviewed**; **connectivity tested** (an ORCA session
opens, streams, is cancelled and closes on the installed agent); **approval tested** (on the
installed agent, an ORCA allow runs once and asks again, a deny or a cancelled ask does not
run, and the calls that never ask are listed); **execution-guard certified** (the #706
acceptance suite passes; none yet).

## Coverage tiers

| Agent (pinned) | Tier | In short |
| --- | --- | --- |
| Claude ACP adapter 0.109.1 running Claude Code 2.1.330 (the image the session's runtime process runs), Linux x64 | **Fail-closed** | Every built-in tool and MCP tool is hooked; a hook that cannot start, crashes, times out or answers garbage blocks. ORCA's `ask` reaches ORCA as a permission request. |
| Codex ACP adapter 2.9.0 running Codex 0.171.0 (the image the process the adapter started runs), Linux x64 | **Deny-enforced, opened only after a probe** | Shell, patches, MCP tools and image reads are hooked; ORCA's deny and ask both block. Codex lets a call through when its hook runner fails, so ORCA checks the hook is trusted and blocks before the session opens. Typed stdin and hosted search are outside. |
| Gemini CLI 0.70.0 (`gemini --acp`), Linux | **No hook; approval tested** | `nativeToolHook: on` is refused. Shell calls and edits ask ORCA, answered with Gemini's one-time option. The read-only tools the suite ran (`list_directory`, `glob`, `read_file`), Gemini's own session and saved grants, and YOLO in a trusted workspace ran without asking ORCA; other routes are listed as unverified. |
| pi 1.6.0 through `pi-acp` 0.0.35, Linux | **No hook; connectivity tested; outside ORCA policy** | `nativeToolHook: on` is refused. pi runs every tool call without asking ORCA, so ORCA's rules and protected files do not apply. A pi extension's own dialogs reach ORCA, but they are not ORCA tool approvals. **Requires an OS sandbox.** |

## Claude (`@agentclientprotocol/claude-agent-acp` 0.109.1)

| What | Behaviour | Known by |
| --- | --- | --- |
| Calls hooked | Every tool call (`matcher: "*"`), including ones Claude remembers as allowed | installed |
| ORCA allow | Exit 0, no output: Claude's own check runs | installed |
| ORCA ask | `permissionDecision: "ask"`: Claude sends `session/request_permission` to ORCA | installed |
| ORCA deny | `permissionDecision: "deny"`: nothing runs | installed |
| Hook cannot start, exits 1 or 3, times out, prints JSON Claude cannot validate | Blocked (`onFailure: "block"`) | installed |
| Hook exits 0 printing non-JSON | Claude lets the call through. ORCA's program cannot do this (its output guard turns stray stdout into exit 2) | installed |
| MCP servers | ORCA runs them and serves them over the ACP connection; Claude Code gets a name and an id, never a command or environment, and a server starts only after the session is admitted. Their tools are hooked as `mcp__<server>__<tool>`, and ORCA checks each request again when it relays it: a tool call only in the live turn and as ORCA's rules decide it then, other than listing nothing else is relayed, and each request and start has a deadline. Allowed, the call reaches the server; denied, it never does | installed (relay checks unit-tested) |
| Adapter runs another Claude Code (`CLAUDE_CODE_EXECUTABLE`) | Refused before any work: a session-start hook records its own process, ORCA checks that process is under the agent it started and hashes the image it runs, accepting only the digest pinned for the adapter (`CLAUDE_HOOK_VERIFIED_PAIRS`). Nothing it records is executed | installed (2.1.329 refused) |
| Outside the hook | What a shell command touches beyond its own text; ORCA's protected-path rules and Claude's sandbox still apply | by design |

## Codex (`@agentclientprotocol/codex-acp` 2.9.0, Codex 0.171.0)

ORCA hands Codex its hook through `CODEX_CONFIG`, which the adapter passes to Codex as session
flags, with Codex's trust for it recorded beside it (`hooks.state`), so nothing is written to
the user's Codex config. Codex runs the hook as `<login shell> -c <command>`, where the login
shell is the account's in the user database (not `$SHELL`), in Codex's own environment with
its `codex-path` directory put first on `PATH`; the acceptance suite records both from the hook
shell itself.

The acceptance suite starts the adapter in its full-access mode (`INITIAL_AGENT_MODE`), with
no sandbox and no asks of Codex's own, so that each row below is the hook's doing alone. The
adapter's default mode adds Codex's workspace sandbox and its own reviewer on top; neither
replaces the hook, which runs before them.

| What | Behaviour | Known by |
| --- | --- | --- |
| Shell (`exec_command`) | Hooked, as `tool_name: "Bash"` with the command | installed |
| Patches (`apply_patch`) | Hooked, with the patch text; ORCA reads the file headers as Codex does | installed |
| MCP tools | Hooked, as `mcp__<server>__<tool>` | installed |
| `view_image` | Hooked, with the path | installed (manually) |
| Text typed into a running command (`write_stdin`) | **Not hooked**: a command ORCA allowed can be fed further input unseen | installed |
| Hosted web search | Runs at the model provider, not hooked; ORCA turns it off (`web_search: "disabled"`) | installed |
| ORCA allow | Exit 0, no output: Codex's approval and sandbox still apply | installed |
| ORCA deny, ORCA ask | Exit 2 with the reason on stderr: blocked. Codex's own `ask` answer lets the call run, so ORCA never sends it | installed |
| Hook exits 1, exits 2 with nothing on stderr, prints output Codex cannot read, times out (ORCA sets 30 s) | **Codex lets the call through.** ORCA's program answers only with exit 0, or exit 2 and a reason, including when it fails | installed (exit codes), source (timeout) |
| Hook not trusted (hash changed, config turned it off) | Not run, so not blocking. ORCA asks the adapter (`_codex/hooks/list`) at session start and refuses unless ORCA's hook is listed trusted and enabled | installed |
| The shell cannot run the hook, or runs something else | Codex lets calls through. ORCA runs the hook's command once the same way at session start, on a call it must block with a fresh nonce, and refuses unless it exits 2 **and** writes the receipt the hook signs for that nonce with a key only the session's context file holds. Another program that exits 2, or echoes the call back, has no receipt. The receipt shows possession of that context and a block for that call, not which program answered: a process under the same OS account could read the file too. The probe's deadline refuses the session even if something the command started keeps its streams open. The probe runs in Codex's hook shell and the environment read off the Codex process (both checked against the real Codex), and its refusal names how it ended | unit-tested; installed (shell and environment) |
| Agent's own `CODEX_CONFIG` sets hooks | Refused: ORCA does not reorder somebody else's hooks | installed |
| Adapter runs another Codex (`CODEX_PATH`) | Refused before the session is created: ORCA finds the Codex app-server among the agent's own processes and hashes the image it runs, accepting only the digest pinned for the adapter (`CODEX_HOOK_VERIFIED_PAIRS`). Nothing it finds is executed | installed (0.170.0 refused) |

## Gemini CLI (`@google/gemini-cli` 0.70.0)

ORCA installs nothing in Gemini and decides only what Gemini asks about
(`session/request_permission`). The recommended launch profile gives the agent a Gemini home
of its own, so nothing the user saved in `~/.gemini` applies, and leaves the workspace
untrusted, which keeps Gemini in its default mode:

```yaml
  - id: gemini
    command: gemini
    args: [--acp]
    env:
      GEMINI_CLI_HOME: /path/to/an/orca-only/gemini-home
      GEMINI_API_KEY: { secret: gemini-api-key }
```

`orca agents` shows an advisory under each Gemini agent: the known settings it can see in
the agent's command line and environment that let calls run without asking ORCA
(`geminiCliFindings` in `packages/agents/src/agent-profiles/gemini-cli.ts`). It is not a hook
or a guard, and it reads no file, so it cannot see what a Gemini home, system settings, an
extension or a trusted-folders list allows. An empty advisory does not mean nothing does.

| What | Behaviour | Known by |
| --- | --- | --- |
| Session | Opens with no `authenticate` call when the key or gateway is in the environment; streams the turn; a cancel while Gemini waits on ORCA ends the turn `cancelled` and the call does not run | installed |
| Shell (`run_shell_command`) | Asks ORCA, `kind: "execute"`, title = the command. Offers `proceed_always` (session), `proceed_once`, `cancel` | installed |
| ORCA allow | Answered `proceed_once`: runs once, and the same call asks again | installed |
| ORCA deny, a person's refusal | Answered `cancel`: does not run | installed |
| Edit of an existing file (`write_file`) | Gemini reads the file through ORCA's `fs/read_text_file`, asks ORCA (`kind: "edit"`), then writes through `fs/write_text_file`; ORCA decides each file operation too (#703) | installed |
| Creating a new file (`write_file`) | **Fails**: Gemini checks whether the file exists by reading it through ORCA. ORCA answers ACP's not-found error (#1006), but Gemini 0.70.0 recognises a missing file only from a JavaScript `Error`, and its ACP connection hands it the plain JSON-RPC error, so the write fails before Gemini asks. A Gemini-side gap; editing an existing file works | installed (error shape: source) |
| `list_directory`, `glob`, `read_file` | **Never ask**: ran without a permission request; the `read_file` run made no `fs/*` call to ORCA either | installed |
| Other read-only tools (`grep_search`, `read_many_files`, web fetch, …) and other native reads | Not run; whether they ask, and whether they read through ORCA, is not established | unknown |
| "Allow for this session" (`proceed_always`) | Gemini stops asking for the **whole command prefix** for the rest of the session (`echo a` grants `echo b`). ORCA never answers with it, and ORCA's engine offers a person only the one-time pair | installed |
| `proceed_always_and_save` | Writes an allow rule for the prefix to `<Gemini home>/.gemini/policies/auto-saved.toml`, used by every later session. Gemini accepts it even when the request did not offer it; ORCA answers only with an option the request offered | installed (unoffered id), source |
| A saved policy in the Gemini home | Matching calls run without asking ORCA | installed |
| `--yolo`, `--approval-mode yolo\|auto_edit`, `session/set_mode` | Ignored while the workspace is untrusted: Gemini keeps its default mode. In a trusted workspace (`--skip-trust`, `GEMINI_CLI_TRUST_WORKSPACE=true`, or a trusted folder in the user's home) the calls run without asking ORCA | installed (YOLO), source (others) |
| `--allowed-tools`, `--policy`, `--admin-policy` | The tools or rules they name run without asking ORCA | source |
| Trusted workspace | Its `.gemini/settings.json`, policies and hooks apply, so a repository can carry them | source |
| What is already in the Gemini home the profile names, system settings (`/etc/gemini-cli`), installed extensions, the trusted-folders list | Not inspected by ORCA or by the advisory; the suite starts each run from an empty home. Treated as able to allow calls ORCA never sees | unknown |
| MCP tools | Ask ORCA with Gemini's server and tool in `_meta`; their session options cover the server or the tool | source |
| `nativeToolHook: on` | Refused before the session starts. Gemini's `BeforeTool` hook (exit 2 blocks, exit 1 lets the call run, 60 s timeout) is the candidate for tier C, after #706 | source |

## pi (`pi-acp` 0.0.35 with `@earendil-works/pi-coding-agent` 1.6.0)

pi does not ask before tool calls (its own `docs/security.md`), and `pi-acp` serves no file
operation through ORCA. ORCA runs pi anyway and says so: the `orca agents` advisory reports "pi runs every
tool call without asking" for every pi agent. The boundary for pi is an operating-system
sandbox, not ORCA's policy.

**Requirement: run pi only inside an operating-system sandbox** (a container or VM that holds
only what pi may read, change and reach). ORCA does not create or check that sandbox. pi is
connectivity tested, not approval tested: no pi tool call is approved or denied by ORCA, and an
extension dialog that reaches ORCA is the extension's question, not an ORCA tool approval.

The recommended launch profile gives pi an agent directory of its
own and pins the pi that `pi-acp` starts:

```yaml
  - id: pi
    command: pi-acp
    env:
      PI_CODING_AGENT_DIR: /path/to/an/orca-only/pi-agent
      PI_ACP_PI_COMMAND: /path/to/pi
```

| What | Behaviour | Known by |
| --- | --- | --- |
| Session | Opens and streams; a cancel during a running command ends the turn `cancelled` and stops the command | installed |
| Shell (`bash`), file writes (`write`) | **Run without asking ORCA**, even under `default: deny`; no `fs/*` call reaches ORCA | installed |
| pi's other tools (`read`, `edit`, …), MCP tools | Not run by the suite. pi's docs say no tool asks before it runs | source |
| ORCA's own files | **Not protected**: pi wrote `.orca/permissions.json` in the workspace | installed |
| An extension's `ctx.ui.confirm` (the one the suite installs) | Reaches ORCA as a permission request on a synthetic `pi-ui-*` call of kind `other`, options `yes`/`no`; the extension gets the answer and decides. Not an ORCA tool approval: the call behind it stays outside ORCA's policy. `select` maps to `choice-<n>` options (source). An ORCA rule allowing kind `other` answers "yes" unattended | installed |
| Settings outside ORCA | Without `PI_CODING_AGENT_DIR`, the user's `~/.pi/agent` applies: settings, extensions, saved project trust, credentials. A trusted project loads its own `.pi` extensions | source |
| What is already in the agent directory the profile names, installed extensions and packages, saved project trust | Not inspected by ORCA or by the advisory; the suite starts each run from an agent directory holding only the stand-in's model settings | unknown |
| Which pi runs | `pi-acp` reports only its own version; it starts `PI_ACP_PI_COMMAND`, else `pi` on `PATH` | source |
| `nativeToolHook: on` | Refused before the session starts. pi's extension `tool_call` hook can block or rewrite a call, but later command-prefix and spawn hooks can still change what runs (#747); the candidate for tier C, after #706 | source |
