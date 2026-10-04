# MCP production preparation contract

This preparation descends from integration commit b4bc23c97fba542a1cb3dcff6b0b0d241f430436. It adds validation schemas, exports, fixtures and this contract only. It installs no handler, grant, capability, transport or production adapter. Native86 fully passed at runtime-identical parent15d639a1; CI378 for the one-file readiness expectation correction remains pending at preparation time. The new observational read implementation still needs independent review. Actual-Cal acceptance remains unverified.

## Shared preparation contract

The integrator owns the preparation commit, containing schemas/type exports and fixtures only. It cannot advertise production handlers. All A/B/C branches start from its exact SHA; no peer-branch imports. This completes existing #327 scope, not an optional feature after claiming #327 complete.

New file `packages/protocol/src/operator-mutations.ts` exports the ten-entry `OperatorMutationContracts` map, `OperatorMutationName`, and inferred `OperatorMutationParams<N>` / `OperatorMutationResult<N>`. Each entry contains `params` and `result` Zod schemas. Shared fixtures live in `packages/protocol/test/fixtures/operator-mutations.ts`; these demonstrate schema shape only and cannot satisfy lifecycle acceptance. Existing barrel exports are integrator-only.

All params are strict objects. `target` is existing OperatorTargetSchema (workspaceId+instanceId). `retry` is strict `{ idempotencyKey: RetryKeySchema }`, required at this MCP edge. Its limit is1–128 UTF-8 bytes, never200 characters. There is no caller principal, credential, lease, execution callback or generated result ID in command input.

| RPC | Exact envelope | Result |
|---|---|---|
| operator.submitRequest | `{ target, command: SubmissionCommandSchema extended with required workflowId/workflowVersion/expectedWorkflowRevision/expectedConfigGeneration, retry }` | real RetryResult of allowlisted SubmissionResult |
| operator.admitRun | `{ target, command: RunsStartParamsSchema without idempotencyKey and with all four guard fields required, retry }` | real RetryResult of allowlisted DirectAdmissionResult |
| operator.admission | `{ target, operationId: AdmissionsGetParamsSchema.shape.operationId }` | real RetryResult of Request/direct result |
| operator.reconcileAdmission | same as admission | same |
| operator.cancel | `{ target, runId, reason?: string(max2000) }` | existing MCP receipt `{ runId, requestId?, asOf }` after real control result |
| operator.answer | `{ target, decision }` retaining the existing strict durable/live union | same receipt after real exact answer |
| operator.continueRun | `{ target, command: ContinuationCommandSchema, retry }` | RunsContinueResultSchema |
| operator.continuation | `{ target, continuationId: ContinuationsGetParamsSchema.shape.continuationId }` | ContinuationReceiptSchema |
| operator.reconcileContinuation | same as continuation | ContinuationReceiptSchema |
| operator.revise | `{ target, command: RevisionCommandSchema, retry }` | RevisionResultSchema |

For direct command shape, derive the four guard fields from the existing direct-admission command's schemas, preserving optional vars/requestId/workItemId and their production validation. Do not broaden `RunsStartParamsSchema` fields opportunistically. Preparation tests must demonstrate equality of accepted fields against the existing DirectAdmissionCommand and reject unknown fields.

RetryResult retains actual operationId, resolved/in-progress state, replayed and nested result. Request results retain requestId; direct results do not invent it. Failure projection exposes stable code and recovery only, deliberately excludes arbitrary message/details. Lookup regexes come from production receipt schemas. Revision payloads reuse nonempty text/UTF-8/JSON/depth validation and declaration-specific runtime validation; no adapter-local relaxed copies. Never construct replayed=false for a flattened response.

## Read mapping: use existing operator.page, no new RPC

Keep OperatorPageParamsSchema and existing tools. Exact-run `collection:"runs", runId` can expose the same server-issued continuation guard as authorized runs.get; exact-run `collection:"inputs", runId` can expose the same pinned revision boundary as inputs.list. No unscoped boundary enrichment. Do not materialize an unrestricted runs.get/inputs.list result and trim it.

The standalone OperatorBoundaryRowSchema validates the following optional fields. OperatorBoundaryPageResultSchema preserves them for consumers; the installed legacy page schema is unchanged in this preparation:

- `continuationState?: "available" | "unsupported" | "unavailable"`
- existing `expectedBoundary?: OperatorIdSchema`, present only with continuationState available
- `revisionState?: "available" | "unsupported" | "unavailable"`
- `revision?: RevisionBoundaryViewSchema`, present only with revisionState available
- `revisionActionId?: string(min1)`, restriction-only from the exact pinned declaration under the existing input-read policy

Available requires the corresponding guard/view; unsupported/unavailable forbids it. No fields means projection not requested or not authorized, never a usable boundary. Unsupported means known unsupported/absent current boundary; unavailable means protected evidence could not be confirmed (including concurrent publication or unverifiable protected evidence), not an empty list. Unexpected journal/store/auth failures propagate through the current authorized read path rather than becoming unsupported. Disclosure of the revision view requires existing current stronger grants (`runs.read`, `inputs.answer`, `runs.control`, resource/workflow scope), rechecked after awaited work. Restriction-only action IDs retain the published weaker input-read policy. A current weak viewer must receive no stronger boundary/schema fields.

