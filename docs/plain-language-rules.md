# Plain-language permission rules

A plain-language rule lets you write a permission rule as a sentence instead of a pattern:

```yaml
agents:
  - id: claude
    command: claude-code-acp
    permissions:
      default: ask
      rules:
        - match: { kind: read, scope: workspace }
          judge:
            criterion: "Reading source, tests and docs, but never .env files, keys or credentials."
```

A small hosted model, called the judge, runs on your own API key. When ORCA is about to read a file for an agent and none of your written rules allows it, the judge decides whether your sentence covers that read. A yes allows that one read, once. Anything else goes to you, as it would without the rule.

It is off until you turn it on (`review.plainRules.enabled: true`, below). A config written before this version has no `enabled`, so nothing changes on upgrade.

You can also write and edit these rules in the app, on the Agents surface's permission panel, under "Plain-language rules".

## What the judge can and cannot do

- **It only adds allows, and only one call at a time.** A judge never denies anything and never saves a standing grant. Every call it does not allow goes to you.
- **Your written rules decide first.** If any deny or ask rule matches the call anywhere in the policy, the judge is not asked. ORCA's own protected files are never opened.
- **Only reads ORCA performs itself.** The judge may allow a read that the agent asks ORCA to do (`fs/read_text_file`), of a single regular file ORCA resolved inside the workspace and then reads, bound to that file. A read or search the agent does itself and only asks permission for goes to you, because ORCA cannot show the agent reads the file the judge was shown. Commands, writes, fetches, links and anything on a remote host go to you too.
- **It is checked again before the call proceeds.** If the rule or the file changed while the judge was deciding, the yes no longer applies and you are asked. The ask says so.
- **The judge sees only what it needs.** It sees your rule's sentence and ORCA's own description of the call: its kind, a label ORCA writes (such as `Read docs/a.md`) and the workspace-relative path. It never sees file contents, absolute paths, the agent's own wording or the agent's conversation. If any part of that description would contain one of the session's secret values, nothing is sent and the call goes to you. Its answers are fixed verdicts and reason codes, never free text.

When the app asks you about a call the judge looked at, the card shows what the judge said and why.

## Setting it up

The judge is off for a session until all five of these are in place. The Config surface's "Plain-language rule judge" checklist shows which are done.

1. **Configure the judge** in `orca.config.yaml`:

   ```yaml
   secrets:
     judge-key: { host: local, provider: env, name: ORCA_JUDGE_KEY, destination: "https://api.anthropic.com/v1/messages" }
   review:
     plainRules:
       enabled: true                        # your opt-in: absent or false, nothing is sent
       judge:
         provider: { kind: anthropic }      # or { kind: openai-compatible, model: <name> }
         destination: https://api.anthropic.com/v1/messages
         credential: judge-key
         limits: { timeoutMs: 5000, maxCallsPerDay: 200 }   # the defaults
   ```

   The key's secret must be pinned to the judge's exact `destination`. ORCA sends it only there, and no agent or MCP server can be given it.

   `enabled: true` is your opt-in to automatic decisions, and step 5 below. Changing anything under `review.plainRules` through the app or the daemon needs the same `permissions.grant` authority as changing a plain-language rule.
2. **Set the key** in the daemon's environment, under the variable the secret names (`ORCA_JUDGE_KEY` above).
3. **Grant disclosure.** An owner issues the credential your runs use with `--judge-disclosure`. This approves sending the call's description to that judge. Give that credential only what its runs need: keep the default `client` preset, narrow it with `--workflow-scope` and `--runs-scope owned` where you can, and don't use the `owner` preset for it. For example:

   ```sh
   orca auth issue <principal> --workflow-scope <workflow> --runs-scope owned --judge-disclosure
   ```

   See `orca auth issue --help` for the other flags. The grant names the configured destination and provider exactly. If you change either, issue a new one. The daemon must run in token mode, because the loopback mode keeps no grants.
4. **Create the daily budget** on the daemon's machine:

   ```sh
   orca judge budget init
   ```

   The budget caps the judge at `maxCallsPerDay` across restarts. The day you create it counts as spent, so the judge first answers the next UTC day. The budget needs Linux or macOS. On Windows the judge is not available in this version. If the store is restored from a backup, the budget is refused until you run `orca judge budget reset`.

5. **Turn it on** with `enabled: true` (step 1). Each run keeps the settings it started with.

If any step is missing, sessions open without a judge and every ask goes to you.

## Turning it off

Set `review.plainRules.enabled: false`, or remove it. New runs get no judge and nothing is sent; a run already going keeps the settings it started with, and stops getting a judge for new sessions as soon as its settings no longer match the active configuration. To stop sends for good, also revoke the credential that carries the disclosure grant (`orca auth revoke <credentialId>`), or issue a new one without `--judge-disclosure`.

## Experimental kinds

Three more kinds of call can be shown to the judge. Each is off by default and needs its own grant (`--judge-disclosure-kind edits|mcp-calls|commands`):

- `edits` and `commands`: the judge's view is shown with the ask as advice. You still answer.
- `mcpCalls`: a rule naming an MCP server and tool that ORCA runs and relays can allow that one relayed call, once.

All three also need `enabled: true`.

See [experimental-kinds.md](preparation/review-judge-701/experimental-kinds.md) for the details, and [plain-language-rules.md](preparation/review-judge-701/plain-language-rules.md) for the design.
