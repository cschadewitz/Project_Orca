# #709 GitHub Copilot CLI ACP — inactive, version-pinned preparation

26 October 2026, ORCA baseline `890eb71847e4c38533ab8f5b2d35f14076b8f923`.
**GO for offline preparation only. Nothing here is installed-tested, connectivity-qualified
(support level A), approval-tested (B) or execution-guard certified (C).** Production
registration and defaults are unchanged: the [launch profile](orca.copilot-acp.example.yaml)
is an example nobody loads, and the [offline contract tests](../../../packages/agents/test/copilot-cli-acp-709.test.ts)
run ORCA's existing generic `openAcpSession` against an in-memory peer.

The target is GitHub Copilot CLI's native ACP server, `copilot --acp --stdio`. It is **not**
the Copilot Language Server (`@github/copilot-language-server --acp`). The ACP registry lists
both under the display name "Copilot": `github-copilot-cli` is this target and
`github-copilot` is the language server.

| File | Purpose |
| --- | --- |
| [source-pins.json](source-pins.json) | Exact documentation, artifact, registry and SDK pins with hashes; machine-readable support matrix |
| [orca.copilot-acp.example.yaml](orca.copilot-acp.example.yaml) | Reproducible launch profile on the existing `AgentSpec` (inert until two placeholders are replaced) |
| [setup-preflight.md](setup-preflight.md) | Pinned install, isolated profile, user-controlled login, preflight checklist, remaining installed steps |
| [copilot-cli-acp-709.test.ts](../../../packages/agents/test/copilot-cli-acp-709.test.ts) and [fixture](../../../packages/agents/test/fixtures/copilot-cli-acp.ts) | Provider-specific offline contract tests and a test-only profile preflight |

## Evidence levels

| Level | Meaning here |
| --- | --- |
| documented | Vendor docs (`github/docs` at `943e6d81`) or the vendor changelog (`github/copilot-cli` at `7ea98dfc`) say so |
| registry-probed | The ACP registry's unauthenticated `initialize`/method probe of 2026-10-26 (`agentclientprotocol/registry` at `1a52bbd4`) |
| source-reviewed | A pinned source read by hand. Only the 13 KB npm loader, ORCA and the ACP SDK qualify: **the Copilot CLI implementation is proprietary and closed, and was not inspected** |
| offline-fixture | ORCA's real code against synthetic Copilot-shaped messages in this PR's tests. Says what ORCA does, not what Copilot does |
| untested-installed | Needs an installed, authenticated run. **None was performed** |

`docs.github.com` and github.com release downloads were denied by this session's egress
policy; the documentation was read from the `github/docs` source repository instead, and
release-asset `SHA256SUMS.txt` was not retrieved. Nothing was installed or launched, no
login or credential was created, and no paid request was made.

## Provenance pins

| Item | Pin | Level |
| --- | --- | --- |
| CLI | `@github/copilot` **1.0.103**, published 2026-10-22T16:21:46Z, `sha512-wj2x08Gp…/yZATw==`, tarball SHA-256 `f7e7909d…4d8393`; `buildMetadata.gitCommit` `131fc866123` is abbreviated and not in the public repository | artifact metadata; loader source-reviewed |
| macOS arm64 binary | `@github/copilot-darwin-arm64@1.0.103`, `os: darwin`, `cpu: arm64`, `sha512-5upfa7Ud…oAu+A==`, 181,811,714 bytes unpacked; **not downloaded**, code signature unchecked | artifact metadata |
| Other platforms | darwin-x64, linux-x64 (glibc), linux-arm64, linuxmusl-x64/arm64, win32-x64/arm64 listed as optional dependencies; three integrities recorded | documented |
| npm build provenance | **None**: no npm provenance attestation on any `@github/copilot*` package; registry signatures are not build provenance | artifact metadata |
| ACP status | ACP server is **public preview, subject to change**; the CLI itself ships as versioned 1.x releases | documented |
| ACP revision | Negotiated `protocolVersion` **1** (registry-probed); ORCA client `@agentclientprotocol/sdk` **1.8.0**, lockfile integrity `sha512-fbP7qHZs…wLMg==`, tag `v1.8.0` = `f4ea2195…`, with an SLSA v1 provenance attestation (not independently verified) | registry-probed; source-reviewed |
| Registry identity | `github-copilot-cli`, version 1.0.103, distribution `npx @github/copilot@1.0.103 --acp` | documented |
| Runtime | npm loader needs Node.js 22+ and only `spawnSync`s the platform binary with the same argv; the native binary runs without Node, so the profile launches it directly | documented; loader source-reviewed |

