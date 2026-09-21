# Setup guide (v0.5.0)

How to stand up an ORCA daemon — in Docker on this machine, or on another machine — give it
Claude Code and Codex to drive, and point each of the three clients at it.

The daemon here is `v0.5.0` at protocol 1.7: the image, the commands against it and both
agent handshakes were run on this release, and every output quoted below is a real one. The
desktop and Kepler steps follow the shipped code and `docs/REAL-AGENT-TEST.md`. Where a step
cannot work in this release it says so rather than offering a shape for it.

## How the pieces fit

Three things, and the mistake worth avoiding is thinking there are two:

- **The daemon** (`orca serve`) owns a **workspace**: an `orca.config.yaml`, the `.orca`
  store beside it, and the repository the agents work in. It interprets runs, holds the
  single-writer lease on each one, and serves the store over HTTP with a WebSocket beside
  it for pushes.
- **The agents** are ACP binaries the daemon spawns — Claude Code and Codex here — locally,
  or over SSH on another host. They run wherever the *daemon* is, not where the client is.
- **The clients** watch and steer. They reach ORCA two different ways, and which way
  decides everything in the second half of this guide:

| Client | How it reaches ORCA | v0.5.0 |
| --- | --- | --- |
| ORCA desktop app | the daemon's own protocol (HTTP `/rpc`, WebSocket `/socket`) | works |
| Kepler | launches `orca acp` and speaks **ACP over stdio** — never the daemon's port | works |
| T3 Code | nothing: it is not an ACP client and ORCA's T3 transport is unimplemented | **does not work** |
| `orca` CLI | the store on disk, in its own process | works |

So "connect Kepler to the daemon" is not the same operation as "connect the app to the
daemon", and the section for each says what it actually is.

