/** Atomic admission boundary shared by HTTP and socket method dispatch. */
import { statSync } from "node:fs";
import { ProtocolFault, MaintenanceParamsSchema, type MaintenanceParams, type MaintenanceResult } from "@orca/protocol";
import type { MethodTable } from "./methods.js";
export class Maintenance {
  private token: string | undefined;
  constructor(
    token?: string,
    private admissionFile?: string,
  ) {
    this.token = token;
  }
  private active = new Map<symbol, string>();
  change({ action, token }: MaintenanceParams): MaintenanceResult {
    if (this.token && this.token !== token)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Another updater owns admission");
    if (action === "resume") this.token = undefined;
    else if (!this.active.size) this.token = token;
    return { ready: this.token === token, active: [...this.active.values()] };
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
    return result;
  }
}
