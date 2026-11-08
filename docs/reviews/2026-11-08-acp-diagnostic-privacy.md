# ACP SDK diagnostic privacy canary — 8 November 2026

Investigated current main `bdf0360aa89ea18f65b3e02f677cdcc224a2396c` in an isolated
worktree, with Node 24.21.0, pnpm 12.4.2 and the frozen dependency graph's SDK
1.8.0. The older preinstalled checkout had SDK 1.5.0 and was not used as runtime
evidence. Existing work and the edited SDK upgrade PR #799 were left untouched.

The synthetic canary confirms SDK diagnostics can bypass the execution logger in
both applicable ORCA ACP roles. It does not establish a real-world disclosure.
No real secrets, existing user logs, provider credentials, live providers,
production data, release or deployment were used.

## Cases and observations

The probe uses `openAcpSession` for ORCA as an ACP client and `serveAcpFacade` for
ORCA as an ACP agent. Its deterministic downstream process and facade cancel
handler inject four different public synthetic markers. Each marker is also a
separately declared sensitive workflow input, so exact-value redaction is tested
without assuming protection for transformed or fragmented secrets.

| Marker source | Unpatched 1.8.0, both roles | Patched 1.8.0, both roles |
| --- | --- | --- |
| Object lacking request/notification/response shape | Absent from stderr; validator returns `-32600` | Same rejection and no stderr payload |
| Failed notification's `_meta` field | Present in stderr, daemon callback and retained tail | Absent from all three |
| Synthetic handler's `RequestError` message/data | Present in stderr, daemon callback and retained tail | Absent from all three |
| Unknown response ID | Present in stderr, daemon callback and retained tail | Absent from all three |

The source contains raw-object `Invalid message` logging, but the current stdio
wire validator rejects the tested malformed objects before that branch. That
source finding is not evidence of raw-object logging through these ORCA paths.
Notification logging passes an object to Node's console inspector; not every
nested value is printed in full. The canary deliberately places its notification
marker at a visible depth, separately from the thrown-error marker.

Before the fix the two regression cases fail with notification, error and unknown
ID markers present in all three stderr-derived observations. The execution logger,
public run state/read view, live/replayed notifications and facade update stream
contain none of the markers. After the fix both regression cases pass; those
existing protections remain intact. Authoritative execution inputs remain exact,
public sensitive vars remain visibly `[REDACTED]`, and the execution logger still
emits redacted output.

Invalid requests still return `-32602`, invalid notification parameters never
invoke the target handler, and the invalid file request never reaches host file
I/O. The legitimate synthetic run completes after the controlled handler failure.
Fixed SDK diagnostic categories and an unrelated stderr control still appear in
stderr, the callback and the retained tail. Nothing globally mutes console output.

Each role has an eight-second owned-child watchdog, a twelve-second test limit
and a 64 KiB stderr cap; the downstream fixture has its own five-second deadline.
Tests use memory stores and isolated processes with an allowlisted environment.
The daemon's real output retention code is exercised with a synthetic spawn and
readiness seam. This is not an Electron UI run, a production daemon session, or an
installed release-artifact acceptance test. The main application's `onLog` wiring
to `console.error` is source evidence; the callback and retained tail are runtime
observations. The freshly built production daemon bundle was inspected and has
only the static forms of the two patched diagnostics.

## Fix and validation

The version-specific pnpm patch removes only the arguments to
`console.error("Error handling notification", ...)` and
`console.error("Got response to unknown request", ...)` in `dist/jsonrpc.js`.
The diagnostic strings, schema validation, dispatch, error conversion and wire
responses remain unchanged. Patch SHA-256:
`f3364b5c43195735c61bf9911b0fad8ed1883cf38ad0caf4a355c1c5c6d7beec`.
The lockfile applies it to agents, engine tests, integrations and testing helpers.
No dependency version changes.

Validated a frozen install, TypeScript checking, application/renderer build,
daemon bundle build, formatting and scoped lint. The consumer/protection suite
passed 1,455 tests with two existing skips across 70 files. Its command was:

```sh
pnpm exec vitest run packages/agents/test packages/integrations/test packages/testing/test \
  packages/engine/test/protected-execution-inputs.test.ts \
  packages/daemon/test/security-sensitive-integration.test.ts \
  packages/app/test/daemon-process.test.ts --maxWorkers=2
```

The new two-role regression passed independently with the test child bundle and
with the existing direct-source fallback mode:

```sh
pnpm exec vitest run packages/integrations/test/acp-diagnostic-privacy.test.ts
ORCA_TEST_BUNDLES=0 pnpm exec vitest run packages/integrations/test/acp-diagnostic-privacy.test.ts
```

## Coordination and remaining scope

[#363](https://github.com/cschadewitz/Project_Orca/issues/363) stays open. This fixes
one confirmed diagnostic bypass and preserves its existing protected-execution
foundation; it does not implement the remaining secret-reference contract or
prove universal protection for arbitrary stderr or transformed agent output.

The edited [#799](https://github.com/cschadewitz/Project_Orca/pull/799) was observed
at `00f2b633f36b39118a3825eae92f390af61db220` and was not changed. Source inspection
of the published SDK 2.0.2 tarball found the same two calls at
`dist/core/jsonrpc.js:791` and `:851`. Tarball SHA-256:
`340d830a286d1c36a9d6d839c57d3f3c65efa72978d6dee79a6b372d0604f206`.
That is source evidence, not a 2.0 runtime canary result. Upgrade reconciliation
must port the patch to that version/path or adopt an equivalent upstream fix and
pass the same regression. Do not silently drop the protection or suppress unused
patch errors. No merge, issue closure, release or deployment is established by
this local investigation.