**Before anything reaches a network, read [Setup a remote ORCA daemon](#4-setup-a-remote-orca-daemon).**
The daemon's port carries no authentication of any kind, and the desktop app sends no
credentials, so the only thing that makes a remote daemon safe is the transport under it.

### What you need

| For | You need |
| --- | --- |
| The daemon in Docker | Docker with the Compose plugin, and a checkout of this repository to build from |
| The daemon from source | Node ≥ 22 (the repo pins 24 via mise) and pnpm 12 |
| The agents | An Anthropic login or key for Claude Code; an OpenAI login or key for Codex |
| The desktop app | A release artifact, or a checkout and `pnpm install` |
| Kepler | Kepler with an **Agents ▸ Custom agent servers** entry you can edit |

---

## 1. Setup a local ORCA daemon in Docker

The image is two stages: the repository's own build produces the single-file daemon bundle
(`packages/app/scripts/build-daemon.js` — the same bundle the desktop app spawns and the
release page carries), and the runtime stage holds that file, a Node, and the two agents
behind their ACP adapters. Nothing of the toolchain survives into it.

Files: [`deploy/docker/Dockerfile`](../deploy/docker/Dockerfile),
[`deploy/docker/compose.yaml`](../deploy/docker/compose.yaml),
[`deploy/docker/orca.config.yaml`](../deploy/docker/orca.config.yaml).

### 1.1 Build the image

From the **repository root**, not from `deploy/docker` — the build context is the checkout:

```bash
git clone https://github.com/cschadewitz/Project_Orca.git
cd Project_Orca
docker build -f deploy/docker/Dockerfile -t orca:0.5.0 .
```

It takes a couple of minutes and lands at about **2.2 GB**, of which the daemon is 6 MB:
the rest is the two agent CLIs and their adapters, each shipping its own platform binaries.
`--build-arg AGENTS=` builds an image with no agents in it — 490 MB — which is what you want
when the agents live on another host over SSH, or when this daemon will be `--read-only`.

### 1.2 Make a workspace

The container is stateless; the workspace is not. Put it somewhere that is not the checkout
— a worktree can be discarded, while the event store is the thing you want to keep.

**On the host, in the same shell you built the image in.** Nothing here runs in the
container: this makes the directory §1.3 mounts at `/workspace`, and it is a host path until
the moment it is mounted. The `cp` is the only line that cares where you are — it reads the
checkout you just built from, so either stay in it or give the file its absolute path. The
repository you clone is **your own project**, the one the agents will work on, not this one:

```bash
mkdir -p ~/orca
cp deploy/docker/orca.config.yaml ~/orca/orca.config.yaml   # from the Project_Orca checkout
git clone <your project> ~/orca/repo
```

On Docker Desktop (macOS, Windows) keep the workspace under your home directory, or add its
path to **Settings ▸ Resources ▸ File sharing** — a bind mount from a directory Docker has
not been given is silently empty inside the container, and the daemon then serves an empty
store rather than failing.

```
~/orca/                     mounted at /workspace
  orca.config.yaml          yours from here on: the app's Config surface writes to this file
  repo/                     the git repository the agents work in
  worktrees/                one per work item, created by the git-worktree provider
  .orca/                    event logs, artifacts, plan, claims — created on first run
```

The shipped config names paths **inside the container** (`/workspace/repo`,
`/opt/orca/workflows`), so read it once before starting: the agent ids, their roles, the
permission policy and `workspace.repo` are the four things worth deciding up front.

### 1.3 Start it

```bash
docker run -d --name orca-daemon \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:6722:6722 \
  --volume ~/orca:/workspace \
  --volume orca-claude-home:/home/node/.claude \
  --volume orca-codex-home:/home/node/.codex \
  orca:0.5.0 serve --host 0.0.0.0 --port 6722
```

Or, with the same thing written down:

```bash
cd deploy/docker
ORCA_WORKSPACE_DIR=~/orca ORCA_UID=$(id -u) ORCA_GID=$(id -g) docker compose up -d --build
```

(`ORCA_UID` rather than `UID`, because `UID` is readonly in bash and the assignment would
fail before compose ever ran.)

Three details in that command are load-bearing:

- **`--host 0.0.0.0` binds the container's interface, not the network.** What keeps the
  daemon private is the `127.0.0.1:` on the host side of `--publish`. Bound to loopback
  *inside* the container it would be unreachable even from the host.
- **`--user "$(id -u):$(id -g)"`** so the `.orca` store and the agents' commits on the
  mounted workspace belong to you rather than to uid 1000. If your uid is not 1000 the
  image's `/home/node` is not yours to write, so add `--env HOME=/workspace/.home` and mount
  the credential volumes under that path instead.
- **The two credential volumes** are what make `claude /login` and `codex login` survive the
  container. Bind-mount your own `~/.claude` instead if you would rather share the host's
  login.

### 1.4 Prove it is up

```bash
docker logs orca-daemon
```

```
orca daemon 0.5.0 listening on http://0.0.0.0:6722 (protocol 1.7)
serving /workspace/.orca: runs.list, runs.get, runs.events, inputs.list, claims.list, artifacts.list, artifacts.get, workflows.list, workflows.get, config.get, agents.list, agents.ping
serving the plan: plans.list, plan.get, items.list, schedule.get, schedule.explain, dependencies.list, risks.list, decisions.list, journal.list
driving runs: inputs.answer, runs.resume, runs.cancel, runs.start, config.set, dependencies.waive, decisions.decide, decisions.reopen, risks.update, claims.release
  no authentication on this port: any local process may call them. The per-run lease stops a second writer, not a caller.
notifications on ws://0.0.0.0:6722/socket: subscribe, unsubscribe
```

Read those four lines rather than skim them: they are the daemon telling you which store it
opened, which methods exist on it, and that the port is unauthenticated. A daemon started
`--read-only` prints the third line as an absence instead, and the ten control methods are
missing from `hello.methods` as well as from the dispatch table — which is how the app knows
to draw a write as *absent* rather than as disabled.

```bash
curl -s http://127.0.0.1:6722/health                     # {"ok":true} — what a supervisor watches
docker exec orca-daemon orca agents                      # hosts, agents, roles
docker exec orca-daemon orca validate                    # OK ai-sdlc (16 nodes, 18 edges), …
curl -s -X POST http://127.0.0.1:6722/rpc \
  -H 'content-type: application/json' \
  -d '{"kind":"request","id":1,"method":"hello","params":{"client":"curl","protocol":{"major":1,"minor":7}}}'
```

`hello` answers with the protocol version, `orcaVersion`, the store directory, the
capabilities (`runs.read`, `runs.subscribe`, `runs.control`, `plan.read`, `plan.write`) and
every method. If a client ever reports a version mismatch, this is the call that settles who
is behind.

### 1.5 Connect to Claude Code

Claude Code does not speak ACP itself. The image installs the adapter that gives it an ACP
stdio interface, and the config already names it:

```yaml
agents:
  - id: claude
    command: claude-agent-acp # @agentclientprotocol/claude-agent-acp
    hostId: local
    roles: [planner, designer, decomposer, reviewer]
    sessionMode: per-step
    env:
      CLAUDE_CODE_EXECUTABLE: /usr/local/bin/claude
```

Two things about that block are worth knowing rather than copying:

- **The package was renamed.** `@zed-industries/claude-code-acp` (binary `claude-code-acp`)
  is deprecated in favour of `@agentclientprotocol/claude-agent-acp` (binary
  `claude-agent-acp`). `docs/REAL-AGENT-TEST.md` still names the old one; this image
  installs the new one.
- **`CLAUDE_CODE_EXECUTABLE` is not decoration.** The adapter bundles a Claude Code of its
  own, and a bundled one has been refused by the API before now for being too old
  (`claude_code_version_too_old`). The variable — which this adapter still honours — points
  it at the current CLI the image installs beside it.

Authenticate once, into the mounted volume:

```bash
docker exec -it orca-daemon claude /login    # prints a URL; paste the code back. Works headless.
docker exec -it orca-daemon claude -p "say pong"
```

Or give the agent a credential instead of a login — `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on a machine you can log in on. Both are
passed through by `compose.yaml`; neither goes into the image. A login is the cheaper habit,
because one serves every agent ORCA spawns and keeps the config free of secrets.

Then verify the wiring:

```bash
docker exec orca-daemon orca ping claude
```

```
OK claude on local: ACP handshake in 551ms, recorded by the daemon at http://127.0.0.1:6722 (state ok)
```

**`ping` proves the transport, not the credentials.** This adapter opens a session for an
unauthenticated caller quite happily; the refusal arrives on the first prompt instead, which
is a half-finished run rather than a failed handshake. `claude -p "say pong"` above is the
check that actually costs the API something, and it is the one that tells you.

### 1.6 Connect to Codex

Codex has no `acp` subcommand — `examples/orca.config.yaml` says `codex acp` and that is
stale, checked against codex-cli 0.155.1. It gets an ACP interface the same way Claude Code
does, from an adapter the image installs:

```yaml
  - id: codex
    command: codex-acp # @agentclientprotocol/codex-acp
    hostId: local
    roles: [builder, tester, deployer]
    sessionMode: per-step
```

```bash
docker exec -it orca-daemon codex login --device-auth      # or: printenv OPENAI_API_KEY | docker exec -i orca-daemon codex login --with-api-key
docker exec orca-daemon codex login status
docker exec orca-daemon orca ping codex
```

Codex's adapter is the stricter of the two and refuses at the handshake, so `ping` is a real
credential check here:

```
FAIL codex on local: ACP handshake with 'codex' failed: Authentication required, recorded by the daemon at http://127.0.0.1:6722 (state down)
```

That asymmetry is worth remembering in both directions: a green `ping` for `claude` says
less than a green `ping` for `codex`.

### 1.7 What the daemon does with a gate

`humanInput.mode: pause` in the shipped config, and for a daemon it is the only mode that
makes sense: a gate parks the run in its event log, the interpreter lets go, and the
question waits on `inputs.list` until somebody answers it from the app's Attention surface
or from `orca answer <requestId> <option>`. `cli` would prompt on a terminal nobody is
watching; `auto` would answer on your behalf.

What it costs is written down in the roadmap and worth knowing before your first gate: the
agent's session does **not** survive the wait. The step that resumes afterwards opens a
fresh session, so the agent loses the conversation it was in the middle of (#237).

---

## 2. Setup the ORCA UI app

The desktop app is an Electron shell over the same protocol the `curl` above spoke. It
imports `@orca/protocol` and `@orca/design` and nothing else from the workspace: everything
it knows about a run arrives over the wire (ADR 0008), which is why it can sit in front of a
daemon in a container or on another machine without knowing the difference.

### From a release

Download from [the v0.5.0 release](https://github.com/cschadewitz/Project_Orca/releases/tag/v0.5.0):

| Platform | Asset |
| --- | --- |
| Linux | `ORCA-0.5.0.AppImage` |
| macOS (Apple silicon / Intel) | `ORCA-0.5.0-arm64.dmg` / `ORCA-0.5.0.dmg` |
| Windows | `ORCA.Setup.0.5.0.exe` |
| Daemon only, no Electron | `orca-daemon-0.5.0.mjs` — `node orca-daemon-0.5.0.mjs serve` |

**Both desktop artifacts are unsigned, and both platforms say so.** On macOS an unsigned app
that arrived with a quarantine attribute cannot be opened by double-clicking it at all —
`xattr -dr com.apple.quarantine /Applications/ORCA.app` is the way past it today. On Windows
the NSIS installer raises a SmartScreen "unrecognised app" warning. `docs/RELEASING.md` has
what signing would take and why it has not happened yet.

A packaged app **starts its own daemon** on loopback over `ORCA_WORKSPACE` (or your home
directory) unless you tell it otherwise — which is the whole subject of §3 and §5.

### From source

```bash
mise install                                   # Node 24 + pnpm 12
pnpm install                                   # downloads the Electron binary
pnpm run build
pnpm --filter @orca/app start                  # or: pnpm --filter @orca/app dev, renderer hot-reloading
```

A development build has **no bundled daemon**, so it has nothing to start: it goes to
`ORCA_DAEMON_URL`, and failing that to `http://127.0.0.1:6722`, which is exactly where
`pnpm run orca serve` and the container in §1 are listening. `docs/DEVELOPMENT.md` has the
rest of the loop.

---

## 3. Connect to the local ORCA daemon

### 3.1 From the ORCA UI

**`ORCA_DAEMON_URL`, set before launch. There is no field for it in the app.** File ▸
*Connect to a daemon* returns the app to that URL after a detour into file mode; it does not
ask for one.

```bash
# Linux
ORCA_DAEMON_URL=http://127.0.0.1:6722 ./ORCA-0.5.0.AppImage

# macOS — the binary, not `open -a`, which drops the environment
ORCA_DAEMON_URL=http://127.0.0.1:6722 /Applications/ORCA.app/Contents/MacOS/ORCA

# Windows (PowerShell) — then start ORCA from this same shell, because the Start-menu
# shortcut does not inherit it. `setx ORCA_DAEMON_URL http://127.0.0.1:6722` makes it
# permanent for new processes, shortcut included.
$env:ORCA_DAEMON_URL = 'http://127.0.0.1:6722'
```

The app picks a daemon in this order, and the first one wins outright:

1. `ORCA_DAEMON_URL` — somebody who has pointed the app at a daemon has said what they want,
   so no second daemon is started beside it.
2. the daemon bundled in a packaged build, on a free loopback port over `ORCA_WORKSPACE`.
3. `http://127.0.0.1:6722`, the default `orca serve` — also where a packaged app lands when
   its bundled daemon refuses to start, on a status bar reading disconnected, because a
   window that opens and tells you it has no daemon beats one that will not open.

You are connected when the status bar says so. The connection is a state machine in the main
process with five states, and **leaving `live` is held silent for five seconds**, so a blip
changes nothing on screen and a real disconnection takes a moment to appear — that is
deliberate, not a hang.

Two things to expect against the container from §1:

- **Writes are there because the daemon is not `--read-only`.** Answering a gate, cancelling,
  resuming, starting a run, editing the config: each is drawn only when the daemon serves the
  method behind it. A `--read-only` daemon makes them *absent*, not greyed out.
- **File ▸ Open a store…** re-points a *packaged* app at any workspace on the local disk by
  starting a bundled `orca serve --read-only` over it. It needs the bundled daemon, so a
  development build refuses with a message telling you to run `orca serve --read-only --cwd
  <path>` and set `ORCA_DAEMON_URL` yourself. It is also local-only: it is a directory
  chooser, not a way to reach another machine.

### 3.2 From the Kepler UI

**Kepler never speaks to the daemon's port.** Kepler is an ACP client, ORCA is an ACP agent
(`orca acp`), and they talk line-delimited JSON-RPC over stdio. Prompts become Requests,
progress streams back as ACP plan and tool-call updates, and gates arrive as Kepler's own
approval prompts. `docs/INTEGRATIONS.md` has what each direction carries.

With the container from §1, the command Kepler launches is `docker exec`, because stdio
survives it:

In Kepler: **Agents ▸ Custom agent servers ▸ Add**

| Field | Value |
| --- | --- |
| Name | `ORCA` |
| Command | `/usr/bin/docker` |
| Args (one per line) | `exec`, `-i`, `orca-daemon`, `orca`, `acp` |

`-i` and not `-it`: a TTY would corrupt the protocol channel. Check it by hand before
blaming Kepler for anything — this is the whole handshake:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}' \
  | docker exec -i orca-daemon orca acp
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false,…},"agentInfo":{"name":"orca","version":"0.1.0"}}}
```

(`"version":"0.1.0"` there is cosmetic and wrong — the ACP facade hardcodes it while
`orca --version` and `hello.orcaVersion` report 0.5.0.)

**One thing to fix before you prompt it, though: the cwd.** `session/new` carries the
client's working directory — the Kepler task's worktree — and the facade uses that as the
workspace in preference to the configured provider, so ORCA edits the task you are looking
at. Through `docker exec` that path is a *host* path the container cannot see. Either mount
the task tree into the container at the identical path:

```bash
--volume ~/kepler/tasks:/home/you/kepler/tasks
```

or run `orca acp` on the host (below) and let only the daemon live in the container. The two
processes over one store is the supported arrangement either way.

Without Docker, Kepler launches a wrapper script instead — the registration form offers a
command and args only, so the process inherits whatever environment Kepler hands it, which
will not have mise activated:

```bash
#!/bin/sh
# /srv/dev/orca-live/orca-acp
exec /path/to/node /path/to/packages/cli/dist/main.js acp --config /srv/dev/orca-live/orca.config.yaml
```

A config for a host-run `orca acp` is a **different file** from the container's, even over
the same store: `/opt/orca/workflows` and `/workspace/repo` mean nothing outside the
container. Copy it, make the paths the host's, and keep `storeDir` pointing at the same
directory the container mounts.

**What the two clients then share is a store, not a connection.** Point `orca acp` and
`orca serve` at the same store and the app will list the runs Kepler drives —
since v0.5.0 the document stores are lock-protected and rename-atomic, so two processes over
one store no longer lose each other's requests, work items and plan records (#196), and
every interpreter holds a single-writer lease per run (#101).

What is *not* shared is the push channel: the socket fans out **this process's** event
store, so a run the `orca acp` process appends is not pushed to the app and appears on its
next read. Lists that look a beat behind for Kepler-driven runs are this, and only a store
watcher closes it.

The alternative, if you would rather stay beside Kepler than inside it, is `orca kepler
<taskDir>` to see what ORCA makes of a task, and `orca submit "$(head -1 AGENTS.md)"
--body-file AGENTS.md` to drive it.

### 3.3 From the T3 Code UI

**This does not work in v0.5.0, in either direction, and there is no configuration that
makes it work.**

- *T3 Code driving ORCA*: T3 Code has no ACP client, so there is nothing to register
  `orca acp` with. If T3 ever adds ACP agents as a provider, `orca acp` plugs in unchanged —
  nothing is needed on ORCA's side.
- *ORCA driving T3 Code*: the adapter in `packages/integrations/src/t3code/` maps ORCA's
  `AgentSession` onto a T3 thread (`openSession` → `thread.create`, `prompt()` →
  `thread.turn.start`, and so on), but the transport under it is not implemented. The only
  shipped `T3CodeRpc` is `UnimplementedT3CodeRpc`, whose `call` and `subscribe` both throw
  `NOT_SUPPORTED`, so a t3code session factory fails on first use.

What is left open on purpose is the concrete WebSocket transport: T3 Code uses Effect RPC
over `/ws` with typed request/success/error envelopes and streaming subscriptions, and
`T3CodeRpc` is the two-method interface to implement (`call`, `subscribe`) against
`@t3tools/contracts` once the envelope is pinned to a version. It is roadmap item 2.

Until then: drive ORCA from Kepler, from the desktop app, or from the CLI, and let T3 Code
run its own threads beside it. Artifact pickup will keep working when the transport lands,
because T3 threads run in local worktrees the host filesystem can read.

---

## 4. Setup a remote ORCA daemon

Read this section before the one after it, because the interesting half is not the setup.

### What the protocol does not do

**The port carries no authentication.** Not a token, not a password, not a header. Anything
that can reach it can list your runs, read your artifacts, answer a gate, cancel a run and
start one. The per-run lease stops a *second writer*; it is not a permission check, and the
daemon says so on startup.

**And the client cannot help.** `DaemonClient` sends one header — `content-type` — and opens
its WebSocket with no credentials at all. So the obvious fix does not work: a reverse proxy
with basic auth, or one demanding a client certificate, will reject the app rather than
protect it. Nor is there a back door in the URL —
`ORCA_DAEMON_URL=http://user:pass@host:6722` does not authenticate anything, it breaks the
app, because Node's `fetch` refuses to construct a request from a URL carrying credentials
("Request cannot be constructed from a URL that includes credentials"). There is nowhere to
put a secret.

