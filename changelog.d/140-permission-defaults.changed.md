- **core:** an agent that declares no `permissions:`, or declares one and leaves `default:`
  unset, no longer gets `default: allow`. The policy it gets instead allows reads, searches, edits, deletes
  and moves **inside the run's workspace** and asks about everything else — `execute`
  wherever it runs, the network, any path outside the workspace. `execute` is asked about
  because ORCA sees a shell command only as the permission title: the agents that matter run
  commands in their own process rather than through ACP's `terminal`, so there is nothing to
  scope the grant by. This is a property of the agent and not of how the run was launched, so
  one config behaves one way. The defaults are ordinary rules and they are the **last** layer:
  configured rules are matched first, then `orca.permissions.json`, then these, and then
  `default:` decides whatever none of them matched. So a hand‑written `deny` still wins, and a
  `reject_always` recorded in the sidecar beats the default allow that made the prompt appear
  (ADR 0009). Spelling the default rules out in your own `rules:` is not a no‑op: it moves them
  ahead of the sidecar, where a recorded `reject_always` can no longer reach them.
- **core:** **writing `default:` at all opts an agent out of those default rules** — `ask`
  exactly as much as `allow`. `permissions: { default: ask }` with no rules now means what it
  says: ask about everything, in‑workspace reads included; it is no longer the same policy as
  leaving `permissions:` off. `permissions: { default: allow }` is the other end and is the
  right thing for a sandbox. If you had `default: ask` written down and want the workspace
  allows back, delete the line.
- **core:** `orca.config.yaml` parses to exactly what it says. The default rules used to be
  injected into the parsed config, so anything that read it back — `orca demo`'s generated
  config, `config.get`'s per‑rule provenance — reported rules nobody had written as if an
  operator had written them.
- **core:** a permission rule can match on `scope: workspace | outside-workspace` — whether
  every location of the tool call is inside the run's workspace or any of them is not. It is
  the one match that needs no path written down, because the path it is about is the run's
  own. A call with no locations at all matches neither and falls through to `default`.
- **engine:** `humanInput: { mode: auto }` refuses an agent `ask` permission rather than
  answering it with the agent's first option. A permission request's options are the agent's,
  in the agent's order, and the first of them is conventionally "allow once" — so taking it
  turned every `ask` in an unattended run back into an `allow`. Gates and questions are
  unchanged, and `option:` still answers a permission when it names an id the agent offered.
- **agents:** an `ask` that has no human-input channel at all is now recorded as
  `ask:no-answerer` rather than a bare `ask:cancelled`, because "the policy wanted a person
  and there was none" is the one a reader of the log has to act on. It was already refused
  rather than parked — a permission cannot outlive the session that raised it — so it fails
  the tool call and not the run.
- **agents:** the ACP session evaluates the *effective* policy rather than the configured one.
  It read `agents[].permissions` straight from the parsed config, which was right only for as
  long as parsing injected the default rules into it; now that they are an explicit layer,
  `openAcpSession` applies it. Without this an agent with no `permissions:` block would have
  been asked about reading files in its own workspace.
