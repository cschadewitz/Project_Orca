/** Atomic admission boundary shared by HTTP and socket method dispatch. */
import { statSync } from "node:fs";
import { ProtocolFault, MaintenanceParamsSchema, type MaintenanceParams, type MaintenanceResult } from "@orca/protocol";
import {
  MAINTENANCE_RUNTIME_METHOD,
  RuntimeMaintenanceParamsSchema,
  type RuntimeMaintenanceParams,
  type RuntimeMaintenanceResult,
} from "@orca/protocol";
import type { RuntimeActivity } from "./runtime-activity.js";
import type { MethodTable } from "./methods.js";
export class Maintenance {
  private token: string | undefined;
  private runtimeOwner = false;
  constructor(
    token?: string,
    private admissionFile?: string,
    private runtime?: { activity: RuntimeActivity; target: RuntimeMaintenanceParams["target"] },
  ) {
    this.token = token;
  }
  private active = new Map<symbol, string>();
  change({ action, token }: MaintenanceParams): MaintenanceResult {
    if (this.runtimeOwner) throw new ProtocolFault("PROTOCOL_MESSAGE", "Runtime admission requires its proof method");
    if (this.token && this.token !== token)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Another updater owns admission");
    if (action === "resume") this.token = undefined;
    else if (!this.active.size) this.token = token;
    return { ready: this.token === token, active: [...this.active.values()] };
  }
  admissionClosed(): boolean {
    return Boolean(this.token) || this.externallyClosed();
  }
  private runtimeChange(params: RuntimeMaintenanceParams): RuntimeMaintenanceResult {
    const runtime = this.runtime;
    if (
      !runtime ||
      params.target.workspaceId !== runtime.target.workspaceId ||
      params.target.instanceId !== runtime.target.instanceId ||
      params.target.processId !== runtime.target.processId
    )
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Runtime target changed");
    if (this.token && this.token !== params.token)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Another updater owns admission");
    const proof = { proof: "runtime-v1" as const, target: { ...runtime.target } };
    if (this.externallyClosed()) return { ...proof, outcome: "blocked", active: ["unavailable"] };
    if (params.action === "resume") {
      if (!this.runtimeOwner) throw new ProtocolFault("PROTOCOL_MESSAGE", "Runtime admission owner changed");
      runtime.activity.resume(params.token);
      this.runtimeOwner = false;
      this.token = undefined;
      return { ...proof, outcome: "released", active: [] };
    }
    if (this.token && !this.runtimeOwner) return { ...proof, outcome: "blocked", active: ["unavailable"] };
    if (this.active.size) return { ...proof, outcome: "blocked", active: ["rpc"] };
    const result = runtime.activity.prepare(params.token);
    if (!result.held) return { ...proof, outcome: "blocked", active: result.active };
    this.token = params.token;
    this.runtimeOwner = true;
    return { ...proof, outcome: "held", active: [] };
  }
  private externallyClosed(): boolean {
    if (!this.admissionFile) return false;
    try {
      statSync(this.admissionFile);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  wrap(table: MethodTable): MethodTable {
    const result = { ...table };
    for (const [name, method] of Object.entries(table)) {
      if (name === "hello" || name === "subscribe" || name === "unsubscribe") continue;
      result[name] = {
        ...method,
        handle: async (params, ctx) => {
          if (this.token || this.externallyClosed())
            throw new ProtocolFault("PROTOCOL_MESSAGE", "Update admission is closed; retry later");
          const id = Symbol(name);
          this.active.set(id, name);
          try {
            return await method.handle(params, ctx);
          } finally {
            this.active.delete(id);
          }
        },
      };
    }
    result["maintenance"] = {
      params: MaintenanceParamsSchema,
      handle: (params) => this.change(params as MaintenanceParams),
    };
    if (this.runtime?.activity.snapshot().available)
      result[MAINTENANCE_RUNTIME_METHOD] = {
        params: RuntimeMaintenanceParamsSchema,
        handle: (params) => this.runtimeChange(params as RuntimeMaintenanceParams),
      };
    return result;
  }
}