That leaves one shape that actually works: **authenticate the transport, not the protocol.**
An SSH tunnel or a WireGuard-style VPN, with the daemon bound to loopback behind it.

### On the remote machine

Either the container from §1, published to loopback only —

```bash
docker run -d --name orca-daemon \
  --user "$(id -u):$(id -g)" \
  --publish 127.0.0.1:6722:6722 \
  --volume ~/orca:/workspace \
  --volume orca-claude-home:/home/node/.claude \
  --volume orca-codex-home:/home/node/.codex \
  --restart unless-stopped \
  orca:0.5.0 serve --host 0.0.0.0 --port 6722
```

— or the standalone daemon bundle from the release page, under a supervisor:

```ini
# /etc/systemd/system/orca.service
[Unit]
Description=ORCA daemon
After=network.target

[Service]
User=orca
WorkingDirectory=/srv/orca
# No --host: the default is 127.0.0.1, which is what you want behind a tunnel.
ExecStart=/usr/bin/node /srv/orca/orca-daemon-0.5.0.mjs serve --port 6722
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The agents run **where the daemon is**, so the remote machine needs the adapters, their
credentials and the repository — that is what the container already carries. A daemon whose
agents should run somewhere else again uses `hosts[].type: ssh` (`docs/INTEGRATIONS.md`);
ORCA does not sync code, so the repository has to be present on whichever machine the agent
lands on.

If the daemon is for watching rather than steering, start it `--read-only`: the ten control
methods leave the dispatch table *and* `hello.methods`, and every client that asks is told
"can't write, and here is why" rather than finding out by failing.

### The tunnel

```bash
ssh -N -L 6722:127.0.0.1:6722 you@remote
```

The remote daemon is then at `http://127.0.0.1:6722` on your machine, and the push socket
comes with it: the client derives the WebSocket URL from the HTTP one by rewriting the
scheme (`http` → `ws`, `https` → `wss`) and appending `/socket`, so both halves take the same
tunnel and the same port. Keep it up with `autossh`, or a `systemd --user` unit, or
`ControlPersist`; a tunnel that drops shows up as the app reconnecting, which it does on a
backoff and gives up on at saturation.

