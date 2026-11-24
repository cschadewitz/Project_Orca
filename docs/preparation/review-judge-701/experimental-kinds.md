# Experimental judge kinds: edits, MCP calls, commands (#701)

Status: **experimental**, each kind off by default. Active with the rest of the judge (`PLAIN_RULE_JUDGE_ACTIVE`).
Design agreed on [#701](https://github.com/cschadewitz/Project_Orca/issues/701) (Cal's answer to the
per-kind switch, and the mapping posted back).

Plain-language rules first decide only reads and searches, where ORCA has verified the real target
([Plain-language rules](plain-language-rules.md), §3). This adds three switches, each **off by
default**, that let the judge answer more kinds of ask:

```yaml
review:
  plainRules:
    judge: { provider: { kind: anthropic }, destination: "https://…", credential: judge-key }
    experimental:
      kinds:
        edits: true      # advice on file writes ORCA performs itself; the person is still asked
        mcpCalls: true   # tool calls to MCP servers ORCA runs and relays
        commands: true   # advice on command asks; the person is still asked
```

## What each kind may do

| Kind | Where it runs | What the judge's yes does | Otherwise |
| --- | --- | --- | --- |
| `edits` | ORCA's own file gate (`authorizeFs`), on a write the typed rules **ask** for | Nothing is allowed: it is recorded as advice | The person is always asked |
| `mcpCalls` | ORCA's MCP relay (`authorizeMcp`), on a tool call the typed rules **ask** for | Allows that one call, once | The person is asked, as before |
| `commands` | The ACP ask for an `execute` call | Nothing is allowed: it is recorded as advice | The person is always asked |

Common to all three:

- **Never standing.** A judge's yes on an MCP call is that one call, once. Nothing is saved as a rule or a session grant.
- **Typed rules stay in charge.** Any deny or ask rule that matches the call, a restricted command
  policy, or an MCP identity the agent only claims closes the lane before the judge is called.
  The answer is checked again against the policy as it is just before the call proceeds, and a
  removed or changed rule refuses it.
- **Bound to facts ORCA checked.** An edit must name exactly one existing workspace file that ORCA
  verified (real path, not protected, not read-only, not hard-linked), and the file's identity is
  checked again when the write starts. An MCP call is identified by the server ORCA runs and the tool
  it is relaying. Agent-side edits and agent-reported MCP identities are never judged.
- **Edits are advice only.** The judge is told which file, never what the write changes, and ORCA
  cannot tell whether a free-form criterion depends only on the path; a verified file identity does not
  establish what a write does. So, as for commands, the verdict is recorded with the ask and the person
  answers (#701 review).
- **An MCP allow is rechecked in full at the handoff.** Just before the request goes to the server, the
  whole first check runs again on the policy as it is then: the typed answer must still be ask, no deny
  or ask rule may match the call, and the same rule must still be there. A typed allow since needs no
  judge.
- **MCP rules name the tool as identifiers.** A judged MCP rule is written in the config with an
  `mcp` field, never through a title pattern, and its `match` is empty or `{ kind: other }`:

  ```yaml
  permissions:
    rules:
      - mcp: { server: notes, tool: search, arguments: [query] }
        match: {}
        judge: { criterion: "Searching my notes for anything but credentials." }
  ```

  The judge sees only the top-level arguments the rule lists, exactly as they will be sent, and each rule
  is judged against its own list: rules listing different arguments are separate judge calls. Every
  listed name, and every string inside each value, is checked for a session secret before anything is
  serialized, and the serialized text once more. If one holds a secret, which the judge could only see
  redacted, those rules are left to the person. A saved
  (sidecar) rule cannot name an MCP tool, and no other lane reads an MCP rule.
- **Each kind its own disclosure.** Each kind has its own request format
  (`orca-plain-rule-request/edit/v1`, `…/mcp/v1`, `…/command/v1`), prompt and grant. The owner grants
  them separately: `orca auth issue --judge-disclosure --judge-disclosure-kind edits
  --judge-disclosure-kind mcp-calls`. A kind that is switched on without its grant is left out, and its
  calls take the existing path; the read judge still works.
- **Only with the read judge.** The kinds ride with the plain-rule judge; without it they do nothing.
- **Recorded.** Each decision record carries the judge's `kind`, and command advice is marked
  `advisory: true`.

MCP arguments are screened like the title before sending, and anything over the size limit is refused
rather than cut short, so the person is asked.
