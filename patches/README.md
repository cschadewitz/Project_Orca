# ACP diagnostic payload protection

`@agentclientprotocol__sdk@2.8.0.patch` removes peer-controlled arguments from two
SDK stderr diagnostics in `dist/core/jsonrpc.js`: failed notifications and unknown
response IDs. (SDK 2.x already narrows the notification log to method, error code and
error message; the patch keeps ORCA's stricter fixed string.) The fixed
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

When upgrading the SDK, port this patch to the new version (or confirm an upstream
equivalent), update the lockfile, and pass the regression above before removing the old
mapping. Do not enable unused-patch allowances merely to make an upgrade install. The
1.8.0 patch targeted `dist/jsonrpc.js`; it was ported to 2.8.0 when the SDK moved to 2.x
(replacing Dependabot PR #799).

Evidence and limits: [8 November investigation](../docs/archive/reviews/2026-11-08-acp-diagnostic-privacy.md).
