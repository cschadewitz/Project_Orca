/** Real journal compaction: settled history folds into a checkpoint that still verifies, and nothing else is folded. */
import { join } from "node:path";
import { expect, it } from "vitest";
import { enterFirstRunWriter, firstRunAttempts } from "@orca/protocol/first-run-fence";
import { firstRunRequiresExplicitContinuationRecovery } from "../../cli/src/first-run-recovery-fence.js";
import { inspectFirstRunOwnership, reserveFirstRunOwnership } from "../src/main/first-run/ownership.js";
import { journal, launch, listing, selected } from "./first-run-compaction-fixture.js";

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
