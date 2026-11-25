# C15 payload allocation attribution — 25 October 2026

**A focused allocator correction passes the portable probes below; Windows C15
and composite/native acceptance remain open.** Production capture is still
hard-disabled. Neither the 32 MiB managed gate nor the 8 MiB controlled-payload
gate changes. The historical Windows failures of **64,061,697 / 59,414,981 bytes**
remain failures, as recorded in [the corrected C15 evidence](windows-c15-corrected-followup.md)
and issues [#416](https://github.com/cschadewitz/Project_Orca/issues/416) /
[#469](https://github.com/cschadewitz/Project_Orca/issues/469).

## Attributed behavior and correction

At main `0f45181c52dfc4bf1edd0e4469ff688dedef9189`, every first allocation in
`ControlledPayloadMemory` creates a 5,242,880-byte backing Buffer. This includes
a tiny setting/control record. Once leases and provider allowances settle, idle
disposal erases and drops the arena reference. Its controlled charge then becomes
zero, while backing storage and V8's `external` accounting are reclaimed on the
engine's schedule. Released Buffer views can also keep a backing allocation alive.
Zero controlled charges do not establish zero process memory or a retained-object
leak; sampled `heapUsed + external` includes transient allocation and GC/accounting
behavior. No GC was forced to change a result.

Twenty **real `NodeRecoveryDisk.writeSetting` operations**, each using a fresh
payload owner, allocate 104,857,600 backing bytes in total before the correction.
No capture or report construction is needed to reproduce an over-budget sampled
peak. This attributes avoidable product allocation amplification that the repeated
C15 fixture setup exercises. It does **not** retroactively attribute every byte of
the archived Windows peaks, whose product/fixture/native split remains unmeasured.

The allocator now adds regions rounded to 128 KiB, sized for the requested
contiguous allocation. Metadata, keys and the 81,920-byte ring can share a small
region. Report operations add space only as needed. Live views never move or copy;
free ranges coalesce within their own region. All region backing, including unused
space, counts against the **original 5 MiB arena ceiling**, and all provider
allowances still share the **original 8 MiB total ceiling**. Growth is admitted
before allocation. Release stays idempotent and erases the aligned range before
reuse; idle disposal still waits for actual lease/provider settlement. Region
fragmentation can conservatively refuse a contiguous request rather than exceed
the ceiling. Existing maximum checkpoint/recovery/report tests continue to pass.

An intermediate implementation grew from 128 KiB to the entire remaining arena
at the first report allocation. Its portable stall result still failed at
57,656,580 bytes. That failed result is retained; the final implementation sizes
every new region to demand.

## Portable measurements

The [receipts and compiled-module SHA-256 manifest](native-packaging-evidence/c15-payload-memory/measurements.json)
retain all three source versions and each completed schedule. `before` is main,
`after` is the failed intermediate design, and `sized` is the final implementation.
The initial exploratory metadata observation and premature 25 ms setup-timeout
failure are also disclosed. Every complete source/schedule observation ran once;
these are observations, not a statistical performance guarantee.

| Portable schedule, 20 cells | Main managed increment | Final managed increment | Final cumulative backing allocation |
| --- | ---: | ---: | ---: |
| Setting metadata only | 48,619,452 bytes (FAIL) | 2,585,492 bytes | 2,621,440 bytes |
| Repeated full-ring checkpoint failure | 62,729,376 bytes (FAIL) | 13,416,640 bytes | 41,943,040 bytes |
| Repeated full-ring checkpoint stall | 61,933,960 bytes (FAIL) | 13,934,372 bytes | 34,078,720 bytes |

The unchanged managed limit is **33,554,432 bytes**. The final controlled peaks
are **131,072 bytes** for metadata and **1,310,720 bytes** for the checkpoint
schedules, below **8,388,608 bytes**. Main's corresponding backing totals are
104,857,600 / 734,003,200 / 419,430,400 bytes. Cumulative allocations are attribution
counters, **not** retained-memory measurements and are not subtracted from peaks.
Heap and external component peaks are separate maxima and must not be added to
reconstruct the simultaneous managed maximum.

`payload-arena-probe.mjs` runs compiled production disk/controller/allocator code
in a fresh Node 24.19.0 Linux x64 process per schedule, using disposable files,
explicit synthetic key wrapping and the existing POSIX fixture adapter. Each
failure/stall cell records 8,192 events and injects only the checkpoint call.
The controller's 1,000 ms public timeout and Off are observed before releasing
the stall; 128 extra prepares per cell are refused without payload allocations
(**2,560/2,560**). Actual controller/disk settlement and zero reservations and
controlled charges are checked after every cell.

Memory sampling requests 2 ms and also samples allocation/operation boundaries,
from a baseline after imports and before the first cell. `arrayBuffers` is not
added to `external` again. Only scalar peaks and fixed phase labels are retained.
No renderer, CLI pair, Windows native adapter, DPAPI, native-worker fault,
publication, sleep/reboot, physical device or continuous native allocation is
measured. These repeated checkpoint cells are **not** the complete 20-method
Windows C15 campaign. RSS is reported separately. Probe failures emit nonzero
exit status; historical receipts predate that exit-status addition but retain
explicit failing memory booleans.

## Reproduction and verification

From the repository root, compile only the relevant graph to a fresh directory:

```sh
node_modules/.bin/tsc --ignoreConfig --outDir /tmp/orca-c15-proof \
  --rootDir packages/app/src --module nodenext --target es2023 --skipLibCheck \
  --types node packages/app/src/main/diagnostics/recovery-controller.ts \
  packages/app/src/main/diagnostics/recovery-disk.ts
node packages/app/test/recovery-preparation/payload-arena-probe.mjs \
  /tmp/orca-c15-proof/main/diagnostics metadata
node packages/app/test/recovery-preparation/payload-arena-probe.mjs \
  /tmp/orca-c15-proof/main/diagnostics failure
node packages/app/test/recovery-preparation/payload-arena-probe.mjs \
  /tmp/orca-c15-proof/main/diagnostics stall
```

Use the same probe with main's compiled graph to reproduce the before comparison;
a failing managed gate returns exit 1. Do not supply `--expose-gc`.

Two new allocation/growth assertions were observed failing before the production
edit. Regressions cover small-region footprint, stable live report/ring views,
erasure and reuse across growth, admission before backing allocation, provider
charges, the unchanged full 5 MiB + 3 MiB ceiling, per-region fragmentation and
coalescing, and actual maximum checkpoint/recovery disposal. The original ceiling
test now fills the remaining allowance from actual backing size; it still checks
exactly 8 MiB and refusal of the next byte.

The development diagnostics/recovery run passed **270 tests**, with **one existing
platform-specific test skipped**. This is source/fixture evidence. Final-commit
validation is reported in the draft PR. Local tools come from the preinstalled
workspace (Vitest 5.0.2, TypeScript 7.0.2), not a fresh lockfile install. A pinned
pnpm attempt first needed a writable data path, then refused to replace the existing
modules directory without a TTY; it was not forced. The already installed,
lockfile-matching `yaml@2.9.1` package was linked into the app's missing dependency
slot for whole-project typechecking. No manifest/lockfile/dependency version changed.
`AGENTS.md`, development and architecture guidance were read; this checkout and
`/workspace/.agents` contain no applicable `.agents/skills` files.

## Next acceptance blocker

Run a newly pinned, reviewed Windows x64 Electron/native **full failure and stall
C15 Off/On comparison** on this final source, retaining per-cell heap/external and
backing allocation attribution without resetting the aggregate baseline, subtracting
fixture cost, forcing GC or changing budgets. The archived Windows supervisor is
intentionally frozen to historical source/compiled hashes; do not remove those
assertions and mislabel a new result as its old candidate. A new exact-source
composition/supervisor manifest is needed. This Linux environment cannot supply
Windows/DPAPI/Electron or physical acceptance. Combined renderer/native resource,
paired-execution, remaining native/crash/privacy/accessibility and independent-review
gates stay open; the separate 4 ms deferral in #597 does not waive memory. No
activation, gate closure, main merge, release or deployment is implied.
