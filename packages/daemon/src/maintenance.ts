/** Atomic admission boundary shared by HTTP and socket method dispatch. */
import { statSync } from "node:fs";
import { ProtocolFault, MaintenanceParamsSchema, type MaintenanceParams, type MaintenanceResult } from "@orca/protocol";
import {
  MAINTENANCE_RUNTIME_METHOD,
  RuntimeMaintenanceRequestSchema,
  type RuntimeDrainParams,
  type RuntimeDrainResult,
  type RuntimeMaintenanceParams,
  type RuntimeMaintenanceResult,
} from "@orca/protocol";
import type { RuntimeActivity } from "./runtime-activity.js";
import type { MethodTable } from "./methods.js";
export class Maintenance {
  private token: string | undefined;
  private runtimeOwner = false;
  private draining = false;
  private drainVerified = false;
  private drainGeneration = 0;
  private handlerRevision = 0;
  private drainOperation: Promise<RuntimeDrainResult> | undefined;
  private inventory:
    | {
        revision: number;
        handlers: number;
        operation: Promise<Pick<RuntimeDrainResult, "unfinished" | "truncated">>;
      }
    | undefined;
  constructor(
    token?: string,
    private admissionFile?: string,
    private runtime?: {
      activity: RuntimeActivity;
      target: RuntimeMaintenanceParams["target"];
      unfinished?: () => Promise<Pick<RuntimeDrainResult, "unfinished" | "truncated">>;
    },
    private readonly newAdmissionOpen?: () => boolean,
    private readonly existingWorkOpen?: () => boolean,
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
    return Boolean(this.token) || this.externallyClosed() || this.durableAdmissionClosed();
  }
  private durableAdmissionClosed(): boolean {
    try {
      return this.newAdmissionOpen !== undefined && this.newAdmissionOpen() !== true;
    } catch {
      return true;
    }
  }
  /** Draining closes new admissions while retaining the producers needed to finish existing work. */
  existingWorkClosed(): boolean {
    return Boolean(this.token && !this.draining) || this.externallyClosed() || this.durableExistingWorkClosed();
  }
  private durableExistingWorkClosed(): boolean {
    try {
      return this.existingWorkOpen !== undefined && this.existingWorkOpen() !== true;
    } catch {
      return true;
    }
  }
  private runtimeChange(
    params: RuntimeMaintenanceParams | RuntimeDrainParams,
  ): RuntimeMaintenanceResult | Promise<RuntimeDrainResult> {
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
    if (params.action === "drain" || params.action === "defer") return this.drainChange(params, runtime);
    if (this.externallyClosed()) return { ...proof, outcome: "blocked", active: ["unavailable"] };
    if (params.action === "resume") {
      if (this.draining) throw new ProtocolFault("PROTOCOL_MESSAGE", "Use defer to release a drain");
      if (!this.runtimeOwner) throw new ProtocolFault("PROTOCOL_MESSAGE", "Runtime admission owner changed");
      runtime.activity.resume(params.token);
      this.runtimeOwner = false;
      this.drainVerified = false;
      this.token = undefined;
      return { ...proof, outcome: "released", active: [] };
    }
    if (this.draining)
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Drain must prove quiescence before idle preparation");
    if (this.token && !this.runtimeOwner) return { ...proof, outcome: "blocked", active: ["unavailable"] };
    if (this.active.size) return { ...proof, outcome: "blocked", active: ["rpc"] };
    const result = runtime.activity.prepare(params.token);
    if (!result.held) return { ...proof, outcome: "blocked", active: result.active };
    this.token = params.token;
    this.runtimeOwner = true;
    return { ...proof, outcome: "held", active: [] };
  }
  private async drainChange(
    params: RuntimeDrainParams,
    runtime: NonNullable<Maintenance["runtime"]>,
  ): Promise<RuntimeDrainResult> {
    const proof = {
      proof: "runtime-drain-v1" as const,
      target: { ...runtime.target },
      unfinished: [],
      truncated: false,
    };
    if (this.externallyClosed()) return { ...proof, outcome: "blocked", active: ["unavailable"] };
    if (params.action === "defer") {
      if (!this.runtimeOwner || !this.draining)
        throw new ProtocolFault("PROTOCOL_MESSAGE", "Only a draining owner can defer; idle admission uses resume");
      runtime.activity.resume(params.token);
      this.drainGeneration++;
      this.drainOperation = undefined;
      this.draining = false;
      this.runtimeOwner = false;
      this.drainVerified = false;
      this.token = undefined;
      return { ...proof, outcome: "released", active: runtime.activity.snapshot().active };
    }
    const alreadyHeld = this.runtimeOwner && !this.draining;
    // An old idle-only lease did not inventory parked work; it cannot gain drain proof by relabeling.
    if (alreadyHeld && !this.drainVerified) return { ...proof, outcome: "blocked", active: ["unavailable"] };
    if (!runtime.unfinished || (this.token && !this.runtimeOwner) || !runtime.activity.beginDrain(params.token))
      return { ...proof, outcome: "blocked", active: ["unavailable"] };
    this.token = params.token;
    this.runtimeOwner = true;
    if (alreadyHeld) {
      const prepared = runtime.activity.prepare(params.token);
      return { ...proof, outcome: prepared.held ? "held" : "blocked", active: prepared.active };
    }
    this.draining = true;
    if (this.drainOperation) return this.drainOperation;
    const generation = this.drainGeneration;
    const operation = (async (): Promise<RuntimeDrainResult> => {
      const snapshot = runtime.activity.snapshot();
      const active = [...new Set([...snapshot.active, ...(this.active.size ? ["rpc" as const] : [])])];
      if (!snapshot.available) return { ...proof, outcome: "draining", active: ["unavailable"] };
      if (active.length) return { ...proof, outcome: "draining", active };
      // Bound each observation without cancelling a reader or launching duplicate stuck reads.
      const inventory = this.inventory ?? {
        revision: runtime.activity.revision,
        handlers: this.handlerRevision,
        operation: Promise.resolve()
          .then(() => runtime.unfinished!())
          .catch(() => ({ unfinished: [], truncated: true })),
      };
      if (!this.inventory) {
        this.inventory = inventory;
        void inventory.operation.then(() => {
          if (this.inventory === inventory) this.inventory = undefined;
        });
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const work = await Promise.race([
        inventory.operation,
        new Promise<Pick<RuntimeDrainResult, "unfinished" | "truncated">>((resolve) => {
          deadline = setTimeout(() => resolve({ unfinished: [], truncated: true }), 1000);
        }),
      ]).finally(() => clearTimeout(deadline));
      if (this.drainGeneration !== generation || this.token !== params.token || !this.draining)
        throw new ProtocolFault("PROTOCOL_MESSAGE", "Drain changed while observing unfinished work");
      if (work.unfinished.length || work.truncated)
        return { ...proof, ...work, outcome: "draining", active: work.truncated ? ["unavailable"] : [] };
      if (this.externallyClosed()) return { ...proof, outcome: "draining", active: ["unavailable"] };
      if (inventory.handlers !== this.handlerRevision || this.active.size)
        return { ...proof, outcome: "draining", active: ["rpc"] };
      const prepared = runtime.activity.prepare(params.token, inventory.revision);
      if (!prepared.held) return { ...proof, outcome: "draining", active: prepared.active };
      this.draining = false;
      this.drainVerified = true;
      return { ...proof, outcome: "held", active: [] };
    })();
    this.drainOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.drainOperation === operation) this.drainOperation = undefined;
    }
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
      const newAdmission = [
        "runs.start",
        "runs.admit",
        "requests.submit",
        "operator.admitRun",
        "operator.submitRequest",
      ].includes(name);
      result[name] = {
        ...method,
        handle: async (params, ctx) => {
          if (
            (this.token && (!this.draining || newAdmission)) ||
            this.externallyClosed() ||
            this.durableExistingWorkClosed() ||
            (newAdmission && this.durableAdmissionClosed())
          )
            throw new ProtocolFault("PROTOCOL_MESSAGE", "Update admission is closed; retry later");
          const id = Symbol(name);
          this.active.set(id, name);
          this.handlerRevision++;
          try {
            return await method.handle(params, ctx);
          } finally {
            this.active.delete(id);
            this.handlerRevision++;
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
        params: RuntimeMaintenanceRequestSchema,
        handle: (params) => this.runtimeChange(params as RuntimeMaintenanceParams | RuntimeDrainParams),
      };
    return result;
  }
}
