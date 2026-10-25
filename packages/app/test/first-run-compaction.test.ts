/** Real journal compaction: settled history folds into a checkpoint that still verifies, and nothing else is folded. */
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { enterFirstRunWriter, firstRunAttempts } from "@orca/protocol/first-run-fence";
import { firstRunRequiresExplicitContinuationRecovery } from "../../cli/src/first-run-recovery-fence.js";
import type { BundledDaemon } from "../src/main/daemon-process.js";
import {
  OWNERSHIP_DIRECTORY,
  inspectFirstRunOwnership,
  reserveFirstRunOwnership,
} from "../src/main/first-run/ownership.js";
import { FirstRunRecovery } from "../src/main/first-run/recovery.js";
import { syntheticFirstRunWriter } from "./fixtures/synthetic-first-run-writer.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
// Under the checkout, like the recovery tests: the lifetime fence refuses tmpfs volumes.
async function selected() {
  const path = await mkdtemp(join(process.cwd(), ".orca-compaction-test-"));
  roots.push(path);
  await writeFile(join(path, "orca.config.yaml"), "synthetic config\n");
  return path;
}
/** One whole owned launch: reserve, attest the writer, attach, observe the direct child's exit and settle. */
function launch(path: string) {
  const owner = reserveFirstRunOwnership(path);
  syntheticFirstRunWriter(path, 123);
  let exited = false;
  const daemon: BundledDaemon = {
    url: "http://127.0.0.1:7654",
    pid: 123,
    get exited() {
      return exited;
    },
    stop: async () => {},
  };
  owner.attach(daemon);
  exited = true;
  expect(owner.complete()).toBe(true);
}
const journal = (path: string) => join(path, OWNERSHIP_DIRECTORY);
const listing = async (path: string) => (await readdir(journal(path))).sort();
const refused = (path: string) => expect(() => inspectFirstRunOwnership(path)).toThrow("reconciliation");

it("keeps working past the former 256-attempt limit, and the folded journal still verifies", async () => {
  const path = await selected();
  for (let count = 0; count < 300; count++) launch(path);
  const names = await listing(path);
  const { checkpoint, history, next, latest } = inspectFirstRunOwnership(path);
  expect(next).toBe(301);
  expect(latest!.settled).toBe(true);
  // A fold happens once 65 attempts follow the checkpoint, and keeps the 16 newest settled ones plus its own.
  expect(checkpoint!.through).toBe(240);
  expect(names.filter((name) => !/^[0-9]{6}$/.test(name))).toEqual(["checkpoint-000240.json"]);
  expect(names).toHaveLength(61);
  expect(history[0]!.number).toBe(checkpoint!.through + 1);
  expect(firstRunAttempts(journal(path))).toEqual(history.map((attempt) => attempt.name));
  expect(firstRunRequiresExplicitContinuationRecovery(path)).toBe(false);
  // The bootstrap's own admission finds the newest attempt of a folded journal.
  const owner = reserveFirstRunOwnership(path);
  await enterFirstRunWriter(path, join(path, ".orca"), owner.launchToken!());
  expect(Object.keys(inspectFirstRunOwnership(path, true).latest!.texts).sort()).toEqual(["claim.json", "writer.json"]);
}, 60000);

