# What ORCA's pre-tool hook covers, per agent

`nativeToolHook: on` (see [WORKFLOWS.md](WORKFLOWS.md#calls-the-agent-does-not-ask-about))
puts ORCA's permission policy in front of every tool call an agent hooks, not only the calls
the agent asks about (#704, #705). This page lists, per agent and pinned version, which calls
the hook sees, how the agent treats each answer and failure, and what stays outside. For an
agent ORCA installs no hook in, it lists which calls reach ORCA as permission requests and
which the agent runs on its own. Every entry says how it is known:

- **installed**: observed on the real agent by ORCA's acceptance tests, which run unattended in
  CI against a scripted stand-in for the model (`gemini-acp-acceptance.yml`);
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
| Gemini CLI 0.70.0 (`gemini --acp`), Linux | **No hook; approval tested** | `nativeToolHook: on` is refused. Shell calls and edits ask ORCA, answered with Gemini's one-time option. The read-only tools the suite ran (`list_directory`, `glob`, `read_file`), Gemini's own session and saved grants, and YOLO in a trusted workspace ran without asking ORCA; other routes are listed as unverified. |

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
| Creating a new file (`write_file`) | **Fails today**: Gemini takes only a "Resource not found" answer as a missing file, and ORCA answers with a generic error, so the write fails before Gemini asks. Being fixed in ORCA | installed |
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
