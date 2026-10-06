Exact executable wrapper and bounded corrective review

copy-once.py and copier.py are the exact executable bytes pinned by the local owner
packet. There is no redacted counterpart. Actual bindings, command packets, nonce
evidence, resource snapshots and provisioning records remain local. The checkpoint
collector and relocation byte-splicing helper are unchanged.

Run the synthetic standard-library suites from this directory, with TMPDIR set to
an approved private writable fixture area:

    python3 -I -S -B -c "import sys,unittest; sys.path.insert(0,'.'); suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(x) for x in ['test_copier','test_wrapper','test_guards']); result=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(not result.wasSuccessful())"

The 28 copier cases and 15 checkpoint cases are retained. Fixture contracts now
supply explicit link policies and joined step identities. test_guards.py adds 34
guards: 32 full-wrapper subprocess cases in new synthetic Git worktrees, plus two
memory-profile/helper cases. All 77 pass. Fixtures, journals and failure evidence
are retained locally. No test reads real bindings or contacts ORCA. Generic result
JSON does not include private paths or measurements. Fixtures require local Linux,
Python and Git; synthetic copy successes do not establish real-root readiness.

Corrective invariants

1. Receipt strictly supports original v1 schema: version is integer 1;
   runId/repo/commonDir/baseCommit/branch/path are nonempty strings; baseCommit is
   40-64 lowercase hex characters. Unknown/missing fields refuse. Receipt runId
   joins run.id/runId, approval.runId/id/requestId and every step.runId.
   Approval stepRunId/nodeId must match one scheduled gate step whose final event
   is waiting. The join applies to the pinned baseline and each fresh checkpoint,
   independently of exact record equality.
2. Before status, query only matching clean/process/smudge driver key names and
   reject any result, including empty-named drivers. Untracked attributes can
   change applicability. Gitlinks and any .gitmodules file refuse; status also
   explicitly ignores submodules. Reject assume-unchanged, skip-worktree and other
   nonordinary index tags before status; never clear or modify flags. This applies
   to both source and destination. Same-size flagged workspace edits refuse, while
   clean workspace links pass. Hooks/fsmonitor/untracked cache remain disabled.
   Named and empty-name clean/process marker commands never execute in regressions.
3. Links may reach copied dependency outputs or explicitly pinned tracked workspace
   packages only. Package entries are derived from pinned Git HEAD, require a
   tracked package manifest, and must equal the supplied complete allowlist.
   Caller-added private/untracked entries cannot grant access. Complete source and
   virtual-destination chains reject absolute/escaping/cyclic paths, unknown
   targets and Git/ORCA components. A linked workspace directory exposes children:
   every actual child must be pinned tracked package data or an approved dependency
   output. Kind/link-text/file-size drift and shared target files refuse.
   .git/.orca entries are excluded from copied trees. Containment alone grants no
   access. The unchanged original dependency contract establishes output trees.
4. Before loading helper/manifest buffers or scanning payloads, Linux memory evidence
   comes from the executing process: host MemAvailable (no swap), RSS/VmSize, finite
   soft/hard RLIMIT_AS/RLIMIT_DATA and every visible cgroup-v2 ancestor's
   memory.max/memory.high minus memory.current. Only the exact hierarchy root may
   omit controller files; host headroom covers that root. Missing/ambiguous nonroot
   measurements refuse. Smallest headroom must cover at least:

       4 * largest_file_bytes + 4 * retained_shim_bytes
       + 8 * manifest_bytes + 192 MiB

   or pinned minimum_available_bytes, whichever is greater. This covers chunk joins,
   retained payloads, relocated shim buffers, JSON/manifest/interpreter overhead
   and reserve. Controls, original/workspace payloads and potential prefix growth
   must fit independently reviewed pins. All real payload reads are capped at
   recorded sizes, including growth during reading. The copy loop releases payload
   and view references before the next file. Actual profile headroom is rechecked
   before copying. A fresh check is a prerequisite, not a reservation or proof
   about another process's resource profile.

Private data-only interface

CLI requires --binding-file and --binding-sha256, and exactly one of --validate-only
or --execute-once. Binding is absolute/no-symlink, regular, single-link, mode0600,
owner uid and hash-pinned. Stage is mode0700/task-owned. Owners review both code
and private data; no task values are embedded in executable code.

Binding fields:
- stage/owner_uid/git_executable; source/destination path/dev/ino/uid identities
- source/destination branches/Git directories; common directory; HEAD/lock blob
- receipt/ready path/hash/content; original inventory/proposal/contract path/hash
- files map of independently pinned controls/helpers; copier/relocation paths
- original counts; authenticated baseline discovery/run/steps/pending gate records
- gate_max_age_seconds/checkpoint_timeout_seconds/minimum_free_bytes
- link_policy:{workspace_packages:[relative directory],workspace_entries:[objects]}
  Entries have path/kind; files have bytes; links have target; directories explicit.
  Pinned Git tree supplies workspace authority. Private state may not be added.
- memory:{largest_file_bytes,retained_shim_bytes,manifest_bytes,
  minimum_available_bytes}: nonnegative integer byte counts, reviewed independently.

The original contract stays unchanged on disk. load_helpers verifies equality with
original inventory/proposal, then adds the separately pinned link policy only to
the in-memory contract. Command pins exact wrapper and binding hashes; binding
pins exact helper bytes. Clean environment has NODE_PATH absent, compile caching
disabled, isolated/no-site/no-bytecode Python, no global/system Git config and
the existing timeout. Actual paths and argv stay local.

Ownership, checkpoint and execution boundary

Validate-only issues no execution nonce, destination probe or copy.
Execute-once requires --owner-holds-roots-and-gate and actual exclusive owner control
of both roots and gate answers/continuations throughout. The flag acknowledges
ownership; it does not acquire a runtime lock or establish cryptographic attestation.

Execution creates an exclusive attempt and private journal, then waits for a new
nonce-bound checkpoint using unchanged collectCheckpoint(bindingFile,bindingSha256,
tools,report). Its complete published code uses existing authenticated MCP discovery
and exact run/step/pending-input read interfaces. No token/bootstrap reads or ORCA
mutation. Trusted owner-supplied evidence must have exact original identities,
scope/records, complete pages, fresh post-request/grouped timestamps and the joined
receipt/run/gate-step. Old review evidence cannot satisfy a new execution nonce.

After checkpoint, provisioning/Git/memory are rechecked, an exclusive assigned-root
write probe is performed, freshness checked again and copier called once.
Permission failure, missing measurement, drift or timeout stops and retains partial
evidence. No retry, cleanup or rollback. Independent destination/source inventory
and destination-local readiness remain pending even after successful copying.

No gate answer, coding-agent start, package manager/install/network preparation,
project build/test, browser/Electron, service action, sandbox change or admission.
Owner-session checks do not establish future worker sandbox/loopback/capacity.
Publication requires independent re-review of these exact bytes; it does not
authorize executing the real packet.
