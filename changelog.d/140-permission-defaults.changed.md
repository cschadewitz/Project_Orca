- **core:** an agent that declares no `permissions:`, or leaves `default:` unset, no longer
  gets `default: allow`. The policy it gets instead allows reads, searches, edits, deletes
  and moves **inside the run's workspace** and asks about everything else — `execute`
  wherever it runs, the network, any path outside the workspace. `execute` is asked about
  because ORCA sees a shell command only as the permission title: the agents that matter run
  commands in their own process rather than through ACP's `terminal`, so there is nothing to
  scope the grant by. This is a property of the agent and not of how the run was launched, so
  one config behaves one way; `permissions: { default: allow }` is the explicit opt‑out and
  is the right thing for a sandbox. The defaults are ordinary rules appended after the
  configured ones, so a hand‑written `deny` still wins and the `orca.permissions.json`
  sidecar is still layered last (ADR 0009).
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
