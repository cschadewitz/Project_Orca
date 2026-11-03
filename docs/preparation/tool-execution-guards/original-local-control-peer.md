# Original local control-peer admission

Baseline: `efd6c2ea4c06a93a51d3e4ce924d7b2c0b681b18`, draft PR #809.
This source component advances the native peer-lifetime part of G1/S0/Exit A.
It does not close M1: installed protected origin, managed-VM/generation binding,
issuer/recovery ownership and private accounting are still unavailable.

Final checks passed 22 native tests normally and optimized, 136 focused tests in
each mode, and 693 explicit non-live outer tests plus seven historical child tests.
The disjoint current harness/reference inventory contains 77 files; all 199
protected historical Git inputs remain exact. Independent gpt-6.1-sol/xhigh review
reproduced the native checks and verified the broader evidence. Exact source/log
hashes, the resolved reentrancy finding and the retained earlier failed local run
are in [the checks record](original-local-control-peer-checks.json).

`OriginalControlPeer` is a real native FD owner and bounded QMP-greeting reader,
not another data-transfer pilot or a constructible VM grant. It never connects,
sends, negotiates capabilities, launches, discovers a numeric PID/path, reconnects,
issues credentials or admits an observer. `require_vm_authority()` always refuses.
The existing runnable nonsecret bundle is unchanged and does not contain this
new component or gain a VM-control command.

## Mechanism and exact authentication claim

The protected future caller retains this passive object before adoption and lends
an already connected AF_UNIX/SOCK_STREAM FD with exclusive read custody. The
component first registers its own fresh native socket, then uses `dup2` into that
owned target. It validates actual native domain/type/non-listener/connected state;
Python wrapper family/type fields are insufficient after replacement. No temporary
Python wrapper owns the borrowed FD and no unregistered raw duplicate is created.

It obtains `SO_PEERCRED` and requires the cached UID/GID to equal the controller's
effective UID/GID. It then directly obtains `SO_PEERPIDFD`: the kernel supplies a
new close-on-exec FD for the socket's cached peer struct-pid. It never passes the
numeric credential PID to `pidfd_open`, opens `/proc/PID`, or substitutes another
process after death. Both owned FDs are registered before follow-up native checks.
Liveness polling rejects any pidfd event and stream error/hangup/half-close.
FD stamps and credentials are rechecked; they supplement protected FD custody,
not protection against a same-UID/root process replacing descriptors. In particular,
fstat identity is not a universal process-equality primitive for legacy pidfds.

This authenticates **cached kernel peer credentials and original cached peer
lifetime**, not Casey's identity, current authorization, VM identity, current
handler or guest physical lineage. AF_UNIX snapshots listener/connector credentials.
A listener inherited by another handler can still identify its original creator.
Native tests demonstrate that distinction, alongside positives where a separate
child actually creates/listens on its endpoint. Death conservatively refuses even
if another holder could still serve the connection. A pidfd pins identity, not
life: the peer can die immediately after a successful check.

The borrowed FD remains owned externally. Its duplicate shares the open-file
description and receive queue. No `settimeout`, `setblocking`, `F_SETFL`, socket
option mutation, send or shutdown is used. Every receive uses `MSG_DONTWAIT`;
original blocking/nonblocking/positive-timeout settings remain unchanged. Reading
consumes the shared queue and therefore requires the trusted caller to exclude
all competing consumers. Closing our duplicate alone does **not** release a QMP
slot while another original/duplicate remains open. The caller must close its own
resources and coordinate existing management use; no socket-occupancy guarantee
or independently isolated same-account control channel is claimed.

## Bounded, one-attempt protocol phase

One monotonic five-second application window starts before adoption effects and
covers adoption, all fragments and subsequent `check_current` calls, including
after the greeting. The deadline is never renewed. This is a restrictive local
window, not a kernel scheduling/I/O deadline, automatic timer cleanup or a
long-running VM-session lease. Retaining the owner does not excuse explicit close.

The decoder accepts at most 65,536 greeting bytes including CRLF, receiving at
most 4,096 bytes per call and one additional byte only to detect overflow. It
checks ASCII/depth (maximum eight) before JSON construction; rejects duplicate
keys, floats/non-JSON constants, oversized integers, malformed shape, wrong types,
extra frames and queued unnegotiated data. Package strings have a 1,024-character
printable-ASCII ceiling; at most 16 distinct capability names of 64 characters
are allowed. Parsed peer strings are discarded and never exposed as authority.

