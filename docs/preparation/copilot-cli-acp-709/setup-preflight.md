# Copilot CLI ACP — setup and preflight (#709)

Contributor guidance for a person who has chosen, and is entitled, to try the
[inactive profile](orca.copilot-acp.example.yaml). It follows the
[#386 launch rules](../../archive/preparation/configuration-launch-implementation/launch.md): no silent install,
no credential capture, no standing permission grant, and a real provider run only after
separate authorization and preflight. **None of the commands below was run for this
packet**; they are the reproducible procedure, and every one that downloads, executes or
authenticates is an installed-validation step.

## 0. Decide before installing

- **Entitlement and payer.** Copilot CLI needs an active Copilot plan, or BYOK. For an
  organization seat, the organization must enable the Copilot CLI policy. Each prompt
  consumes the payer's Copilot usage; ORCA cannot show cost or remaining quota. Name the
  account, the payer and a budget before the first turn.
- **Workspace.** Use a disposable checkout with no secrets for the first runs. Copilot reads
  `AGENTS.md`, `.github/copilot/settings*.json`, `.github/hooks/`, `.claude/settings*.json`,
  `.github/allowed_models.txt` and workspace MCP configuration from it (README, *Environment
  and configuration layers*).
- **Target.** `@github/copilot` (CLI). Not `@github/copilot-language-server`.

## 1. Pinned, verifiable artifact (macOS arm64)

Fetch only the platform package, verify it against the recorded integrity, and unpack it into
a version-named directory you own (not world-writable). `npm pack` downloads a tarball and
runs no package scripts.

```sh
PREFIX=/absolute/user-owned/prefix
DEST="$PREFIX/github-copilot-cli/1.0.103/node_modules/@github/copilot-darwin-arm64"
WORK="$(mktemp -d)"
( cd "$WORK" && npm pack @github/copilot-darwin-arm64@1.0.103 )
# Must print: sha512-5upfa7UdJJQbRRfyrYqaZ81xy0SSXba8HNRNwJYVw1NuONFFt3u7FzPBQJ/XpB/1m/YGPmmK4XRgITAF4oAu+A==
printf 'sha512-%s\n' "$(openssl dgst -sha512 -binary "$WORK/github-copilot-darwin-arm64-1.0.103.tgz" | openssl base64 -A)"
mkdir -p "$DEST" && tar -xzf "$WORK/github-copilot-darwin-arm64-1.0.103.tgz" --strip-components=1 -C "$DEST"
codesign --verify --strict --verbose=2 "$DEST/copilot"   # record the result and signing identity
```

Stop if the integrity differs. Linux x64 uses `@github/copilot-linux-x64@1.0.103`
(`sha512-9qNrzrec…`, see [source-pins.json](source-pins.json)) and the matching path in the
profile. The npm loader, Homebrew, WinGet and the install script are documented alternatives,
but they resolve "latest" unless pinned, and the script's checksum check is skipped when
`SHA256SUMS.txt` cannot be fetched.

## 2. Isolated Copilot profile

```sh
mkdir -m 700 -p "$PREFIX/github-copilot-cli/profile"
```

This becomes `COPILOT_HOME`: its own `settings.json`, `permissions-config.json`, hooks, MCP
configuration, `providers.json`, logs and session state. Do not copy an existing
`~/.copilot` into it; ambient permissive settings are not ORCA policy.

## 3. User-controlled authentication

Run the login yourself, with the same `COPILOT_HOME` ORCA will use:

```sh
COPILOT_HOME="$PREFIX/github-copilot-cli/profile" "$DEST/copilot" login
```

The OAuth token goes to the macOS Keychain (service `copilot-cli`). Do not write a token into
ORCA configuration, issue text, logs or exported config. Start the ORCA daemon from an
environment **without** `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`,
`COPILOT_PROVIDER_*` or a truthy `COPILOT_ALLOW_ALL`: `LocalHost` passes the daemon's
environment through, and an inherited token silently overrides the login above (README P2).
`gh auth token` is the lowest-priority fallback if nothing else is found.

## 4. Profile

Copy [orca.copilot-acp.example.yaml](orca.copilot-acp.example.yaml)'s agent into the
workspace's `orca.config.yaml` and replace both `/REPLACE-WITH-ABSOLUTE-PREFIX` values with
`$PREFIX`. Then confirm every row:

| Check | Why |
| --- | --- |
| `command` is the absolute path under `…/1.0.103/…` | No PATH lookup, no `npx`, no later global install swaps the binary |
| `args` contain `--acp`, `--stdio`, `--no-auto-update`; no `--port` | ORCA speaks stdio; the version must not move |
| No `--allow-all*`, `--yolo`, `--allow-tool`, `--allow-url`, `--autopilot`, `--mode autopilot`, `--no-sandbox`, `--trust-folder` | Each grants, widens or skips asking |
| `env.COPILOT_HOME` is the isolated absolute path | No ambient approvals or hooks |
| `env.COPILOT_ALLOW_ALL: "false"`, `env.COPILOT_PLAN_THEN_AUTOPILOT: "false"`, `env.COPILOT_AUTO_UPDATE: "false"` | Override inherited values |
| No token variable in `env` | Config is not a secret store (#336 owns secret references) |
| `hostId: local` | Only the local stdio child is prepared |

The offline test suite applies the same checks to the example (`copilotProfileFindings` in
[the fixture](../../../packages/agents/test/fixtures/copilot-cli-acp.ts)); it is test-only
and not wired into ORCA.

Also record, without changing them, any managed policy on the machine:
`/Library/Application Support/GitHubCopilot/managed-settings.json`, the `com.github.copilot`
configuration profile, and `/etc/github-copilot/policy.d/*.json` (policy hooks always run).

## Remaining installed validation

Each step needs its own authorization, the named payer and budget, the disposable workspace,
and benign effects. Record exact commands, outputs (with credentials redacted), timestamps,
artifact hashes, skipped steps and cleanup.

1. Artifact: integrity and `codesign` result from step 1; `"$DEST/copilot" --version` reports 1.0.103.
2. Handshake: actual `initialize` response — protocol version, capabilities, `agentInfo`, auth method IDs.
3. Unauthenticated `session/new` returns `-32000` and ORCA reports `AGENT_PROTOCOL`.
4. Authenticated `session/new`: session ID, advertised config options (model, mode, effort, `allow_all`), `available_commands_update` contents — in particular whether `/allow-all`, `/yolo`, `/permissions` or `/reset-allowed-tools` are advertised.
5. One text-only turn ("reply with the word ok", tools excluded with `--available-tools=""` if accepted): streaming order, `usage_update`, stop reason.
6. Cancellation during a long text turn, then during a pending permission ask: what Copilot returns, and that nothing continues afterwards.
7. One benign permission ask per kind (an in-workspace file create, a harmless shell command such as `echo`, a URL fetch to a test host): actual option IDs, kinds and names; then, per option, what changed in `permissions-config.json`, `settings.json` and later asks in the same and a new session.
8. Unsupported methods: whether Copilot ever sends `terminal/*`, `elicitation/*` or custom requests to ORCA, and how it behaves after `-32601`.
9. Cleanup: delete the disposable workspace, `COPILOT_HOME` and the Keychain item if not kept; revoke the OAuth app authorization if not kept.

Steps 7 onward begin support level B and belong with #705's provider qualification; any
stronger guard claim needs #700 and #706 for this exact tuple.
