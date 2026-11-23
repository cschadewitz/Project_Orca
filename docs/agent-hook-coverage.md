# What ORCA's pre-tool hook covers, per agent

`nativeToolHook: on` (see [WORKFLOWS.md](WORKFLOWS.md#calls-the-agent-does-not-ask-about))
puts ORCA's permission policy in front of every tool call an agent hooks, not only the calls
the agent asks about (#704, #705). This page lists, per agent and pinned version, which calls
the hook sees, how the agent treats each answer and failure, and what stays outside. Every
entry says how it is known:

- **installed**: observed on the real agent by ORCA's acceptance tests, which run unattended in
  CI against a scripted stand-in for the model (`claude-hook-acceptance.yml`,
  `codex-hook-acceptance.yml`);
- **source**: read in the agent's source at the pinned version, not exercised;
- **unknown**: not established, and treated as not covered.

An agent, version or platform not listed here is refused while `nativeToolHook: on`.

## Coverage tiers

| Agent (pinned) | Tier | In short |
| --- | --- | --- |
| Claude ACP adapter 0.109.1 running Claude Code 2.1.330 (the image the session's runtime process runs), Linux x64 | **Fail-closed** | Every built-in tool and MCP tool is hooked; a hook that cannot start, crashes, times out or answers garbage blocks. ORCA's `ask` reaches ORCA as a permission request. |
| Codex ACP adapter 2.9.0 running Codex 0.171.0 (the image the process the adapter started runs), Linux x64 | **Deny-enforced, opened only after a probe** | Shell, patches, MCP tools and image reads are hooked; ORCA's deny and ask both block. Codex lets a call through when its hook runner fails, so ORCA checks the hook is trusted and blocks before the session opens. Typed stdin and hosted search are outside. |
| Gemini CLI, pi | **None yet** | Refused while `nativeToolHook: on`. |

## Claude (`@agentclientprotocol/claude-agent-acp` 0.109.1)

| What | Behaviour | Known by |
| --- | --- | --- |
| Calls hooked | Every tool call (`matcher: "*"`), including ones Claude remembers as allowed | installed |
| ORCA allow | Exit 0, no output: Claude's own check runs | installed |
| ORCA ask | `permissionDecision: "ask"`: Claude sends `session/request_permission` to ORCA | installed |
| ORCA deny | `permissionDecision: "deny"`: nothing runs | installed |
| Hook cannot start, exits 1 or 3, times out, prints JSON Claude cannot validate | Blocked (`onFailure: "block"`) | installed |
| Hook exits 0 printing non-JSON | Claude lets the call through. ORCA's program cannot do this (its output guard turns stray stdout into exit 2) | installed |
| Adapter runs another Claude Code (`CLAUDE_CODE_EXECUTABLE`) | Refused before any work: a session-start hook records its own process, ORCA checks that process is under the agent it started and hashes the image it runs, accepting only the digest pinned for the adapter (`CLAUDE_HOOK_VERIFIED_PAIRS`). Nothing it records is executed | installed (2.1.329 refused) |
| Outside the hook | What a shell command touches beyond its own text; ORCA's protected-path rules and Claude's sandbox still apply | by design |

## Codex (`@agentclientprotocol/codex-acp` 2.9.0, Codex 0.171.0)

ORCA hands Codex its hook through `CODEX_CONFIG`, which the adapter passes to Codex as session
flags, with Codex's trust for it recorded beside it (`hooks.state`), so nothing is written to
the user's Codex config. Codex runs the hook through `$SHELL -lc`.

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
| Login shell cannot run the hook, or runs something else | Codex lets calls through. ORCA runs the hook's command once the same way at session start, on a call it must block with a fresh nonce, and refuses unless it exits 2 **and** writes the receipt the hook signs for that nonce with a key only the session's context file holds. Another program that exits 2, or echoes the call back, has no receipt | unit-tested; the shell is the user's |
| Agent's own `CODEX_CONFIG` sets hooks | Refused: ORCA does not reorder somebody else's hooks | installed |
| Adapter runs another Codex (`CODEX_PATH`) | Refused before the session is created: ORCA finds the Codex app-server among the agent's own processes and hashes the image it runs, accepting only the digest pinned for the adapter (`CODEX_HOOK_VERIFIED_PAIRS`). Nothing it finds is executed | installed (0.170.0 refused) |

## Gemini CLI and pi

Not supported yet; refused while `nativeToolHook: on`. What is known so far (#743, #747):

- **Gemini CLI 0.70** (source): a `BeforeTool` hook fires at execution, after confirmation, for
  every executed tool. `deny`/`block` blocks; exit 1 is a non-blocking error (the call runs);
  exit 2 or higher blocks; the default timeout is 60 s and counts as an error.
- **pi** (source): tools pass through an extension's `tool_call` hook, which can block or
  rewrite a call; later command-prefix and spawn hooks can still change what finally runs.
