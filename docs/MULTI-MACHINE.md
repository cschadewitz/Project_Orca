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
   16).

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
Linux, cannot be picked for setup. **Add profile…** offers the same list for a machine that
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

**Policy notes.** The default tailnet policy lets you SSH to machines you own. If you tag a host
(for example `tag:orca-server`), it leaves `autogroup:self`, so add a narrow SSH rule for your
own devices and the account ORCA logs in as. Avoid broad `autogroup:member` rules.

Windows hosts cannot be set up this way yet: Tailscale SSH has no Windows server (#1238). Without
Tailscale, typed SSH profiles keep working over any VPN or LAN.

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
