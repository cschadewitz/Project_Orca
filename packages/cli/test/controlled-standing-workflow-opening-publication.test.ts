/** Opening-publication and pending-grant scenarios of the fresh standing workflow.
 * Split out of controlled-standing-workflow.test.ts so the scenarios run beside each other, not in sequence.
 */
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores, FileExecutionStore, ProtectedEventStore } from "@orca/store";
import { LiveHumanInput } from "@orca/engine";
import { runControlledOwnedReadTest } from "./controlled-owned-read-producer-expanded.js";
import { bootstrap, supervisor } from "./controlled-standing-workflow-fixture.js";

it.each([1, 2] as const)(
  "opening publication %s settles before independent private writes start",
  async (ordinal) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    Object.assign(c.options, { ownerDurationMs: 300000, pendingSaveIntent: true });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const append = ProtectedEventStore.prototype.append;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const put = FileExecutionStore.prototype.putPayload;
    let openings = 0;
    const writes: string[] = [];
    const appendSpy = vi.spyOn(ProtectedEventStore.prototype, "append").mockImplementation(async function (
      this: ProtectedEventStore,
      input,
    ) {
      const event = await Reflect.apply(append, this, [input]);
      if (input.type === "step.waiting" && ++openings === ordinal) {
        entered();
        await gate;
      }
      return event;
    });
    const putSpy = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(function (
      this: FileExecutionStore,
      ref,
      input,
    ) {
      if (input.type === "agent.update") writes.push(input.payload.update.kind);
      return Reflect.apply(put, this, [ref, input]);
    });
    const running = runControlledOwnedReadTest(c.base, "connected", c.options);
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error("Opening gate was not reached");
        }),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(writes.filter((kind) => kind === "controlled-baseline-v1").length).toBe(ordinal === 1 ? 0 : 1);
      expect(writes.includes("controlled-deferred-intent-v1")).toBe(false);
      expect(writes.includes("controlled-final-delivery-ack-v1")).toBe(false);
      expect(c.observed.length).toBe(0);
      release();
      const result = await running;
      expect(result.receipts.length).toBe(2);
      expect(writes.filter((kind) => kind === "controlled-baseline-v1").length).toBe(1);
      expect(writes.filter((kind) => kind === "controlled-deferred-intent-v1").length).toBe(1);
      expect(writes.filter((kind) => kind === "controlled-final-delivery-ack-v1").length).toBe(1);
    } finally {
      release();
      await running.catch(() => undefined);
      appendSpy.mockRestore();
      putSpy.mockRestore();
    }
  },
  // This holds publication gates and then completes all three phases. Allow a
  // finite full-fixture watchdog under contention; action/lease expiry and every
  // ownership, publication-order and no-premature-effect assertion stay intact.
  60000,
);

it.each([
  [1, "failure"],
  [1, "cancel"],
  [2, "failure"],
  [2, "cancel"],
] as const)(
  "opening publication %s %s drains the started append before returning",
  async (ordinal, failure) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    Object.assign(c.options, { ownerDurationMs: 300000, pendingSaveIntent: true });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const OriginalAbortController = globalThis.AbortController;
    const controllers: AbortController[] = [];
    // The controlled entry creates its run controller synchronously before its
    // first await. Capture that real controller; never fabricate a live query.
    vi.stubGlobal(
      "AbortController",
      class extends OriginalAbortController {
        constructor() {
          super();
          controllers.push(this);
        }
      },
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const append = ProtectedEventStore.prototype.append;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const put = FileExecutionStore.prototype.putPayload;
    let openings = 0,
      settled = false;
    const writes: string[] = [];
    const appendSpy = vi.spyOn(ProtectedEventStore.prototype, "append").mockImplementation(async function (
      this: ProtectedEventStore,
      input,
    ) {
      const event = await Reflect.apply(append, this, [input]);
      if (input.type === "step.waiting" && ++openings === ordinal) {
        entered();
        await gate;
        if (failure === "failure") throw new Error("Controlled opening completion lost");
      }
      return event;
    });
    const putSpy = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(function (
      this: FileExecutionStore,
      ref,
      input,
    ) {
      if (input.type === "agent.update") writes.push(input.payload.update.kind);
      return Reflect.apply(put, this, [ref, input]);
    });
    const closeSpy = vi.spyOn(LiveHumanInput.prototype, "close");
    const running = runControlledOwnedReadTest(c.base, "connected", c.options);
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error("Opening gate was not reached");
        }),
      ]);
      if (failure === "cancel") controllers[0]!.abort("Run cancelled while opening append remains pending");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
      if (failure === "cancel") expect(closeSpy).toHaveBeenCalledOnce();
      else expect(closeSpy).not.toHaveBeenCalled();
      expect(writes.filter((kind) => kind === "controlled-baseline-v1").length).toBe(ordinal === 1 ? 0 : 1);
      expect(writes.includes("controlled-deferred-intent-v1")).toBe(false);
      expect(writes.includes("controlled-final-delivery-ack-v1")).toBe(false);
      expect(c.observed.length).toBe(0);
      release();
      await expect(running).rejects.toThrow();
      expect(settled).toBe(true);
      const events = await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", [
        "human.answered",
      ]);
      expect(events.length).toBe(0);
    } finally {
      release();
      await running.catch(() => undefined);
      appendSpy.mockRestore();
      putSpy.mockRestore();
      closeSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  },
  30000,
);

it("saves the same pending grant after original action expiry using fresh bounded Save authority", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  const realNow = Date.now.bind(Date);
  let skew = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    beforeSaveChoice: async () => {
      skew = 56000;
    },
  });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts.length).toBe(2);
    expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
    expect(c.observed.map((item) => item.phase)).toEqual(["human-read", "rule-read"]);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    const events = await stores.events.readTypes("controlled", ["agent.permission"]);
    const marker = events.find((event) => event.type === "agent.permission" && event.payload.scopedApprovalRef);
    expect(Boolean(marker?.executionPayloadRef)).toBe(true);
    const payload = (await stores.execution.getPayload(
      "controlled",
      marker!.executionPayloadRef!,
      "agent.permission",
    )) as {
      entry: {
        version: number;
        acceptedAt: string;
        action: { expiresAt: string };
        intent: { capturedAt: number };
        saveAuthority: { issuedAt: number; expiresAt: number };
        command: { rule: { expiresAt: null } };
      };
    };
    const approval = payload.entry,
      accepted = Date.parse(approval.acceptedAt);
    expect(approval.version).toBe(3);
    expect(approval.intent.capturedAt).toBeLessThan(Date.parse(approval.action.expiresAt));
    expect(accepted).toBeGreaterThan(Date.parse(approval.action.expiresAt));
    expect(approval.saveAuthority.issuedAt).toBeLessThanOrEqual(accepted);
    expect(accepted).toBeLessThan(approval.saveAuthority.expiresAt);
    expect(approval.saveAuthority.expiresAt - approval.saveAuthority.issuedAt).toBeLessThanOrEqual(60000);
    expect(approval.command.rule.expiresAt).toBeNull();
  } finally {
    clock.mockRestore();
  }
  // Full-fixture watchdog only; the real action, Save and lease checks still apply.
}, 60000);

it("refreshes disclosure after its handle expires without expiring the pending intent", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const realNow = Date.now.bind(Date);
  let skew = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    refreshSaveReview: true,
    beforeSaveChoice: async () => {
      skew = 65000;
    },
  });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts.length).toBe(2);
    expect(c.observed.map((item) => item.phase)).toEqual(["human-read", "rule-read"]);
  } finally {
    clock.mockRestore();
  }
}, 30000);
