// A child process that writes to a SQLite metadata store until it is killed; see
// sqlite-recovery.test.ts. After each write is acknowledged it prints one line, so the parent
// knows exactly which writes the store promised before the kill.
import { asVersionedDocumentStore, sqliteStores } from "@orca/store";
import { sha256 } from "@orca/core";

const [dir, tag] = process.argv.slice(2) as [string, string];
const stores = sqliteStores(dir);
const plans = asVersionedDocumentStore(stores.plan.plans);
const ack = (line: string) => process.stdout.write(`${line}\n`);
for (let i = 0; ; i++) {
  for (;;) {
    const current = await plans.getVersioned("plan_counter");
    if (!current) throw new Error("the counter was not seeded");
    const next = { ...current.doc, name: String(Number(current.doc.name) + 1) };
    if ((await plans.putIfVersion(next, current.version)).ok) {
      ack(`counter ${next.name}`);
      break;
    }
  }
  const op = `${tag}-${i}`;
  await stores.plan.journal.append({
    type: "request.linked",
    planId: "plan_ops",
    origin: { kind: "api" },
    payload: { requestId: op },
  });
  ack(`journal ${op}`);
  const event = await stores.events.append({ type: "run.started", runId: "run_crash", payload: {} });
  ack(`event ${event.seq}`);
  const body = `artifact ${op}`;
  await stores.artifacts.put(
    {
      id: `art_${op}`,
      kind: "spec",
      name: op,
      mediaType: "text/plain",
      contentHash: sha256(body),
      size: Buffer.byteLength(body),
      version: 1,
      producedBy: { runId: "run_crash" },
      createdAt: "t",
    } as never,
    body,
  );
  ack(`artifact art_${op}`);
}
