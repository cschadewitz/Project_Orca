# agent-01 supervision proposal — owner review, no activation

This is the deployment-specific continuation of [PR446](https://github.com/cschadewitz/Project_Orca/pull/446),
prepared from main `e1db2049e4a9b4a26a9f66e16e6891f8caf131d6` (PR482).
Casey approved automatic startup after reboot and bounded automatic restarts under `casey`,
subject to review of the exact configuration before installation. This proposal performs
no SSH, installation, credential access, settings changes, restart or deployment.
**An ORCA bootstrap coding run is active. No live cutoff is authorized now.**
The observations below were supplied by the owner on 2026-10-04, not re-observed on Linux.

## Exact proposal and authority boundary

| Item | Existing value or proposed destination |
| --- | --- |
| Host / user | `agent-01`, Debian 13.7, systemd 257, `casey` UID 1000; user units, no `User=` impersonation |
| `HOME` / working directory | `/home/casey` / `/home/casey/.orca-codex-work` |
| Configuration / workflow | `/home/casey/.orca-codex-work/orca.yaml` / `work.yaml` in that same directory; retain both unchanged |
| Daemon | `/home/casey/.local/share/orca-runtime/49efcc7236ac127c952bb1f7a50fc6ef72f7df84/packages/cli/dist/main.js` |
| Service-entry Node | `/home/casey/.local/share/mise/installs/node/24.21.0/bin/node` |
| Launcher's internal Node alias | `/home/casey/.local/share/mise/installs/node/24/bin/node`; cutover must verify resolution and hash against the reviewed 24.21.0 binary |
| Clean `PATH` | `/home/casey/.local/share/mise/installs/node/24.21.0/bin:/usr/bin:/bin` |
| Private temp | `/srv/dev/orca-temp-cal`, `casey`, `0700`; explicit `TMPDIR` **after** `env -i` in both units |
| Daemon listener | `127.0.0.1:33871`; explicit `--config /home/casey/.orca-codex-work/orca.yaml` before `serve` |
| MCP launcher | `/home/casey/.orca-codex-work/mcp-client.cjs`, SHA-256 `302b68229a763b69bc32c482148f0f855fd003d9b38f16bea9b218f95001287e` |
| Retained MCP CLI | `/home/casey/.local/share/orca-runtime/3702da5b38dc449280c2837366615de741e9c45c/packages/cli/dist/main.js`; **not** the daemon pin |
| Issued scoped credential | `/home/casey/.orca-codex-work/cal-codex-work.json`, private `0600`, issued JSON (not PR446's raw token-file format) |
| Tunnel | `/opt/orca-tunnel/0.0.15/tunnel-client`, existing ID `tunnel_6ac0b657e5d88191a442de4978b38ea9` |
| Proposed profile / key reference | `/home/casey/.orca-codex-work/supervision/tunnel-profile.yaml` / `tunnel-runtime.key` in that same private directory |
| Proposed local tunnel health | `127.0.0.1:33872`; availability requires owner verification |
| Proposed unit destinations | `/home/casey/.config/systemd/user/orca-daemon.service` and `orca-tunnel.service` |

The recommended **explicit opt-in** uses `tunnel-profile.live-launcher.yaml.template`
and retains the current private launcher byte-for-byte. It validates exact principal,
six grants, workflow/owned-run scope, literal-dot token format and local expiry before
executing MCP `3702da5` against port 33871. It has **no fixed credential-ID or daemon
boot pin** and does not itself establish fresh authenticated discovery before startup.
The supplied hash includes the literal-dot character-class regex repair; do not restore
an earlier launcher copy. No private launcher or credential contents are included here.
The unchanged launcher internally execs Node through the `24/bin/node` alias above.
The absolute 24.21.0 service-entry path does **not** pin every descendant: neither it
nor the clean PATH overrides that internal absolute alias. Its resolution is an owner
verification gate, not an additional enforcement mechanism in the unit or launcher.

Required authority remains principal `cal-codex-work`, permissions exactly `runs.read`,
`artifacts.read`, `workflows.read`, `runs.start`, `runs.control`, `inputs.answer`, workflow
`cal-codex-work`, and `runs: owned`. The currently issued credential expires
**2026-10-05T18:16:53.254Z**. Supervision cannot extend it or prove revocation status.
If expired/revoked, keep mutation access closed and use the owner's separate credential
process; no owner-token fallback, broadening, or renewal is part of this proposal.

PR446's `launch-mcp.js`, `credential-policy.js`, guarded tunnel template and service
profile are unchanged. That alternative validates a raw token and daemon credential
store, pins credential ID and workspace/boot UUID, and checks authenticated discovery
before opening stdio. Selecting it is a separate reviewed migration, including its
different file formats: owner-controlled adoption of each new boot UUID is mandatory
under the [existing boot-pin procedure](service-supervision.md#post-start-boot-identity-mandatory-before-reopening-the-tunnel).
It does **not** provide unattended MCP reconnect after daemon reboot. Never remove a
repository guard or auto-adopt a boot UUID to make either option appear equivalent.

## Render and review locally

From this repository, render each non-secret artifact to a new local staging directory
(these commands create local review files only; they do not install):

```sh
mkdir ../agent01-review
node tools/deploy/private-mcp-service/render-agent01.js orca-daemon.service > ../agent01-review/orca-daemon.service
node tools/deploy/private-mcp-service/render-agent01.js orca-tunnel.service > ../agent01-review/orca-tunnel.service
node tools/deploy/private-mcp-service/render-agent01.js tunnel-profile.yaml > ../agent01-review/tunnel-profile.yaml
```

The renderer has fixed reviewed proposal values, takes only an artifact name, reads
only repository templates, and normalizes LF on Windows. Review the entire rendered
files and their hashes before later transfer. Never run them from the current main
build: only the separate installed runtime paths above are proposed for execution.
The shared PR446 unit templates now include explicit config, working directory, temp
and cgroup shutdown settings; the separate guarded MCP launcher policy is unchanged.

Both unit entries begin `/usr/bin/env -i HOME=... PATH=... LANG=C TMPDIR=...`.
No shell expansion, login initialization, `NODE_OPTIONS`, `NODE_PATH`, tunnel overrides,
API key environment or `EnvironmentFile` is imported. The clean PATH must be checked
against the existing adapter/worker configuration on Linux: preserve the configured
absolute adapter path and explicit worker TMPDIR; do not substitute a broad login PATH.
Any indispensable proxy/CA/worker environment addition needs a literal, narrow reviewed
change to the proposal. `XDG_RUNTIME_DIR`/D-Bus settings for owner **management commands**
are not automatically forwarded to daemon or tunnel children.

Each service uses `Restart=on-failure`, `RestartSec=5s`, six starts per five-minute
window, and a 30-second SIGTERM stop window followed by SIGKILL for remaining cgroup
members. This bounds a rapid failure loop, not total lifetime restarts; clean exits and
explicit stops do not restart. Forced termination can interrupt work, hence the quiescence
gate below. Tunnel `Wants=orca-daemon.service` plus `After=` pulls in/orders startup
without stop/restart propagation in either direction. There is no `Requires`, `PartOf`
or `BindsTo`. Stopping the tunnel leaves admitted daemon work alone; stopping a daemon
for maintenance requires explicitly stopping the tunnel first. `After` with `Type=simple`
is not readiness. User `network-online.target` is not proof of host connectivity.
Startup races/network outages may exhaust retries; investigate before `reset-failed`.
These relationships follow [systemd 257 unit semantics](https://github.com/systemd/systemd/blob/v257/man/systemd.unit.xml).

## Staged owner runbook — future maintenance window only

1. **Review and prerequisites.** Confirm the active bootstrap and all other runs have
   reached an owner-approved quiescent state before any stop. Record active/paused run
   IDs, root paths/branches, pending input, admission and continuation receipts, stable
   retry IDs, uncertain outcomes and configuration generation. Do not cancel, resume,
   reconcile or replay work just to prepare this switch. Identify both foreground SSH
   processes and their owned descendants by PID/start time/executable/cwd/listener;
   do not publish raw environment or argv dumps that might expose the tunnel key.
   Recheck runtime manifests, launcher hash, config/workflow hashes, installed binary
   hashes, private ownership/modes and sufficient space on `/srv/dev` **and** `/tmp`.
   Verify the live launcher still execs the separate MCP pin and that its existing
   clean-child environment does not expose a control-plane key. Stop on drift.
   Before cutover, use these **read-only** owner checks on Linux (not run by this PR):

   ```sh
   /usr/bin/readlink -e /home/casey/.local/share/mise/installs/node/24/bin/node
   /usr/bin/readlink -e /home/casey/.local/share/mise/installs/node/24.21.0/bin/node
   /usr/bin/sha256sum /home/casey/.local/share/mise/installs/node/24/bin/node /home/casey/.local/share/mise/installs/node/24.21.0/bin/node
   ```

   Require both canonical paths to identify the reviewed 24.21.0 binary and both
   SHA-256 values to match its independently reviewed binary hash; equal version
   strings or equal hashes without that reviewed reference are insufficient.
   Missing paths, changed alias resolution or a hash mismatch block cutover. Do not
   retarget the alias or edit the launcher to pass. Recheck after any mise/Node change
   and before a later restart/rollback that could select a different descendant binary.

2. **User manager and hardening acceptance.** As Casey, inspect `loginctl show-user
   casey -p Linger`, `systemctl --user is-system-running`, user unit/drop-in inventory,
   and availability/ownership of `/run/user/1000` and its bus. Do not switch to root
   services or change user namespaces/security settings when this fails. Run
   `systemd-analyze --user verify` on the staged units and inspect all effective
   directives/drop-ins before approval. Keep `UMask=0077`, `PrivateTmp=yes` and
   `NoNewPrivileges=yes`. Verify private mount namespace support for this **user**
   manager, worker sandbox/user-namespace compatibility, adapter paths, and temp
   visibility with disposable Linux fixtures before switching. An unsupported or
   ignored protection is a blocker, not permission to turn it off. PrivateTmp does not
   replace the explicit `/srv/dev/orca-temp-cal` directory. See the
   [systemd 257 execution reference](https://github.com/systemd/systemd/blob/v257/man/systemd.exec.xml).

3. **Private runtime-key entry (owner only).** Persistent storage has not been
   configured or verified. The owner already holds a restricted Read+Use replacement
   key; no key creation, access change, admin key or secret retrieval is required here.
   After approval, create the proposed `supervision` directory as Casey with mode 0700,
   verify no symlink/writable ancestors, and enter the key directly on Casey's private
   terminal using the hidden prompt below. Disable terminal/session recording and
   shell tracing; never paste it into chat, YAML, argv, environment, history or logs.
   This future command creates a new 0600 file exclusively and refuses overwriting an
   existing one. If interrupted, the owner must inspect the private state and resolve
   it deliberately; do not repeatedly overwrite it. Validate only owner/mode and
   successful use, never print or hash the secret into evidence.

   ```sh
   /usr/bin/python3 - <<'PY'
   import getpass, os
   path = '/home/casey/.orca-codex-work/supervision/tunnel-runtime.key'
   key = getpass.getpass('Restricted tunnel runtime key (hidden): ')
   if not key or any(c.isspace() for c in key):
       raise SystemExit('STOP: empty or whitespace-bearing key')
   fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
   with os.fdopen(fd, 'w') as output:
       output.write(key + '\n')
   del key
   PY
   ```

   Install the reviewed YAML as Casey-owned 0600 in that directory. Its only secret
   setting is `api_key: file:/home/casey/.orca-codex-work/supervision/tunnel-runtime.key`.
   Run the pinned tunnel's `doctor --profile-file <exact-profile> --explain` in the
   same clean environment as its unit, privately; do not upload raw diagnostics.
   Confirm Read+Use, intended audience/association, one `main` command and proposed
   loopback health port availability. Doctor is not a second `run` client. The
   [0.0.15 configuration reference](https://github.com/openai/tunnel-client/blob/v0.0.15/docs/configuration.md)
   documents file references and profile precedence. The key file is still sensitive
   plaintext at rest, readable by Casey; mode 0600 is not an OS keychain.

4. **Backup and switch, only after explicit window approval.** Stop new dispatch by
   stopping the identified foreground tunnel first. Recheck quiescence locally with
   authenticated reads, then gracefully stop the identified foreground daemon. Confirm
   both processes/descendants are gone and port 33871 is free; no overlapping daemon
   writers or clients for this tunnel ID. Take and verify a **new current-state**, consistent
   private backup before starting the service: ORCA home including protected/auth/audit
   state, current configs/workflows and launcher, external stores, run worktrees/branches,
   owned receipts, and old unit/profile state or their absence. Keep credentials protected
   in any backup and entirely out of repository/CI; an online copy alone is not a
   consistent rollback snapshot. Retain existing backups too. Do not use PR480's historical
   pre-admission restore recipe. Install only the reviewed units/profile; do not rewrite
   ORCA config, workflow, credential JSON, runtime or launcher.

5. **Start and authenticate before access.** `systemctl --user daemon-reload`, then
   start only `orca-daemon.service`. Verify exactly one writer, expected executable,
   cwd/config/environment and listener; check `http://127.0.0.1:33871/health` locally.
   Use the existing scoped authenticated client for `operator.discover`: require credential
   authentication, principal, exact six grants, workflow and owned-run scope, stable
   workspace UUID, and freshly observed boot UUID. Preserve the pre-switch stable
   workspace identity from authenticated discovery; never accept a changed workspace
   simply because health works. Verify installed build/path/hash independently; version
   `0.6.0` alone does not establish the commit. Only then start `orca-tunnel.service`.
   Confirm exactly one tunnel, `/healthz` and `/readyz` on loopback 33872, and fresh
   `discover_orca` plus harmless reads from the intended client. Health/readiness proves
   neither authority nor successful execution. No new smoke admission is authorized here.

6. **Reboot and bounded restart acceptance.** After the exact configuration is accepted,
   enable both user units for `default.target`. If lingering is already enabled, leave
   it alone. If absent, record Casey's approval of this persistence change and have the
   owner run `loginctl enable-linger casey`; without a boot-started user manager,
   enablement alone does not establish startup after reboot without login. This PR
   does not execute that command. Separately schedule a quiescent restart/reboot test:
   tunnel-only restart must retain daemon PID/boot/work; daemon restart/reboot must
   produce a fresh boot identity with the same stable workspace and scoped authority.
   Test failure-rate exhaustion, shutdown cleanup and startup without SSH in disposable
   Linux fixtures first. Record sanitized unit status/restart counts and identity comparisons.
   Do not induce a crash or reboot while admitted work is active. Reset only the failed
   unit's start limit after diagnosis; never an unbounded restart loop.

## Every reconnect and rollback

With the retained live launcher, services can start automatically while credentials and
dependencies remain valid; this does **not** authorize automatic mutation replay. After
every restart, reconnect, rotation or rollback, require fresh authenticated discovery,
compare the stable workspace/authority/build, and use the fresh target for any separately
authorized mutation. Stale targets must remain rejected. This is a client/owner operating
gate, not a new launcher-enforced boot pin. Preserve uncertain admission/continuation
identifiers and inspect their existing receipts before any separately authorized retry;
never mint a new retry ID to work around uncertainty. Supervision does not prove safe
automatic admission recovery or extend scoped credential lifetime.

If only the tunnel fails, stop/disable that owned unit and preserve the daemon and admitted
work. For a service migration rollback, obtain quiescence, stop/disable tunnel then daemon,
verify no descendants/writer/listener remain, and return to the known foreground commands
with the **same current 49ef daemon, 3702 MCP launcher, clean environment and current files**.
Ensure units cannot auto-start alongside foreground processes. Restore previous unit/profile
configuration only as reviewed; if lingering was newly enabled, reverting it is a separate
owner decision because it affects other user services. Rediscover before reopening access.
Do not restore stale snapshots, expired/revoked credentials, or downgrade binaries over
post-admission state. Preserve all admitted runs, protected inputs, auth/audit records, logs,
generations, worktrees, branches and receipts, including failed/cancelled run files. If data
or runtime recovery is needed, stop and obtain a separately reviewed reconciliation plan;
see the [PR480 correction](../owned-root-candidate-49efcc7/correction-2026-10-04.md#reuse-and-recovery-boundaries).
Service rollback does not implicitly revoke credentials or delete files.

## Verification boundary

The renderer and synthetic tests exercise exact pins, clean environment directives,
dependency/shutdown boundaries, secret references and the separate launcher option.
PR446 policy/launcher tests remain in use; real POSIX file-mode/UID and `/usr/bin/env`
fixtures run on Linux and explicitly skip on Windows. No Linux acceptance, live secret
validation, systemd verification, worker-sandbox compatibility, cutover, restart/reboot,
expiry/rotation lifecycle or automatic recovery acceptance has been performed by this PR.

Local Windows validation (Node 24.19.0, pnpm 12.4.2): the two service test files passed
12 tests with 6 explicit Linux-only skips; full `pnpm run lint` and `pnpm run typecheck`
passed. Changed JavaScript passed default Prettier checks. Full `format:check` reported
912 existing checkout files with CRLF; the full check with `--end-of-line auto` passed.
No unrelated files were reformatted. Rendered proposal files were inspected locally;
this evidence is not Debian/systemd acceptance.
