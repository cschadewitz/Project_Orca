# ACP diagnostic payload protection

`@agentclientprotocol__sdk@1.8.0.patch` removes peer-controlled arguments from two
SDK stderr diagnostics: failed notifications and unknown response IDs. The fixed
diagnostic strings still appear. There is no process-wide console interception,
and no change to validation, dispatch, error conversion, responses or closure.
pnpm applies the hash-pinned patch to all four locked SDK consumers, including the
daemon bundle. A frozen install must preserve this mapping.

The bounded regression is
`packages/integrations/test/acp-diagnostic-privacy.test.ts`. It exercises the actual
ORCA client and facade in disposable subprocesses, checks protocol rejection and
protected projections, and observes real stderr through the production bundled
daemon's output callback and retained exit tail. All inputs are synthetic.

This is related to [#363](https://github.com/cschadewitz/Project_Orca/issues/363),
which remains open for its wider launch secret-reference and supported-surface
acceptance work. The patch is not a general redaction guarantee for stderr.

Do not lose the protection when reconciling the existing edited
[SDK upgrade PR #799](https://github.com/cschadewitz/Project_Orca/pull/799). Its
published SDK 2.0.2 dependency still contains both payload-bearing calls in
`dist/core/jsonrpc.js`; this version-specific 1.8.0 patch targets
`dist/jsonrpc.js`. Port it or use an upstream equivalent, update the lockfile, and
pass the same two-role canary before removing the 1.8.0 patch mapping. Do not enable
unused-patch allowances merely to make the upgrade install. The #799 branch was
not changed by this investigation.

Evidence and limits: [8 November investigation](../docs/reviews/2026-11-08-acp-diagnostic-privacy.md).
