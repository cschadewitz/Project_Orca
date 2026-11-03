# Preventive source sizing and blocked owner custody

This increment continues PR #809 from 158a94fd. It is non-live source engineering
for #706. No original run, retained image, platform owner, private sink or loaded
code evidence was recovered or fabricated in this environment.

## Implemented source restrictions

The previous runtime allowance alone was 32 × 256 MiB = 8 GiB raw, 16 GiB
retained hex, plus whole JSON text and UTF-8 copies. Per-entry bounds and streamed
comparison did not bound that aggregate to a practical amount.

The new `ORIGINAL_SOURCE_LIMIT` is an additional restrictive 512 MiB aggregate
raw source ceiling. It is independent of the 256 MiB trace ceiling and the two
separate 1 MiB report and original-metadata ceilings. Runtime count stays 32 and
per-runtime size stays 256 MiB. Image entries retain the existing designation's
16 MiB bound; ordinary originals are at most 65536 bytes, witnesses 130 bytes,
and lifetime contents zero. No allowance, source pin or grammar is expanded.

Earlier historical preparation reads in `assert_image_sources` and `prepare`
precede these capture guards and remain outside this new bound. All four launch
entry points still refuse before any such effect.

The source inventory is sized before capture. Each capture also checks its
remaining aggregate allowance before opening, reads at most the per-entry bound
plus one refusal byte, and checks descriptor and path physical correspondence.
Symlinks and nonregular original inputs refuse; existing runtime symlink policy
is unchanged. These are temporal correspondence checks, not preventive isolation.

Original packet writes now validate the metadata/asset grammar before opening the
sink and stream exact canonical JSON with escaped string segments of at most
16384 characters. Receipt comparison computes the original canonical digest and
compares the complete on-disk bytes without retaining an encoded packet copy.
Report publication also validates its known-field grammar and separate 1 MiB
metadata budget before opening the report sink. The final original source digest
and physical evidence seals remain required.
JSON insertion order, escaping and all canonical bytes remain significant.

The 512 MiB raw ceiling allows at most 1 GiB retained hex, plus bounded metadata,
Python objects and one file's capture/conversion transients. Capture still holds
raw chunks and their joined bytes transiently; it does not promise a measured RSS
ceiling, a small total replay footprint, or OS-enforced memory containment. Replay
and the existing trace parser have separate allocations. The unchanged launch
refusals prevent treating these improvements as a qualified observation path.

## Owner-bound custody contract: blocked at M1

M1 requires a named independently authenticated issuer, a preexisting recovery
owner, and a private evidence sink. None is present. This change deliberately
provides no constructible authority object, callback success flag, deserializer,
CLI option or fake adapter as a substitute. M2 remains blocked.

A future cohesive adapter must reserve source, serialized-packet and private-sink
capacity under the original external owner before any acquisition or write. Its
opaque in-process custody handle must bind that owner, original session, exact
source inventory, lane, destination descriptor and recovery record. Neither JSON,
a copied receipt nor a pathname can reconstruct that handle. The original owner
must retain responsibility across startup ambiguity, settlement and persistence.

Before effects, the sink owner must enforce access and destination isolation,
provide fixed-capacity reservation and recover uncertain publications. Writes must
use owned descriptors, consume each publication attempt once, enforce bytes before
each write, and preserve the private original error without exposing its text.
Any failed/ambiguous reservation, close, sync, acknowledgment or transfer leaves
custody with the original recovery owner, blocks command/receipt release, and
forbids automatic retry. A successful file write alone is not durable media proof.

The current source writer uses a trusted pathname and existing repeated snapshot
publication; it is not that adapter and makes no path-custody or durability claim.
Its source bounds must be carried into the eventual reservation, not advertised as
a replacement for it. M1 identity/authorization and recovery semantics, private
sink implementation, preventive containment, loaded-code closure, complete
current-source replay and independent security qualification remain proof gaps.
No host, SSH, VM260 or pve2 work is authorized or performed.

## Verification and review of this increment

On Node v24.19.0 and Python 3.12 in the managed cloud checkout:

- `PYTHONPATH=tools/owned-read-proof python3 -B -m unittest test_source_sizing test_controlled_connected test_finalizer_worker_guard -q`: **80 tests passed**, 7.758 seconds.
- `timeout --kill-after=5s 180s python3 -B tools/owned-read-proof/check_nonlive.py`: **512 tests run**, 17.008 seconds, exit 1, **two errors and no assertion failures**. One test requires absent `ORCA_LEGACY_IMAGE_FIXTURE`; the current-image inspection class setup refuses its byte-pinned rebuilt image. These are unresolved evidence failures, not skips or passes. No pins or assertions were loosened.
- Changed Python files compile; `git diff --check` passes. No TypeScript or dependency change was made; the full repository/Vitest/coverage suite was not run.