it("detects tampering with the checkpoint or the history it binds, and carries reconciliation forward", async () => {
  const path = await selected();
  // Attempt 1 is settled by explicit same-boot reconciliation, the rest by observed exit.
  reserveFirstRunOwnership(path);
  const recovery = new FirstRunRecovery(path);
  const request = recovery.prepare(() => {});
  expect(await recovery.reconcile(request.requestId, () => {})).toMatchObject({ state: "reconciled" });
  for (let count = 0; count < 64; count++) launch(path);
  const { checkpoint } = inspectFirstRunOwnership(path);
  expect(checkpoint).toMatchObject({ through: 48, recovered: true });
  expect(await listing(path)).not.toContain("000001");
  // The folded reconciliation still keeps retained continuations parked.
  expect(firstRunRequiresExplicitContinuationRecovery(path)).toBe(true);
  const file = join(journal(path), "checkpoint-000048.json");
  const original = await readFile(file, "utf8");
  const value = JSON.parse(original) as Record<string, unknown>;
  const tamper = async (change: () => Promise<void>, undo: () => Promise<void>) => {
    await change();
    refused(path);
    expect(() => reserveFirstRunOwnership(path)).toThrow("reconciliation");
    await undo();
    expect(() => inspectFirstRunOwnership(path)).not.toThrow();
  };
  const restore = () => writeFile(file, original);
  for (const field of ["head", "configHash", "anchorHash"])
    await tamper(() => writeFile(file, JSON.stringify({ ...value, [field]: "0".repeat(64) }) + "\n"), restore);
  await tamper(() => writeFile(file, JSON.stringify({ ...value, through: 47 }) + "\n"), restore);
  await tamper(() => writeFile(file, "{"), restore);
  await tamper(
    () => rename(file, join(path, "preserved-checkpoint.json")),
    () => rename(join(path, "preserved-checkpoint.json"), file),
  );
  await tamper(
    () => rename(file, join(journal(path), "checkpoint-000049.json")),
    () => rename(join(journal(path), "checkpoint-000049.json"), file),
  );
  // Removing the retained tail, including the reservation that wrote the checkpoint, is not a shorter history.
  const tail = (await listing(path)).filter((name) => /^[0-9]{6}$/.test(name));
  await tamper(
    async () => {
      await mkdir(join(path, "preserved-tail"));
      for (const name of tail) await rename(join(journal(path), name), join(path, "preserved-tail", name));
    },
    async () => {
      for (const name of tail) await rename(join(path, "preserved-tail", name), join(journal(path), name));
    },
  );
  await tamper(
    () => writeFile(join(journal(path), "unexpected"), "preserve"),
    () => rm(join(journal(path), "unexpected")),
  );
}, 60000);

it("never folds an unsettled attempt, and refuses to compact past one", async () => {
  const path = await selected();
  for (let count = 0; count < 64; count++) launch(path);
  // The 65th reservation folds settled history while its own claim is still in flight.
  const owner = reserveFirstRunOwnership(path);
  const after = await listing(path);
  expect(after).toContain("checkpoint-000048.json");
  expect(after).toContain("000065");
  expect(after).not.toContain("000048");
  const { latest } = inspectFirstRunOwnership(path, true);
  expect(latest).toMatchObject({ reservationId: expect.any(String), settled: false });
  expect(Object.keys(latest!.texts)).toEqual(["claim.json"]);
  expect(() => owner.check()).not.toThrow();
  // Lost before settling: nothing is folded past it, and nothing is removed.
  for (let count = 0; count < 3; count++) expect(() => reserveFirstRunOwnership(path)).toThrow("reconciliation");
  expect(await listing(path)).toEqual(after);
});

it("verifies an interrupted compaction, still checks what it left, and finishes it on the next reservation", async () => {
  const path = await selected();
  for (let count = 0; count < 64; count++) launch(path);
  const saved = join(path, "saved");
  for (const name of ["000040", "000045", "000046", "000047", "000048"])
    await cp(join(journal(path), name), join(saved, name), { recursive: true });
  launch(path);
  expect(inspectFirstRunOwnership(path).checkpoint!.through).toBe(48);
  // As if the process stopped part-way: the oldest folded attempts gone, a later run still present, one renamed
  // aside and half removed, and a checkpoint that was never renamed into place.
  for (const name of ["000046", "000047", "000048"])
    await cp(join(saved, name), join(journal(path), name), { recursive: true });
  await cp(join(saved, "000045"), join(journal(path), "discarded-000045"), { recursive: true });
  await rm(join(journal(path), "discarded-000045", "claim.json"));
  await writeFile(join(journal(path), "checkpoint-000099.pending"), "{");
  expect(() => inspectFirstRunOwnership(path)).not.toThrow();
  // What remains of folded history must still end exactly on the checkpoint's head.
  await rm(join(journal(path), "000048"), { recursive: true });
  refused(path);
  await cp(join(saved, "000048"), join(journal(path), "000048"), { recursive: true });
  await writeFile(join(journal(path), "000047", "terminal.json"), "{}\n");
  refused(path);
  await cp(join(saved, "000047", "terminal.json"), join(journal(path), "000047", "terminal.json"));
  // An earlier folded attempt reappearing out of sequence is not a run that ends on the head.
  await cp(join(saved, "000040"), join(journal(path), "000040"), { recursive: true });
  refused(path);
  await rm(join(journal(path), "000040"), { recursive: true });
  launch(path);
  const names = await listing(path);
  expect(names.filter((name) => !/^[0-9]{6}$/.test(name))).toEqual(["checkpoint-000048.json"]);
  expect(names[0]).toBe("000049");
  expect(() => inspectFirstRunOwnership(path)).not.toThrow();
}, 30000);