Every hash, blob ID and path is in [source-pins.json](source-pins.json).

## Launch, platforms, authentication and entitlement

**Launch** (documented): `copilot --acp` defaults to stdio; `--stdio` disambiguates;
`--port N` selects TCP on 127.0.0.1 and is mutually exclusive with `--stdio`. stdout carries
only NDJSON; the server exits when stdin closes. `session/new` cannot set tool filtering or
reasoning: `--available-tools`, `--excluded-tools` and `--effort` are fixed at launch for
every session of that process. ORCA spawns one process per session, so the launch arguments
are effectively per ORCA session. The profile adds `--no-auto-update` and
`COPILOT_AUTO_UPDATE=false`, because otherwise auto-update could replace the pinned version.

**Platforms** (documented): macOS, Linux and Windows (PowerShell 6+ on Windows); npm, Homebrew
cask, WinGet, install script, release downloads. macOS arm64 has a dedicated npm platform
package. The local shell sandbox uses Seatbelt on macOS (macOS 15+ tested by the vendor),
bubblewrap ≥ 0.5.0 on Linux, and recent Windows 11.

**Authentication** (documented; ORCA's handling offline-fixture):

| Mechanism | Documented behavior | ORCA position |
| --- | --- | --- |
| OAuth (`copilot login`, browser or device flow) | Token in the OS keychain (service `copilot-cli`; macOS Keychain), else an opt-in plaintext `$COPILOT_HOME/config.json` | **Approved user-controlled path.** The person runs it themselves; ORCA never sees the token |
| `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` | Fine-grained PAT with the user-owned "Copilot Requests" permission, OAuth or GitHub App user token; classic PATs unsupported; an env token **silently overrides** the stored login | Never written into ORCA config (preflight refuses it). An inherited daemon variable overrides the chosen login (proposal P2) |
| `gh auth token` fallback | Lowest priority, used when nothing else is found | Ambient; note in preflight |
| BYOK (`COPILOT_PROVIDER_*`, `providers.json`, `COPILOT_PROVIDERS_CONFIG`) | Runs in ACP without GitHub login; `COPILOT_OFFLINE=true` stops GitHub contact; GitHub-hosted features unavailable | Out of this profile; provider keys would be secrets for #336, never config literals |
| ACP `authenticate` | Registry probe saw `terminal`-type auth (it records types only, not IDs or count); `session/new` returns `-32000 Authentication required` when not logged in; changelog 1.0.69 requires a Copilot login before `authenticate` succeeds | ORCA does not call `authenticate`. It fails closed with `AGENT_PROTOCOL` and stops the process (offline-fixture) |

**Entitlement** (documented, not assumed): an active GitHub Copilot plan; the CLI is
available on all plans, but for organization-provided seats the Copilot CLI policy must be
enabled; MDM `forceLoginOrgs` can refuse personal, other-enterprise and BYOK sign-in. Model
choice affects usage (ACP model info carries a usage multiplier, changelog 0.0.403). No account, plan, seat or budget was assumed or
checked, and ORCA cannot report Copilot cost.

## Support and limitations matrix

Support levels follow the issue: **A** connectivity, **B** controlled approval validation,
**C** certified execution guards.

| Area | Evidence | Status |
| --- | --- | --- |
| stdio launch via existing `AgentSpec` | documented; offline-fixture (exact spec reaches `spawnAgent`) | A prepared, untested-installed |
| TCP `--port` | documented | Unsupported by this profile |
| macOS arm64 / Linux x64 / Windows | documented; artifact metadata | untested-installed |
| `initialize`, protocol 1, `loadSession`, `session/list` | registry-probed; offline-fixture | A prepared |
| Capability negotiation | offline-fixture: ORCA offers `fs` read/write, `terminal: false`, boolean config options | A prepared |
| Authentication | documented; registry-probed; offline-fixture fail-closed | untested-installed |
| Streaming (`agent_message_chunk`, `plan`, `tool_call*`, `usage_update`, `available_commands_update`) | documented kinds; offline-fixture ordering and foreign-session drop; unknown variants dropped by the SDK without failing the turn | A prepared |
| Session and turn identity | offline-fixture: ORCA session id distinct from Copilot's; per-turn `turnId`/`invocationId`; concurrent prompt refused; duplicate responses ignored | A prepared |
| Errors | offline-fixture: prompt error → `AGENT_PROTOCOL`, session reusable; stream end rejects the turn | A prepared; Copilot's real error codes unknown |
| Cancellation | offline-fixture: `session/cancel` sent, pending ask answered `cancelled`, wedged agent killed after `cancelGraceMs` | untested-installed: whether Copilot stops running shells, subagents and background work is unknown |
| Unsupported client methods | offline-fixture: `terminal/create`, `elicitation/create`, `mcp/message`, `_copilot/*` get `-32601` and the turn continues | Copilot's reaction to the refusal is unknown |
| `session/load` / `session/close` | documented and registry-probed | Not exercised; ORCA loads only on explicit resume and ends sessions by stopping the process |
| Permission option IDs, kinds, scope, lifetime | **unknown** | Unsupported until observed; fixtures use synthetic IDs |
| Rule-matched answer bounded to this invocation | source-reviewed ORCA; offline-fixture | **Gap** (P1) |
| `allow_all` session config option | documented (changelog 1.0.39/1.0.60/1.0.81); source-reviewed ORCA | ORCA never sets it (engine sets only `category: "model"`); other layers can |
| Native bypass routes | documented | **Unsupported/unmediated**, inventory below |
| B controlled approval validation | — | Not started; needs a separately authorized installed run |
| C execution-guard certification | — | Not qualified; needs #700 contract and #706 acceptance for the exact tuple |

## Permission requests: what ORCA sends back

ORCA answers `session/request_permission` through the existing policy
([`resolvePermission`](../../../packages/agents/src/permissions.ts)): protected paths, then
configured rules, sidecars and defaults. Offline-fixture results:

- Only an option ID present in **this** request is ever selected; a human answer naming an
  ID that was not offered becomes `cancelled`.
- Allow selects the first `allow_once`; deny selects `reject_once`; `ask` with no answerer,
  an ask from another `sessionId`, and an ask after the turn ended are `cancelled`.
- A changed command (`git status; curl …`) or an out-of-workspace path does not inherit a rule.
- An option whose `kind` is outside ACP's four (for example a hypothetical session scope)
  makes the SDK reject the whole request with `-32602`; ORCA selects nothing.
- When no `allow_once` is offered, a rule-matched allow is refused (`cancelled`), never
  widened to `allow_always` (#702; this was a gap before it).

What Copilot's options mean is **unknown**: the IDs, how many allow variants are offered,
and whether an `allow_always` maps to "approve for session", "don't ask again in this
repo/directory" (persisted to `permissions-config.json`) or a permanent URL grant in
`settings.json` (all three exist in the interactive CLI) must be observed on 1.0.103.

## Remembered approvals

| Store | Scope and lifetime (documented) | ORCA visibility |
| --- | --- | --- |
| `$COPILOT_HOME/permissions-config.json` `locations.<key>.tool_approvals` / `allowed_directories` | Per Git root, or directory outside Git; **linked worktrees resolve to the main repository root and share approvals**, so ORCA's `git-worktree` runs share one entry; persists until edited, `/reset-allowed-tools`, or the path disappears | None |
| `$COPILOT_HOME/settings.json` `allowedUrls` | Permanent URL/domain approvals across all sessions and locations | None |
| In-session approvals ("approve for session") | Session lifetime; choosing it also auto-approves pending parallel requests of the same type (changelog 0.0.384) | None |
| Launch flags (`--allow-*`, `--yolo`), `COPILOT_ALLOW_ALL` | Process lifetime; `COPILOT_ALLOW_ALL=true` exactly also trusts the folder and loads its hooks | Profile refuses the flags and pins `COPILOT_ALLOW_ALL=false` |
| `allow_all` config option, `/allow-all`, `/yolo`, `/permissions assisted` | Session; client- or slash-command-driven; launch-flag baseline survives an ACP toggle-off (changelog 1.0.81) | ORCA never sets it; whether slash commands that change permissions are advertised over ACP is unknown |
| `$COPILOT_HOME/config.json` `trustedFolders` | Persistent folder trust (hooks, workspace MCP, repository plugins) | None; ACP-mode trust prompting is unknown |
| Managed `permissions` allow/ask/deny/`limitTo` (MDM, file, server) | Device or account; server policy re-fetched hourly | None |
| ORCA `orca.permissions.json` sidecar | ORCA's own "always" rules, matched before Copilot is answered | ORCA's |

The isolated `COPILOT_HOME` in the profile starts these Copilot stores empty; it does not stop
them filling up, and ORCA has no ACP method to read or revoke them.

## Environment and configuration layers

Documented precedence (later wins): built-in defaults → MDM managed → user
`settings.json` → repository `.github/copilot/settings.json` → local
`.github/copilot/settings.local.json` → environment → command-line flags. Managed `sandbox`
values are a floor and `permissions.disableBypassPermissionsMode: "disable"` always wins.
Also read: `.claude/settings.json` and `.claude/settings.local.json` (hooks and cross-tool
keys), `.github/hooks/*.json`, `$COPILOT_HOME/hooks/`, plugin hooks, root-owned policy
hooks in `/etc/github-copilot/policy.d` (always run, cannot be disabled), managed settings
at `/Library/Application Support/GitHubCopilot/managed-settings.json` or the
`com.github.copilot` plist on macOS, `.github/allowed_models.txt`, MCP config (user,
workspace, `--additional-mcp-config`, ORCA's `mcpServers` in `session/new`), `lsp-config.json`,
`providers.json`, custom instructions (`AGENTS.md` and others) and the environment variables
listed in the command reference. ORCA's `LocalHost` passes the **entire daemon environment**
to the agent with `AgentSpec.env` laid over it, so absent profile keys inherit ambient values.

## Execution routes that do not reach an ACP permission request

Each is documented behavior; none is mediated by ORCA, and their ACP-mode behavior on 1.0.103
is untested-installed.

1. Operations Copilot classifies as read-only (searching, reading, "read-only shell commands") are allowed automatically.
2. Saved, session, launch-flag, environment, `allow_all` and managed approvals above.
3. `permissionRequest` hooks returning `allow` short-circuit the permission service; `preToolUse` can return `allow` and `modifiedArgs` (substituted arguments), so the executed action may differ from what was projected.
4. Hooks themselves run shell commands on the host (policy hooks even inside a sandboxed session) at session start, prompt submission, tool use, stop and compaction.
5. Built-in file tools run in-process and do not use ACP `fs/*`, so ORCA's file handlers and protected-path checks never see them; the OS sandbox does not constrain them either (best-effort self-check only).
6. Shell: `bash`/`powershell` run natively (ORCA offers `terminal: false`); `write_bash` sends input to a running shell; background shell sessions may outlive the turn.
7. Subagents (`task`, fleet, custom agents, up to 32 concurrent and depth 4 by default); whether their asks reach ORCA with the parent `sessionId` is unknown.
8. MCP servers (ORCA-provided, user, workspace, plugin, built-in GitHub — the last disabled by the profile), MCP sampling, remote MCP (never sandboxed).
9. Extensions, plugins, skills and LSP servers (spawned processes).
10. `web_fetch` and URL access; the sandbox-bypass prompt (`requestSandboxBypass`) and `/sandbox disable` leave the sandbox for the session.
11. GitHub-hosted effects: `/delegate` to the cloud agent, remote control, `--share-gist`, session sync.
12. Memory writes and session state persisted under `$COPILOT_HOME`.

**A successful handshake is not execution-guard qualification**: Copilot asks only about what
Copilot decides to ask about, and an ORCA answer binds only the projected `toolCall` it was
shown.

## Proposed shared-core changes (documented, not implemented)

These touch shared files other agents own; this PR changes none of them.

- **P1 — bounded automatic selection** (done for allow in #702; the deny fallback to
  `reject_always` is unchanged) (`packages/agents/src/permissions.ts`, `resolvePermission`):
  on a rule-matched allow, select only `allow_once`, and answer `cancelled` when none is
  offered instead of falling back to `allow_always`; keep `reject_always` as the deny
  fallback only if its native effect is qualified. The code change is the `pick` kinds list
  in the `allow` case; its owner must review every existing test and caller that offers only
  `allow_always`. Until then, the Copilot path is not "rule match stays bounded";
  the offline characterization test fails when P1 lands and must be flipped then. This
  overlaps #702/#705 strict selection (`selectStrictPermissionOption`), which already requires
  a bounded this-invocation choice; P1 brings the ordinary path in line rather than adding a
  second selector.
- **P2 — environment allowlist for agent processes** (`AgentSpecSchema`, `LocalHost.spawnAgent`):
  an opt-in `inheritEnv: false` (or an `envUnset` list) so a provider profile can drop
  ambient `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `COPILOT_ALLOW_ALL` and similar.
  Secrets would then arrive only through #336 references. Until then, operators must start the
  daemon without them (setup-preflight.md); `AgentSpec.env` can override but not unset.

No new vault, secret store, provider registry, orchestration engine or capability flag is
proposed; #335–#337 own capability, secret and session boundaries.

## Remaining installed validation

Each step needs separate authorization, an explicit payer and budget, a benign disposable
workspace, and the isolated profile. Steps are listed in
[setup-preflight.md](setup-preflight.md#remaining-installed-validation): artifact
download/integrity/codesign on macOS arm64, version, real `initialize`/auth methods,
authenticated `session/new`, one streamed text-only turn, cancellation, the real permission
options and their native persistence, unsupported-method reactions, and then B/C work under
#705/#706.

## Unresolved questions

1. Actual permission option IDs/kinds per tool kind on 1.0.103, and the scope each persists to.
2. Whether Copilot sends `session/request_permission` for subagent, MCP, URL, memory and sandbox-bypass actions over ACP, or uses a custom method.
3. How `ask_user` surfaces over ACP when not disabled (elicitation, a custom request, or not at all).
4. What Copilot does after `session/cancel`: running shells, background agents, pending asks, and the stop reason it returns.
5. Folder-trust behavior in ACP mode (no TTY) and whether repository hooks load.
6. Whether the keychain login is keyed by `COPILOT_HOME`, and whether an empty `GH_TOKEN` counts as set.
7. Whether permission-changing slash commands (`/allow-all`, `/yolo`, `/permissions`, `/reset-allowed-tools`) are advertised and executed over ACP from prompt text.
8. Whether `--sandbox` on an unsupported host in ACP mode fails or continues unsandboxed (documented: a saved preference continues with a notice).
9. Code-signing and notarization identity of the macOS arm64 binary, and release `SHA256SUMS.txt` for v1.0.103.
10. Copilot's JSON-RPC error codes for quota, policy refusal and model unavailability.

## Not done

No install, launch, login, credential, paid request, upstream contact, deployment, merge or
sandbox change. `tools/owned-read-proof` is untouched. Nothing here accepts or claims #699,
#700, #705 or #706; #594's existing acceptance is unaffected.
