# Installing ORCA v0.6.0 for the first time

ORCA is two things: a **daemon** (`orca serve`, the server that owns a workspace's `.orca`
store and drives runs) and a **desktop app** (the UI, which only ever talks to a daemon over
HTTP and a WebSocket). The desktop app ships with a copy of the daemon inside it, so the
simplest install is the app alone. Everything else here is about running the daemon
somewhere other than inside the app: on the same machine, in a container, or on a server.

The v0.6.0 release page carries every artifact:
<https://github.com/cschadewitz/Project_Orca/releases/tag/v0.6.0>. The repository is
private, so downloads go through an authenticated GitHub CLI:

```sh
gh auth status || gh auth login
gh release download v0.6.0 -R cschadewitz/Project_Orca -p '<pattern>' -D ~/Downloads
```

| Artifact | Pattern | What it is |
| --- | --- | --- |
| Linux desktop, x64 | `ORCA-0.6.0-linux-x86_64.AppImage` | one-file app |
| Linux desktop, x64 / arm64 | `ORCA-0.6.0-linux-{x64,arm64}.tar.gz` | the same tree, unpacked |
| macOS desktop | `ORCA-0.6.0-mac-{x64,arm64}.dmg` | app bundle |
| Windows desktop | `ORCA-0.6.0-win-{x64,arm64}.exe` | NSIS installer; the `.zip` beside it is an archive, not the supported install path |
| Daemon / CLI | `orca-daemon-0.6.0.mjs` | the whole CLI in one ESM file; needs Node 22 or newer, nothing else |

All builds are **unsigned** (`docs/RELEASING.md`, "Signing and notarisation are not done").
Expect a Gatekeeper refusal on macOS and a SmartScreen warning on Windows; the workarounds
are in the desktop section below.

## Before anything else: a workspace and its configuration

Every daemon serves one **workspace**: a directory holding an `orca.config.yaml` and, once
something has run, a `.orca/` store beside it. The bundled daemon in the desktop app and the
standalone `.mjs` are the same program, so the workspace is the same in every scenario.

Two things the release artifacts do **not** contain and the configuration must point at:

- the shipped **workflows** (`workflows/*.yaml`: `program`, `ai-sdlc`, …), and
- the shipped **prompt templates** (`templates/**/*.md`).

They are plain files in the source tree at the same tag. Put them somewhere stable, once:

```sh
mkdir -p ~/orca/release && cd ~/orca/release
gh api repos/cschadewitz/Project_Orca/tarball/v0.6.0 > v0.6.0.tar.gz
tar -xzf v0.6.0.tar.gz --strip-components=1 --wildcards '*/workflows/*' '*/templates/*'
ls workflows templates      # program.yaml, ai-sdlc.yaml, … / sdlc/, strict/, …
```

Then create the workspace. Start from `examples/orca.config.yaml` in the same tarball (it
documents every key), or from this minimum, which is one local Claude Code agent filling
every role:

```yaml
# ~/orca/work/orca.config.yaml
version: 1
storeDir: .orca

hosts:
  - id: local
    type: local

agents:
  - id: claude
    command: claude-code-acp        # any ACP agent binary on PATH
    args: []
    hostId: local
    roles: [decomposer, planner, designer, builder, tester, reviewer, deployer]
    sessionMode: per-step

workflows: ["/home/YOU/orca/release/workflows/**/*.yaml"]
templates: ["/home/YOU/orca/release/templates/**/*.md"]

program:
  workflow: program
  itemWorkflow: ai-sdlc

workspace:
  provider: git-worktree            # local | git-worktree | kepler
  repo: /path/to/the/repository/orca/works/on
  baseBranch: main
  branchPrefix: orca/
  hostId: local

humanInput:
  mode: pause                       # park at gates; answer from the app or `orca answer`
```

Relative `workflows:`/`templates:` globs resolve against the config file's directory;
absolute paths are the least surprising for a first install. The agent binary is yours to
install. For Claude Code that is the ACP adapter:

```sh
npm install -g @zed-industries/claude-code-acp   # `claude-code-acp` must then be on PATH
```

`docs/INTEGRATIONS.md` covers Codex, Gemini CLI, OpenCode and agents on other machines over
SSH. The scripted `orca demo` (no LLM needed) proves a *source* checkout (`pnpm run demo`,
README "Quick start"); in v0.6.0 the standalone daemon file's `demo` fails with
`WORKFLOW_NOT_FOUND` because it looks for the workflows relative to itself, so with the
release artifacts the check is `validate` plus the `hello` handshake shown below.

## Install the UI (desktop app)

The app starts its own daemon on a free loopback port over `ORCA_WORKSPACE` if that is set,
or over your home directory otherwise. A home directory has no store, so the app opens
connected but empty; **File ▸ Open a store…** then re-points it at a workspace, read-only.
For a writable first install, launch the app with `ORCA_WORKSPACE` set to the workspace
above.

### Linux

