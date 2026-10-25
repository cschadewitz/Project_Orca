# Windows C15 readiness run 5 — hosted synthetic evidence

[Windows run 40219769173](https://github.com/cschadewitz/Project_Orca/actions/runs/40219769173)
and [proof job 121248595528](https://github.com/cschadewitz/Project_Orca/actions/runs/40219769173/job/121248595528)
passed at exact tested harness **`dbedc9db00fadc442e4caca388fc73555b9664aa`**.
[CI 40217495227](https://github.com/cschadewitz/Project_Orca/actions/runs/40217495227)
also passed on that commit. This evidence-only successor changes no product,
harness, workflow, manifest hash or acceptance boundary and does not rerun Windows.

The directly inspected job logs record Windows Server 2025 x64, Node 24.21.0,
pnpm 12.4.2, a frozen install without lifecycle scripts, source/compiled/harness
verification, **22/22 portable tests**, native x64 build, checksum-pinned owned
Electron staging and accepted Documents ancestry. The product source stays
**`14666a315b43bc859ad0b73dda92ddf280b0de10`**; all 365 compiled hashes,
native source and Electron 44.9.1 archive pins remain unchanged.

## Artifact review and result

The parent independently reviewed
[artifact 12609202535](https://github.com/cschadewitz/Project_Orca/actions/runs/40219769173/artifacts/12609202535)
and supplied its ZIP verification. GitHub reports **68,993 bytes**; the parent's verified ZIP SHA-256 is
**`ff729d89ffcfd4d9c7bae6f544df24a948881791ff45519fa24047687015c7dc`**.
This update environment inspected job logs and artifact metadata; it did not
materialize or independently hash/parse that ZIP and attempted no URL workaround.

The parent recomputed all **14 exact-head harness SHA-256 pins** from connector
bytes and checked manifest/build/results, selected source, runtime and native
bindings. The unchanged local manifest SHA-256 is
`96948f6bd6a6287f37a51c81b17ebb068ff7567e92a1ea75b97a21b364d60960`.
The build receipt digest independently visible in the job log is
`fd893fd039affd01b58752046ea8fc257bb36b0dc984f27531c46b967e73dd01`.
Both failure and stall Off/On comparisons pass correctness, memory, semantic/work
parity, child-lifecycle overlap, owned exits and disposable-root cleanup.

Each of the **eight CLI demos** exited 0 with **29 artifacts**, giving **58 per
mode in each schedule**. All **four diagnostic children** exited 0. All 20 On
cell constraints in each schedule were recomputed. Stall pressure remains
128 attempts / 128 refusals per cell, with no added disk calls, dispatches or
payload allocations and retained parked backing where required.

| On schedule | Budgeted managed measurement, bytes | Controlled binary peak, bytes | Minimum start margin, ms | Minimum end margin, ms | Readiness to first fault, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| failure | 15,319,656 | 2,490,368 | 41.9903 | 13,122.949 | 41.001 |
| stall | 19,596,119 | 2,490,368 | 60.0644 | 719.4433 | 58.9745 |

All **40 On fault entries** satisfy `start + 2000 ns < entry` and
`entry + 2000 ns < end` within one of the two actual child intervals. The margins
above are the minimum distances from entry to the corresponding child start/end;
they do not relax either 2-microsecond exclusion. Stall has 14 entries in the first
demo and six in the second, with none in the inter-demo gap. The unchanged memory
budgets are **33,554,432 managed bytes** and **8,388,608 controlled binary bytes**;
baseline placement, sampling and accounting are unchanged.

The ZIP retains **parsed start/final frames**, without raw fd 3 bytes or a separate
EOF marker. EOF/close acceptance follows from the exact pinned collector returning
`completed`, which requires final validation, EOF and close; the ZIP does not
provide independently replayable wire evidence. Parsed frames and the parent’s
binding/interval checks must not be described as raw-pipe capture. The separate
[Linux parity report](windows-c15-readiness-parity.json) retains its own raw bytes
and does not fill that Windows evidence gap.

## Scope and preserved history

This supports the fixed **hosted synthetic Windows x64** failure/stall protocol
over real Electron/native disk, DPAPI and clock, with semantic/work equality and
captured child-lifecycle overlap. `nativePublish` and `nativeWrite` intercept before
backend dispatch. It does not establish physical interruption, durable-media
failure, Mac/ARM64, second-user isolation, renderer-combined or signed installed-app
acceptance, continuous managed/native accounting, complete execution-graph/network/
credential-call equivalence, or **4 ms responsiveness/renderer Layout acceptance**.
Captured lifecycle overlap includes startup, waits and cleanup; it does not prove
continuous CPU/engine work or exact physical concurrency.

The original two-demo workload, 29/58 gates, all 20 cells, semantic/work oracle,
50-second launch-time CLI deadline, 120-second diagnostic watchdog, elapsed gate,
strict 2-microsecond exclusions and memory budgets remain unchanged. Production
capture/activation stays disabled, Mac remains held, and earlier failed/partial
attempts—including run 4’s early readSetting entry—remain historical failures or
partial results. No merge, activation, dispatch, release, signing, credentials or
security changes are part of this documentation update.
