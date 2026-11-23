# Experimental judge kinds: edits, MCP calls, commands (#701)

Status: **inactive**. Built behind `PLAIN_RULE_JUDGE_ACTIVE = false`, like the rest of the judge.
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
        edits: true      # file writes ORCA performs itself (fs/write_text_file)
        mcpCalls: true   # tool calls to MCP servers ORCA runs and relays
        commands: true   # advice on command asks; the person is still asked
```

## What each kind may do

| Kind | Where it runs | What the judge's yes does | Otherwise |
| --- | --- | --- | --- |
| `edits` | ORCA's own file gate (`authorizeFs`), on a write the typed rules **ask** for | Allows that one write, once | The person is asked, as before |
| `mcpCalls` | ORCA's MCP relay (`authorizeMcp`), on a tool call the typed rules **ask** for | Allows that one call, once | The person is asked, as before |
| `commands` | The ACP ask for an `execute` call | Nothing is allowed: it is recorded as advice | The person is always asked |

Common to all three:

- **Never standing.** A judge's yes is one call, once. Nothing is saved as a rule or a session grant.
- **Typed rules stay in charge.** Any deny or ask rule that matches the call, a restricted command
  policy, or an MCP identity the agent only claims closes the lane before the judge is called.
  The answer is checked again against the policy as it is just before the call proceeds, and a
  removed or changed rule refuses it.
- **Bound to facts ORCA checked.** An edit must name exactly one workspace file that ORCA verified
  (real path, not protected, not read-only, not hard-linked; a new file does not qualify yet). An MCP
  call is identified by the server ORCA runs and the tool and arguments it is relaying, and only a
  judged rule whose `titlePattern` is exactly `^<server>: <tool>$` (optionally with kind `other`) can
  answer it. Agent-side edits and agent-reported MCP identities are never judged.
- **Each kind its own disclosure.** Each kind has its own request format
  (`orca-plain-rule-request/edit/v1`, `…/mcp/v1`, `…/command/v1`), prompt and grant. The owner grants
  them separately: `orca auth issue --judge-disclosure --judge-disclosure-kind edits
  --judge-disclosure-kind mcp-calls`. A kind that is switched on without its grant is left out, and its
  calls take the existing path; the read judge still works.
- **Only with the read judge.** The kinds ride with the plain-rule judge; without it they do nothing.
- **Recorded.** Each decision record carries the judge's `kind`, and command advice is marked
  `advisory: true`.

MCP arguments are sent to the judge with the session's secret values replaced, and screened like the
title before sending.
