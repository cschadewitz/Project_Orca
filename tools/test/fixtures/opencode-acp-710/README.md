# Pinned OpenCode source excerpts for #710

These are unmodified line ranges from OpenCode v1.19.4
(`anomalyco/opencode@148842ef7cb1bc34192b3fff57d0f9721ab9c801`). They are not a provider
distribution and not an executable launcher.

The [source record](../../../../docs/preparation/opencode-acp-710/source-pins.json) holds,
for each excerpt:

- the upstream path and original line range;
- the Git blob identity;
- the SHA-256 and byte length.

Tests refuse an excerpt whose digest differs.

## Which excerpts run

[`opencode-acp-710-source.ts`](../../../../packages/agents/test/opencode-acp-710-source.ts)
type-strips and imports these excerpts, with labelled synthetic dependencies:

- `acp-permission-options`
- `acp-permission-selected-reply`
- `acp-permission-process`
- `acp-tool-kind`
- `wildcard-match`
- `permission-from-config`
- `permission-evaluate`
- `agent-defaults`
- `subagent-permissions`

The synthetic dependencies are a fixed home directory, a value-returning session lookup and
recording reply/write sinks. No shell, file system, network or credential is reachable.

The remaining excerpts back source-review assertions and are only read as text:

- `acp-initialize`
- `permission-ask`
- `permission-reply`
- `agent-user-override`
- `task-ask`
- `edit-ask`
- `shell-ask`
- `shell-spawn`
- `config-*`

## Limits

Upstream source and its tests do not establish installed behaviour.

## Licence

OpenCode is MIT-licensed; the licence is retained as `license-opencode.txt`.
