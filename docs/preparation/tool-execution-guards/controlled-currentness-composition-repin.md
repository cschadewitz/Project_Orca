# Disposable currentness composition image pins (#785)

This prepares the disposable observer for independently source-reviewed candidate
`3fce8bcc9afd381cd07c0e06051921307d6322b3`. It changes only observer source/image
selectors, synthetic historical/current fixture selection, the retained build
manifest and this record. The producer and child implementations are unchanged
from that candidate. Manifest review remains pending; no fresh traced execution,
bootstrap designation, accepting token or production eligibility is claimed.

## Build correspondence

The preserved environment built one new physical image at
`/tmp/orca-785-frozen-image`, without an installation or lockfile change. The exact
candidate lockfile SHA-256 is
`352f24faa4a0b52765738749035e39a89e1d0f40c5312b61655be1040cdb6c8a`.
Node is 24.21.0; the installed build uses tsx 4.23.15 and esbuild 0.28.2.
The relevant installed SDK is 1.8.0 and Zod is 4.6.7. Validation uses Vitest 5.0.5,
TypeScript 7.0.2 and ESLint 10.13.0. Corepack/pnpm was not invoked.

Parsed installed-lock importers, settings and lockfile version match the candidate
lock. Every common package/snapshot record matches. The installed lock omits only
the 15 pnpm 12.4.2 executable/package records; none is a build input. This is a
build with preserved matching dependencies, not a claim that a new frozen install
ran or that the installed lock is byte-identical to the repository lock.

The complete manifest has 386 input paths: 194 repository inputs and 192
dependency inputs. All 192 dependency paths and byte hashes equal the previously
retained reviewed 386-input image. The repository path set is unchanged; only
`packages/cli/test/controlled-owned-read-producer.ts` has different input bytes.
Every repository input was compared to `git show` at the exact candidate SHA,
and every dependency input was compared to the actual installed file bytes.
The standalone child was also compared to the candidate's committed bytes.

The complete new native manifest is retained without reformatting as
[controlled-currentness-composition-frozen-build.json](controlled-currentness-composition-frozen-build.json).
The older 385-input candidate manifest and prior 386-input stat-consolidation
manifest remain unchanged as historical build records.

| Input or image file | Bytes | SHA-256 |
| --- | ---: | --- |
| Producer TypeScript input | — | `61d62d01d32057036ea3cd638fa6a04abcf3f0b04be9973ae3c1c24ee44295a8` |
| Child | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |
| Producer bundle | 2184692 | `b155c2ae67af5be2b74468b909911c1af0a9db7c7559d76f06bfd089168b99f6` |
| Build manifest | 47911 | `7363dcc4d83530f43744c7c031f3f9f054c21917b3ffc99d27725c3840634dc2` |

Both child and producer bytes differ from the prior reviewed image. In particular,
the prior producer bundle hash `d0ad8d81a7980364a4b6ae80c0876cce951104fb3323e7d1fc3fc2c01a21ec92`
does not describe this image. The earlier preparation environment's 385-input
bundle hash `242b05ae8bc5eea24dd4c81d66ad177b61dcd1788e3f48916abb8c27b0a1ba9e`
also does not describe this image.

## Selector and fixture changes

`controlled_supervisor.py`, `controlled_connected.py` and
`controlled_timestamps.py` select the exact reviewed candidate source SHA.
`controlled_timestamps.py` also selects the new producer input and child hashes.
No runtime fallback to historical sources or image generations is added.

Positive timestamp/semantic controls use a distinct current-source fixture.
The historical `557f62f` fixture retains its exact canonical digest
`53bfcaef92557acfea26c147ca1e1f1584e4541409fd071cff761c4b62eeb2f8`.
The former current `fa25390` fixture is retained separately with its exact digest
`b489c4fdea308cc4803aafe4a12e1656a6eda30cf2210735fe9779f2419853f2`.
Both retain their original producer input hash and refuse current designation.

Controls exercise old/new source, child bytes, declared child hash and producer
input mixtures; image/receipt/plan identity and byte associations; and mutation
after successful currentness checks. The real rebuilt manifest must equal the
complete retained frozen-input manifest. Existing checks of every repository and
dependency source input remain active.

## Validation

- Full Python discovery: 340 tests pass, including child composition/stat/receipt,
  image and original-evidence association controls and retained tamper negatives.
- Optimized Python: all 7 image-pin and all 15 timestamp controls pass under
  `python -O`.
- Targeted genuine producer/fdinfo Vitest suites: 65 tests pass with one worker.
  They ran from an unchanged candidate checkout at `/tmp/orca-785-validation`,
  using the preserved package dependency links. This avoids the previously
  diagnosed `/workspace` overlay inode representation problem; assertions and
  source were not changed to accommodate it.
- Complete manifest/input/hash comparisons, Node child syntax and
  `git diff --check` pass. The candidate lockfile remains byte-identical.

## Observation gate

The prior refusal packets and paired observation remain preserved in their
original directories. No evidence is reinterpreted as a fresh successful run.
This preparation does not change 55-second owner, 60-second process or 256-MiB
trace bounds, phase/currentness/final-dispatch checks, production accepted-build
registries, credentials or security settings. A fresh observation requires
independent review of these exact pins and manifest first. PR metadata and the
distinct parallel Claude branch remain with the parent owner.
