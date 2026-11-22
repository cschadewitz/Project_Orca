// A child process racing on one SQLite metadata database; see sqlite-store.test.ts.
// It compare-and-swaps a shared counter and appends to a shared run and plan, N times each.
import { asVersionedDocumentStore, sqliteStores } from "@orca/store";

const [dir, prefix, count] = process.argv.slice(2) as [string, string, string];
const stores = sqliteStores(dir);
const plans = asVersionedDocumentStore(stores.plan.plans);
for (let i = 0; i < Number(count); i++) {
  for (;;) {
    const current = await plans.getVersioned("plan_counter");
    if (!current) throw new Error("the counter was not seeded");
    const next = { ...current.doc, name: String(Number(current.doc.name) + 1) };
    if ((await plans.putIfVersion(next, current.version)).ok) break;
  }
  await stores.events.append({ type: "run.started", runId: "run_shared", payload: {} });
  await stores.plan.journal.append({
    type: "request.linked",
    planId: "plan_shared",
    origin: { kind: "api" },
    payload: { requestId: `req_${prefix}${i}` },
  });
}
stores.close?.();