**If you terminate TLS in front of it** — a proxy on the remote, `https://orca.internal` —
the client follows to `wss://` on its own, and the proxy has to pass `POST /rpc` and
`GET /health` and upgrade `GET /socket`. What TLS buys you there is confidentiality and
integrity, not access control: see above. Treat the network the daemon sits on as the
boundary, or put the tunnel back.

---

## 5. Connect to the remote ORCA daemon

### 5.1 From the ORCA UI

Identical to §3.1, because after the tunnel the URL is a local one:

```bash
ssh -N -L 6722:127.0.0.1:6722 you@remote &
ORCA_DAEMON_URL=http://127.0.0.1:6722 ./ORCA-0.5.0.AppImage
```

Two things differ from the local case and both are about where the files are:

- **Artifacts arrive over the wire; paths do not.** The app shows an artifact's content and
  its location, but that location names the remote filesystem. Nothing in the app opens it.
- **File ▸ Open a store… is still local.** It is a directory chooser plus a bundled daemon on
  *this* machine, so it cannot reach the remote store. Coming back from a store you opened
  that way is File ▸ *Connect to a daemon*, which returns to `ORCA_DAEMON_URL`.

If you gave the remote daemon a hostname and TLS instead of a tunnel,
`ORCA_DAEMON_URL=https://orca.internal` is the whole change.

