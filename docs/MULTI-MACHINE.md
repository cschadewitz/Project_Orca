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

## 1. Local only

The desktop app starts its bundled daemon, or you run `orca serve` in a workspace. Agents
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

The same host can run **`orca acp`** as the agent, so that the remote machine runs a whole
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
   `orca remote add user@host` and then `orca remote add user@host --confirm CODE`
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
    # serverCommand: orca              # the worker's CLI on the ssh login's PATH
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
orca remote enroll build-box --host-key SHA256:...
```

The parent must be a workspace the CLI owns (one you run with `orca serve`). A workspace the
desktop app set up in first-run refuses `orca remote enroll` ("First-run mutation requires owned
daemon admission"), and the app has no enrollment screen yet
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
| a whole ORCA workflow on a machine with no daemon, for the length of one session | `orca acp` on an SSH host (setup 2) |
| work that survives a dropped connection, a worker that enforces its own caps for every parent, and history on the worker | daemon delegation (setup 4) |
| to see several machines' own work side by side | the app's Machines surface (setup 3) |

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