Independent review used **gpt-6.1-sol, xhigh** against the final executable diff.
The reviewer found no actionable correctness, privacy, security or budget
regression. Its verification passed 22 focused source/finalizer/nonlive tests,
three receipt tests, and three extra synthetic checks for post-preflight growth,
same-size mutation during capture and later in-memory original mutation. Review
requested the earlier-preparation-read scope clarification now included above.
This is a bounded source review, not formal security approval or live readiness.

Repository `AGENTS.md` and `docs/DEVELOPMENT.md` were read. Neither repository
`.agents/skills` nor `/workspace/.agents/skills` exists in this checkout.
The old uncertain PR-description write was not retried; publication is limited to
the reviewed source/evidence branch update. No PR description/comment change or
manual workflow dispatch accompanies this increment.

Subsequent [setup diagnosis and repair](python-setup-investigation.md) identifies
the exact stale dependency inputs and records a passing selection with the
documented fresh historical fixture. Earlier failed results below remain dated
evidence, separate from that later setup repair.

## Independent baseline attribution supplement

The same independent **gpt-6.1-sol, xhigh** reviewer subsequently compared
baseline `158a94fd58daf0eaea28f8ce63445a251a639961` with executable candidate
`77b6dbbea7f1b2cf187d3f4b17b1cbce0e7900e4`. It verified access to the exact
candidate files and independently matched these SHA-256 values:

| Candidate path | SHA-256 |
| --- | --- |
| `tools/owned-read-proof/controlled_supervisor.py` | `2adeab0090b0b9e1ce6ba20dccec679b9a334bfbd91e67f7deb1f6e0b815955c` |
| `tools/owned-read-proof/check_nonlive.py` | `c3116369c876fdea002b309e382de963d355dc736aae4d086d0c655c50e98cdf` |
| `tools/owned-read-proof/test_source_sizing.py` | `16e10ae04f3ae749c9dced736989935eab5fd29d4ff7454b5193905f3c40b1ed` |
| `tools/owned-read-proof/test_finalizer_worker_guard.py` | `169370d9a722cc359b9026f3578d53d2185379ca4fb90f2ca87d54e3e7852734` |

All image build source inputs, builder, child, inspection pins, lockfile and
TypeScript configuration are unchanged across the two commits. The reviewer
created an isolated baseline worktree and copied the existing dependency tree,
including relative links and package dependency trees; it did not install new
dependencies or construct a historical acceptance fixture. Separate unlaunched
builds under Node 24.19.0, tsx 4.23.15 and esbuild 0.28.2 produced identical bytes
at baseline and candidate:

| Output | Baseline and candidate size | Baseline and candidate SHA-256 |
| --- | ---: | --- |
| `controlled-build.json` | 47838 | `3ff84fb6cb1b1e3e053231a07ba3b2f160e8da820d0f2bc7d16ab81c2e3ff9b6` |
| `controlled-producer.mjs` | 2236786 | `a3caa5df9b61c08b80fdfbe4bbcc94b3c6671c8ac7b8b5a2a53ac4d8fb548cd3` |
| `controlled-child.mjs` | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |

Both baseline and candidate inspector calls refused with the fixed code
`current image inspection refused`. The manifest and producer differ from the
unchanged fixed pins (48027 and 2248652 bytes, respectively); the child matches.
The two manifests contain the same 386 source keys, no parent-relative keys and
no source-head field. Thus this mismatch already exists at baseline in this
dependency/toolchain environment and is not caused by the source-sizing delta.
The exact underlying historical dependency/build drift is not diagnosed here;
byte equality does not supply authority or resolve qualification.

This attribution is separate from the absent `ORCA_LEGACY_IMAGE_FIXTURE`, which
remains unprovided and untested, and from the 80 focused passing tests. No pin,
assertion, fixture requirement or launch boundary was changed to obtain a pass.
The reviewer again confirmed the preserved independent budgets and unchanged
first-statement launch refusals; no actionable source regression was found.


Subsequent source work after the named pve2/Casey console-controller direction adds
[a real single-report custody transaction](host-report-custody-and-delivery.md),
with native preallocation and publication tests. It is a partial artifact mechanism,
not an installed host provider or full S0/G1/G4 exit. Actual principal, protected
root, aggregate capacity, original-session binding and complete evidence transport/
export policy remain separate setup prerequisites. Earlier source/error/CI records
above remain preserved as dated evidence.