### 5.2 From the Kepler UI

Kepler needs **a command it can launch that speaks ACP on stdio**, and ACP survives an
`ssh -T` hop exactly as it survives `docker exec -i` — that is how ORCA's own SSH host works.
So the remote case is a wrapper on your desktop:

```bash
#!/bin/sh
# ~/bin/orca-acp-remote — register this as the custom agent command
exec ssh -T -o BatchMode=yes you@remote docker exec -i orca-daemon orca acp
```

| Field | Value |
| --- | --- |
| Name | `ORCA (remote)` |
| Command | `/home/you/bin/orca-acp-remote` |
| Args | *(empty)* |

Requirements are the SSH ones: key-based auth with no prompt, and **nothing on stdout but
the protocol** — a login banner, an MOTD or a shell rc that prints anything will corrupt the
channel, and the symptom in Kepler is a session that never starts. `ssh -T` and
`BatchMode=yes` handle most of it; a noisy `.bashrc` on the remote is the one that catches
people.

Note that this does not tunnel the daemon — it launches a *second* ORCA process on the
remote, beside the daemon, over the same store. That is the supported arrangement (see the
end of §3.2 for what the two share and what they do not), and if you also want the desktop
app you want the tunnel from §5.1 as well. They are independent.

Where Kepler is itself a server install, the sessions already run on that server, so a
custom agent pointed at a path on it needs no tunnelling and no ORCA on your desktop at all
(`docs/REAL-AGENT-TEST.md` §8).