New internal projection callback type in OperatorReadOptions, installed per authenticated invocation by B:

`boundaryRow?: (params: OperatorPageParams, row: OperatorRow) => Promise<OperatorRow>`

It is invoked only for already-authorized exact-run runs/inputs rows, after collection resource filtering and before emission/count/cursor decisions. It may only add the allowlisted boundary/restriction fields; input row identity cannot change. The function closes over current credential resolution and existing production read services, never a caller principal. Existing final current-principal/snapshot revision checks remain mandatory. Include resulting boundary identity/state in the page snapshot invalidation mechanism, so a changed boundary cannot silently reuse a cursor or publish mixed results. A owns row schema/consumer plumbing; B supplies the callback from existing continuation.expectedBoundary, revision source readBoundaries and pinned restriction validation. Do not reuse the current optional callback's bare empty array as proof that an omitted observational boundary is unsupported: distinguish the existing service's uncertainty refusal at the composition seam. This is a projection wrapper, not a second authoritative journal.

The exact callback return is deliberately the existing OperatorRow type to avoid cross-package daemon imports. Preparation fixtures must reject identity mutation, cross-run boundary targets, contradictory state/guard pairs and undeclared action IDs. B/C tests must demonstrate service-backed behavior, not only those fixtures.

Pending correction replacement/history tools remain explicitly unsupported in this ten-alias mount. Do not claim the MCP can read protected pending text from a public summary or execute replacement until that separate supported surface is agreed. UI/CLI pending semantics stay intact.

## Receipt and dispatch composition owned by B

Reserved additive model methods for integration:

`RequestSubmissionModel.submitRetry(command: SubmissionCommand, authority: SubmissionAuthority, retry: RetryOptions): Promise<RetryResult<SubmissionResult>>`

`AdmissionRetryModel.admitRetry(command: DirectAdmissionCommand, retry: RetryOptions, authority: DirectAdmissionAuthority): Promise<RetryResult<DirectAdmissionResult>>`

Each preserves the actual service retry envelope and reuses its model's existing guarded start/dispatch path only for resolved accepted results. Legacy submit/admit/runs.start response behavior remains unchanged. No new claim, key scope, invocation lease or parallel dispatch mechanism. New internal daemon `createOperatorMutationMethods(): MethodTable` handlers use authenticated MethodContext dependencies on each call; method installation is conditional on real services/authority factories. Audit uses authenticated actor and allowlisted target/correlation IDs, never raw key/payload/source-supplied actor. Live operator reads must wire existing liveState/liveRevision hooks to the actual coordinator; currently absent hooks correctly report owner-unavailable.


## Ownership and integration

A owns packages/integrations/src/mcp/{contracts,backend,server,transport,index}.ts, packages/protocol/src/operator-reads.ts, packages/daemon/src/operator-read-model.ts, packages/cli/src/commands/mcp.ts, docs/mcp-operator.md, and new tests packages/integrations/test/mcp-operator-production-contract.test.ts, packages/daemon/test/mcp-operator-boundary-projection.test.ts, packages/protocol/test/mcp-operator-mutation-contract.test.ts. A supplies reserved wiring in docs/patches/327-operator-production-mount.patch without applying it. A uses OperatorBoundaryPageResultSchema when real enrichment is mounted; the old result parser would strip new fields. A may extend OperatorReadOptions with the internal callback above, returning OperatorBoundaryRow, and must run OperatorBoundaryProjectionSchema with the trusted pinned declaration before emitting a row.

B remains the parent integrator. B owns new packages/daemon/src/operator-mutations.ts and packages/daemon/test/operator-mutation-{composition,authority}.test.ts, all existing bootstrap/auth/method registries/audit, model receipt-preserving methods, barrel/manifests and CLI composition. B supplies current-authority projection and real mutation adapters. Existing legacy method signatures remain intact.

C owns new packages/integrations/test/mcp-operator-production-{lifecycle,recovery,authority}.test.ts, packages/integrations/test/mcp-operator-production-fixture.ts and docs/mcp-operator-production-acceptance.md. Tests use the actual compiled daemon and MCP transport with synthetic isolated state; absent mounting is an explicit dependency blocker, never replaced by fixture mutation callbacks.

All branches start from the exact published preparation commit. No peer imports or overlapping ownership. Shared preparation schemas change only through coordination with Casey/Cal. Required production evidence covers all ten aliases, current and revoked grants, exact target/resource identity, bounded reads/cursor invalidation, real receipt replay/conflicts, Request/direct identity, root continuation, live owner lifetime, revision provenance/rationale exclusion, safe errors/audit and restart/concurrent writers. Reference transport success does not satisfy actual-Cal acceptance. No main merge, release, deployment, credentials or host-security changes are included.
