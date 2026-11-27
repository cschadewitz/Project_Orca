# Running ORCA across machines

ORCA can use more than one machine in four ways. They differ in where the daemon runs, where
the agents run, and which machine owns the run history. Pick the smallest one that does
the job. They also combine: a parent daemon can delegate to one machine and run SSH-hosted
agents on another, and the app can watch all of them.

| Setup | Daemons | Agents run on | Run history lives on | Reach |
| --- | --- | --- | --- | --- |
| [1. Local only](#1-local-only) | one, on this machine | this machine | this machine | nothing remote |
| [2. Remote agents over SSH](#2-local-daemon-remote-agents-over-ssh) | one, on this machine | other machines over `ssh` | this machine | sshd and the agent binary there |
| [3. App watching several daemons](#3-the-app-watching-several-daemons) | one per machine, independent | each daemon's own machine | each machine | the app's SSH profiles |
| [4. Parent delegating to remote daemons](#4-a-parent-daemon-delegating-to-remote-daemons) | a parent and one or more workers | each worker | the worker owns the work; the parent records the step | sshd on each worker, enrolled |

Commands below are written as `orca-cli …`, the command line the Windows and Ubuntu desktop
installs put on `PATH` (#1207): on Windows the installer adds `resources\bin` under the install
directory to your user `PATH` (open a new terminal after installing), and on Ubuntu the
package installs `/usr/bin/orca-cli`. Plain `orca` is not used because on Ubuntu Desktop it
is the GNOME screen reader. In a source checkout, `pnpm run orca …` runs the same CLI.

The server's CLI is a remote's `serverCommand`. A profile you create in the app uses `orca-cli`
when you leave it empty; a server made by the app's server setup uses its own launcher's full
path. Where it is left out, in a workspace config's `remotes[]` or on a profile saved before
0.8.1, it means `orca`, as it always has, so a remote set up earlier keeps working while its
server still runs an older ORCA. Write `serverCommand: orca-cli` for a server with a desktop
install: on Ubuntu Desktop, `orca` there is the screen reader.

## 1. Local only

The desktop app starts its bundled daemon, or you run `orca-cli serve` in a workspace. Agents
are local processes (`hosts` omitted, or `type: local`).

```yaml
# orca.config.yaml
version: 1
workflows: [workflows/*.yaml]
agents:
  - { id: claude, command: claude-code-acp }
limits:
  maxAgentSessions: 4      # optional; unlimited when absent
```

Limits: one machine's CPU, memory and accounts. Nothing below is needed.

## 2. Local daemon, remote agents over SSH

A machine that only runs agents does not need ORCA's daemon. Declare it as an SSH host, and
each agent session there is `ssh … -- bash -lc 'cd <cwd> && exec <agent>'`. The ssh
child's stdin and stdout carry ACP, and files come back over SFTP. See
[integrations](INTEGRATIONS.md#remote-agents-over-ssh) for the details.

```yaml
hosts:
  - id: buildbox
    type: ssh
    host: build.internal
    user: ci
    identityFile: ~/.ssh/orca
    workspaceRoot: /srv/work
    maxSessions: 3           # optional cap on sessions on that host
agents:
  - { id: claude-remote, command: claude-code-acp, hostId: buildbox }
```

The same host can run **`orca-cli acp`** as the agent, so that the remote machine runs a whole
ORCA workflow for a step, without a daemon there:

```yaml
agents:
  - { id: remote-orca, command: orca, args: [acp], hostId: buildbox }
```

Use this when the remote machine has no daemon and you do not want one: the work happens
inside that ssh session and ends with it. The remote keeps no daemon-owned record of the
step that another parent could reattach to. It enforces no caps of its own across parents,
and it needs nothing but key-based ssh and the binaries on the login PATH.

Limits: the repository must already be on the remote (ORCA does not sync code). A dropped
connection ends that agent session, as with any SSH-hosted agent. The run history stays on
this machine.

## 3. The app watching several daemons

Each machine runs its own daemon and owns its own runs. The desktop app connects to one
**focused** daemon to show and change things, and the **Machines** surface (`⌘7`) watches
more of them read-only. See [daemon connections](daemon-connection.md#watching-several-daemons-882).

1. Make each machine a managed server once: in the app, **Add a machine…** in the
   connection dialog. From a source checkout, use
   `orca-cli remote add user@host` and then `orca-cli remote add user@host --confirm CODE`
   ([one-step setup](daemon-connection.md#add-a-machine-one-step-server-setup-881)). This
   pins the host keys you confirmed and installs the signed server bundle.
2. Save an SSH profile for each one. The app signs in automatically
   ([#875](daemon-connection.md#automatic-sign-in-875)), and the daemon stays on the
   server's loopback.
3. **Watch a machine…** on the Machines surface adds a profile to the watched list (at most
   16). For a machine added from your tailnet, the surface also says whether it is online
   there, read from this computer's Tailscale client every 30 seconds while the surface is open
   and never over ssh. An offline machine says "Offline on your tailnet" and when it was last
   seen, beside why the connection failed. This is a hint only: whether the app is connected
   still comes from the ssh connection (#1230).

Limits: the daemons do not talk to each other, and a run never moves between them. Choose
the focused machine to start or answer work there.

## 4. A parent daemon delegating to remote daemons

A step whose agent is `type: orca-daemon` becomes a run on another daemon, called the worker.
The worker runs a named workflow with its own agents, store and limits. The parent forwards
the worker's gates, cancels the worker's run when the step is cancelled, reattaches after a
dropped connection, and brings the step's artifacts back. The full contract is in
[workflow authoring](WORKFLOWS.md#delegating-steps-to-another-daemon).

Worker (`build-box`), set up as in setup 3 or by hand, with its daemon on loopback port 6722.
A server set up in one step starts with no agents and no workflows, so add them to its
`orca.config.yaml` (under `~/.local/share/orca-server`) first:

```yaml
# build-box: orca.config.yaml
version: 1
workflows: [workflows/*.yaml]          # includes `build`, the workflow parents delegate to
agents:
  - { id: claude, command: claude-code-acp }
limits:
  maxAgentSessions: 2                  # parents are held to this too
```

Parent:

```yaml
# this machine: orca.config.yaml
remotes:
  - id: build-box
    destination: ci@build-box.example
    identityFile: /home/me/.ssh/id_ed25519
    serverCommand: orca-cli             # the worker's CLI on the ssh login's PATH (omitted: orca)
    # serverConfig: /srv/orca/orca.config.yaml
agents:
  - { id: remote-builder, type: orca-daemon, profile: build-box, workflow: build }
```

One-time enrollment. First get the worker's host key fingerprint from a source you already
trust, not over the connection you are about to trust: the worker's console, or its
administrator. An `ssh` command to the worker is not a check yet, because nothing has
verified that endpoint.

```sh
# on build-box itself (console, or a session already pinned to its key)
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# on the parent, in its workspace
orca-cli remote enroll build-box --host-key SHA256:...
```

A CLI-owned workspace (one you run with `orca-cli serve`) enrolls with the command above. A
workspace the desktop app set up in first-run enrolls from the app instead: only the daemon the
app launched may write that workspace, so its first-run fence refuses `orca-cli remote enroll`
("First-run mutation requires owned daemon admission"). Add the `remotes:` entry and the
`type: orca-daemon` agent in Config > Raw, then Validate and review, Save reviewed changes and
Apply saved configuration. A new remote takes effect when the app's daemon next starts, so quit
and reopen the app. The remote is then listed under **Remote daemons** on the Config surface.
Choose **Enroll**, enter the fingerprint (and the jump host's, if the route has one), and choose
**Enroll remote**. The app's daemon pins the key and has the worker issue the credential exactly
as `orca-cli remote enroll` does. On Windows, where the worker cannot issue the credential during
enrollment, paste the output of `orca-cli auth issue <name> --preset client --json` from the worker
(its `serverCommand`) into the Credential field. The daemon proves it first and saves it, readable only by you, in its
own file (`auth/remotes/<id>.<credential id>.token`) only when the enrollment commits, so a
refused credential never replaces the one in use
([#1206](https://github.com/cschadewitz/Project_Orca/issues/1206)).

Enrollment pins exactly that host key and has the worker issue the parent a credential over
ssh. The credential is scoped to the workflows this config delegates and to the runs the
parent itself starts. After that, delegation needs nobody.

What to expect:

- **Capacity.** The parent never holds more delegated sessions open to a worker than the
  worker's `limits.maxAgentSessions`, and waits with
  `waiting for an agent slot: 2 of 2 in use on remote build-box`. Several parents
  sharing one worker are bounded by the worker's own enforcement. A worker without a cap is
  unlimited.
- **Connection loss.** The step keeps the worker's run id and reattaches when ssh comes
  back, before the turn's deadline (`turnTimeoutMs`, 30 minutes by default). It never
  submits the work a second time.
- **History.** The work is in the worker's run list, owned by the parent's principal and
  stating the parent run as its `origin`. The parent's step shows its progress and keeps
  its artifacts.

Limits: text artifacts only. The worker needs the repository, or an allowed `gitRef` to
fetch. Windows parents do not issue credentials during enrollment, so save one by hand
([details](WORKFLOWS.md#delegating-steps-to-another-daemon)).

### SSH host or delegation?

| You want… | Use |
| --- | --- |
| an agent binary on a machine with no ORCA daemon, and history on this machine | SSH host (setup 2) |
| a whole ORCA workflow on a machine with no daemon, for the length of one session | `orca-cli acp` on an SSH host (setup 2) |
| work that survives a dropped connection, a worker that enforces its own caps for every parent, and history on the worker | daemon delegation (setup 4) |
| to see several machines' own work side by side | the app's Machines surface (setup 3) |

## Using your own tailnet (incubating, #1225)

> **Not in a release yet.** This is built behind the incubating `tailnet-hosts` flag
> (docs/WORKSTREAMS.md): it is off unless the process is started with
> `ORCA_INCUBATING=tailnet-hosts`. What follows describes the command line and the app as they stand on `main`.

If you use [Tailscale](https://tailscale.com) (or a Headscale server), you can grow your pool of
daemon hosts over your own tailnet. ORCA hosts nothing for this: it **reads** the Tailscale
client you are already signed in to, by its fixed install path, and never changes it, your
tailnet or its policy. It runs no relay or coordination server, holds no Tailscale auth key, and
never treats tailnet membership as permission: every connection is still ORCA's own pinned SSH
tunnel, and every daemon call still needs an ORCA credential.

**On the new host** (Linux x64): install Tailscale and join your tailnet with Tailscale SSH on.
For a Windows x64 host, see [Windows hosts](#windows-hosts) below.

```sh
sudo tailscale up --ssh
```

That is all. No sshd setup, no SSH keys, no GitHub access.

**From your own machine:**

```sh
orca-cli remote add you@build-1 --tailnet                 # inspect: prints the host key and a code
orca-cli remote add you@build-1 --tailnet --confirm CODE  # set it up
orca-cli remote add you@build-1 --tailnet --push-bundle --confirm CODE   # host with no internet access
orca-cli remote enroll build-1 --tailnet                  # a remotes[] entry whose host is build-1 (setup 4)
```

**In the desktop app:** Connect to a daemon → **Add a machine…** lists the machines on your
tailnet. Pick one, enter the account to log in as (`you@`), and save: the app checks the machine,
shows the host keys your tailnet advertises for it, and sets it up once you confirm, carrying the
signed bundle over the tunnel. When Tailscale asks you to approve the login, the dialog says so
and **Open approval page** opens it in your browser. Offline machines, and machines that are not
Linux or Windows, cannot be picked for setup. **Add profile…** offers the same list for a machine that
already runs a daemon.

- `build-1` is the machine's name on your tailnet (its short or full MagicDNS name, or its node
  ID). The profile is bound to that machine's stable node ID: ssh dials its current Tailscale
  address on every connect, and a name that now belongs to a different machine is refused.
- **Login approval.** Tailscale's default rule for your own devices asks you to approve an SSH
  login in your browser (check mode). ORCA shows the approval link and waits for you. Only for a
  machine on your tailnet, and only a page on Tailscale's coordination server
  (`https://login.tailscale.com`): any server can print a login banner, so a link anywhere else is
  never offered. With a self-hosted control plane such as Headscale, name its https origin in
  `ORCA_TAILNET_LOGIN_ORIGIN`.
- **Host keys.** A machine running Tailscale SSH advertises its SSH host keys to your tailnet.
  ORCA checks the server against exactly those keys, so you do not compare a fingerprint by
  hand; you still confirm the setup. These keys are vouched for by your tailnet's coordination
  server. Tailnet Lock does **not** sign them (it signs node keys only), so they are as
  trustworthy as that server. A machine without Tailscale SSH, or one shared in from another
  tailnet, uses the ordinary confirm-the-fingerprint flow; ORCA prints `sudo tailscale set --ssh`
  for the first case.
- **No internet on the host.** `--push-bundle` makes your machine fetch the signed server bundle,
  the pinned cosign and Sigstore's trusted root, and copy them over the pinned SSH connection
  into a new directory under `~/.cache/orca-courier/` on the host, removed afterwards. The host
  takes the carried trusted root only if this ORCA release pins its digest. When Sigstore
  publishes a new root, an offline setup refuses until you update ORCA; one with internet access
  is unaffected.
  The host still checks the bundle's signature itself. Such a host is updated from the app, not
  by its own timer.

**Putting your repository there** (#1235). The host needs no git credentials and no access to
where your code is hosted:

```sh
cd ~/src/app
orca-cli remote push-repo you@build-1 --tailnet                    # the current branch
orca-cli remote push-repo you@build-1 --tailnet --ref refs/heads/release/1.2 --name app
```

This computer writes the branch (or each `--ref`, a full branch or tag name) into a git bundle,
copies it over the host key `remote add` pinned, and the host fetches it into
`~/.local/share/orca-server/repos/<name>.git`. A checkout beside it,
`~/.local/share/orca-server/checkouts/<name>`, has that repository as `origin`. A later push
moves both forward. A branch the host has at a commit your push does not build on is refused,
never overwritten, and with several refs none of them moves. A checkout with changes of its own is
left as it is, and so is anything at that path whose `origin` is another repository. The host
needs `git`. When there is a checkout of the pushed repository, the command prints the
`workspace:` settings (`provider: git-worktree`, `repo:` the checkout,
`allowedRefs:` the pushed branches) for the server's `orca.config.yaml`, so delegated steps can
name a pushed `gitRef`. To set them from this computer, connect the app to the machine's profile:
Config lists the repositories pushed there, and **Use as workspace** puts those settings into
the draft, with `baseBranch` the branch the checkout there is on, named in full (`refs/heads/…`). If the workspace is already that
checkout and fetches from `origin`,
**Allow pushed branches** only adds the pushed branches it does not allow yet; any other workspace
is left alone and Config says why. Review, save and apply the draft as with any other change.

**Installing and signing in agents there** (#1236). The host needs no npm, no access to the npm
registry and no terminal:

```sh
orca-cli remote agent install you@build-1 --tailnet --agent codex      # or copilot, or claude
orca-cli remote agent login you@build-1 --tailnet --agent codex
orca-cli remote agent status you@build-1 --tailnet
```

`install` downloads the agent's pinned npm packages on this computer (the versions ORCA's
acceptance runs use, each checked against npm's sha512 integrity, and kept in
`~/.cache/orca/courier/agents/` so the next host needs no download), copies them over the host
key `remote add` pinned. On the host, the program ORCA sends checks the carried list against the
package lock shipped with this ORCA (`tools/deploy/host-agents.lock.json`), not against what was
carried, and every tarball against its sha512 there. It unpacks them member by member (one
package directory, plain files and directories only, no path twice, bounded in entries and
bytes) into `~/.local/share/orca-server/agents/<agent>/<version>`, and records every file it
wrote. No package's install script runs. Nothing installed is reused, reported as installed or
run (status, sign-in) unless it is still exactly that record, owned by the account and closed
to other writers, with the profile closed to other accounts. The
command prints the `agents:` entry for the server's `orca.config.yaml`. Each agent gets its own
profile on the host, `~/.local/share/orca-server/agents/<agent>/home` (`CODEX_HOME`,
`COPILOT_HOME`, `CLAUDE_CONFIG_DIR`), never the account's everyday one.

`login` runs the agent's own sign-in on the host with no terminal, so it uses a device code: the
command prints the agent's sign-in page (only a link on that agent's own sign-in site is shown)
and the code, and you approve it in your browser here. The agent writes its credential on the
host; no key or token goes from this computer to the host. Whether your agent plan allows the
same account on several machines is between you and its provider. Codex (`codex login
--device-auth`) and GitHub Copilot CLI (`copilot login --device-code`) are supported.

Claude Code is installed the same way (the `claude-agent-acp` adapter, with the unmodified
Claude Code binary its SDK ships), but ORCA never signs it in: `login` refuses it. You sign it
in yourself, with your own account, on the host: `install` and `status` print the one command to
run there (over `tailscale ssh`, say), which runs its own `auth login` with its profile. ORCA
never reads what it writes, so `status` reports its sign-in as unknown. The host needs `python3`
3.8.17, 3.9.17, 3.10.12, 3.11.4 or later, for safe unpacking.

In the app, the same is under **Agents** on the machine's profile in the connection dialog. It
lists each agent with its pinned version, whether it is installed and signed in (or why an
install is not usable), with **Install** and **Sign in**. During a sign-in it shows the code and
the sign-in page's host, and **Open sign-in page** opens that page in your browser. For Claude
Code there is no **Sign in**: it shows the command to run on the machine instead. While the app
is connected to that machine's profile, Config lists the agents installed there: **Add to
configuration** puts the agent's `agents:` entry (the one `install` prints) into the draft. If an
earlier install there added an agent with that id, **Update in configuration** changes only its
`command`, `args` and the agent's own `env` keys, keeping its permissions, name and other
settings. Any other agent with that id, including one you configured yourself, is left alone and
Config says why: remove or rename it to add the installed one. Review, save and
apply it as with any other change (#1235).

**Policy notes.** The default tailnet policy lets you SSH to machines you own. If you tag a host
(for example `tag:orca-server`), it leaves `autogroup:self`, so add a narrow SSH rule for your
own devices and the account ORCA logs in as. Avoid broad `autogroup:member` rules.

Without Tailscale, typed SSH profiles keep working over any VPN or LAN.

### Windows hosts

Tailscale SSH has no Windows server, so a Windows x64 host uses the OpenSSH Server that Windows
itself ships (#1238). ORCA does not bundle, update or reconfigure it: Windows Update installs and
updates it, and you maintain nothing for it beyond Windows Update.

**On the Windows host**, install Tailscale and sign in to your tailnet. Then turn its OpenSSH
Server on with the line your own ORCA gives you, run once in an administrator PowerShell there:

- In the desktop app, **Add a machine…** shows it when you pick a Windows machine, with what it
  does, and copies it for you.
- From a source checkout, `orca-cli remote windows-ssh` prints it (`--json` for the command and
  digest alone).

The line downloads `tools/deploy/orca-windows-ssh.ps1` from your ORCA version's tag, checks its
SHA-256 against the copy your ORCA install ships, and runs it only if they match; otherwise it
deletes the download and runs nothing. It never pipes a download into the session. To read the
script first, it is in your ORCA install's `resources/server-setup/` folder, and it runs the same
way with `powershell -NoProfile -ExecutionPolicy Bypass -File orca-windows-ssh.ps1`.

- If the OpenSSH Server is already installed, starts automatically and is running, it changes
  nothing, its firewall rules included, and says so. It does not then claim SSH is limited to
  Tailscale: that policy is yours.
- Otherwise it lists exactly what it would change and asks first. Anything but `y` changes
  nothing ("Nothing was changed"). The changes, only those still needed, in this order:
  1. Install the OpenSSH Server Windows feature from Windows Update. Its `sshd` service stays
     stopped.
  2. Allow inbound SSH (TCP 22) only over the Tailscale adapter, with the firewall rule
     "ORCA: OpenSSH Server over Tailscale", and disable the rule the feature adds for every
     network (`OpenSSH-Server-In-TCP`).
  3. Check that SSH is then allowed over Tailscale alone, and only then set `sshd` to start
     automatically and start it.
- It refuses, changing nothing, outside an administrator session, without the Tailscale
  adapter, on a Windows too old to have the feature (before Windows 10 1809 or Windows Server
  2019), or when SSH would stay open on another network: a firewall profile that is off or
  allows inbound connections by default, another enabled rule that allows SSH (it changes no
  rule it did not make, and none a policy manages), or a rule by its own name with another
  scope.
- A step that fails stops the run before `sshd` is started; run it again to finish.

**From your own machine**, add it as above (`orca-cli remote add you@desk-1 --tailnet`, or **Add
a machine…**). Its host key is not advertised by your tailnet, so you compare the fingerprint by
hand before you confirm, as for any first-seen key. Signing in uses the key or password your
Windows account accepts over SSH. For an administrator account, Windows reads its keys from
`C:\ProgramData\ssh\administrators_authorized_keys`, not from the account's own
`.ssh\authorized_keys`.

The setup then runs as that account and needs no administrator rights of its own: it installs
under `%LOCALAPPDATA%\orca-server`, downloads and verifies the signed Windows server bundle on
the host (`--push-bundle` is Linux only for now), and registers the scheduled task
`\ORCA\orca-server`.
- **At boot, or at logon.** Where the account may register a task that starts at boot, the
  daemon runs whether or not anyone is logged on. Otherwise the task starts when the account
  logs on, and the setup says so; setting it up again while the account is an administrator
  moves it to boot.
- A setup directory whose path has a space is refused for now.

## How this is tested

The **Two daemons** workflow (`.github/workflows/two-daemons.yml`) runs on every pull
request that touches the daemon, CLI, protocol, host or delegation code:

- **Two daemons over loopback ssh:** two daemons on one runner, with one behind a throwaway
  sshd. These are the enrollment, refusal and recovery cases from
  `packages/cli/test/delegation-883.test.ts`.
- **Two machines in containers:** `packages/cli/test/delegation-machines-885.test.ts`
  builds this checkout's server bundle (unsigned) and installs it in separate Ubuntu 24.04 containers
  (`packages/testing/machine/Dockerfile`) on a private network. A parent and a second parent
  each enroll with the worker's host key and an issued credential. The test then checks
  delegation with the artifact brought back, a forwarded gate, cancellation, the parent
  dropping off the network mid-step and reattaching without a second submission, and both
  parents together never exceeding the worker's cap of 2.

To run the container test locally: `pnpm run build`, then
`ORCA_TWO_MACHINES=1 pnpm exec vitest run packages/cli/test/delegation-machines-885.test.ts`
with Docker running. `ORCA_SERVER_BUNDLE` reuses a built bundle, and `ORCA_MACHINE_BASE` names
a base image that already has the packages, for a host without the Ubuntu archive.
Both jobs run on pull requests that change the paths listed in that workflow:
the daemon, CLI, protocol, engine, core, store and agent sources, the testing fixtures, the
bundle build, and the lockfile and package manifests. A change outside those paths does not
start them.

This container test is not release acceptance. It installs an unsigned bundle built from the
checkout and does not verify a signature or a native install. Signed bundles and installs on
real hosts are accepted separately, with the project's release-testing approach.
