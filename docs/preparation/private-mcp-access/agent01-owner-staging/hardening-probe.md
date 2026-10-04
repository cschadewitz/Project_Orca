# One disposable user-manager hardening probe

This is a **new, separate owner-run artifact**, `probe-hardening.py`. The successful
`stage-agent01.py` remains byte-for-byte unchanged. This task has not run the probe,
contacted agent-01, or changed any service. Existing daemon/tunnel foreground jobs
must remain running. No service installation, lingering, credentials or ORCA mutation
is part of this check.

## Evidence received since the staging packet

The owner reports successful staging and `systemd-analyze` syntax exit 0. The owner
also independently verified the official Node 24.21.0 Linux x64 archive checksum
against downloaded official SHASUMS, then streamed only the archive's `bin/node`
through SHA-256 without executing it. That extracted **binary** digest was
`7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`, matching both
installed Node paths. This supersedes the earlier independent-reference gap by
**owner evidence**, not by a download or host observation performed in this task.
The archive digest is a different value and was not supplied here; do not substitute
the binary digest for it. Neither syntax nor Node provenance establishes runtime hardening.

## Exact effects and cleanup — review before running

The parent script first checks Linux/agent-01/UID 1000 and its fixed private source
path. It makes read-only `systemctl --user show` calls for the exact probe name and
the manager's actual `UnitPath`; it never queries or controls either ORCA service.
It requires the name to be not-found/inactive with no fragment/drop-ins, and rejects
any existing exact unit, applicable exact/prefix/type-wide drop-in directory, or
exact-name `.wants`, `.requires` or `.upholds` directory in those search paths.
Even an empty override directory blocks the probe. Do not change unit configuration
concurrently. Nothing is deleted or relaxed to satisfy a prerequisite.

It requests exactly one transient user service through `/usr/bin/systemd-run` with
`--user --unit=orca-preflight-hardening-20261004.service --wait --pipe --collect --quiet
--expand-environment=no` and these explicit properties:

| Property | Value |
| --- | --- |
| Type | `exec` |
| PrivateTmp / NoNewPrivileges | `yes` / `yes` |
| UMask / Restart | `0077` / `no` |
| RuntimeMaxSec / TimeoutStopSec | `15s` / `5s` |
| TimeoutStartSec | `10s` (bounds startup separately) |
| KillMode / SendSIGKILL | `control-group` / `yes` |

The sole service program is `/usr/bin/env -i HOME=/home/casey PATH=/usr/bin:/bin LANG=C
TMPDIR=/srv/dev/orca-temp-cal /usr/bin/python3 -I -S -B
/home/casey/orca-staging-download-1199f7e/probe-hardening.py --inside`.
`env` execs one isolated system Python process. Apart from loading its own program and
standard library, that process reads only its own `/proc/self/status`, its mount/user
namespace identities, and directory metadata for `/tmp`, `/var/tmp` and
`/srv/dev/orca-temp-cal`. It reads only the named TMPDIR environment value and emits
a small allowlisted JSON observation to the parent. It does not enumerate directories,
read their files, create a test file, inspect another process, use the network, spawn
workers, access keys/credentials, or run any ORCA/adapter command.

The parent compares its own corresponding observations against the child: mount
namespace and `/tmp`/`/var/tmp` identities must differ; the custom temp directory must
remain visible with identical identity/ownership/mode, UID 1000 and mode 0700. Child
NoNewPrivs must be 1, umask `0077`, all four UID values 1000, and TMPDIR correct.
A user-namespace identity change is reported as an observation, **not** required or
treated as proof of arbitrary user-namespace or worker-sandbox capability.

Effects are the transient unit/cgroup/runtime record, systemd's private temporary
directories/mount namespace, the short-lived helper/service processes, and ordinary
systemd lifecycle metadata. No persistent unit or application file is written. Child
output goes through `--pipe`; only booleans and the final result reach the owner's
terminal, never raw proc status, argv, environment, directory IDs or manager diagnostics.

On normal completion, `--collect` requests removal of even failed transient units;
systemd tears down their private temporary directories/cgroup. The script performs
one final read-only absence check. If collection is not yet observed, it reports STOP
rather than claiming cleanup. There is **no automatic retry, reset-failed, stop command
or manual deletion**. The parent's command deadline is 40 seconds; timeout/disconnection
does not assert the service has stopped. Its configured start/runtime/stop limits remain
the service-side bounds. Investigate any remaining exact probe unit privately before
considering another attempt; never stop another service or disable hardening.
The downloaded script itself remains for review. See
[systemd 257 transient-service semantics](https://github.com/systemd/systemd/blob/v257/man/systemd-run.xml).

## Checked transfer and single owner invocation

Download raw `probe-hardening.py` from the immutable preparation commit linked in
the handoff, using existing private repository access. Transfer it as a **new** regular
Casey-owned 0600 file to `/home/casey/orca-staging-download-1199f7e/probe-hardening.py`.
The existing download directory must remain private 0700 without symlink ancestors.
Refuse an existing destination; do not overwrite or paste/reconstruct the Python text.
Keep tracing off. This short digest gate invokes the wrapper once, which performs all
prechecks before constructing the transient service request:

```sh
if /usr/bin/test -f /home/casey/orca-staging-download-1199f7e/probe-hardening.py &&
   /usr/bin/test ! -L /home/casey/orca-staging-download-1199f7e/probe-hardening.py &&
   printf '%s\n' '126e889da358e3fed5a962e8ac301851d771dc1530b77b2b3f62e5cbddca4bc8  /home/casey/orca-staging-download-1199f7e/probe-hardening.py' | /usr/bin/sha256sum --check --status
then
  /usr/bin/env -i HOME=/home/casey PATH=/usr/bin:/bin LANG=C TMPDIR=/srv/dev/orca-temp-cal /usr/bin/python3 -I -S -B /home/casey/orca-staging-download-1199f7e/probe-hardening.py
else
  printf '%s\n' 'STOP: probe transfer verification failed'
fi
```

Require exit 0, `passed:true`, all `checks` true, and `unit_collected:true`.
Any failure/unsupported setting is a stop, not permission to weaken protections.
This establishes only the observed **basic user-manager hardening** if it passes.
It does not establish actual Codex sandbox/adapter operation, writable-temp behavior,
reboot startup, restart recovery, credentials, or ORCA deployment acceptance.

## Preparation validation

Pure/mocked tests verify the exact transient invocation, rejection of each missing
hardening observation, unit/drop-in refusal and manager-path scanning. They never run
systemd, read live procfs or execute the host entrypoint. Python syntax and those five
synthetic tests passed on Windows. No Linux or live probe was run by this preparation.
The three focused repository test files also passed (15 tests, 6 explicit Linux-only
PR446 skips; the unchanged stager's nested suite retains its 4 POSIX skips). Changed
JavaScript lint/format and diff whitespace checks passed.
