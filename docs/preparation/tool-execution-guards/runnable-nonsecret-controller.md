# Runnable nonsecret controller bundle

Baseline: `683977e560f5a77e6e1b4d5265a0b515a81dd9a6`, draft PR #809.
The standard-library `orca-evidence.pyz` now provides an actual command around the
native custody copy, packet exporter and read-only receiver. It is deliberately
limited to two fixed public profiles. It issues no observation grant, selects no
private original inventory and cannot deserialize an original receipt.

## The operator command

In the existing pve2 root-console session, after copying and checksum-verifying
the reviewed attachment into a fresh private temporary helper directory:

```sh
python3 -I -S -B /var/tmp/NEW_PRIVATE_HELPER_DIRECTORY/orca-evidence.pyz pilot --source "$EXISTING_PILOT_FILE" --output-parent /var/tmp/NEW_PRIVATE_HELPER_DIRECTORY
```

`EXISTING_PILOT_FILE` means the existing nonsecret 16,777,216-byte host pilot that
Casey already transferred. Its exact private path stays in the handoff, not this
repository or bundle. The command does not regenerate it. Before creating any
trial output it requires the complete independent SHA-256
`080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e`.
Inputs already mismatched in preflight refuse before output creation. A change
observed later during custody/export/verification can leave a private partial trial.
The original source's contents, permissions and pathname are not modified.

The successful JSON result prints only a fresh `trial_name`, fixed profile/scope,
counts and hashes. It does not echo the arbitrary source/output-parent paths.
Under the selected helper directory, copy/upload **only**:

```text
<trial_name>/packet/chunk-00000000.bin
<trial_name>/packet/packet-index.v1
```

These are one 16 MiB payload chunk and a 212-byte index. The independently pinned
index SHA-256 is `c3e2aedd222732c37f6784524fcf75cb85914485df412586299a3a7a69547e04`.
It is fixed by the observed pilot's size/hash and wire grammar before execution,
not learned from the generated index or a caller manifest. The same attachment
can later run `verify-pilot --packet /ABSOLUTE/RECEIVED_PACKET_DIRECTORY` read-only,
using these independent expectations. Native private root/file checks still apply.

The short operator sequence is: create one fresh 0700 temporary helper directory;
copy the reviewed attachment using the already working user-operated SCP route;
verify its separately supplied SHA; run the single command; copy the exact two
packet files into a new empty Windows folder and attach them privately. Preserve
the same verified host/account/port/configuration. Passwords stay in local prompts,
never chat. No repo clone, dependency, account, key, service or permanent install is
needed. No agent connects to the host or runs these commands there.

SCP itself is not a no-clobber publication primitive: the helper directory and
Windows destination must be freshly created and empty, and these copy steps run
once. On an existing destination, partial copy, fingerprint/authentication/SFTP
failure, CLI failure, lost result or upload rejection, stop and report. Do not
overwrite, delete, retry, force a legacy protocol, change known hosts, enable a
service, zip/rename files or regenerate bytes on Windows as a workaround.

## Native scope, prerequisites and exact bounds

The attachment requires an existing Linux Python 3.11+ with its standard library,
trusted local procfs, `O_PATH`, `O_TMPFILE`, `posix_fallocate`, pread/pwrite and the
qualified filesystem semantics used by the existing exporter. Unsupported native
APIs, capacity or FD exhaustion stop with fixed phase/reason codes. No installation,
mount/configuration change or allocation fallback is attempted. The builder's Git
dependency exists only in the source-build environment, never on pve2.

The pilot's public-source 0644 allowance is restricted to this pinned nonsecret
input. It does not change the generic exporter/private-source checks. An owned
O_PATH pin validates a regular source inode before its procfd reader opens; full
hash/stamp/path checks precede output acquisition. A new native private custody
file is allocated before its copy writes and sealed/read back; the real exporter
then reserves every exact output chunk/index byte before its own copy writes.
The exporter and receiver both compare against the independent pinned profile.
The custody file remains separate from the published packet and is not uploaded.

The observed-pilot trial creates **33,554,644 file-data bytes**:16 MiB custody copy
+ 16 MiB exported chunk + 212-byte index. The original pilot already exists outside
that count. The attachment itself and directory/inode/allocation overhead are
additional. This is a bounded two-stage pipeline, not whole-pipeline reservation
before the custody copy and not a host filesystem quota. An allocation/copy failure
leaves its partial private trial directory for inspection, without deleting or
altering the original pilot. The existing 12 GiB permanent one-attempt proposal is
unneeded for this small public trial and remains unapplied.

Every native slot is registered before later effects. Close consumes the handle
once, including uncertain close; original private failures survive later cleanup.
The original PID/thread owner cannot be serialized. Complete-write, file-sync,
create-only index-last publication, directory-sync and real receiver checks remain
in the pipeline. Lost stdout delivery returns nonzero/uncertainty with fixed text;
visible files do not authorize retry or constitute a recovered original receipt.
No failure journal or new original-artifact allowance is introduced.

