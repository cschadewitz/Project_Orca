/** Actual encrypted payload/event IO, including the final synchronous publication seal. */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { FileExecutionStore, fileStores, executionEvents } from "@orca/store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-scoped-protected-"));
  roots.push(root);
  const stores = fileStores(root);
  await stores.execution.putInputs({
    runId: "run",
    workflowId: "synthetic",
    workflowVersion: "1",
    vars: {},
    sensitiveNames: [],
    secrets: [],
  });
  const event = await stores.events.append({
    type: "agent.permission",
    runId: "run",
    payload: {
      stepRunId: "step",
      sessionId: "session",
      title: "create a scoped rule",
      decision: "scoped-rule-save-accepted",
      scopedApprovalRef: "approval",
      entry: { scope: "private-synthetic-disclosure", choice: "save" },
    },
  });
  return { root, stores, event, path: (name: string) => join(root, "private-execution", name) };
}
it("protects explicit Save independently of secret matching, survives restart, and records no answer", async () => {
  const f = await fixture();
  expect(f.event.payload).toEqual({
    stepRunId: "step",
    sessionId: "session",
    title: "create a scoped rule",
    decision: "scoped-rule-save-accepted",
    scopedApprovalRef: "approval",
  });
  expect(await f.stores.events.readTypes("run", ["human.answered"])).toEqual([]);
  const events = await fileStores(f.root).events.read("run");
  expect(JSON.stringify(events)).not.toContain("private-synthetic-disclosure");
  const restored = await executionEvents(events, new FileExecutionStore(f.root));
  expect(restored[0]?.payload).toMatchObject({ entry: { scope: "private-synthetic-disclosure", choice: "save" } });
  for (const name of await readdir(f.path("")))
    expect(await readFile(f.path(name), "utf8")).not.toContain("private-synthetic-disclosure");
});
it.each(["ordinary", "secret", "uuid-secret"] as const)(
  "redacts every scoped approval metadata field from public reads and notifications (%s)",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "orca-scoped-metadata-"));
    roots.push(root);
    const stores = fileStores(root);
    const secret = "synthetic-secret";
    const uuidSecret = "8a729bca-466a-4d7b-98d4-86b7ad8c17b6";
    await stores.execution.putInputs({
      runId: "run",
      workflowId: "synthetic",
      workflowVersion: "1",
      vars: {},
      sensitiveNames: [],
      secrets: [secret, uuidSecret],
    });
    const notifications: unknown[] = [];
    const unsubscribe = stores.events.subscribe((event) => notifications.push(structuredClone(event)));
    const input = {
      type: "agent.permission" as const,
      runId: "run",
      payload: {
        stepRunId: "step",
        sessionId: "session",
        title: `${secret} title`,
        decision: `${secret} decision`,
        toolCallId: `${secret} tool call`,
        scopedApprovalRef: kind === "ordinary" ? "x" : kind === "secret" ? secret : uuidSecret,
        entry: { choice: "save", privateScope: secret },
      },
    };
    const event = await stores.events.append(input);
    unsubscribe();
    const persisted = await fileStores(root).events.read("run");
    expect(notifications).toHaveLength(1);
    for (const publicValue of [event, ...persisted, ...notifications]) {
      expect(JSON.stringify(publicValue)).not.toContain(secret);
      expect(JSON.stringify(publicValue)).not.toContain(uuidSecret);
      expect(publicValue).toMatchObject({
        payload: {
          title: "[REDACTED] title",
          decision: "[REDACTED] decision",
          toolCallId: "[REDACTED] tool call",
          scopedApprovalRef: kind === "ordinary" ? "x" : "[REDACTED]",
        },
      });
      expect((publicValue as { payload: unknown }).payload).not.toHaveProperty("entry");
    }
    const restored = await executionEvents(persisted, new FileExecutionStore(root));
    expect(restored[0]?.payload).toEqual(input.payload);
  },
);
it.each(["payload", "key", "inputs", "overlay", "new-overlay"] as const)(
  "final synchronous seal refuses changed %s without rehydrating protected text",
  async (target) => {
    const f = await fixture();
    await f.stores.execution.addSensitivity("run", { sensitiveNames: [], secrets: ["synthetic-overlay"] });
    const observed = await f.stores.execution.observe!(
      () => f.stores.execution.getPayload("run", f.event.executionPayloadRef!, f.event.type),
      { maxRecords: 32 },
    );
    expect(observed.assertUnchanged!()).toBeUndefined();
    await observed.verifyUnchanged();
    if (target === "new-overlay") await f.stores.execution.addSensitivity("run", { sensitiveNames: [], secrets: [] });
    else {
      const names = await readdir(f.path(""));
      const name =
        target === "payload"
          ? `${f.event.executionPayloadRef!}.payload.json`
          : target === "key"
            ? ".execution-key"
            : target === "inputs"
              ? "run.inputs.json"
              : names.find((n) => n.includes(".sensitivity."))!;
      const bytes = await readFile(f.path(name));
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(f.path(name), bytes);
    }
    expect(() => observed.assertUnchanged!()).toThrow();
    await expect(observed.verifyUnchanged()).rejects.toThrow();
  },
);
it("a fresh observer refuses missing proof and never repairs or recreates it", async () => {
  const f = await fixture();
  const path = f.path(`${f.event.executionPayloadRef!}.payload.json`);
  await rm(path);
  await expect(
    new FileExecutionStore(f.root).observe(
      () => new FileExecutionStore(f.root).getPayload("run", f.event.executionPayloadRef!, f.event.type),
      { maxRecords: 32 },
    ),
  ).rejects.toThrow();
  expect(await readdir(f.path(""))).not.toContain(`${f.event.executionPayloadRef!}.payload.json`);
});
it("approval cannot use public-only fallback when protected inputs are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "orca-scoped-no-input-"));
  roots.push(root);
  const stores = fileStores(root);
  await expect(
    stores.events.append({
      type: "agent.permission",
      runId: "run",
      payload: {
        stepRunId: "step",
        sessionId: "session",
        title: "create a scoped rule",
        decision: "scoped-rule-save-accepted",
        scopedApprovalRef: "approval",
        entry: { private: "synthetic-private-scope" },
      },
    }),
  ).rejects.toThrow();
  expect(await stores.events.readTypes("run", ["agent.permission"])).toEqual([]);
});