```sh
gh release download v0.6.0 -R cschadewitz/Project_Orca -p 'ORCA-0.6.0-linux-x86_64.AppImage' -D ~/Applications
chmod +x ~/Applications/ORCA-0.6.0-linux-x86_64.AppImage
ORCA_WORKSPACE=~/orca/work ~/Applications/ORCA-0.6.0-linux-x86_64.AppImage
```

On arm64, or if you would rather not have an AppImage, take the tarball instead:

```sh
gh release download v0.6.0 -R cschadewitz/Project_Orca -p 'ORCA-0.6.0-linux-x64.tar.gz' -D /tmp
mkdir -p ~/Applications/orca && tar -xzf /tmp/ORCA-0.6.0-linux-x64.tar.gz -C ~/Applications/orca --strip-components=1
ORCA_WORKSPACE=~/orca/work ~/Applications/orca/orca
```

If the window opens on "disconnected", Chromium's sandbox is usually the cause on distros that
restrict unprivileged user namespaces; the app's console output (start it from a terminal)
says so.

### macOS

Open the `.dmg`, drag ORCA to `/Applications`, then clear the quarantine flag once, because
the build is unsigned and Gatekeeper will otherwise report the app as damaged:

```sh
xattr -dr com.apple.quarantine /Applications/ORCA.app
ORCA_WORKSPACE=~/orca/work open -a ORCA
```

### Windows

Run the `.exe` for your architecture and accept the SmartScreen "unrecognised app" prompt
(More info ▸ Run anyway). Set the workspace for your account, then start ORCA from the Start
menu:

```powershell
[Environment]::SetEnvironmentVariable('ORCA_WORKSPACE', 'C:\Users\YOU\orca\work', 'User')
```

