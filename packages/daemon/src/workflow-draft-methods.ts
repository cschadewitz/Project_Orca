/**
 * The `workflowDrafts.*` methods (#180). Like template authoring they sit on the
 * configuration model and its authority: reading a draft is a configuration read, and every
 * other method - opening one included, since it writes a file - is a configuration write,
 * present only when the daemon is writable.
 */
import { OrcaError } from "@orca/core";
import { WORKFLOW_DRAFT_METHOD_CONTRACTS } from "@orca/protocol";
import type { MethodContext, MethodTable } from "./methods.js";
import type { DraftCaller } from "./workflow-drafts.js";

/**
 * The legacy loopback transport has no principal; it is owner-authorized, and its drafts are
 * filed under one fixed owner. An authenticated call always carries the guard's actor.
 */
const LOCAL_OWNER = "local";

function service(ctx: MethodContext): {
  model: NonNullable<MethodContext["config"]>["workflowDrafts"];
  caller: DraftCaller;
} {
  if (!ctx.config?.canApply || !ctx.identity)
    throw new OrcaError("NOT_SUPPORTED", "Workflow drafts require a workspace identity and configuration generations.");
  const authority = ctx.configurationAuthority ?? (async () => {});
  return {
    model: ctx.config.workflowDrafts,
    caller: {
      principalId: ctx.mutationActor?.principalId ?? LOCAL_OWNER,
      read: () => authority(false),
      write: () => authority(true),
    },
  };
}

export function workflowDraftMethods(writable: boolean): MethodTable {
  const contracts = WORKFLOW_DRAFT_METHOD_CONTRACTS;
  const table: MethodTable = {
    "workflowDrafts.get": {
      params: contracts["workflowDrafts.get"].params,
      handle: (params, ctx) => {
        const s = service(ctx);
        return s.model.get(params.workflowId, s.caller);
      },
    },
  };
  if (writable)
    Object.assign(table, {
      "workflowDrafts.open": {
        params: contracts["workflowDrafts.open"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          return s.model.open(params.workflowId, s.caller);
        },
      },
      "workflowDrafts.apply": {
        params: contracts["workflowDrafts.apply"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          return s.model.apply(params, s.caller);
        },
      },
      "workflowDrafts.undo": {
        params: contracts["workflowDrafts.undo"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          return s.model.undo(params, s.caller);
        },
      },
      "workflowDrafts.redo": {
        params: contracts["workflowDrafts.redo"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          return s.model.redo(params, s.caller);
        },
      },
      "workflowDrafts.review": {
        params: contracts["workflowDrafts.review"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          return s.model.review(params, s.caller);
        },
      },
      "workflowDrafts.publish": {
        params: contracts["workflowDrafts.publish"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          return s.model.publish(params, s.caller);
        },
      },
      "workflowDrafts.discard": {
        params: contracts["workflowDrafts.discard"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          return s.model.discard(params, s.caller);
        },
      },
    } satisfies MethodTable);
  return table;
}
