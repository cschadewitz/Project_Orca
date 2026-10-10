# Native diagnostics foundation — 8 October first slice

Base: merged #470, main `db579fb7ac9cfce2e4e6901713088a80602311da`.
This is implementation preparation for open #416/#469, not native acceptance or
permission to activate capture. The existing Config studio DiagnosticsSection,
controller, encrypted format, consent fences and report vocabulary are reused.

## Implemented boundary

- `native/diagnostics/clock.c` is a small Node-API 8 addon. On macOS it reads
  `mach_continuous_time`, converts ticks with the native timebase using a 128-bit
  intermediate, and reads `kern.bootsessionuuid` into a fixed 37-byte buffer.
  Read/conversion failure returns unavailable. There is no wall-clock fallback,
  child process, file read, logging or network operation. Boot identity stays private.
- `native-clock.ts` loads only the fixed local addon location. Capability mismatch,
  absence and unsupported platforms refuse reads. It copies primitive observations
  and permanently latches missing/invalid readings, exceptions, elapsed rollback or
  changed boot identity for that clock instance. It never calls field accessors or
  serializes a native object.
- `daemon-process.ts` now offers an optional startup observer. The actual spawn,
  pre-handshake exit and deadline branches emit exactly one closed category per
  failed attempt. No output, message, stack, endpoint, path or credential reaches
  that observer. Successful startup and post-handshake exits produce no startup
  failure. Observer exceptions cannot alter startup retries or outcomes.
- `startup-producer.ts` maps only those categories to the existing controller's
  `record` method. The controller remains the consent, production-enabled, clock
  and resource fence. No queue, retained source object or retroactive replay is added.

The clock APIs follow [Apple's continuous-clock implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/clock.c)
and [read-only boot-session sysctl](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c).
The ABI uses [Node-API](https://nodejs.org/download/release/v24.21.0/docs/api/n-api.html).
These are source/API evidence; actual supported OS/device conformance remains required.

## Build and portable evidence

The addon has an explicit `binding.gyp`; ordinary installation/build/package does
not build or activate it. With an already installed node-gyp and verified headers:

```sh
node /path/to/node-gyp/bin/node-gyp.js rebuild \
  --directory packages/app/native/diagnostics \
  --nodedir=/path/to/verified/node-headers
```

Use Node 24.21.0/pnpm 12.4.2 in this cloud lane and a frozen dependency install.
The 535-entry supply-chain policy passed. Node 24.21.0 headers were checked against
the official release SHASUMS256 entry; headers archive SHA-256:
`57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2`.
The Linux addon compiled/loaded with node-gyp 12.3.0 and correctly advertised
unsupported/suspendInclusive=false and returned unavailable on repeated reads.
That is ABI/refusal evidence, not compilation or execution of the Darwin branch.

Focused portable tests exercise copied clock authority, suspend-sized synthetic
increments, missing/invalid readings, boot replacement, rollback, native exceptions,
unsupported/capability refusal, production C conversion overflow/rounding boundaries,
actual startup branches, exception isolation, current consent and disabled capture.
The C arithmetic check compiles the actual conversion header on Linux/macOS; Windows
does not run that compiler fixture. TypeScript clock and process tests are portable.
Linux disk/controller tests use disposable profiles, synthetic key protection and the
existing Linux no-replace helper. None proves Keychain, DPAPI or native storage.

The initial 49-test run had one assertion failure: it expected disabled production to
refuse saving an opt-in setting. The reviewed controller deliberately remembers that
setting while reporting unavailable. The test was corrected to require remembered
consent with productionEnabled=false, rejected records and unavailable preview;
no product behavior was changed to satisfy it. Historical #470 CI failures and limits
remain in that PR's evidence; this slice does not relabel them as successful.

## Integration order and remaining gates

1. Root coordinates `main/index.ts` with the updater lane. A later exact-head wiring
   change can bind `onStartupDiagnostic: startupDiagnosticObserver(controller)` and
   select the native clock after app readiness. This slice leaves that shared file
   untouched and the production flag false. The current package allowlist does not
   include the addon: architecture-specific build, packaged location and Electron
   load proof are a later explicit integration step, not inferred from Node loading.
2. Implement native filesystem authority through opened, identity-checked directories
   and handle-relative operations. The current NodeRecoveryDisk uses path operations;
   replacing just its adapter's path checks would not establish parent-swap safety.
   Preserve the encrypted format and controller while introducing the smallest
   necessary filesystem seam. Keep the refusing production factory until that port
   actually covers enumeration, reads, writes, replacement, cleanup and publication.
3. Verify macOS build/load on the actual supported architectures and packaged Electron.
   A disposable clock-only probe can compare private boot identity across independent
   app processes, observe elapsed continuity across real sleep/wake and wall changes,
   and observe identity replacement across reboot. Publish only sanitized verdicts,
   never raw boot identity. These checks do not require capture to be enabled.
4. Windows remains unavailable. Microsoft's
   [interrupt-time API](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryinterrupttime)
   is a candidate elapsed source; trustworthy same-boot identity and native restart/
   sleep/hibernate behavior are still unverified. Do not substitute boot wall time,
   process uptime or an unreviewed identifier. Native handle/DACL and DPAPI acceptance
   are also outstanding; portable tests do not establish any of these.
5. Add the other producers at their actual owners: fresh connection facts behind
   current connection lifetime checks; admission/resume/protected/run outcomes only
   behind corresponding current resource authority. Do not serialize connection
   snapshots, hello, operator rows, logs or private execution records. Unobserved
   metadata stays unknown. No extra diagnostic RPC probe is authorized.
6. Preserve the 4 ms main-callback target, 8 MiB controlled-payload ceiling, 32 MiB
   combined managed/external-memory acceptance and existing report/disk bounds.
   Native per-read latency, paired execution performance, transient combined memory,
   secure storage, crash durability and physical/packaged UI acceptance are unmeasured.
   No full-suite duplicate, native workflow, deployment or host/security change is
   made here; root owns CI admission and merge. #416/#469 stay open.