`private-export` always refuses. No caller digest, inventory, JSON capability or
`--approve` option enables private/raw export. Unknown arguments and native errors
have fixed bounded projections without source paths, raw bytes, exception text,
argv or traceback. Observer/issuer/full-source refusals, source pins, existing
budgets/timeouts and receipt non-serialization stay unchanged.

## Isolated, reproducible packaging

The only ZIP entries, in fixed order, are `__main__.py`, `orca_controller_cli.py`,
the unchanged `packet_exporter.py`, the unchanged `packet_receiver.py`, and
`SOURCE.json`. Entries use ZIP_STORED, fixed 1980 timestamps, regular 0644 metadata
and no extra files, comments or extraction. `SOURCE.json` identifies the exact Git
build commit and five bounded input snapshots (including the unbundled builder).
The builder requires the workspace input bytes to equal those exact committed
blobs and builds from the captured snapshots, so later workspace mutations cannot
affect the archive. It disables replacement objects and lazy fetching through
command-local Git switches; unsupported Git versions refuse. The qualified local
builder uses existing Git 2.52.0. No Git or private-repository access is needed by
the artifact consumer.

Run the exact `-I -S -B` invocation: real isolation, no site startup and no bytecode
writes are required before CLI imports. The bootstrap removes the ZIP's own search
path before importing its standard-library verifier, preventing extra archive
entries from shadowing `hashlib`, `json` or `zipfile` before whitelist checks. It
restores only the validated archive for its known internal modules. Missing,
changed, extra or compressed entries refuse without ambient module fallback.
Poisoned cwd/PYTHONPATH/site-hook tests exercise the actual isolated ZIP.

These checks do not authenticate a self-modified manifest or undo interpreter/site
startup before an incorrectly flagged launch. The separately delivered artifact
SHA must be checked before execution. Host interpreter/stdlib/loaded-code trust
and cooperative root/ancestor/procfs assumptions remain prerequisites, not an
original observation loaded-code attestation.

## Local evidence and delivery limits

The final source selection passed 20 CLI tests in normal Python (2.132 s) and
optimized Python (2.175 s), 114 focused custody/export/receiver/sizing/CLI tests
in each mode (2.793 s and 2.916 s), and 671 explicit non-live outer tests
(27.311 s) plus seven historical child tests (6.274 s). The historical fixture
retains its genuine frozen source/dependencies; all 199 protected historical Git
inputs were checked before copying the disjoint 75-file current harness/reference
inventory. No real tracer case was selected. Exact file/log hashes and independent
review are recorded in [the checks record](runnable-nonsecret-controller-checks.json).
The separately delivered attachment identifies its exact committed build source;
its external SHA and Library identity are supplied in the handoff, avoiding a
self-referential source-commit/artifact digest record.

`selftest` is a separate fixed **synthetic local** profile: 16 MiB public `P` bytes
plus one `Q`, two chunks and a 299-byte index, 33,554,733 file-data bytes with custody.
It uses the same native pipeline and independently known index/hash constants.
Its result says `synthetic-local-selftest-not-observed-pilot`. The delivered bundle
is tested in isolated Python mode on this profile, never relabeled as the observed
080acf pilot. Actual-pilot size/hash/type negatives run against independent local
bytes and must create no trial output.

The parent authorized materializing the actual uploaded pilot for a local positive
run. The resolved-reference preparation succeeded, but the current required helper
exited 1 with `library file transfer failed: download failed`. No retry/alternate
transfer was attempted. No actual-pilot bytes are embedded in the repository or
bundle. Parent independently ran the exact delivered 70,104-byte bundle from commit
`efd6c2ea4c06a93a51d3e4ce924d7b2c0b681b18` (SHA-256
`cb025ded500cfabfcf7b77bcb2d182ecd0199372043718fed8c9a76febdf5102`) against its retained
genuine pilot copy. `pilot` and `verify-pilot` exited zero, the 212-byte index matched
the pinned hash, and source hash/mode stayed unchanged. This is receiving-cloud
execution, not success of this executor's held failed materialization or a host run.

The actual 16 MiB host→Windows SCP→private upload fact remains valid. A local CLI
selftest or receiving-side CLI check does not establish host native compatibility,
index upload acceptance, private/full-profile transport or issuer authority. Future
private setup still proposes the existing pve2 root-console principal and a dedicated
root-owned 0700 `/var/lib/orca-evidence`, outside guest mounts/snapshots, with the
existing 12 GiB one-attempt proposal only after owner/filesystem/capacity review.
No private export occurs before actual original-run, artifact/disposition, privacy,
independent retention and recovery binding. No host action or PR metadata write is
part of this source/delivery task.