### 5.3 From the T3 Code UI

Not available, for the same reason as §3.3, and remoteness adds nothing to it: the missing
piece is a transport, not a network. Roadmap item 2.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| App's status bar reads disconnected against a live daemon | `ORCA_DAEMON_URL` was not in the app's environment — `open -a` on macOS drops it; launch the binary directly |
| `client speaks protocol 1.7, daemon speaks 1.2` | Two versions. `hello` names both; upgrade the older one |
| `orca ping` says "recorded nothing: no daemon answered" although one is | The CLI gives the daemon 2 s, and a cold agent spawn takes longer, so it fell back to an in-process handshake. Run it again — the second one goes through the daemon and records the health the Agents surface reads |
| `FAIL … Authentication required` from `orca ping codex` | `codex login` in the container, into the mounted `~/.codex` volume |
| `orca ping claude` is OK but the first step fails on auth | The Claude adapter opens a session unauthenticated; `claude -p "say pong"` is the check that means something |
| `claude_code_version_too_old` on the first prompt | The adapter used its own bundled Claude Code; set `CLAUDE_CODE_EXECUTABLE` in `agents[].env` (the image does) |
| `spawn codex-acp ENOENT`, or `codex acp` "unrecognized subcommand" | Codex has no ACP mode; the agent's `command` is the adapter, `codex-acp` |
| `WORKFLOW_INVALID: no agent fills role …` | A role in the workflow is in no agent's `roles:`, or the daemon started without the config — `orca agents` lists what it sees |
| `RUN_LEASED: run … is already being interpreted` | Another process drives that run. Let it finish, or `orca leases` and `orca leases break <runId> --force` if you know it is gone |
| A work item is claimed by a run that died | `orca claims`, then `orca claims release <workItemId>` — or **Release** on the Agents surface |
| Kepler shows the agent but sessions never start | The launcher is not executable, or something printed on stdout — stdout is the protocol channel and logs must go to stderr |
| Writes are missing from the app rather than disabled | The daemon is `--read-only`, or it is a file-mode store. That is the design: absence is the honest rendering |
| The app is a beat behind on runs the CLI or Kepler started | Pushes do not cross processes; the socket fans out the daemon's own store. The next read catches up |
| `orca demo` fails with `workflow 'program' not registered` inside the container | `demo` finds the shipped workflows relative to its own module, which a single-file bundle has moved. Run it from a checkout; `orca validate` is the container's equivalent smoke test |
| The `.orca` store is owned by uid 1000 on the host | Start the container with `--user "$(id -u):$(id -g)"` |
| `failed to bind host port 127.0.0.1:6722: address already in use` | Something already serves that port — on a machine that also runs a daemon from a checkout, it is that. `ORCA_PORT=16722 docker compose up`, and point `ORCA_DAEMON_URL` at the same number |
| `bash: UID: readonly variable` | `UID=$(id -u) docker compose …`. Use `ORCA_UID` |

## What v0.5.0 will not do

Worth knowing before you build a habit on it:

- **No authentication on the daemon port, and no way for a client to present a credential.**
  §4.
- **T3 Code, in either direction.** §3.3.
- **A gate does not preserve the agent's session.** The step that resumes opens a fresh one
  (#237).
- **`config.set` reloads nothing.** The daemon serves the configuration it booted with, so a
  config saved from the app's Config surface takes effect on the next `orca serve`. The one
  exception is the permission sidecar, which a running session now re-reads.
- **The daemon cannot create a request.** `runs.start` takes a workflow and vars; submitting
  and decomposing a request is `orca submit` or a prompt through `orca acp`. A
  `requests.submit` method goes beside it when somebody designs one.
- **No completion percentage, no ETA, no agent cost**, anywhere. ORCA cannot supply them and
  does not approximate them.

`docs/ROADMAP.md` is the full list and says why for each.
