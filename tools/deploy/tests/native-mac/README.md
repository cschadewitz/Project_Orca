# Portable Mac artifact fixture validator

This is a **fixture-only** implementation slice for #385/#388. It neither verifies
production candidates nor satisfies either issue's native Mac acceptance criteria.
Python 3.9+ and its standard library are sufficient; no dependencies, credentials,
network, Apple tools, archive extraction or subprocesses are used by the validator.

From the repository root:

```sh
python3 tools/deploy/tests/native-mac/make_fixture.py /tmp/orca-native-mac-fixture
python3 tools/deploy/native-mac-verify.py \
  --mode fixture \
  --fixture-app /tmp/orca-native-mac-fixture/ORCA.app \
  /tmp/orca-native-mac-fixture/delivery

PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tools/deploy/tests/native-mac -p 'test_*.py' -v
```

Success prints `PASS (fixture only)` with the unverified native stages. Invalid input
exits 1 with a diagnostic on stderr. Usage errors exit 2. `--mode` is mandatory;
`--mode candidate` exits 2 with an explicit unsupported-production message before
reading any files. A `kind: candidate` manifest also fails in fixture mode. There is
no production switch, unsigned fallback or promotion output.

## Source contract and unresolved decisions

The original baseline is `e94bf699d9f3000de8822ed3434c1dce92b6ce19`, reconciled with
main at `94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb`. The field names and
semantics come exclusively from the [delivery v1 artifact contract](../../../../docs/preparation/native-mac-delivery/artifact-contract.md).
The [testing fixture contract](../../../../docs/preparation/native-mac-testing/fixture-contracts.md)
supplies negative cases. There is no second delivery manifest or extension field.
The separate `--fixture-app` input is a test-side observation, not a manifest field.

No field-name conflict was found between these two documents at the baseline. Both
still describe a proposal. The testing document's reference to #405 being absent
from audited main is historical; this work reads the delivery document at the
requested baseline. Main now records approved bundle and Team IDs under D1;
certificate/authority verification, macOS support (D4), version mapping (D5), and
review/ownership decisions (D6) are not established by these fixtures. Synthetic
values do not resolve them. In particular:

- `com.schadewitz.orca`, `darwin`, `arm64`, the `gha:RUN_ID:RUN_ATTEMPT:mac-arm64`
  syntax and daemon resource path are the documented v1 constants.
- `bundleShortVersion` and `bundleVersion` are opaque strings compared **verbatim**
  with the synthetic plist. No mapping from SemVer is inferred. `0007.02` is
  intentionally unequal to `7.2`; the tests also accept identical opaque strings.
- Protocol numbers must be nonnegative integers and agree with the synthetic app
  identity. They are not pinned to 1.9. No runtime compatibility policy is invented.
- `minimumMacOS: "0.0"`, toolchain versions `0.0.0`, build `gha:0:0:mac-arm64`, the
  source SHA, publisher strings, UUIDs and certificate digest are invented fixture
  data. They are neither a real build nor supported-OS/publisher requirements.
- Signing declarations require nonempty team/authority, a digest, `true` hardened
  runtime and `passed` verification. They cannot establish an expected publisher,
  validate a certificate or prove any signature. The production wrong-team check
  remains a native/approved-publisher check. The fixture deliberately retains an
  invented Team ID rather than claiming the approved publisher signed its bytes.
- Notary logs and verification reports have no fixed machine-readable schema in
  delivery v1. Their references, bytes and digests are checked; their contents are
  not interpreted as Apple results. No competing report schema is introduced.

## What passes

`make_fixture.py` copies frozen templates to a new directory (it refuses to
overwrite one), retaining the checked-in checksums. The comment-only daemon stub
is stored as `.mjs.txt` so repository code tooling does not treat fixture data as a
JavaScript program; materialization only removes that `.txt` suffix. It does not
build or package anything. Use an unused temporary destination when rerunning.

The checked-in fixture is deliberately recognizable as synthetic. Its `.dmg` and
`.zip` files are short plain-text stubs, not archives. `ORCA.app` contains only an
identity JSON, a plist and a comment-only daemon stub; it cannot launch. The fixture
reports say that no signing, submission or ticket validation occurred. They have
real SHA-256 hashes of these **synthetic** bytes.

The validator checks:

- Strict UTF-8 JSON with duplicate keys and non-JSON constants rejected, integer
  schema version 1, complete documented fields and no unknown object fields.
- Identity types and syntax, SemVer release version, UTC timestamp, exact resolved
  toolchain version syntax, app/daemon release equality and declared architecture.
- Exactly one correctly named DMG and one ZIP; distinct artifact/evidence paths;
  positive integer byte counts (booleans are not integers); lowercase SHA-256.
- Relative `/` paths without empty, `.` or `..` components, absolute/drive paths,
  backslashes or control characters. Every read resolves within its selected root
  and must be a regular file. Internal symlink aliases cannot duplicate a listed
  path; escapes, loops and FIFOs fail. The validator never follows manifest URLs.
- Listed evidence for signing, both notary submissions and all three staple
  targets, with final file sizes and streaming hashes checked. Submission digests
  are distinct stage declarations and are never equated to final container hashes.
- `SHA256SUMS`: lowercase digest, exactly two spaces, relative filename, LF per
  entry including the last, sorted unique names, exact coverage of the two
  containers, raw manifest bytes and all listed evidence. It must not list itself.
- Raw identity-file digest without JSON reserialization, parsed identity equality
  with the manifest, synthetic daemon hash, and exact plist bundle-ID/version/macOS
  strings. The app tree is separately supplied; there is **no assertion that either
  container contains it**. Files not listed in the manifest are not consumed.

Use private, static directories. Path checks defend against static traversal and
symlink escapes; this is not a race-resistant reader for a tree another process can
mutate during verification. The `kind` flag is a scope declaration, not provenance:
relabeling bytes as a fixture cannot turn a pass into production evidence. Checksums
detect changed bytes, not an attacker who replaces both the bytes and the checksums.

## Negative cases and native boundaries

Tests copy the positive fixture to a temporary directory and mutate one condition
at a time. Structural mutations refresh only the manifest's checksum, so a stale
checksum does not hide the intended failure. Integrity cases deliberately retain
the old digest/size. The suite covers every required field plus duplicate keys and
paths, malformed types, unknown schemas/fields, missing formats, filename mismatch,
invalid identities, missing evidence/files, traversal, symlink escapes/aliases/loops,
nonregular files, modified container/evidence/identity/daemon bytes, pre-staple hash
substitution, checksum syntax/coverage/order, and fixture/candidate confusion.

`x64` declarations fail, but an `arm64` declaration is not Mach-O architecture
inspection. Synthetic `Accepted`/`passed` statuses exercise shape only. Actual
signatures, expected publisher, timestamps/entitlements, app tickets in both final
containers, notarization, Gatekeeper, authenticated delivery/revoked access,
packaged metadata/runtime versions, authenticated hello, process association,
native execution, sample workflows and hardware/OS support are **not run** here.
No app, daemon, release, installer or credential configuration is touched.

The focused Python suite is intentionally invoked directly. Existing Vitest/CI
discovery does not run it; workflow changes are outside this slice's ownership.