The Windows app is the one platform with in-app updates from v0.6.0 on ("Check for
updates" in the header). They need a private feed configured by an operator; `docs/UPDATING.md`
has the setup. Without it the commands report no feed and nothing else changes.

### Check it

The status bar reads **live**; Config shows the configuration file you wrote; Agents lists
`claude` (or whichever agent you configured) and **Ping** completes a handshake with it.
Runs is empty until something runs.

## Install the server (daemon)

Use a separate daemon when the UI should not own it: a daemon that outlives the window,
serves several clients, or runs on another machine. The daemon has **no authentication**. It
binds `127.0.0.1:6722` by default and any process that can reach the port can start, resume,
cancel and answer runs. Keep it on loopback and reach it over SSH; do not put it on a
network interface that anything untrusted can see.

Every variant below points the desktop app at the daemon with `ORCA_DAEMON_URL`. When that
is set the app starts no daemon of its own.

### Local

Prerequisites: Node 22 or newer (`node --version`), Git if the workspace provider is
`git-worktree`, and the workspace from the top of this page.

```sh
mkdir -p ~/orca/bin
gh release download v0.6.0 -R cschadewitz/Project_Orca -p 'orca-daemon-0.6.0.mjs' -D ~/orca/bin
cat > ~/orca/bin/orca <<'EOF'
#!/bin/sh
exec node "$HOME/orca/bin/orca-daemon-0.6.0.mjs" "$@"
EOF
chmod +x ~/orca/bin/orca
export PATH="$HOME/orca/bin:$PATH"          # and in your shell profile

orca --version                              # 0.6.0
orca --cwd ~/orca/work validate             # OK ai-sdlc / plan-resume / program: the shipped files resolve
orca --cwd ~/orca/work serve                # orca daemon 0.6.0 listening on http://127.0.0.1:6722 (protocol 1.8)
```

The `.mjs` is the entire CLI, so `orca runs`, `orca status`, `orca answer` and the rest all
work from it. Leave `serve` running in a terminal, or under systemd for your user:

```ini
# ~/.config/systemd/user/orca.service
[Unit]
Description=ORCA daemon
After=network.target
[Service]
WorkingDirectory=%h/orca/work
ExecStart=/usr/bin/env node %h/orca/bin/orca-daemon-0.6.0.mjs serve
Environment=PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin
Restart=on-failure
TimeoutStopSec=20
[Install]
WantedBy=default.target
```

`PATH` matters: the daemon spawns your agent binary with the environment the service has,
not your shell's. Then:

```sh
systemctl --user daemon-reload && systemctl --user enable --now orca.service
curl -sS -X POST http://127.0.0.1:6722/rpc -H 'content-type: application/json' \
  -d '{"kind":"request","id":1,"method":"hello","params":{"client":"curl/0","protocol":{"major":1,"minor":8}}}'
# {"kind":"response","id":1,"ok":true,"result":{"orcaVersion":"0.6.0", ...
ORCA_DAEMON_URL=http://127.0.0.1:6722 ~/Applications/ORCA-0.6.0-linux-x86_64.AppImage
```

**Managed Debian deployment.** For a long-lived server that will be upgraded in place, the
supported path is the `orca-release` adapter (`tools/deploy/orca-release.py`): versioned
release directories, a pinned toolchain built from source, locked launches and an atomic
`current` switch. It is the deployment `docs/UPDATING.md` describes under "Debian"; its
"Bootstrap once" section is the first-time install for that layout, and the `deployment.json`
and `orca.service` there replace the unit above.

### Local Docker

There is no published image; this is a container around the standalone daemon. It suits a
daemon whose agents also live in the image. An agent that needs your credentials, your
editor's tooling or the SSH agent is simpler to run as the Local install above.

Layout on the host:

```
~/orca/docker/
  Dockerfile
  orca-daemon-0.6.0.mjs      # from the release page
  release/workflows/         # from the v0.6.0 tarball
  release/templates/
~/orca/work/                 # the workspace: orca.config.yaml, .orca/, the repository
```

```dockerfile
# ~/orca/docker/Dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*
# The agents this daemon runs live in the image too. Claude Code's ACP adapter, for example:
RUN npm install -g @zed-industries/claude-code-acp
COPY orca-daemon-0.6.0.mjs /opt/orca/orca-daemon.mjs
COPY release/workflows /opt/orca/workflows
COPY release/templates /opt/orca/templates
RUN printf '#!/bin/sh\nexec node /opt/orca/orca-daemon.mjs "$@"\n' > /usr/local/bin/orca && chmod +x /usr/local/bin/orca
WORKDIR /work
EXPOSE 6722
# Bind to the container's interfaces; the publish rule below keeps it on the host's loopback.
ENTRYPOINT ["orca", "serve", "--host", "0.0.0.0", "--port", "6722"]
```

The workspace's config points at the paths inside the image:

```yaml
workflows: ["/opt/orca/workflows/**/*.yaml"]
templates: ["/opt/orca/templates/**/*.md"]
workspace:
  provider: git-worktree
  repo: /work/repo            # bind-mounted below
```

Build, run and connect:

```sh
cd ~/orca/docker && docker build -t orca:0.6.0 .
docker run -d --name orca --restart unless-stopped \
  -p 127.0.0.1:6722:6722 \
  -v ~/orca/work:/work \
  -e ANTHROPIC_API_KEY \
  orca:0.6.0
docker logs orca                    # orca daemon 0.6.0 listening on http://0.0.0.0:6722 (protocol 1.8)
docker exec orca orca validate      # run from /work: the image's workflows and templates resolve
ORCA_DAEMON_URL=http://127.0.0.1:6722 ~/Applications/ORCA-0.6.0-linux-x86_64.AppImage
```

`-p 127.0.0.1:6722:6722` is the whole of the access control: it publishes the port to the
host's loopback only. Agent credentials go in as environment (`-e`), never into the image.
The CLI is available with `docker exec orca orca …`, and because the store is a bind mount,
the same `.mjs` on the host can read it too. Use the same user id inside and out (`--user
"$(id -u):$(id -g)"`) if you do, so the store's files stay yours.

### Remote

The daemon runs on a server; the desktop app runs on your machine. The daemon stays on the
server's loopback and the app reaches it through an SSH tunnel, which is the authentication
the daemon itself does not have.

On the server, do the **Local** install (or the managed Debian deployment) as the user who
will own the workspace and run the agents. The workspace, the repository the agents work on
and the agent binaries all live on the server; the app never touches its filesystem. Confirm
with the `hello` `curl` from the Local section, on the server.

On your machine, open the tunnel and point the app at its local end:

```sh
ssh -N -L 6722:127.0.0.1:6722 you@server.example.net &
ORCA_DAEMON_URL=http://127.0.0.1:6722 ~/Applications/ORCA-0.6.0-linux-x86_64.AppImage
```

On macOS use `ORCA_DAEMON_URL=http://127.0.0.1:6722 open -a ORCA`; on Windows set
`ORCA_DAEMON_URL` for your account the way `ORCA_WORKSPACE` is set above and open the tunnel
with the same `ssh` command in PowerShell. The tunnel carries both `POST /rpc` and the
`/socket` WebSocket, so runs, agent output and gates push to the app as they do locally. If
the tunnel drops, the status bar leaves **live** after five seconds and the app reconnects
and resumes from its cursor when the tunnel is back.

Two things the remote scenario changes:

- **The CLI is a server-side tool.** `orca runs`, `orca answer` and friends read and write
  the store directly, so run them on the server (over `ssh`), not through the tunnel. Only
  `orca agents` and `orca ping` accept `--host`/`--port` to ask a daemon instead.
- **Agents on a third machine** are a daemon configuration, not a client one: an `ssh` host
  in `orca.config.yaml` with key-based auth from the server (`docs/INTEGRATIONS.md`,
  "Remote agents over SSH").

Do not replace the tunnel with `--host 0.0.0.0` on the server. The port has no
authentication, and anything that can reach it can drive the agents with the server's
credentials.

## Uninstalling

Nothing is registered anywhere. Delete the app (AppImage, `/Applications/ORCA.app`, or the
Windows uninstaller in Settings ▸ Apps), the `.mjs` and its wrapper, the systemd unit or
container, and, if you mean it, the workspace's `.orca/` store, which is the only thing that
holds runs, artifacts and plans.
