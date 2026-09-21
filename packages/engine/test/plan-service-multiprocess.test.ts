/** Two PlanService instances over one store directory: neither loses the other's plan records (#196). */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "@orca/core";
import { PlanService } from "@orca/engine";
import { fileStores } from "@orca/store";

const human = { kind: "human" as const, actor: "test" };

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("PlanService over a shared store directory", () => {
  it("ensures one plan and one risk from two independent services", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-plan-mp-"));
    dirs.push(dir);
    // Two services with their own stores over one directory: an `orca serve` beside a
    // one-shot CLI. The lookups behind ensurePlan/upsertRisk are list()+filter, so each
    // one only finds the other's record if the store re-reads the file.
    const service = () => new PlanService({ stores: fileStores(dir, new FakeClock()), clock: new FakeClock() });
    const a = service();
    const b = service();
    // Both have read the empty collections before either writes - the long-lived daemon
    // that loaded at 10:00 and the CLI command that runs at 10:05.
    expect(await a.listPlans()).toEqual([]);
    expect(await b.listPlans()).toEqual([]);

    const planA = await a.ensurePlan({ key: "roadmap", name: "Roadmap" }, human);
    const planB = await b.ensurePlan({ key: "roadmap", name: "Roadmap" }, human);
    expect(planB.id).toBe(planA.id);

    // b reads the risks before a writes one, so its view of that collection is stale too.
    expect((await b.snapshot(planA.id)).risks).toEqual([]);
    await a.upsertRisk(planA.id, { key: "migration", title: "Migration locks table" }, human);
    await b.upsertRisk(planA.id, { key: "migration", title: "Migration locks table, still" }, human);

    const c = service();
    expect((await c.listPlans()).map((p) => p.key)).toEqual(["roadmap"]);
    const { risks } = await c.snapshot(planA.id);
    expect(risks.length).toBe(1);
    expect(risks[0]?.title).toBe("Migration locks table, still");
  });
});
