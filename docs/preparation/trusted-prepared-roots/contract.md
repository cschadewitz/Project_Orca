# Version 1 data and trust boundary

The contract is an approved preparation description, not a permission grant.
`validate-contract.mjs` consumes plain JSON values and returns deterministic
digests or bounded refusal codes. The only filesystem reads are its checked-in
schemas. The state function returns a proposed projection; it persists nothing.
Do not import it into production as an authorization implementation.

## Envelopes and identity

The three `*-v1.schema.json` files use JSON Schema 2020-12. Every object requires
all declared fields and rejects unknown fields. The local schema checker supports
only the vocabulary those files use: type, const, enum, anyOf, required, properties,
additionalProperties, items, maxItems, string bounds/patterns and integer bounds.
No executable hooks, subprocess arguments, environment or source overrides exist.

Canonical JSON v1 encodes sorted ASCII object keys, ordered arrays, JSON strings,
booleans, null and safe integers, with no whitespace. UTF-8 SHA256 yields the
unprefixed 64-character lowercase digest. Fractions, nonfinite numbers, negative
zero, undefined and non-JSON objects refuse. `decodeCanonical` requires exact
canonical bytes and thereby rejects duplicate keys or alternative encodings.
Pretty-printed examples are review artifacts; serialize their parsed data
canonically before using the external-envelope decoder. Raw manifest, lock,
executable and original receipt hashes remain hashes of their exact file bytes;
they are never substituted with a normalized document hash. The synthetic example
uses canonical receipt/ready bytes as its invented original file representation.

| Contract field | Required meaning and trusted source |
| --- | --- |
| `version`, `kind` | Exactly v1 trusted-prepared-root; no permissive migration |
| `inputs.repository`, `baseCommit` | Approved canonical repository and exact reviewed commit; no moving ref |
| `inputs.source`, `root` | Canonical no-symlink path plus device, inode and owner uid; distinct nonoverlapping roots |
| `sourceBranch`, `branch`, `commonDir`, `gitDir` | Exact independently observed registration; root branch is the original reserved branch |
| `receipt`, `receiptSha256`, `ready`, `readySha256` | Original owned-root v1 receipt and Git-ready record, exact bytes/hash and content; never rewritten to fit observations |
| `runId`, `stepRunId`, `nodeId`, `inputId` | Original run, scheduled waiting gate step and pending input join |
| `generation` | Captured generation id and protected snapshot digest from #332; current repository config cannot replace it |
| `profile` | Approved preparation execution profile id and digest; no owner-to-worker implication |
| `manifests`, `lock` | Complete approved manifest set, raw hashes, lock raw hash and Git blob identity |
| `inventorySha256`, `workspaceSha256`, `shimInventorySha256` | Independently pinned typed dependency/identity inventory, complete tracked workspace allowlist and reviewed relocation plan |
| `tools` | Every execution/verification tool's name, version and exact executable bytes; names/version strings alone are insufficient |
| `backend` | Exact reviewed wrapper, copier, relocation and checkpoint-collector bytes at the frozen backend commit |
| `outputs` | Nonempty unique nonoverlapping relative dependency-output directories; Git/ORCA/private state excluded |
| `requiredChecks` | Exact nonempty unique check set, independently approved for the named profile |
| `capacity` | Pinned payload/shim/manifest growth budgets, memory minimum and disk minimum |
| `validity` | Integer millisecond validity interval and positive checkpoint age bound; injected trusted clock |

The fixture's trusted contract digest is
`280c63f2a77506a2ea915e89a55adf4d7add1c776430b88fed443dab4f340abe`.
Its trusted result digest is
`bdfd0bdd16ff1d92477ce213359a92afb7f2e3c304bede6c94ffe9c00c53d258`.
These constants are asserted in tests. Object-key order cannot change them;
array order and any content change do. Test-only repinning models an independently
approved hypothetical input so semantic refusal guards can be reached. It is
explicitly forbidden as an operational way to accept drift.

## Independently collected observations

`snapshot-v1` binds all observed inputs exactly to the approved contract. It
contains synthetic inventories, shim summaries, both roots' Git inspection and
the actual preparing process's capacity profile. Validating once is insufficient:
collect again immediately before preparation under continuously held ownership.
`validateSnapshot` refuses changed identities, manifest/lock/tool/shim/generation
pins, partial outputs and stale observations. Pre-copy drift blocks the attempt.

The fixture inventories include device/inode/link-count evidence in addition to
path/kind/mode/hash/size/link text. Real controller inventories must be complete,
stable during bounded reads, independently derived and collected without following
foreign directory links. Their workspace entries must equal pinned Git HEAD data,
include tracked package manifests and every exposed directory child. Containment
alone is not an allowlist. Agent-written reports cannot satisfy these preconditions.

The oracle models virtual link resolution and inode independence. It does not
probe a filesystem, recognize actual shim bytes, authenticate MCP responses or
verify an executable version/native load. In the shim summary,
`reviewed-pnpm-posix-v1` means the pinned recognizer has accepted the exact hardened
header, both NODE_PATH forms and runtime body; it is not a new relaxed template.
Its raw mapping, spans, unchanged-byte digest, target and header evidence remain
in the protected backend packet. The oracle checks pinned summary identity,
executable mode, plausible prefix count and exact output size/hash. The real
backend must retain its full recognizer and byte-splicing checks.

