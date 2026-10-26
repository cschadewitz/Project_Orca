# Controlled owned-read observer: framing draft — #702 / #703 / #706

Base: main `8a98b5496e38e5c03cee722f3390383d2544e84d`. This is observer/test
support only. `tools/owned-read-proof/controlled_contract.py` validates a finite
specification and frames trace events; it does not accept execution, qualify a
build, authenticate lifecycle records, or construct a capability. The original
`verify.py`, candidate fixture, and nonzero service-read refusal are unchanged.
The authority decision at commit `1b337cfbbb2f7a6a684adf1797cda234ffc6b309`
remains a separate design input.

## Exact framing inputs

`frame_trace(text, plan, supervisor_log, used_tokens)` takes supervisor-retained
originals. No child-supplied JSON or report may substitute for any argument.
`validate_plan(plan, used_tokens)` checks the same specification grammar alone.
All dictionaries reject unknown and missing fields.

The version-1 plan has exactly these fields:

| Field | Required value |
| --- | --- |
| `version` | Integer `1` |
| `lane` | `bootstrap` or `connected` |
| `leaderPid` | Original kernel-observed positive leader PID, retained by supervisor |
| `commandFd`, `ackFd` | Distinct original inherited pipe descriptors greater than 2 |
| `maximumTraceBytes` | Positive bound, at most 268435456 UTF-8 bytes |
| `phases` | Ordered `{name, token}` records described below |
| `privateRoots` | Exact canonical root path to original physical identity |
| `privateFiles` | Exact canonical file path to `{root, identity}` |
| `privateIO` | Ordered finite operation records described below |

Bootstrap has exactly one phase named `bootstrap`. Connected has exactly `save`,
`human-read`, `rule-read`, in that order. Each phase has a distinct token of 64
lowercase hexadecimal characters. The supervisor generates fresh random tokens,
retains them before delivery and reserves them in its replay history before any
send, including unsuccessful runs. `used_tokens` is the retained set from earlier
runs; tokens in the current retained plan are checked against that prior set.
Grammar validation checks shape and uniqueness; it cannot establish entropy or
prove the supervisor retained the supplied history.

For each phase, the supervisor sends exactly the ASCII bytes
`orca-phase:<name>:<token>\n` to its command pipe. After the requested operation
settles, the child writes exactly `orca-done:<name>:<token>\n` to its ack pipe.
The supervisor records successful complete I/O in `supervisor_log`, which must
contain exactly `{event: "sent", name, token}` then
`{event: "received", name, token}` for every phase in order. Actual partial I/O,
lost ack, duplication or reordered delivery refuses this narrow protocol. No
retry/resume or inference of execution absence follows from a missing ack.
The phase ack is a framing ack only; it is not a lease acknowledgement or proof
of lifecycle success.

Trace framing requires complete decoded `read(commandFd, bytes, count)` and
`write(ackFd, bytes, count)` operations by the retained leader. Both requested and
returned counts must equal the expected wire length. In this lane the command
`read` must be decoded: the candidate runner's `raw=read,readv` setting would hide
those bytes and must not be reused unchanged. Only disposable test credentials
may appear in the controlled trace; no real credential input is authorized.

A phase begins after command-read completion and ends before ack-write entry.
Unknown syscalls refuse; relevant open, descriptor and path effects intersecting
either boundary's entry/completion interval refuse. Events inside each window and
outside all windows are returned for subsequent full replay. Outside events are
not discarded or implicitly allowed. This framing stage does not establish
control-descriptor lineage, resource inodes, kernel effects or full settlement.
Those independent checks remain required before any observed lifecycle result.

## Finite private-I/O specification grammar

This initial grammar covers **pre-existing retained regular files only**. Every
root and file retains `[device, inode, mode, uid, gid]`; root identities must name
directories and file identities must name regular files. Physical aliases,
noncanonical paths, descriptor paths, wildcard roots, unbound operation paths,
unknown operations and unknown fields refuse. At most 16 roots, 128 files and
512 exact operation steps are supported. Each file must be used and closed.

Each operation contains exactly `phase`, `op`, `path`, plus the listed fields:

| `op` | Additional fields |
| --- | --- |
| `openat` | `flags`: exact list from the combinations below |
| `statx` | None |
| `read`, `write` | `maximumBytes`: integer 1–8192 |
| `pread64` | `offset`: nonnegative integer; `maximumBytes`: integer 1–8192; their sum must fit a signed 64-bit offset |
| `fsync`, `close` | None |

Allowed open flag sets are `O_RDONLY|O_CLOEXEC`,
`O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC`,
`O_RDWR|O_NOFOLLOW|O_CLOEXEC`, and
`O_WRONLY|O_NOFOLLOW|O_CLOEXEC`. Duplicate flags refuse. Steps are ordered by phase;
an operation requires a preceding unmatched open, and reads/writes must fit its
access mode. Each step describes one occurrence, not an unlimited allowance.
This validates the proposed specification; it does not match actual private
syscalls or prove the supplied identities remain current.

Creation, store/sidecar temporary publication, rename and unlink remain unsupported
in this slice. The producer must first supply its actual paths, flags, sequence,
byte bounds and physical lineage, including newly created identities. They must
then receive explicit replay rules and negative controls. There is no `.orca`
exception and no inferred private-I/O permission from a directory name.

## Validation and pending integration

`python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py' -v`
includes grammar-only mutation controls for this slice. Their well-formed trace
fixtures demonstrate parsing, not actual canonical service execution or positive
acceptance. Existing real transfer, interval and cleanup controls remain separate.

Pending producer inputs are the actual disposable entrypoint, retained command
channel/phase protocol, complete private publication sequence and authenticated
semantic record format. Integration must still reconstruct original resource
creation, descriptor/inode lineage, readonly reopen, unlink, exact positional
results, all effects and cleanup. It must independently check bootstrap evidence,
Save's zero reads and zero live answers, genuine protected review/Save records,
the first original human answer and final lease ack, and the distinct fresh rule
authorization. No final read total can substitute for these phase checks.

Same-UID cooperative supervision and explicitly designated test operator/reviewer/
principal roles remain disclosed assumptions. This draft changes no engine,
daemon, protected-owner runtime, production trust, accepted build, credentials,
services, host security settings, user workspace or native Mac behavior.
