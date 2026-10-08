/** Synchronous producer entry and idle fencing; never installs, cancels or replays work. */
import { OrcaError } from "@orca/core";
import type { RuntimeActivityReason } from "@orca/protocol";
export class RuntimeActivity {
  private readonly active = new Map<symbol, RuntimeActivityReason>();
  private token: string | undefined;
  private closed = false;
  private sources: (() => { available: boolean; active: RuntimeActivityReason[] }) | undefined;
  private admissionClosed: (() => boolean) | undefined;
  bind(sources: () => { available: boolean; active: RuntimeActivityReason[] }, admissionClosed: () => boolean): void {
    if (this.sources) throw new OrcaError("RUN_STATE", "Runtime activity already bound");
    this.sources = sources;
    this.admissionClosed = admissionClosed;
  }
  enter(reason: RuntimeActivityReason): () => void {
    if (this.closed || this.token || this.admissionClosed?.())
      throw new OrcaError("RUN_STATE", "Runtime admission is closed");
    const id = Symbol(reason);
    this.active.set(id, reason);
    return () => {
      this.active.delete(id);
    };
  }
  snapshot(): { available: boolean; active: RuntimeActivityReason[] } {
    try {
      const source = this.sources?.();
      return {
        available: !this.closed && source?.available === true,
        active: [...new Set([...this.active.values(), ...(source?.active ?? [])])],
      };
    } catch {
      return { available: false, active: ["unavailable"] };
    }
  }
  prepare(token: string): { held: boolean; active: RuntimeActivityReason[] } {
    if (this.token && this.token !== token) throw new OrcaError("RUN_STATE", "Another updater owns runtime admission");
    const snapshot = this.snapshot();
    if (!snapshot.available || (this.admissionClosed?.() && !this.token))
      return { held: false, active: ["unavailable"] };
    // Reentrant source/admission observations may reserve new work. Recheck
    // producer reservations after every observation and before publishing the fence.
    const active = [...new Set([...snapshot.active, ...this.active.values()])];
    if (active.length) return { held: false, active };
    this.token = token;
    return { held: true, active: [] };
  }
  resume(token: string): void {
    if (!this.token || this.token !== token) throw new OrcaError("RUN_STATE", "Runtime admission owner changed");
    if (!this.snapshot().available) throw new OrcaError("RUN_STATE", "Runtime idle proof unavailable");
    this.token = undefined;
  }
  close(): void {
    this.closed = true;
  }
}
