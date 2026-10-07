# Owner staging packet and historical service-cutover evidence

## Reconciled status — 7 October 2026

This packet retains the original 4 October staging/probe recipes and exact artifact
hashes for audit. **Those recipes are historical, not current operating instructions
or a request to repeat transfer, installation, cutover, key entry or lingering.**
No live host/credential/configuration read or action is performed by this reconciliation.
Main inspected is `c1eba301702fef0466b2d3481c36d62331ee7d48`; the historical service runtime has its
separate pins below.

The [5 October owner service-cutover acceptance](https://github.com/cschadewitz/Project_Orca/pull/496#issuecomment-5986160454)
supersedes the earlier not-installed/not-enabled/`Linger=no` status for that recorded
target and scope. #392/#393 already append this evidence, preserving their other gates.

| Evidence class | Recorded result and limit |
| --- | --- |
| Owner terminal | Fresh all-principal scan covered 24 runs, no unsettled continuations; one historical stale run explicitly preserved. Installed unit/profile hashes and effective `UMask=0077`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, bounded restart/cgroup shutdown matched reviewed #484 rendering `1199f7e4705d904f3f5dfda32a2644d0b8346e01`. Daemon stayed `49efcc7236ac127c952bb1f7a50fc6ef72f7df84`, MCP stayed `3702da5b38dc449280c2837366615de741e9c45c`. |
| Owner service state, 5 October 00:35:58 UTC | Both units active/running, `NRestarts=0`, enabled, `Linger=yes`, loopback-only listeners 33871/33872. This is historical post-cutover state, not current health or reboot acceptance. |
| Connector-verified configured-worker smoke, 00:08:12 UTC | One result with identifier suffix `49fa1cf2-052c-411c-9cee-ec6f4d3cdc38` completed the five prescribed shell/Git checks with initial/final verification, unchanged HEAD `8875f4585d7e5cd038ec974f5c6c270f8c5f01c3`, no source commit, clean source and complete empty source-review index. Retrieved patch was exactly `No source changes.` It does not prove every worker/runtime/operator scenario. |
| Connector-verified post-SSH read | Owner closed setup SSH windows at 00:36:42; authenticated discovery/run read succeeded at 00:36:52 with the same service instance and unchanged scoped authority. This is observed post-cutover access, not full interruption/reconnect/recovery acceptance. |
| Tunnel doctor | Configuration/key-reference resolution, executable readability and brief health-bind success only; doctor does not authenticate runtime-key grants or run the MCP child. Separate discovery/worker evidence carries those distinct observations. |
| Backup/install prerequisites | Owner confirmed current-backup scope/capacity and success at 00:02:12, before installation. The first backup guard stopped before archive creation; the reviewed V2 narrow 0775 exceptions changed no permissions. Existing state/roots/backups and dependency symlinks remained retained. See the linked acceptance for helper digests and eight synthetic backup fixtures; those helpers are not added to this packet. |

The recorded scoped credential expired **5 October at 18:16:53 UTC**. Neither renewal,
present credential validity nor present live health is inferred. Before future authorized
mutations, recheck authenticated target/service identity and scope, preserving original
retry/receipt identity and retained work. This is a future operating constraint, not an
instruction to obtain access or run discovery now.

Keep #392/#393 open for real reboot/restart/network interruption, expiry/rotation/
revocation/audience boundaries, rollback/removal, full automatic recovery and the
complete actual-Cal operator/approval matrix. Service enablement/Linger/one worker
smoke/post-SSH read cannot clear those gates. No reinstall or credential/access change
is proposed; no host test, mutation, merge or closure is authorized here.

## Historical staging preparation (4 October)

The following original commands/effects remain reproducible audit records only.
Current operation must follow a separately reviewed action-time runbook and fresh
authorization; do not execute these preserved recipes against the historical paths.

Follow-up: the owner reports staging/syntax success and independent official Node
verification. See [the separate disposable hardening probe](hardening-probe.md) for
that evidence and its exact proposed effects. It supersedes the historical Node gap
below; the original staging script and rendered files remain unchanged.

The three sibling unit/profile files are exact LF output of `render-agent01.js`
at merged source **`1199f7e4705d904f3f5dfda32a2644d0b8346e01`** (PR484).
They retain the original staging proposal unchanged, including separate daemon/MCP
pins, then-current launcher, clean environment, hardening and the then-missing
persistent runtime-key reference. Later cutover evidence above supersedes that missing-
reference status for the historical installed setup; the staged artifact is unchanged.
No credential, profile secret or host state was read to prepare this packet.
All cutover limits in [the runbook](../agent01-supervision.md) still apply.
The original stage required the foreground daemon/tunnel to remain running.
That pre-cutover instruction does not describe the later installed service state.

| File | SHA-256 of downloadable LF bytes |
| --- | --- |
| `orca-daemon.service` | `c9b805d674ed474cf712d2493e6bf0546efea4d9ed67ec4799bfacf4795f63d9` |
| `orca-tunnel.service` | `19ea0774df1abaf0066a9cf4136ecdf4613f4daf1f1f240ed2402fd00cf0b43c` |
| `tunnel-profile.yaml` | `d9deb85cae77c9da4dbb796daae62a22613ee18182489fb5518d2b7bd3529d38` |
| `stage-agent01.py` | `c9af7b86f414cdab80545afa05598760c763faa7065edd70d85ab166904f494e` |

## Historical supplied prerequisite evidence, not acceptance

Owner metadata reported at **21:23 UTC, 2026-10-04**, without this task accessing agent-01:

- Node `24/bin/node` resolves to `24.21.0/bin/node`; both observed binary SHA-256 values
  are `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.
- The Casey user manager is running; `Linger=no`. Both ORCA units are not found/inactive,
  with no drop-ins. Port 33871 binds only `127.0.0.1`; port 33872 is free.
- `/home/casey/.orca-codex-work` and `/srv/dev/orca-temp-cal` are Casey-owned 0700.
  The issued `cal-codex-work.json` is a regular Casey-owned 0600 file; contents unread.

These are prerequisite observations at that time, not systemd/sandbox acceptance.
At the initial preparation checkpoint the independent Node distribution-reference
check was **unverified**: the permitted
web tool could not access `https://nodejs.org/dist/v24.21.0/SHASUMS256.txt`.
No permission expansion, alternate download bypass, archive download, execution or
installation followed. The owner-reported digest is the installed **binary** digest,
not an archive checksum. The later owner-reported verification in [hardening probe](hardening-probe.md) closes
that historical gap by owner evidence, not this task's host observation. The original
required method was an independently sourced official
Linux x64 archive, verifying its archive digest against the official SHASUMS, then
extracting `bin/node` without execution and comparing that separate binary digest.
Do not relabel the supplied equality as independent provenance or use it to clear cutover.

## Historical transfer/staging recipe — do not repeat as current instructions

`stage-agent01.py` is self-contained (about 6.5 KB), embedding the exact three non-secret
files and their hashes. Download its **raw bytes from the immutable preparation commit
linked in the handoff**, using the existing authorized private GitHub access. Do not
download a moving branch, paste/reconstruct the program, run `curl | python`, or add an
access token to argv/environment. No new access or credential is required by this packet.

Use an existing owner-approved transfer method to copy those unchanged bytes into a
**new private directory**, with no overwrite and no symlinks:
`/home/casey/orca-staging-download-1199f7e/stage-agent01.py`.
The owner should create that directory exclusively as Casey (0700); an existing path
is a STOP, not a reason to reuse/empty it. Transfer only the script, as a regular 0600
file. Verify directory/file ownership and absence of symlink ancestors privately.
Keep shell tracing/session recording off. The short check below prints no source,
argv, environment, credential or raw diagnostic output. A mismatch does not run Python:

```sh
if /usr/bin/test -f /home/casey/orca-staging-download-1199f7e/stage-agent01.py &&
   /usr/bin/test ! -L /home/casey/orca-staging-download-1199f7e/stage-agent01.py &&
   printf '%s\n' 'c9af7b86f414cdab80545afa05598760c763faa7065edd70d85ab166904f494e  /home/casey/orca-staging-download-1199f7e/stage-agent01.py' | /usr/bin/sha256sum --check --status
then
  /usr/bin/env -i HOME=/home/casey PATH=/usr/bin:/bin LANG=C /usr/bin/python3 -I -S -B /home/casey/orca-staging-download-1199f7e/stage-agent01.py
else
  printf '%s\n' 'STOP: script transfer verification failed'
fi
```

Before executing, review its exact effects: it requires Linux, `agent-01`, Casey UID/EUID
1000, and no arguments. It traverses `/`, `/home`, `/home/casey` by directory descriptors,
refusing symlinks, unexpected owners and group/world-writable parents. It exclusively
creates **`/home/casey/orca-service-review-1199f7e`** as 0700 and writes only the three
embedded review files plus `rendered-sha256.json`, each 0600 with exclusive/no-follow
opens and checked embedded hashes. Any existing destination, including a symlink,
is refused. Interruption leaves partial staging for inspection; no automatic deletion,
retry overwrite or recovery is attempted. Successful staging prints one generic line.

The script reads no ORCA home, key, credential or daemon data; contacts no service or
network; starts no process; and never calls systemctl, installs units, changes lingering,
enters a key, starts/restarts/stops anything, or changes the existing launcher. The only
filesystem writes are that new review directory and its four named files. Cleanup is
optional owner removal of those four reviewed files and the empty review directory;
never recursively delete an existing/unverified path or touch the live ORCA home.

## Historical owner-only syntax check, after successful staging

At initial publication the preparation agent had not run this on Linux. Later owner
syntax success is recorded above and in the probe packet. Preserve this recipe for
audit; it is not a current instruction to rerun it or operate the service manager:

```sh
if /usr/bin/env -i HOME=/home/casey PATH=/usr/bin:/bin LANG=C XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /usr/bin/systemd-analyze --user --man=no --recursive-errors=yes verify /home/casey/orca-service-review-1199f7e/orca-daemon.service /home/casey/orca-service-review-1199f7e/orca-tunnel.service >/dev/null 2>&1
then
  printf '%s\n' 'SYNTAX CHECK PASSED; runtime compatibility and activation remain unverified'
else
  printf '%s\n' 'STOP: syntax/dependency check failed; no services changed'
fi
```

Only the exit result is exposed. A failure requires private diagnosis of this bounded
check, not installation or removing hardening. `--recursive-errors=yes` makes dependency
warnings fail too; `--man=no` avoids invoking man, and do **not** add `--generators`.
This loads unit definitions/dependencies for verification without submitting service
start/stop jobs or changing the user manager. It does not read the tunnel profile's key
reference, invoke the launcher, or contact the live daemon. See the
[systemd 257 verification reference](https://github.com/systemd/systemd/blob/v257/man/systemd-analyze.xml).

A successful syntax check is still **not** PrivateTmp/NoNewPrivileges/user-namespace,
worker-sandbox or reboot acceptance. In particular the executable immediately named by
ExecStart is `/usr/bin/env`; syntax verification does not independently validate every
descendant executable. The original stager included no transient fixture; the subsequent separate probe
is preserved in its own historical packet, without renewed execution authority.
The original stage barred tunnel doctor because its staged persistent key reference
was then absent, and barred key entry, daemon-reload, service start/stop/restart/enable,
enable-linger and ORCA mutation. Later owner cutover/doctor evidence supersedes those
historical setup-status claims; this reconciliation still authorizes no such action.

## Local validation

The packet tests compare rendering and embedded bytes/hashes, and exercise fail-closed
platform checks. Linux-only tests cover private creation, existing-directory/symlink
refusal, corrupted payload refusal and interrupted-write retention using disposable
test directories only. Windows cannot establish those POSIX filesystem properties;
their explicit skips must remain visible. No host acceptance is claimed.

Windows results: all three focused Vitest files passed (14 tests passed, 6 Linux-only
PR446 skips). The separately run Python suite passed 2 tests and explicitly skipped
4 Linux filesystem tests. Python AST syntax, changed JavaScript lint, JSON/YAML/JS
formatting and diff whitespace checks passed. Markdown remains manually wrapped per
repository policy. No Linux script, systemd verification or compatibility fixture ran by that
preparation agent. Later owner/connector evidence is separately recorded above.
