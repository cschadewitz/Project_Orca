/**
 * The operation inventory: every method the daemon can answer, the permission it needs, the
 * resource it touches and whether a call is audited. This table *is* the permission matrix in
 * `docs/daemon-security.md`, and `auth-operations.test.ts` holds the two to each other and to
 * every method the protocol package declares.
 *
 * Deny by default. A method that is not in this table is refused with `AUTH_FORBIDDEN` even
 * when a method table answers it, so a method added to `methods.ts` without a line here
 * cannot be reached by anyone until somebody decides who may call it. Reads are not exempt
 * and neither is anything that "only" reports a capability.
 */
import type { Permission } from "./principal.js";

/**
 * What a call is aimed at, which decides how the guard checks it (guard.ts):
 *
 * - `none`: nothing but the operation grant - a process-level or workspace-level method.
 * - `run`: `params.runId` names a run the caller must be able to see.
 * - `run-list`: a list over runs, filtered to what the caller can see, with counts recomputed.
 * - `workflow`: `params[param]` names a workflow the caller's scope must include.
 * - `workflow-list`, `artifact`, `artifact-list`, `input-list`, `claim-list`: lists and lookups
 *   with their own filtering.
 * - `input`: a gate decision - the exact pending request and the run it belongs to.
 * - `claim`: the run holding a claim on `params.workItemId`.
 * - `subscription`: the socket's own subscribe/unsubscribe; notifications are gated one by one.
 * - `search`: a scan across runs (#255). The guard hands the method the caller's read scope,
 *   so hidden runs are never opened and artifacts are read only with `artifacts.read`; it
 *   also filters the hits afterwards, and a named run the caller cannot see answers empty.
 */
export type ResourceKind =
  | "none"
  | "run"
  | "run-list"
  | "workflow"
  | "workflow-list"
  | "artifact"
  | "artifact-list"
  | "input"
  | "input-list"
  | "claim"
  | "claim-list"
  | "subscription"
  | "search";

export interface OperationSpec {
  /** The grant the call needs. `null`: any authenticated principal (hello, unsubscribe). */
  permission: Permission | null;
  /** Additional operation grants, all required before parameter diagnostics and discovery. */
  additionalPermissions?: readonly Permission[];
  resource: ResourceKind;
  /** For `workflow`: which param names the workflow. */
  param?: string;
  /**
   * `mutation` and `decision` calls are written to the audit log with their outcome whether
   * they succeed or fail; every denial is written regardless of this.
   */
  audit?: "mutation" | "decision";
  /** The method is reserved for a story that has not shipped; nothing registers it yet. */
  reserved?: true;
}

/** The method string reserved by #330 for preflight validation of launch inputs. */
export const WORKFLOWS_VALIDATE_INPUTS_OPERATION = "workflows.validateInputs";