Each synthetic array is capped at 256 items and string at 256 characters to keep
the executable oracle bounded. This is a deliberately small model, not a format
for inlining a real 22,985-entry tree into a launch response. A later controller
must stream the full protected inventory and mapping evidence, retain exact hashes
and return a bounded digest/reference projection. Truncation never satisfies a
complete-inventory check. Choosing that production storage/streaming interface is
a reviewed follow-up, not permission to drop entries or raise limits silently.

## Guard preservation

| Reviewed guard | Fixture/oracle refusal and later backend obligation |
| --- | --- |
| Link authority | Absolute, escaping, cyclic, dangling/unknown, nondirectory and Git/ORCA chains refuse; full workspace children stay pinned |
| Writable independence | Regular nlink must be 1; repeated source/destination inodes or overlap with source, workspace or another prepared root refuse |
| Shims | Unknown template, missing/extra mappings, hash/mode/size drift or inadequate retained-buffer budget refuse; only reviewed root-prefix spans may change |
| Metadata | Historical package-manager metadata keeps original bytes; it cannot be relocated or treated as bootstrap evidence |
| Git | Matching clean/process/smudge keys refuse, including empty driver names; only ordinary cached H tags pass in either root; gitlinks and any .gitmodules refuse |
| Filesystem effects | Existing or partial output trees refuse; no overwrite/resume, hardlink/reflink substitution, reset, cleanup or rollback |
| Capacity | Exactly one cgroup-v2 membership/mount, every visible ancestor, host MemAvailable without swap, current RSS/VmSize and all finite soft/hard AS/DATA limits; missing/ambiguous data refuses |

Capacity uses the smallest host, cgroup memory.max/current, memory.high/current
and finite rlimit/VmSize headroom. Only the exact hierarchy root may omit all
controller files. Ancestors are complete and ordered child to hierarchy root.
Memory must cover the greater of the pinned minimum and:

```text
4 * largestFileBytes + 4 * retainedShimBytes
  + 8 * manifestBytes + 192 MiB
```

Disk has its independent minimum. Recheck capacity before loading payload buffers
and immediately before the copy. A fresh reading reserves no memory and proves
nothing about another process's limits or peak concurrent worker capacity. Unsupported
host refusals remain blocked evidence; the guards must never be weakened to make a
test host pass.

## Bounded preparation result

`result-v1` binds contract digest, original run/root/branch/base/generation/profile,
attempt/fence/nonce, ordered times/expiry, fresh pre/post nonce-bound joined gate
checkpoints, one successful copy invocation, retained journal/output digest and
independent verification. All checkpoints must be authenticated, complete, for
the scheduled gate's final waiting event, and still show the original unanswered
input. Public synthetic summaries stand for protected complete records, including
discovery principal/scope/target and bounded grouped timestamps in the backend.

Verification joins source-before/source-after and workspace inventories, unchanged
metadata, exact permitted destination outputs and all required passed checks at
the named profile. `failed`, `blocked`, `skipped` and `not-run` remain distinct and
cannot be promoted to readiness. The trusted controller pins the accepted result
digest only after independent verification, in protected state under the existing
fence. Consumers compare against that pin; recomputing an incoming digest is never
authority. Private paths, argv, gate pages and resource details stay protected.

The `trust` object in the example is a synthetic harness input, not a fourth
untrusted envelope. Its exclusive flag, acquired fence id, nonce, attempt id,
lease expiry, accepted digests and other-root file identities must come from the
controller's actual ownership and protected evidence. No contract/result field,
task prose, repository configuration or agent marker can construct it.

`--owner-holds-roots-and-gate` in the reviewed wrapper is an attestation, not an
acquired lock. Mode 0700 is not isolation against a same-UID agent. A successful
copy/native-load under an owner profile does not prove worker write sandbox,
loopback, network controls or peak capacity. `prepared` only classifies the exact
preparation evidence; the existing launcher still needs its independently approved
execution policy and current enforcement before proceeding.

## State projection and retained evidence

| Current state and event | Outcome |
| --- | --- |
| fresh + acquired exclusive ownership + valid fresh inputs | preparing, original reserved attempt identity |
| fresh + refusal/drift/expiry/concurrent owner | blocked; no copy, contender cannot alter incumbent evidence |
| preparing + exact independent result | prepared for its bounded interval/profile |
| preparing + crash/lost owner/partial output/drift/expiry/refusal | uncertain; retain attempt and all observations/journal/partial outputs |
| preparing + failed or unavailable verification | uncertain, even when the copy reports success |
| prepared + drift/expiry | blocked; old result remains evidence, loses readiness |
| blocked or uncertain + any retry/cleanup/rollback/gate/agent event | inspection required; no automatic effect |

Fresh refers to trusted original provisioning already complete, with no preparation
attempt consumed. It never adopts an unreceipted directory. The evidence digests in
`transition` are append-only synthetic references, not a competing event ledger.
The caller must reread protected state and compare/reserve/publish under the
existing ownership fence. A loser records only its own refusal, never changes
the incumbent's shared receipt. After lease loss, no stale holder publication is
permitted; local uncertainty is retained for authorized later inspection.
No state transition answers a gate, admits/starts an agent or performs recovery.
