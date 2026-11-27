# Codex through its app-server (experimental, not yet available)

`driver: codex-app-server` is a second way for ORCA to talk to Codex (#1154, tracking #1189).
Instead of starting the `codex-acp` adapter, ORCA starts your installed Codex CLI as
`codex app-server` and speaks its protocol directly. This page says what it needs and what it
does not fix. The full description is in
[WORKFLOWS.md](../WORKFLOWS.md#codex-through-its-app-server-driver-codex-app-server-experimental-refused-for-now),
and the evidence is in the [hook coverage page](../agent-hook-coverage.md#evidence-for-the-codex-app-server-drivers-asks-1165).

**It is experimental, and not available yet.** ORCA refuses every session that asks for it until
the route is qualified, and it is never the default. It claims no support tier and is not a
guard. To use Codex today, use the ACP adapter (`codex-acp`) with no `driver`.

## What it needs

- **Codex 0.171.0, the native binary, on Linux x64.** ORCA compares the executable's SHA-256
  with the build it pinned before every start, and starts nothing else. An npm install's
  `codex` command is a Node script that starts the native binary, so point `command` at the
  binary itself, for example
  `node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
- **Codex's whole package, as installed.** Codex runs other files from its package: its
  bundled bubblewrap (`codex-resources/bwrap`, the sandbox), `bin/codex-code-mode-host` and
  `codex-path/rg`. ORCA pins these too, and before every start checks that each one is a plain
  file in the package with its pinned SHA-256 (#1286). Leave the package as npm installed it;
  a file that was changed, moved or replaced by a link is refused.
- **No bubblewrap on Codex's `PATH` that you could replace.** Codex runs a `bwrap` it finds on
  its `PATH` before its bundled one, and checks only the bundled one. ORCA therefore accepts a
  `bwrap` on that `PATH` only when it, and every directory above it, is owned by root and
  writable by no one else, as an installed `bubblewrap` system package is. A `bwrap` in your
  home directory or under `/tmp` is refused. ORCA fixes Codex's `PATH` when the session opens,
  checks that one and starts every Codex process of the session with it, so `PATH` must be a
  plain value: an agent whose `PATH` comes from a secret is refused. The whole check has one
  30-second limit; one that does not finish in time starts nothing.
- **Your own `codex login`.** ORCA never signs in, never refreshes a token and never reads
  Codex's credential files. Run `codex login` yourself. A Codex that reports no login is
  refused with "run `codex login`".
- **ORCA's own machine.** The driver runs only on the daemon's host for now (#1166).

```yaml
agents:
  - id: codex
    command: /home/you/.local/share/orca-agents/codex/0.171.0/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
    driver: codex-app-server
    hostId: local
```

## What the first-run review shows

For an agent with this driver, the app's first-run review finds the executable as it does for
any agent. It never runs it. It also reads the file's bytes and says whether they match a Codex
build ORCA pinned for this machine, and which version. A missing executable, or one that is not
a pinned build, is reported before anything is started. The review shows the driver as
experimental, with the caveats below. A match is not a check that Codex runs, or that you are
signed in.

## What it does not fix

- **Calls Codex runs in its sandbox.** Codex decides which commands run inside its own sandbox
  without asking, so ORCA's rules are never consulted for those. The sandbox, not ORCA, bounds
  them.
- **The IPC caveat.** A command ORCA allows can still connect to programs on the same machine,
  through a unix socket, a local port or a named pipe, and make something happen that no rule
  decided. ORCA has not verified that Codex's sandbox prevents this
  ([the IPC caveat](../agent-hook-coverage.md#the-ipc-caveat)).
- **The hook stays fail-open.** ORCA's optional pre-tool hook (`nativeToolHook: experimental`)
  on this driver keeps Codex's own hook runner, which lets a call through when the hook fails
  to run ([on the Codex app-server driver](../agent-hook-coverage.md#on-the-codex-app-server-driver-1161-refused-for-now)).
- **A cancel is not proof that a command stopped.** Codex can end a cancelled turn while a
  command it started runs on (#1299). ORCA reports such a cancel as `unconfirmed` or
  `not-carried-out`, and then takes no further prompt on that session.
- **A process of your own user.** The pins are checked by path, before Codex starts. They
  catch a package that drifted or had a file swapped, not a process running as you that
  changes Codex while it starts or runs (#1286).
- **The judge advises on commands only** on this driver ([plain-language rules](../plain-language-rules.md#codex)).