These are defensive source-side restrictions, not guarantees imposed by QEMU's
evolving protocol and not measured compatibility with the installed host. Unknown
keys or a larger legitimate greeting refuse. Adjustment requires source review
and installed compatibility evidence; no automatic fallback or expansion exists.
The ephemeral buffer is independent of report/original/trace/diagnostic allowances.
There is no file output, journal, credential, disk reservation or host quota grant.
Python object overhead, the borrowed socket's existing kernel buffers and future
whole-controller resource accounting remain separate.

At most two FDs are owned, in addition to the one borrowed endpoint. Original
PID/thread and busy guards prevent ownership transfer and same-thread reentrancy
during adoption, reads, fresh checks and close. The object cannot be pickled.
Original private exceptions survive later cleanup; public failures use only fixed
text with no acquired private exception context, package/error strings or paths.
Close consumes each owned slot once even after an uncertain close. A partial read,
EOF, timeout, unsupported API, identity change, peer death or close failure makes
uncertainty permanent. No repeated greeting, restart adoption or automatic retry
recovers this original owner. This tests lost/partial greeting delivery, not an
unimplemented command's durable lost-ack reconciliation.

## Upstream and existing-project contracts

Inspected primary sources, not installed-host evidence:

- [Linux v6.18 socket implementation](https://raw.githubusercontent.com/torvalds/linux/v6.18/net/core/sock.c)
  obtains the pidfd from the socket's cached peer object, rather than numeric PID
  lookup; [UAPI constants](https://raw.githubusercontent.com/torvalds/linux/v6.18/include/uapi/asm-generic/socket.h)
  define option 77. This implementation deliberately qualifies Linux x86_64 only
  and requires the native operation to succeed; a version string is insufficient.
- [AF_UNIX implementation](https://raw.githubusercontent.com/torvalds/linux/v6.18/net/unix/af_unix.c)
  explains credential snapshots and listener inheritance. [Linux pidfd polling
  documentation](https://man7.org/linux/man-pages/man2/pidfd_open.2.html) explains
  termination/hangup events; this component does not call that numeric-PID API.
- [Proxmox helpers](https://raw.githubusercontent.com/proxmox/qemu-server/master/src/PVE/QemuServer/Helpers.pm)
  construct local management socket names; [its QMP client](https://raw.githubusercontent.com/proxmox/qemu-server/master/src/PVE/QMPClient.pm)
  uses Unix connections and documents limited QMP occupancy. These upstream paths,
  retry behavior and broader response limit are not adopted or assumed installed.
- [QEMU QMP specification](https://www.qemu.org/docs/master/interop/qmp-spec.html)
  describes ASCII CRLF greetings and capability negotiation before commands.
  The new component intentionally stops before negotiation or command traffic.

Existing daemon bearer authentication and durable run ownership identify admitted
ORCA actors/runs; they do not bind a Proxmox process or issue an observation lane.
`LiveExecutionAuthorities` revalidates already admitted ownership and cannot supply
the missing initial admission. Private execution storage and release-wrapper
lifetime locks retain their own purposes and threat models. None is relabeled as
independent observation-custody isolation or a VM-session issuer.

## Next actual controller boundary and stopping condition

The next component must be an installed, protected original controller entry that
alone supplies the native endpoint, coordinates existing management occupancy and
binds the cached peer to the exact managed VM generation. It must establish whether
the installed QEMU actually owns/listened on the endpoint or whether daemonization,
inherited listeners or a proxy invalidate that association. It must also retain
original process/session responsibility across commands, revocation and lost replies.
A root UID, pathname, pidfile, JSON greeting, checksum or copied receipt cannot
replace that binding. Until it exists, this component supplies no command/issuer
capability and cannot release any observer refusal.

The concrete recommendation remains the existing root-console principal and a
future root-protected controller outside VM rollback, with the proposed 0700
`/var/lib/orca-evidence` and 12 GiB one-attempt profile only after actual origin,
filesystem/quota/privacy/recovery review. Nothing is installed or allocated here.
No new SSH-in-guest, credential, service, network or security setting is proposed
as a substitute. Exact installed-interface qualification remains an operator action
for separate review; this task makes no connection or availability check.

Parent independently completed the receiving-cloud test of the prior exact bundle
`efd6c2ea` against Casey's genuine uploaded nonsecret bytes: `pilot` and
`verify-pilot` exited zero, the index was 212 bytes with hash
`c3e2aedd222732c37f6784524fcf75cb85914485df412586299a3a7a69547e04`, and source hash/mode
were unchanged. This is receiving-cloud CLI execution, not success of this
executor's held failed transfer, a pve2 run, VM connection or original authority.
