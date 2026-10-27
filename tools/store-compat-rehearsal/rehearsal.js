/** Fail-closed orchestration for disposable cross-version rehearsals; callbacks permit offline fixtures. */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareSnapshots, copyToNew, preflightNewDirectory, snapshotRoots } from "./snapshot.js";

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}
function requireResult(result, name, daemon = false) {
  requireCheck(
    !result.error &&
      !result.timedOut &&
      (daemon ? result.matched && (result.code === 0 || result.signal === "SIGTERM") : result.code === 0),
    `${name} failed: exit=${result.code}, signal=${result.signal}, ready=${result.matched}, timeout=${result.timedOut}`,
  );
}
/** Point a disposable copy's config at its own store. Refuses anything but the one demo line. */
async function retarget(copy, original) {
  const file = join(copy, "orca.config.yaml");
  const text = await readFile(file, "utf8");
  const from = `storeDir: ${join(original, ".orca")}\n`;
  if (text.split(from).length !== 2) throw new Error(`refusing to retarget ${file}: unexpected storeDir`);
  await writeFile(file, text.replace(from, `storeDir: ${join(copy, ".orca")}\n`));
}

export async function rehearse({ work, entry, checkouts, describe, run, schemaRead }) {
  // No write or callback (including describe's binary version probe) before this check.
  await preflightNewDirectory(work, checkouts);
  await mkdir(work, { recursive: false, mode: 0o700 });
  const summarize = (comparison) => ({
    equal: comparison.equal,
    added: comparison.added,
    removed: comparison.removed,
    changed: comparison.changed,
  });
  const report = {
    evidence: "synthetic source rehearsal: prior-release scripted demo store on this machine; not installed evidence",
    startedAt: new Date().toISOString(),
    entry,
    status: "failed",
    steps: {},
  };
  const step = (name, value) => {
    report.steps[name] = value;
    console.log(`[${name}] ${JSON.stringify(value).slice(0, 400)}`);
  };

  try {
    report.old = describe("old");
    report.new = describe("new");
    const live = join(work, "workspace");
    const backup = join(work, "backup", "workspace");
    await mkdir(join(work, "backup"));

    // 1. The prior release writes its own store.
    const generated = await run("old", ["demo", "--dir", live, "--quiet"]);
    step("generate", generated);
    requireResult(generated, "prior-release demo");

    // 2. Writers stopped (nothing is running): consistent manifest, then a verified offline copy.
    const pre = await snapshotRoots({ workspace: live });
    await writeFile(join(work, "pre-upgrade.manifest.json"), JSON.stringify(pre, null, 2));
    await copyToNew(live, backup);
    step("backup", {
      entries: pre.roots.workspace.entries.length,
      verified: compareSnapshots(pre, await snapshotRoots({ workspace: backup })).equal,
    });

    requireCheck(report.steps.backup.verified, "backup equality failed");

    // 3. What the candidate writes when it merely opens the prior store (fresh copy each time).
    const probes = [
      ["validate", ["validate"]],
      ["read command (runs)", ["runs"]],
      ["read-only daemon", ["serve", "--read-only", "--port", "0"], /listening on /],
    ];
    const probeResults = [];
    for (const [index, [name, args, until]] of probes.entries()) {
      const copy = join(work, `probe-${index}`, "workspace");
      await mkdir(dirname(copy));
      await copyToNew(backup, copy);
      await retarget(copy, live);
      const before = await snapshotRoots({ workspace: copy });
      const result = await run("new", [...args, "--cwd", copy], { until, timeoutMs: 120_000 });
      probeResults.push({
        ...result,
        name,
        reachedReady: until ? result.matched : undefined,
        writes: summarize(compareSnapshots(before, await snapshotRoots({ workspace: copy }))),
      });
      step("first-open probes", probeResults);
      requireResult(result, `first-open probe: ${name}`, Boolean(until));
    }

    // 4. The candidate's scripted writer on the live store: the first upgraded writer.
    const upgraded = await run("new", ["demo", "--dir", live, "--quiet"]);
    const post = await snapshotRoots({ workspace: live });
    step("upgrade", { ...upgraded, writes: summarize(compareSnapshots(pre, post)) });

    requireResult(upgraded, "candidate upgrade");

    // 5. Attempted downgrade, measured without the prior binary: its schemas over the new records.
    step("prior schemas over upgraded store", schemaRead("old", join(live, ".orca")));
    step("candidate schemas over upgraded store (control)", schemaRead("new", join(live, ".orca")));

    // 6. Rollback = keep the upgraded state aside, restore the whole backup to the original path.
    const retained = join(work, "upgraded-retained", "workspace");
    await mkdir(dirname(retained));
    await rename(live, retained);
    await copyToNew(backup, live);
    const restored = await snapshotRoots({ workspace: live });
    step("restore", {
      equalsPreUpgrade: compareSnapshots(pre, restored).equal,
      writesSinceBackupNeedingReconciliation: summarize(
        compareSnapshots(pre, await snapshotRoots({ workspace: retained })),
      ),
    });

    requireCheck(
      report.steps.restore.equalsPreUpgrade,
      "restore differs from pre-upgrade manifest; prior binary refused",
    );

    // 7. Offline validation with the matching prior binary, on its own restored store.
    const validations = [];
    for (const args of [["validate"], ["runs"]]) {
      requireCheck(
        compareSnapshots(pre, await snapshotRoots({ workspace: live })).equal,
        "pre-upgrade equality not proven; prior binary refused",
      );
      const result = await run("old", [...args, "--cwd", live], { timeoutMs: 120_000 });
      validations.push({ ...result, args });
      const writes = summarize(compareSnapshots(pre, await snapshotRoots({ workspace: live })));
      step("prior binary on restored store", { validations, writes });
      requireResult(result, `prior binary ${args[0]}`);
      requireCheck(writes.equal, "prior binary changed the restored store");
    }

    // 8. A partial or mixed restore must not pass as the backup. The partial copy has one run
    // log moved out of it (kept beside it, not deleted); the mixed copy has one upgraded file.
    const partial = join(work, "negative-partial", "workspace");
    const mixed = join(work, "negative-mixed", "workspace");
    for (const path of [partial, mixed]) {
      await mkdir(dirname(path));
      await copyToNew(backup, path);
    }
    const firstRun = readdirSync(join(partial, ".orca", "runs")).sort()[0];
    await rename(join(partial, ".orca", "runs", firstRun), join(work, "negative-partial", `withheld-${firstRun}`));
    await copyFile(join(retained, ".orca", "requests.json"), join(mixed, ".orca", "requests.json"));
    step("negative restores", {
      partial: summarize(compareSnapshots(pre, await snapshotRoots({ workspace: partial }))),
      mixed: summarize(compareSnapshots(pre, await snapshotRoots({ workspace: mixed }))),
    });

    requireCheck(!report.steps["negative restores"].partial.equal, "partial restore was not detected");
    requireCheck(!report.steps["negative restores"].mixed.equal, "mixed restore was not detected");
    report.status = "passed";
  } catch (error) {
    report.failure = { message: error.message, code: error.code };
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(join(work, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(`report: ${join(work, "report.json")}`);
  return report;
}
