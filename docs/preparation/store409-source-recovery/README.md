# Store #409 source-recovery inputs

This directory is an inert source packet for independent review and three-way
reconciliation with current main. Application files at their normal repository
paths are unchanged by this publication. None of these inputs is wired into the
runtime or test configuration.

## Contents and use

- `historical.patch`: exact recovered historical four-path patch.
- `base/`: two reconstructed original source files.
- `final/`: four complete intended final source, test, and documentation files.
- `manifest.json`: exact repository-path mappings, byte lengths, SHA-256 hashes,
  Git blob IDs, base-absence entries, and provenance qualifications.

Treat current main as the current version, `base/<repository path>` as the common
base input, and `final/<repository path>` as the intended historical result.
The test and documentation paths have no historical base file. Reconcile against
current main and review changes rather than overwriting current runtime files or
blindly applying the historical patch. Preserve these packet bytes as evidence.

## Provenance and verification limits

The recovery report attributes the implementation to
`b9241e81174b34f8e4367a5be5a5ad7554bb88a9`, parent
`eab8e29643a4e36b13d5005cc760ecc5e1f061c8`, followed by documentation commit
`8875f4585d7e5cd038ec974f5c6c270f8c5f01c3`.
These are report claims. Original Git commit objects were not exported or
published; commit authorship, parentage, and the association of source bytes with
those historical commits have not been independently verified here.

The exact patch and final-file bytes were independently hash-verified. Two base
source files were reconstructed by reverse git apply in an isolated data-only
directory and matched every reported length, SHA-256 and Git blob ID. This verifies
the source-byte relationship, not the unavailable historical commit objects.
The manifest records the test/documentation absence in the reconstructed base.

This publication is a new commit based on the observed current main recorded in
the manifest. It contains no application-source overwrite, new implementation,
test execution, integration approval, deployment, or live acceptance. Raw export
receipts, operational reports, and artifact collections are intentionally omitted.
