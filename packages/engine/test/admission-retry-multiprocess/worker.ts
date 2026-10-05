import { processFixture, type AdmissionKind, type Boundary } from "./fixture.js";

const [dir, kind, stopAt, mode] = process.argv.slice(2) as [string, AdmissionKind, Boundary | "none", string];
process.on("disconnect", () => process.exit(0));
const send = (type: string, data?: unknown) =>
  new Promise<void>((resolve, reject) => {
    process.send!({ type, pid: process.pid, data }, (error) => (error ? reject(error) : resolve()));
  });
async function gate(name: string, data?: unknown) {
  const released = new Promise<void>((resolve) => {
    const listener = (message: { release?: string }) => {
      if (message.release !== name) return;
      process.off("message", listener);
      resolve();
    };
    process.on("message", listener);
  });
  await send(name, data);
  await released;
}

try {
  const f = await processFixture(dir, async (name) => {
    if (name === stopAt) await gate("boundary", { name });
  });
  const lock = f.store.lock.bind(f.store);
  f.store.lock = async (id, action) => {
    const pending = lock(id, action);
    const [, result] = await Promise.all([send("locking"), pending]);
    return result;
  };
  const claim = f.store.claim.bind(f.store);
  f.store.claim = async (...args) => {
    await gate("claim");
    const value = await claim(...args);
    await send("claimed", { fresh: value.fresh, operationId: value.record.operationId });
    if (stopAt === "claimed") await gate("boundary", { name: "claimed" });
    // Both callers entered claim on an empty ledger. Delay the non-owner until
    // the owner holds the operation mutex, then prove bounded live contention.
    if (mode === "race" && !value.fresh) await gate("contender");
    return value;
  };
  await gate("ready", { operations: await f.store.batch(), runs: await f.orc.listRuns(), starts: f.starts() });
  const result = await f.submit(kind);
  if (stopAt === "response") await gate("boundary", { name: "response" });
  await send("result", { result, starts: f.starts() });
  process.disconnect!();
} catch (error) {
  await send("error", { message: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
  process.disconnect!();
}
