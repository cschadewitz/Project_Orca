# Independent maintenance observer preparation

This is the bounded M10 follow-up to [#483](https://github.com/cschadewitz/Project_Orca/issues/483)
and merged [#485](https://github.com/cschadewitz/Project_Orca/pull/485).
It prepares code and unpopulated templates only. Do not close #483 on source merge.
No host observation, real journal read, identity/key creation, installation, access
change, activation or service control was performed during this slice.

## Source and interface pins

- Base main: `db579fb7ac9cfce2e4e6901713088a80602311da`.
- Reused #485 head: `c99c75308007297684ba9ff4fb6193fc524d5ed9`;
  merge: `a299db8bb9d7eb47c103090b9f62d7af3f3db29b`.
- The draft PR records the final source head. Record the reviewed commit and build
  artifact hashes independently at installation; `BUILD.deployedRevision` remains null.
- `serveMaintenanceStdio()` retains the refusing backend.
  `serveLinuxMaintenanceStdio()` explicitly selects the fixed Linux observer.
  Neither import nor discovery acquires host data. No app main/preload/Workspace wiring
  is required or changed; the independent tunnel owns the stdio process lifecycle.
- `maintenance-readonly-v2` hashes source preparation and unresolved identity metadata.
  Policy hash, bridge UUID and kernel boot UUID are diagnostic provenance, not credentials,
  deployed-build attestation or verified human identity. Discovery's boot identity remains
  unavailable; successful host health contains a before/after-checked kernel boot UUID.

The [package README](../packages/maintenance-mcp/README.md) defines the closed API and
limits. The source adapter accepts fixed aliases only. It has no environment/config/path
selector and no arbitrary shell, unit, bus, journal-directory or control operation.

## Fixed source behavior

| Observation | Source and behavior | Remaining prerequisite |
| --- | --- | --- |
| Host health | Three fixed `/proc` files and root `statfs`; aggregate 16 KiB budget; strict typed projection; reject boot changes | Confirm runtime is agent-01, kernel/proc and root namespace are the approved host views, and reads are allowed for the separate unprivileged identity |
| Service health | Prepared same-user `/usr/bin/systemctl --user show`; only fixed unit, Id/LoadState/ActiveState | Pin manager kind, positive numeric UID and exact fixed unit in reviewed source policy; shipped mappings are null |
| Logs | Prepared current-user journal query, fixed UID/unit/boot/time/record/field filters; structured projection before backend | Same identity pin, narrow existing journal visibility and dedicated typed producer fields; ordinary MESSAGE text is excluded |
| Foreground ORCA | Always `not_supervised`; no PID/process search | Do not invent a supervisor for it |
| Work-route services under another UID | Unavailable; no other-user/system/root fallback | A separately reviewed narrow helper would be new work; no broad bus/journal grants |

Each query shares its observation's one-second deadline and source byte allowance.
stdout and discarded stderr count together. Query errors, warnings, invalid target
provenance and oversized streams fail closed. A timeout/overflow kills only that query
child and retains the backend slot until close; discovery does not consume source slots.
Kernel/native filesystem calls cannot be force-preempted; stuck reads can consume the
two fixed slots without accumulating orphan work. Supervisor limits remain required.

Journal records must include kernel-supplied `_UID`, `_BOOT_ID` and `_SYSTEMD_USER_UNIT`,
plus `__REALTIME_TIMESTAMP` in epoch microseconds and these dedicated producer fields:

| `ORCA_MAINTENANCE_CATEGORY` | Approved producer fields and exact values |
| --- | --- |
| `lifecycle` | `ORCA_MAINTENANCE_STATE`: `started`, `stopped`, `failed` |
| `readiness` | `ORCA_MAINTENANCE_READY`: `true` or `false` |
| `resource` | `ORCA_MAINTENANCE_RESOURCE`: `memory` or `root`; `ORCA_MAINTENANCE_USED_PERCENT`: decimal 0–100 |

Unsupported/binary/multiple-value fields become omitted records, never strings hidden
in safe fields. Unknown fields, MESSAGE, argv, PIDs, private paths and journal cursors
are discarded. Provenance mismatch refuses the complete batch. A 64-record snapshot
is conservatively truncated; omission counts concern that snapshot only. An empty batch
does not prove complete journal visibility, producer compatibility or healthy service
state. No application is modified to emit these fields by this slice.

The command choices use the [systemd 257 journal reference](https://github.com/systemd/systemd/blob/v257/man/journalctl.xml)
and [systemctl reference](https://github.com/systemd/systemd/blob/v257/man/systemctl.xml).
Verify the installed versions and semantics during separately authorized host acceptance.
Native acquisition uses [Node asynchronous filesystem APIs](https://nodejs.org/docs/latest-v24.x/api/fs.html)
and [direct process spawning](https://nodejs.org/docs/latest-v24.x/api/child_process.html).
These source references do not establish installed host compatibility.

## Independent launcher and template handoff

The unpopulated [template directory](../tools/deploy/maintenance-mcp/) contains:

- `launcher.mjs.template`: import only a reviewed built maintenance package path;
  refuse non-Linux, root or extra launcher arguments, then open the explicit stdio entry.
- `tunnel-profile.yaml.template`: one maintenance stdio command and dedicated association
  and key-file placeholders. There is no work-route/owner-token fallback.
- `maintenance-tunnel.service.template`: a separate user unit, clean environment before
  tunnel-client/Node startup, no ORCA dependency or restart propagation, no automatic
  restart, and candidate CPU/memory/task/shutdown limits. It has not been installed or
  verified against agent-01's user-manager hardening support.

The bridge is a tunnel-owned child in this candidate topology; that does not establish
an independent `maintenance-bridge.service`. Leave its supervisor observation unavailable
until the actual child/supervisor model is reviewed. The profile follows the already
selected [official tunnel-client 0.0.15 configuration](https://github.com/openai/tunnel-client/blob/v0.0.15/docs/configuration.md),
including `mcp.commands` and a control-plane key file reference. No client artifact was
downloaded or executed. A future private rendered copy must pin executable, built
package, profile and launcher paths/hashes and the exact official client artifact.

Render only during a separately authorized owner installation review. Keep credentials,
actual key-file paths, tunnel associations and private host metadata out of this repo.
Use independent runtime/state/temp directories accessible under the unit's hardening;
`ProtectHome=yes` cannot be relaxed merely to reuse Casey's private work-route files.
Review systemd quoting, placeholders, file ownership/ACLs, read-only runtime files and
the clean environment before Node starts, including removal of `NODE_OPTIONS` and tunnel
command/URL overrides. The user manager itself identifies the approved service UID.
Do not create an OS identity, enable linger, join journal/admin groups, grant sudo, install
units, edit live profiles, generate keys or change access to complete this preparation.

## Focused source evidence

Reuse #485's 41 synthetic tests and reviewed CI evidence for the closed contract and SDK
route; that historical CI is not evidence for this new head. The current focused suite
adds synthetic kernel descriptors, fake query children and typed journal fixtures. It
checks exact routes/environment, partial reads, byte/record/deadline bounds, descriptor
closure, child-close slot discipline, source failure isolation, boot/UID/unit mismatch,
secret/path omission and unchanged default refusal. No actual host data is read.

Use the installed binaries without automatic package-manager refresh:

```text
node_modules/.bin/vitest run packages/maintenance-mcp/test --maxWorkers=2
node_modules/.bin/eslint packages/maintenance-mcp/src packages/maintenance-mcp/test
node_modules/.bin/tsc -p packages/maintenance-mcp --noEmit --composite false
node_modules/.bin/tsc -b packages/maintenance-mcp
node_modules/.bin/prettier --check packages/maintenance-mcp
git diff --check
```

The PR records exact results, tool versions, dependency-resolution limitations and
self-review. No broad suite, host jobs or Actions workflow dispatch is required for
this bounded slice. A focused pass does not claim full-repository or production proof.

## Activation prerequisites — unrun

1. Owner separately approves the concrete reviewed artifact and agent-01 binding,
   independent unprivileged identity, runtime ownership and private tunnel/key scope.
   Pin exact source/build/launcher/client hashes and the manager/UID/unit map; change
   the source policy hash for any approved identity binding. Unsupported targets stay
   unavailable. A shared service principal still does not verify a human caller.
2. Verify kernel/root namespace correctness, narrow source permissions, installed
   systemd/Node compatibility, actual producer field/provenance behavior and journal
   rotation/permission loss. Never fix unavailable reads by broadening host access.
3. Validate official client launch, secure key loading, stdio lifecycle, private workspace
   association, denied callers, session/rate/slow-reader controls and candidate supervisor
   CPU/memory/task/shutdown limits. Source/package limits are not ingress or session limits.
4. Perform harmless actual-client discovery first, then separately authorized typed host
   and structured-log reads. Record unavailable and omitted sources honestly. Synthetic
   streams do not establish actual-client access or live source safety.

## Revocation prerequisites — unrun

Verify denied fresh sessions and already open sessions after dedicated maintenance
association/key revocation; confirm reconnect, rotation and expiry cannot reuse cached
authority. The package has no credential, end-user auth or tunnel revocation mechanism.
Bind observations to current boot/bridge/policy/build evidence during acceptance; no
cursors or cached authorization are implemented. Owner-controlled rollback/removal must
stop/disable only the dedicated maintenance tunnel, remove only its dedicated service/key
association and verify both existing and fresh calls fail. Preserve ORCA state and the
work route. These actions are prerequisites, not commands executed here.

## Outage prerequisites — unrun

With separately approved independent supervision, prove discovery and host diagnosis
remain available when ORCA's daemon, admission/work route or protected store is down.
Do not dispatch work or invoke restart/repair controls to simulate this. Separately
authorize service lifecycle checks, SSH logout, reboot and recovery acceptance; verify
the actual parent/child model and host boot/policy/build changes on reconnect.

Colocation on **agent-01 cannot survive agent-01 host, kernel, network, power or
hypervisor failure**. A separate management VM is deferred. This source preparation
does not establish logout/reboot survival, live access, revocation or outage acceptance.