export const OPERATIONS: Readonly<Record<string, OperationSpec>> = {
  "scopedPermissions.review": {
    permission: "permissions.grant",
    additionalPermissions: ["inputs.answer"],
    resource: "none",
  },
  "scopedPermissions.choose": { permission: "inputs.answer", resource: "none", audit: "decision" },
  "scopedPermissions.inspect": { permission: "permissions.grant", resource: "none" },
  "scopedPermissions.cancel": { permission: "inputs.answer", resource: "none" },
  hello: { permission: null, resource: "none" },
  "operator.discover": { permission: null, resource: "none" },
  // The closed collection discriminant selects a grant; OperatorReadModel checks it before diagnostics.
  "operator.page": { permission: null, resource: "none" },
  "operator.hostResources": { permission: "host.telemetry.read", resource: "none" },
  "operator.config": { permission: "config.read", resource: "none" },
  "operator.preflight": { permission: "runs.start", resource: "none" },
  "operator.artifact": { permission: "artifacts.read", resource: "run" },

  // Authenticated production services retain current grant and exact-resource checks.
  // cancel/answer adapt into the existing guarded control methods after target validation.
  "operator.submitRequest": {
    permission: "runs.start",
    additionalPermissions: ["plan.write"],
    resource: "none",
    audit: "mutation",
  },
  "operator.admitRun": { permission: "runs.start", resource: "none", audit: "mutation" },
  "operator.admission": { permission: "runs.start", resource: "none" },
  "operator.reconcileAdmission": { permission: "runs.start", resource: "none", audit: "mutation" },
  "operator.cancel": { permission: "runs.control", resource: "none", audit: "mutation" },
  "operator.answer": { permission: "inputs.answer", resource: "none", audit: "decision" },
  "operator.continueRun": { permission: "runs.control", resource: "none", audit: "mutation" },
  "operator.continuation": { permission: "runs.read", resource: "none" },
  "operator.reconcileContinuation": { permission: "runs.control", resource: "none", audit: "mutation" },
  "operator.revise": {
    permission: "inputs.answer",
    additionalPermissions: ["runs.control"],
    resource: "none",
    audit: "decision",
  },

  "runs.list": { permission: "runs.read", resource: "run-list" },
  "runs.get": { permission: "runs.read", resource: "run" },
  "runs.events": { permission: "runs.read", resource: "run" },
  "runs.recovery": { permission: "runs.read", resource: "run" },
  "runs.dryRunReport": { permission: "runs.read", resource: "run" },
  search: { permission: "runs.read", resource: "search" },
  // Exact target checks live in the authenticated revision service, including after the input closes.
  "inputs.revise": { permission: "inputs.answer", resource: "none", audit: "decision" },
  "inputs.replaceRevision": { permission: "inputs.answer", resource: "none", audit: "mutation" },
  "inputs.revisionPending": { permission: "runs.read", resource: "none" },
  "inputs.list": { permission: "runs.read", resource: "input-list" },
  "claims.list": { permission: "runs.read", resource: "claim-list" },
  "artifacts.list": { permission: "artifacts.read", resource: "artifact-list" },
  "artifacts.get": { permission: "artifacts.read", resource: "artifact" },
  "workflows.list": { permission: "workflows.read", resource: "workflow-list" },
  "workflows.get": { permission: "workflows.read", resource: "workflow", param: "id" },
  [WORKFLOWS_VALIDATE_INPUTS_OPERATION]: {
    permission: "runs.start",
    resource: "workflow",
    param: "workflowId",
    reserved: true,
  },

  "requests.submit": { permission: "plan.write", resource: "none", audit: "mutation" },
  "requests.reconcile": { permission: "plan.write", resource: "none", audit: "mutation" },
  "requests.admission": { permission: "plan.write", resource: "none" },
  "requests.admissions": { permission: "plan.write", resource: "none" },
  "runs.admit": { permission: "runs.start", resource: "workflow", param: "workflowId", audit: "mutation" },
  "runs.continue": { permission: "runs.control", resource: "none", audit: "mutation" },
  "continuations.get": { permission: "runs.read", resource: "none" },
  "continuations.reconcile": { permission: "runs.control", resource: "none", audit: "mutation" },
  "admissions.get": { permission: "runs.start", resource: "none" },
  "admissions.find": { permission: "runs.start", resource: "none" },
  "admissions.fence": {
    permission: "runs.start",
    resource: "workflow",
    param: "workflowId",
    audit: "mutation",
  },
  "admissions.reconcile": { permission: "runs.start", resource: "none", audit: "mutation" },
  "runs.start": { permission: "runs.start", resource: "workflow", param: "workflowId", audit: "mutation" },
  "runs.resume": { permission: "runs.control", resource: "run", audit: "mutation" },
  "runs.cancel": { permission: "runs.control", resource: "run", audit: "mutation" },
  "runs.reviewEffect": { permission: "runs.control", resource: "run", audit: "mutation" },
  // A checkpoint attempt is a new run of the source's workflow: the admission authority also
  // checks that workflow (and request/work item) like runs.admit, and the engine that the
  // caller started the source.
  "runs.recover": { permission: "runs.start", resource: "run", audit: "mutation" },
  // `always` additionally needs `permissions.grant`; the guard checks it before anything else.
  "inputs.answer": { permission: "inputs.answer", resource: "input", audit: "decision" },
  "claims.release": { permission: "claims.release", resource: "claim", audit: "mutation" },

  "templates.get": { permission: "config.read", resource: "none" },
  "templates.history": { permission: "config.read", resource: "none" },
  "templates.validate": { permission: "config.read", resource: "none" },
  "templates.preview": { permission: "config.read", resource: "none" },
  "templates.variant": { permission: "config.write", additionalPermissions: ["config.read"], resource: "none" },
  "templates.save": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  "templates.assign": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  "templates.publish": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  // Workflow drafts (#180) edit workflow files under the configuration directory: reading one
  // is a configuration read, and opening, editing and publishing one are configuration writes.
  "workflowDrafts.get": { permission: "config.read", resource: "none" },
  "workflowDrafts.open": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  "workflowDrafts.apply": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  "workflowDrafts.undo": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  "workflowDrafts.redo": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  "workflowDrafts.review": { permission: "config.write", additionalPermissions: ["config.read"], resource: "none" },
  "workflowDrafts.publish": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  // A dry run (#183) simulates the caller's draft and leaves a run tree behind: a draft write
  // that also needs the grant to start runs.
  "workflowDrafts.dryRun": {
    permission: "config.write",
    additionalPermissions: ["config.read", "runs.start"],
    resource: "workflow",
    param: "workflowId",
    audit: "mutation",
  },
  "workflowDrafts.discard": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  "config.get": { permission: "config.read", resource: "none" },
  "config.apply": { permission: "config.write", resource: "none", audit: "mutation" },
  // Every Save/validation receipt includes unredacted document bytes, even for an empty patch.
  "config.set": {
    permission: "config.write",
    additionalPermissions: ["config.read"],
    resource: "none",
    audit: "mutation",
  },
  // Protocol 2.12 (#701): a saved plain-language rule is standing permission policy.
  "permissions.saveJudgedRule": {
    permission: "permissions.grant",
    // config.read too: the answer says whether an equal rule is on file, where and until when.
    additionalPermissions: ["config.write", "config.read"],
    resource: "none",
    audit: "mutation",
  },

  "plans.list": { permission: "plan.read", resource: "none" },
  "plan.get": { permission: "plan.read", resource: "none" },
  "items.list": { permission: "plan.read", resource: "none" },
  "schedule.get": { permission: "plan.read", resource: "none" },
  "schedule.explain": { permission: "plan.read", resource: "none" },
  "dependencies.list": { permission: "plan.read", resource: "none" },
  "risks.list": { permission: "plan.read", resource: "none" },
  "decisions.list": { permission: "plan.read", resource: "none" },
  "journal.list": { permission: "plan.read", resource: "none" },
  "dependencies.waive": { permission: "plan.write", resource: "none", audit: "decision" },
  "decisions.decide": { permission: "plan.write", resource: "none", audit: "decision" },
  "decisions.reopen": { permission: "plan.write", resource: "none", audit: "decision" },
  "risks.update": { permission: "plan.write", resource: "none", audit: "decision" },

  "agents.list": { permission: "agents.read", resource: "none" },
  "agents.ping": { permission: "agents.ping", resource: "none", audit: "mutation" },

  // Secret reference metadata (#336): never a value; filtered to the caller's grant.
  "secrets.list": { permission: "secrets.read", resource: "none" },
  "secrets.check": { permission: "secrets.read", resource: "none" },

  // Store-wide subscriptions are open to any principal: each notification is gated on its own
  // (guard.ts `notificationGate`). A run-scoped one needs `runs.read` and the run.
  subscribe: { permission: null, resource: "subscription" },
  // A subscription id is only ever looked up on the caller's own connection.
  unsubscribe: { permission: null, resource: "subscription" },

  maintenance: { permission: "daemon.maintenance", resource: "none", audit: "mutation" },
  "maintenance.runtime": { permission: "daemon.maintenance", resource: "none", audit: "mutation" },
};

