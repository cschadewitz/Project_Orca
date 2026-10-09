/** Optional authoring dispatch uses existing config authority and generation availability. */
import { OrcaError } from "@orca/core";
import { TEMPLATE_METHOD_CONTRACTS } from "@orca/protocol";
import type { MethodContext, MethodTable } from "./methods.js";
function service(ctx: MethodContext) {
  if (!ctx.config?.canApply || !ctx.identity)
    throw new OrcaError(
      "NOT_SUPPORTED",
      "Template authoring requires a workspace identity and configuration generations.",
    );
  // Explicit legacy loopback transport is owner-authorized; authenticated calls always receive the guard's seam.
  const authority = ctx.configurationAuthority ?? (async () => {});
  return {
    model: ctx.config.templates,
    target: ctx.identity,
    read: () => authority(false),
    write: () => authority(true),
  };
}
export function templateMethods(writable: boolean): MethodTable {
  const contracts = TEMPLATE_METHOD_CONTRACTS;
  const table: MethodTable = {
    "templates.get": {
      params: contracts["templates.get"].params,
      handle: (_params, ctx) => {
        const s = service(ctx);
        return s.model.read(s.target, s.read);
      },
    },
    "templates.history": {
      params: contracts["templates.history"].params,
      handle: (params, ctx) => {
        const s = service(ctx);
        checkTarget(params.target, s.target);
        return s.model.history(params.key, s.target, s.read);
      },
    },
    "templates.validate": {
      params: contracts["templates.validate"].params,
      handle: (candidate, ctx) => {
        const s = service(ctx);
        checkTarget(candidate.target, s.target);
        return s.model.validate(candidate, s.read);
      },
    },
    "templates.preview": {
      params: contracts["templates.preview"].params,
      handle: (params, ctx) => {
        const s = service(ctx);
        checkTarget(params.target, s.target);
        if (params.candidate) checkTarget(params.candidate.target, s.target);
        return s.model.preview(params, s.read);
      },
    },
  };
  if (writable)
    Object.assign(table, {
      "templates.variant": {
        params: contracts["templates.variant"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          checkTarget(params.target, s.target);
          return s.model.variant(params, s.write);
        },
      },
      "templates.save": {
        params: contracts["templates.save"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          checkTarget(params.candidate.target, s.target);
          return s.model.save(params.candidate, params.candidateRevision, s.write);
        },
      },
      "templates.assign": {
        params: contracts["templates.assign"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          checkTarget(params.target, s.target);
          return s.model.assign(params, s.write);
        },
      },
      "templates.publish": {
        params: contracts["templates.publish"].params,
        handle: (params, ctx) => {
          const s = service(ctx);
          checkTarget(params.target, s.target);
          return s.model.publish(params, s.write);
        },
      },
    } satisfies MethodTable);
  return table;
}
function checkTarget(
  a: { workspaceId: string; instanceId: string },
  b: { workspaceId: string; instanceId: string },
): void {
  if (a.workspaceId !== b.workspaceId || a.instanceId !== b.instanceId)
    throw new OrcaError("CONFIG_STALE", "Template target changed.");
}
