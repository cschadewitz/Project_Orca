# Fan-out diagnostics (#706) — diagnostic only

Tools used for the [controlled connected validation fan-out investigation](../../../../docs/preparation/tool-execution-guards/controlled-connected-validation-fanout.md).
They measure how many currentness checks and syscalls the disposable controlled
child/producer performs. They are **not** the observer: no kernel or semantic
replay, no bootstrap closure, no designation authority. Nothing they print is
evidence, an accepting token or a qualification. Their outputs were never
retained as evidence.

`drive.py` and `child-units.py` use a synthetic `ConnectedDesignation` whose
closure returns `None`, and a synthetic receipt. With `ORCA_DIAG_CANDIDATE=1` they
replace `assert_image_sources` **inside their own process only**, so an
unreviewed candidate image can be measured. The real observer refuses such images
and must keep doing so. Unit discovery does not import this directory: there is
no `__init__.py` and no `test*.py`.

## Files

| File | Purpose |
| --- | --- |
| `drive.py` | Runs bootstrap then connected lanes of a built image: `plain`, `census`, `strace-c`, `strace-full` (observer flags minus `--always-show-pid`) or `strace-limited` (plus `prlimit --fsize=268435456`, `--kill-on-exit`, 60 s deadline). |
| `census-preload.mjs` | `node --import` preload: counts synchronous fs calls per phase and records real JS stacks at every child check (its single `/proc/self/fdinfo/<lifetime>` open). `ORCA_CENSUS_LIGHT=1` stacks only at unit entries; `ORCA_CENSUS_SEQ=1` writes an ordered event log with promise-continuation ids (enables a no-op async hook). |
| `analyze.py` | `trace`, `units`, `callers`, `entries`, `consumers`, `adjacent`, `sites`, `stracec`, `markers` reports over those outputs. |
| `gate-units.mjs` | Exact syscalls of one root resolution, one never-typed inspect and one enrolled inspect, with no-op ports; delimited by `/MARK-*` statx probes. |
| `child-units.py` | Exact syscalls of one child check, from the real image's startup sequence under strace. |
| `experiments/*.patch` | The two rejected experiments, applicable to commit `ec1f91a` (A+D1+D2): `exp1` drops `inspect()`'s closing check everywhere; `exp2` narrows the managed lifetime port to lifetime facts, cancellation and credentials. |

## Reproducing

Prerequisites: Node 24 on `PATH`, `pnpm install --frozen-lockfile`, `strace`,
`prlimit`. Build an image from the checkout under test:

```sh
node tools/owned-read-proof/build-controlled.mjs /tmp/img-<commit>     # new directory
cd tools/owned-read-proof/diagnostics/fanout
ORCA_DIAG_CANDIDATE=1 python3 -I drive.py /tmp/img-<commit> /tmp/out plain
ORCA_DIAG_CANDIDATE=1 ORCA_CENSUS_LIGHT=1 python3 -I drive.py /tmp/img-<commit> /tmp/census census
python3 -I analyze.py units /tmp/census/connected-census.json
python3 -I analyze.py entries /tmp/census/connected-census.json
ORCA_DIAG_CANDIDATE=1 ORCA_CENSUS_LIGHT=1 ORCA_CENSUS_SEQ=1 python3 -I drive.py /tmp/img-<commit> /tmp/seq census
python3 -I analyze.py sites /tmp/seq/connected-census.json.seq.json
ORCA_DIAG_CANDIDATE=1 python3 -I drive.py /tmp/img-<commit> /tmp/limited strace-limited
python3 -I analyze.py trace /tmp/limited/connected.trace
strace -f -qq -o /tmp/units.trace node --import tsx gate-units.mjs
python3 -I analyze.py markers /tmp/units.trace resolve-begin resolve-end
```

`ORCA_DIAG_CANDIDATE` is unnecessary for the reviewed image at the start commit.
Full traces are 25–360 MB each. Heavy census mode (`ORCA_CENSUS_LIGHT` unset) slows
the flow enough that the 55-second owner expiry refuses later phases; use it
only for Save.

## Caveats

- strace 6.8 was the only tracer available; the observer requires 6.13. Byte
  counts may differ slightly with 6.13 and `--always-show-pid`.
- Census counts are wrapped JavaScript calls, not syscalls. Node's `realpathSync`
  is one call but one `lstat` per path component, and `readFileSync` adds an
  internal `fstat`.
- The first heavy census used an owner classifier that reported the bound child
  check (`Object.check@child`) as `child.other`. This version classifies both
  forms as `child.check`. Published figures used `checkStacks` and `counts`,
  which that bug did not affect.
