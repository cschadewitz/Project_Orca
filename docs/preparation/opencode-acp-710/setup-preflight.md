# OpenCode 1.19.4 setup and preflight (#710)

These steps are for an operator **after** the bounded installed test in
[installed-test-plan.md](installed-test-plan.md) has been separately authorized. None of
them was run while preparing this packet.

They do not replace the #386 first-run review
([agent preflight](../../implementation/386-agent-preflight.md)). That review only observes
whether the configured executable exists and reads its header. It does not check the
version, the ACP route or sign-in, and it does not accept a provider. These steps add the
OpenCode-specific checks it leaves to an operator.

Never paste a credential into ORCA setup, configuration, a support export, an issue or this
packet.

## 1. Pick a profile root

Create one empty directory owned by the operator, called `PROFILE` below, for example
`~/orca-provider-review/opencode-1.19.4/`. It holds:

```
PROFILE/opencode-1.19.4/bin/opencode   # verified binary (step 2), read-only
PROFILE/opencode.isolated.json         # copy of this packet's file, read-only
PROFILE/home/                          # HOME for the child: no ~/.opencode, no dotfiles
PROFILE/xdg/{config,data,state,cache}/ # XDG_* for the child; data/ receives auth.json
PROFILE/workspace/                     # the isolated, disposable test workspace
```

Copy [orca.opencode.example.yaml](orca.opencode.example.yaml)'s agent entry into the test
workspace's `orca.config.yaml`. Replace every `/REPLACE-WITH-PROFILE-ROOT` with the
absolute `PROFILE` path. Change nothing else.

An unedited copy fails closed: #386 reports the command **Missing**.

## 2. Obtain and verify the platform binary — never the npm wrapper

The `opencode-ai` wrapper's postinstall runs Node, may run `npm install` on its own, and
executes the binary to check it. Instead, verify the platform package for the host:

- macOS arm64: `opencode-darwin-arm64`
- macOS x64: `opencode-darwin-x64`
- Linux: `opencode-linux-x64` or `opencode-linux-arm64`

For the package:

1. Download its tarball from
   `https://registry.npmjs.org/<pkg>/-/<pkg>-1.19.4.tgz` into an empty directory.
2. Check its SHA-512 against `integrity` in [source-pins.json](source-pins.json)
   (`openssl dgst -sha512 -binary <tgz> | base64`) and its SHA-1 against `shasum`.
3. Stop on any mismatch.
4. Extract the tarball **without running any script**, copy `bin/opencode` to
   `PROFILE/opencode-1.19.4/bin/opencode`, and make the copy read-only.
5. Record the binary's SHA-256 as installed evidence.

Matching integrity proves only that the file is the one npm published. It does not prove
which source revision built it: registry metadata has no `gitHead`. Record that as unknown.

On macOS, Gatekeeper and quarantine handling of a binary extracted from a tarball is
**unverified**. Do not disable Gatekeeper or change any security setting. If the binary
cannot run as-is, stop and report.

Do not run `opencode upgrade`. `--major` would replace this tuple with OpenCode 2.

## 3. Refuse configuration the profile cannot isolate

Stop if any of these exists:

- `/etc/opencode/opencode.json[c]` (Linux)
- `/Library/Application Support/opencode/opencode.json[c]` (macOS)
- a macOS managed-preferences profile for `ai.opencode.managed` (check with
  `profiles -P` or System Settings → Privacy & Security → Profiles; do not modify it)
- `%ProgramData%\opencode\` (Windows)

These layers are applied after the profile's files. Agent rules delivered there are not
overridden by `OPENCODE_PERMISSION`.

Also check that `PROFILE/home` and `PROFILE/xdg/config` are empty, apart from the
`$schema`-only `opencode.json` OpenCode may seed there.

## 4. Scrub the environment and make the first execution a version check

ORCA passes its whole environment to the agent, and the profile cannot remove a variable.
Start the ORCA daemon for this test from a shell that holds no credentials. In particular,
none of: cloud provider keys, `GITHUB_TOKEN`, `AWS_*`, `GOOGLE_*`, `AZURE_*`, any other
`*_API_KEY`, or `OPENCODE_*` beyond what the profile sets.

Record the variable *names* present (never their values) as evidence. Every shell command
OpenCode runs inherits this environment.

Before starting an ORCA agent session or running `auth login`, run
`PROFILE/opencode-1.19.4/bin/opencode --version` with the profile's `HOME`, `XDG_*` and
`OPENCODE_*` environment values. This must be the **first execution** of the verified
binary, after steps 1–3, and is part of the separately authorized installed test. Expect
`1.19.4`; stop on a mismatch or launch failure. Record the result before continuing to
step 5. A version check does not prove subsequent config-loading commands are free of
side effects: they can start the background dependency installation described in the
[installed plan](installed-test-plan.md#scope-and-effects), even with `--pure`.

## 5. Authenticate the one backend, outside ORCA

Run, as the operator, in a terminal with the profile's environment:

```sh
env HOME=PROFILE/home XDG_CONFIG_HOME=PROFILE/xdg/config XDG_DATA_HOME=PROFILE/xdg/data \
    XDG_STATE_HOME=PROFILE/xdg/state XDG_CACHE_HOME=PROFILE/xdg/cache \
    OPENCODE_CONFIG=PROFILE/opencode.isolated.json OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    PROFILE/opencode-1.19.4/bin/opencode auth login
```

Then:

1. Choose **Anthropic → Manually enter API Key**.
2. Use a key from an account with an explicit payer and a spend limit set at the provider.
3. Do not choose Claude Pro/Max: the documentation states Anthropic prohibits it.

The key lands in `PROFILE/xdg/data/opencode/auth.json`. Never copy it anywhere else.

ORCA has no sign-in button and never calls ACP `authenticate`: that method is a no-op in
1.19.4. Expired or missing credentials show up as a prompt error.

## 6. Check before the first prompt

- The first-execution version result from step 4 is recorded as `1.19.4`, before the
  step 5 `auth login`.
- #386 review shows the executable observed, with the expected architecture (Mach-O arm64
  on Apple Silicon).
- The ORCA config still has the profile's `permissions` rules and **no** `default:`.

## Cleanup

1. Close the ORCA session; ORCA terminates the child.
2. Confirm that no `opencode` process remains.
3. Revoke the API key at the provider.
4. Delete `PROFILE/xdg/data/opencode/auth.json`.
5. Archive the evidence (step 2 hashes, variable names, test results), then delete
   `PROFILE`.
