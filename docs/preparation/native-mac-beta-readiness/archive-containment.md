# Offline fixture ZIP containment for #388

This source increment closes the separate-tree gap identified by the
[readiness ledger](readiness.md). It reads a bounded ZIP and verifies the actual
identity, plist and daemon members inside root `ORCA.app`. A successful synthetic
containment result does not pass any native acceptance gate or complete #388.

The exact implementation base is main
`983b824adba26b0d26cfca747e5c303d03a397c6`. The merged
[#442 validator](https://github.com/cschadewitz/Project_Orca/pull/442) and
[#467 identity integration](https://github.com/cschadewitz/Project_Orca/pull/467)
are reused unchanged. Repository instructions, development/architecture guidance,
[delivery v1](../native-mac-delivery/artifact-contract.md),
[fixture contracts](../native-mac-testing/fixture-contracts.md) and the ledger
were read; no repository `.agents` skills were present. Ownership is confined to
the new verifier, its Python tests and this document. Existing validators,
runtime, updater/recovery, manifests, lockfiles and workflows are unchanged.

## Interface and identity binding

The [verifier](../../../tools/packaged-mac/archive-containment.py) uses Python 3.9+
and the standard library. From the repository root, supply a private, static
synthetic delivery directory whose ZIP is a real synthetic archive:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/packaged-mac/archive-containment.py \
  --mode fixture \
  --build-id gha:0:0:mac-arm64 \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  /tmp/synthetic-orca-zip-delivery
```

These build/source values are the existing invented fixture identity. Supply the
explicit expected values for the selected fixture rather than deriving selection
from an untrusted archive. The directory contains the existing
`native-mac-artifact.json`; there is no new manifest. The test suite constructs
real synthetic ZIPs in temporary directories from the frozen identity/plist and
comment-only daemon bytes. The checked-in #442 ZIP is a text stub and intentionally
fails this verifier; the frozen fixture is not rewritten or upgraded in place.

Both `--mode candidate` and `kind: candidate` are refused, preserving the ledger's
candidate-mode boundary until provenance/native validation is implemented. Usage
errors exit 2 before validation; containment failures exit 1 with a diagnostic;
success exits 0 and explicitly prints `PASS (fixture ZIP containment only)` with
the selected build/source, archive digest, member count and decompressed byte count.
The result retains the separate unrun native stages.

The command imports shared delivery-v1 JSON parsing, identity validation, path and
declaration checks from `native-mac-verify.py`, without invoking its CLI or its
separate-tree validation. The outer manifest shape, required pair, unique safe
paths, artifact names and declared evidence references are checked. Selection uses
`identity.buildId` + `identity.sourceCommit` + ZIP format + `identity.arch: arm64`
and requires `platform: darwin`. The selected final ZIP's actual size and SHA-256
must match its artifact record before any archive parsing.

Inside the ZIP, the verifier requires these direct regular members with real
directory ancestors:

- `ORCA.app/Contents/Resources/orca-build.json`: raw byte SHA-256 equals
  `identitySha256`; shared strict parsing/identity validation and parsed equality
  bind all fields to external `identity`. JSON is never reserialized for hashing.
- `ORCA.app/Contents/Info.plist`: bundle ID, short version, bundle version and
  minimum macOS strings match their delivery-v1 expectations verbatim.
- `ORCA.app/Contents/Resources/daemon/orca-daemon.mjs`: actual decompressed bytes
  match the sealed identity's daemon SHA-256 and required resource path.

The contract requires root `ORCA.app`. Wrappers, alternate root apps and root
case variants fail; nested Electron helper apps are allowed. Bounded `__MACOSX`
metadata is permitted alongside the app. All members, including unused resources
and AppleDouble metadata, are streamed with full payload CRC/size checks. Stored
members require equal compressed/uncompressed lengths. Raw DEFLATE decoding requires
terminal stream EOF with no unused compressed bytes; forged prefix sizes/CRCs,
unterminated streams and concatenated/trailing compressed data fail. Local headers,
signed or unsigned data descriptors and supported compression methods/flags must
agree with the central index. Indexed record ranges must completely cover byte zero
through the central directory, whose records must also account for every declared
directory byte. Unindexed records, prefixes and interior/final gaps fail, even when
all offsets and the external archive hash have been consistently adjusted. Unicode
path extra fields must agree with the actual
member name in both local and central metadata; they cannot select another path.
XML and binary plists are supported. Binary object tables and object byte ranges
are checked before parsing, preventing aliased/overlapping objects from amplifying
a bounded plist into unbounded parser allocations.

## Bounds and symlinks

The CLI has fixed ceilings, not an option to bypass them. Tests inject smaller
ceilings to exercise boundaries without creating huge inputs.

| Resource | Ceiling |
| --- | --- |
| Archive bytes | 2 GiB |
| Central directory | 16 MiB, checked before `ZipFile` allocates its index |
| Members | 50,000 |
| One decompressed member | 512 MiB |
| Total decompressed bytes | 4 GiB |
| Per-member compression ratio | 1,000 times compressed bytes (denominator at least one) |
| Manifest, identity and plist | 1 MiB each |
| Member name | 4,096 UTF-8 bytes, 64 components |
| Explicit plus implicit filesystem nodes | 100,000 |
| Symlinks | 2,048; 4,096 bytes per UTF-8 target |
| Link resolution | 40 hops and 64 components per resolution |
| Decompression read buffer | 64 KiB; only bounded identity/plist/link payloads retained |

This deliberately supports single-volume ordinary stored/deflated ZIPs. ZIP64,
encrypted/split archives, unsupported flags, other compression methods,
prepended/trailing data, unindexed records, padding gaps, and malformed or overlapping
metadata are refused. Signed and unsigned streaming data descriptors, reordered
central entries and bounded comments are supported; record order need not match
directory order. A candidate needing a broader
container subset requires another reviewed increment, not larger ad hoc flags.
Advertised sizes/ratios are checked before decompression. Every decoder output is
capped by the remaining member/total/metadata/link/ratio budget and expected size,
with at most one excess output byte to detect a violated ceiling. CRC and hash cover
the complete successful payload. No `ZipExtFile` truncation or unbounded decoder
flush is used. No extraction is performed.

Names reject absolute/drive paths, backslashes, empty/`.`/`..` components, NUL,
control characters and invalid Unicode. Duplicate members and file/directory
collisions fail. Every explicit and implicit path component is indexed using
Unicode NFC plus case folding to refuse case/normalization ambiguity, including
ambiguous ancestor spellings. This is a conservative portable ambiguity check,
not a model of every macOS filesystem collation rule.

Unix ZIP symlink mode is handled deliberately. Typical Electron framework links
such as `Versions/Current -> A`, `Resources -> Versions/Current/Resources` and
`Electron Framework -> Versions/Current/Electron Framework` pass. Relative `..`
targets are permitted when component-by-component resolution remains inside the
same `ORCA.app`; linked ancestors are resolved before later `..` components.
Absolute/drive/backslash targets, escapes, dangling links, cycles, file ancestors,
children stored underneath links and special device/FIFO/socket members fail.
Identity/plist/daemon symlink substitutions fail even when a framework link would
be valid. Framework links cannot alias another resource into a required path.

Filesystem inputs must remain private and static. The existing safe-file checks
reject static delivery-root escapes/nonregular files. Hashing and archive inspection
use the same open ZIP handle, but this is not a race-resistant reader against a
concurrent writer changing an open inode.

## Evidence and remaining gates

Containment establishes equality of observed ZIP members to the selected synthetic
delivery-v1 expectations. It does not authenticate an attacker-controlled manifest
or prove that an Apple code signature covers those bytes. This command does not read
or hash the DMG, evidence files or `SHA256SUMS`; it checks their manifest declarations
only. The existing fixture validator remains the separate delivery-set regression.

Signatures/approved publisher, entitlements, notarization, staple tickets, Gatekeeper,
TCC, actual Mach-O arm64 execution, app/daemon process association, packaged workflows,
DMG containment and invited downloads remain **unrun**. No extraction, mounting,
app launch, live candidate download, production updater adapter, activation, real
host-state change, credential/access change, release or distribution is performed.
D4 supported OS floor and D5 production version/plist policy remain **unchosen**;
synthetic values and verbatim comparisons do not decide them. #385/#388 and the
parent's independent review, CI and merge gates remain open.

Focused validation commands, leaving existing tests unchanged:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tools/packaged-mac/tests -p 'test_archive_containment.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tools/deploy/tests/native-mac -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 node_modules/.bin/vitest run \
  tools/test/native-mac-validator-integration.test.js --maxWorkers=2
git diff --check
```

At the corrected implementation: Python 3.12.14 / Node 24.19.0; all 46 containment
tests pass without skips. The original 37 containment tests passed at
`81431d64dd221398771d9bbac36606af4bb91a60`, but
[independent review 5450824960](https://github.com/cschadewitz/Project_Orca/pull/541#pullrequestreview-5450824960)
reproduced eight false passes from forged payload lengths/terminal streams and
unindexed record gaps. The correction adds an independent synthetic record writer
and deterministic regressions for both blockers, including consistently rebound
archive hashes and explicit actual-budget checks. Unsupported ambiguous framing is
rejected; valid descriptors, empty payloads and decoder chunk boundaries still pass.
The 37 unchanged Python validator and seven unchanged producer/validator regressions
passed at the original head and are not rerun for this correction. The synthetic
cases cover valid layouts/links, spaces/non-ASCII,
duplicate/case/normalization ambiguity, wrong roots, resource substitutions, traversal,
link escape/cycles, malformed/truncated/CRC-invalid archives, local-header/Unicode
path overrides, data descriptors and decompression/index limits. Python 3.9 syntax,
UTF-8/LF/final-newline, local documentation links and whitespace are checked separately.
ESLint has no Python/Markdown configuration, and Prettier excludes Markdown and has
no Python parser; no repository Python formatter/linter is configured. Vitest/CI
discovery does not automatically run the focused Python suite; workflow wiring stays
outside these three reserved paths. No broad duplicate suite or CI polling is run.