/**
 * The capabilities `hello` advertises, and the grant each needs before a principal is told
 * about it. A capability not listed here is shown to a principal holding every permission
 * and to nobody else.
 */
export const CAPABILITY_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  "operator.discover": [
    "host.telemetry.read",
    "runs.read",
    "artifacts.read",
    "workflows.read",
    "runs.start",
    "config.read",
    "plan.read",
  ],
  "operator.page": ["runs.read", "artifacts.read", "workflows.read", "config.read", "plan.read"],
  "operator.hostResources": ["host.telemetry.read"],
  "operator.config": ["config.read"],
  "operator.preflight": ["runs.start"],
  "operator.artifact": ["artifacts.read"],
  "inputs.revise": ["inputs.answer"],
  "inputs.replaceRevision": ["inputs.answer"],
  "inputs.revisionPending": ["runs.read"],
  "runs.admit": ["runs.start"],
  "runs.continue": ["runs.control"],
  "continuations.get": ["runs.read"],
  "continuations.reconcile": ["runs.control"],
  "admissions.get": ["runs.start"],
  "admissions.reconcile": ["runs.start"],
  "inputs.live": ["inputs.answer"],
  "runs.read": ["runs.read"],
  "runs.subscribe": ["runs.read"],
  // The app derives "can write" from this one capability (`useWritability`), so it is shown
  // to a principal that can make any run write at all; each method is still checked.
  "runs.control": ["runs.control", "runs.start", "inputs.answer", "claims.release"],
  "plan.read": ["plan.read"],
  "plan.write": ["plan.write"],
  "workflows.validateInputs": ["runs.start"],
};
