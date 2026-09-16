import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, PlanSchema } from "@orca/core";
import { filePlanStores, InMemoryPlanJournal, JsonlPlanJournal } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const plan = PlanSchema.parse({ id: "plan_1", key: "p", name: "P", createdAt: "t", updatedAt: "t" });

describe("plan journal", () => {
  for (const [name, make] of [
    ["memory", async () => new InMemoryPlanJournal(new FakeClock())],
    ["jsonl", async () => {
      const d = await mkdtemp(join(tmpdir(), "orca-plan-"));
      dirs.push(d);
      return new JsonlPlanJournal(d, new FakeClock());
    }],
  ] as const) {
    it(`${name}: assigns per-plan seq and filters subscribers`, async () => {
      const j = await make();
      const seen: string[] = [];
      j.subscribe((e) => seen.push(`${e.planId}:${e.seq}:${e.type}`), "plan_1");
      await Promise.all([
        j.append({ type: "plan.created", planId: "plan_1", origin: { kind: "system" }, payload: { plan } }),
        j.append({ type: "request.linked", planId: "plan_1", origin: { kind: "api" }, payload: { requestId: "req_1" } }),
        j.append({ type: "plan.created", planId: "plan_2", origin: { kind: "system" }, payload: { plan: { ...plan, id: "plan_2", key: "q" } } }),
      ]);
      expect((await j.read("plan_1")).map((e) => e.seq)).toEqual([0, 1]);
      expect(seen).toEqual(["plan_1:0:plan.created", "plan_1:1:request.linked"]);
      expect((await j.listPlans()).sort()).toEqual(["plan_1", "plan_2"]);
    });
  }
  it("jsonl survives a restart", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-plan-"));
    dirs.push(d);
    await new JsonlPlanJournal(d).append({ type: "plan.created", planId: "plan_x", origin: { kind: "system" }, payload: { plan } });
    const e = await new JsonlPlanJournal(d).append({ type: "request.linked", planId: "plan_x", origin: { kind: "system" }, payload: { requestId: "r" } });
    expect(e.seq).toBe(1);
  });
});

describe("file plan stores", () => {
  it("round-trip plans, dependencies, risks and decisions through JSON files", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-plan-"));
    dirs.push(d);
    const s = filePlanStores(d);
    await s.plans.put(plan);
    await s.dependencies.put({ id: "dep_1", planId: plan.id, from: "wi_a", target: { kind: "external", key: "vendor" }, type: "blocks", requiredBy: "start", status: "open", origin: { kind: "human" }, createdAt: "t", updatedAt: "t" });
    await s.risks.put({ id: "risk_1", planId: plan.id, key: "k", title: "K", description: "", category: "technical", likelihood: 2, impact: 3, status: "open", triggers: [], affects: [], mitigatedBy: [], origin: { kind: "human" }, createdAt: "t", updatedAt: "t" });
    await s.decisions.put({ id: "dec_1", planId: plan.id, key: "d", title: "D", question: "", status: "open", criteria: [], options: [], scale: 10, consequences: [], blocks: [], origin: { kind: "human" }, createdAt: "t", updatedAt: "t" });
    const again = filePlanStores(d);
    expect((await again.plans.get(plan.id))?.key).toBe("p");
    expect((await again.dependencies.list())[0]?.target).toEqual({ kind: "external", key: "vendor" });
    expect((await again.risks.get("risk_1"))?.impact).toBe(3);
    expect((await again.decisions.get("dec_1"))?.title).toBe("D");
  });
});
