# #703/#706 owned disposable file read

Base: `df2e623175f58f2031efb0bb7386d2de1cae8990`. This is an inactive,
source-qualified Linux acceptance slice. It advances the disposable-memory
composition to one real OS read without changing canonical contracts, policy
persistence, approval UI, provider hooks or production registration. Refs #703,
#706; both broad issues remain open. Early boundary checkpoint:
https://github.com/cschadewitz/Project_Orca/issues/703#issuecomment-6409360728.

## Capability and ownership

`createDisposableFileReadForTest` requires explicit `enabled: true` and accepts
synthetic content, never an existing pathname, descriptor or project. Setup
creates one random private temporary directory and one exclusive synthetic file.
It verifies a regular file, effective-UID ownership, private directory mode,
file mode `0400` and exactly one link. Setup closes its writer, opens a private
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK` descriptor, compares `lstat`/`fstat`, unlinks
the name and verifies the retained inode now has zero links. Setup writes and
cleanup are test scaffolding; the executor has no write or shell operation.

The read descriptor never leaves the closure. A fresh opaque owner lifetime,
resource reference and `physicalTargetRef` bind the inode and its revision:
`dev`, `ino`, `mode`, `uid`, `gid`, `nlink`, `size`, `mtimeNs`, `ctimeNs`. Every
required identity field must be a bigint; missing facts refuse. File resources
use the accepted canonical physical-resource alternative, without memory fields
or a competing resource type. The file qualifier registry recognizes only the
exact registered owner/executor pair. Copied executors, forged handles, caller
resource strings and another owner do not create qualification.

The only parameters are exact own data fields `{ resourceRef, offset, length }`.
Accessors, extra fields (including paths), negative zero, unsafe integers and
out-of-range slices refuse. The entire file and each read are bounded to 4096
bytes. Capture retains the exact codec bytes, original owner snapshot and opaque
capture before policy, recording or review awaits. No prefix/title heuristic
establishes ownership. No file bytes are read into memory during setup/capture
for later substitution as the supposedly real read.

## Policy, review and execution

The existing `SyntheticReadFence` now admits the privately registered file codec
as a separate qualification. The existing actual `createStrictPolicyPort` and
bounded `createLocalReviewJudge` remain responsible for rules and review. Tests
use the offline reference judge; no external provider/hook is invoked. The
canonical `ActionEvidenceV1`, physical `ActionResourceV1`, policy port, judge
ports, permit and receipt are unchanged. The existing lease's `withOwnership`
continues to fence authorization, recording and dispatch; this fixture supplies
no replacement principal/lease authority or new persistence ledger.

Fresh policy/authority is checked before permits, before authorization recording,
after recording and immediately before one-use consumption. The file owner also
checks its original base snapshot, generation, current effective UID and full
inode revision on every capture/encode/current-state check. The fence retains
original injected methods so later object mutation cannot substitute them.

Execution consumes the same private descriptor and captured offset/length in one
bounded positional `readSync`. There is no await or callback between the last
checks, one-use claim and syscall. Descriptor identity prevents symlink,
replacement, rename and cwd changes from redirecting the read. `fstat` and owner
checks immediately after the syscall refuse changed metadata or short reads
before response start. No current-path lookup or reopen occurs during execution.

The active combined lifetime signal now reaches the executor. It rechecks after
observation and response-acknowledgement awaits. The fence also rechecks current
owner/resource/authority after executor settlement, rather than only checking
cancellation. Cancellation can stop waiting for an uncooperative callback. Its
late completion cannot initiate a response after the observation await. A
response already started cannot be retracted; response acknowledgement, response
start, read effect, dispatch entry and authorization recording are separate facts.
Revocation during an await is rechecked at the next checkpoint; no instantaneous
remote revocation guarantee is claimed.

A failed/uncertain required record never dispatches. Once consumed, any uncertain
read, observation, delivery, authority or lifetime outcome is terminal
`execution-unknown`. Concurrent dispatch shares one promise/receipt; the file
executor independently refuses a second read. New fences, copied captures,
late advice, another owner and lost acknowledgement do not replay the action.
There is no restart recovery or durable execution transaction in this slice.

## Host and platform boundaries

Supported source scope is one newly created, detached regular inode in a trusted
local Linux process/filesystem, with functioning POSIX owner modes, no outside
writer and complete bigint stat facts. The ownership proof is construction and
private descriptor possession, not UID equality alone. Existing
`store/protected-file.ts` supplies the precedent for `O_NOFOLLOW`, descriptor
identity and pre/post change checks. Existing owned-root worktree documentation
explicitly does not promise hostile same-user containment. That foundation and
#449 remain separate; no OS/sandbox settings are changed here.

There is no Node API here to seal a general regular file against a hostile
same-UID/root actor, atomically authorize a syscall against remote revocation,
or prove immutable content while an external writer races the read. Those
properties/environments are unsupported. Post-read checks do not undo a read
that already happened. Nanosecond metadata is change evidence, not a content seal.
The fixture does not establish immutable snapshots against hostile writers,
network-filesystem/kernel behavior, hard-link intake, arbitrary file ownership,
Windows reparses, macOS/TCC, SSH, descendant processes or arbitrary native syscalls.
If these properties are required, this capability cannot supply them. No fallback
to path-prefix checks, memory qualification or weaker sandbox settings exists.

Coverage stays `policy-per-ask`, with empty `installedRefs` and
`independentlyObservedEffects: false` in capture-time qualification. The test
report separately records observed Linux syscall effects; running source tests
cannot turn a source module into an installed-provider qualification. There is
no package barrel export, ACP callback/native-tool interception, config flag,
production mount, grant, credential, migration, deployment or activation.

## Evidence and reproducibility

`packages/engine/test/composed-file-guard.test.ts` uses actual policy, judge and
fence modules with a real newly created temporary tree for each fixture. A
call-through spy on `node:fs.readSync` independently observes the OS-call count,
exact positional arguments, returned byte count and buffer contents, rather than
inferring an effect from a fence receipt. The response fixture independently
copies bytes received at response start. Records and acknowledgement adapters
reuse the existing synthetic protected-payload test store; durable persistence
acceptance belongs to the separate owner.

Tests cover automatic/required/advisory allow, deny/human/outage, source/installed
label separation, symlink/replacement/rename/cwd redirection attempts, changed
metadata before/after syscall, missing ownership/policy facts, foreign resources,
revoked rules, policy revision, invalid parameters, mutated caller parameters,
forged/copied/wrong-owner capabilities, concurrent dispatch, record uncertainty,
read uncertainty, lost delivery acknowledgement and no replay. Ten await stages
(ownership acquisition, authority, capture recording, projection, judge, review
recording, policy source, authorization recording, read observation and response
acknowledgement) each exercise caller cancellation, revocation, generation,
owner replacement, expiry and disposal. Separate uncooperative post-read
callbacks verify cancellation settles without waiting and late completion
cannot cause another read.

Commands use pinned pnpm 12.4.2 and frozen setup, retaining all supply-chain and
lifecycle policy. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` only skips an unused test
binary; no Electron/native/provider validation is claimed. See
`owned-file-read-validation.md` for exact environment, results and remaining gates.
