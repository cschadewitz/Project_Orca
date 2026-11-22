/**
 * Store-side rows of docs/preparation/store-compatibility-rehearsal, against this checkout only.
 *
 * The stores here are hand-written in the shape v0.6.0 wrote - no `executionPayloadRef`, no
 * `journal`, no private-execution, workspace identity or auth - and are synthetic. They are
 * not a v0.6.0 store and prove nothing about an installed one; `rehearse.js` runs the real
 * cross-version rehearsal against a v0.6.0 checkout. What these pin is how *this* code meets
 * a store without its newer state, so the matrix fails loudly when that behaviour changes.
 */
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  FileExecutionStore,
  FileWorkflowVersionStore,
  JsonlEventStore,
  ProtectedEventStore,
  workspaceIdentity,
} from "@orca/store";
import { inventoryRecoveryRoots } from "../../../packages/store/src/recovery-inventory.ts";
import { STORE_COMPONENTS } from "../../../packages/store/src/recovery-manifest.ts";
import { validateRecoveryManifest } from "../../../packages/store/src/recovery-validation.ts";
import { compareSnapshots, copyToNew, snapshotRoots } from "../../store-compat-rehearsal/snapshot.js";

const cli = resolve("packages/cli/src/main.ts");
const reader = resolve("tools/store-compat-rehearsal/schema-read.js");
// Operator settings must not reach a disposable workspace.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")));
const RUN = "run_old";
const OLD_LINES = [
  {
    id: "evt_0",
    seq: 0,
    runId: RUN,
    at: "2026-09-29T00:00:00.000Z",
    type: "run.created",
    payload: {
      workflowId: "review",
      workflowVersion: "1",
      workspace: { hostId: "local", cwd: "/w" },
      vars: { ticket: "ORCA-1" },
    },
  },
  { id: "evt_1", seq: 1, runId: RUN, at: "2026-09-29T00:00:01.000Z", type: "run.started", payload: {} },
  {
    id: "evt_2",
    seq: 2,
    runId: RUN,
    at: "2026-09-29T00:00:02.000Z",
    type: "run.completed",
    payload: { outcome: "success" },
  },
];
const jsonl = (lines) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

const bases = [];
const children = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((done) => child.once("close", done));
      child.kill("SIGKILL");
      await closed;
    }
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});
async function oldShapedWorkspace() {
  const base = await mkdtemp(join(tmpdir(), "orca-store-boundary-"));
  bases.push(base);
  const workspace = join(base, "workspace");
  await mkdir(join(workspace, ".orca", "runs"), { recursive: true });
  await writeFile(join(workspace, "orca.config.yaml"), "version: 1\nstoreDir: .orca\nworkflows: []\ntemplates: []\n");
  await writeFile(join(workspace, ".orca", "runs", `${RUN}.jsonl`), jsonl(OLD_LINES));
  return { base, workspace, store: join(workspace, ".orca") };
}
const added = (comparison) => comparison.added.map((path) => path.replace(/^workspace:/, ""));

it("D1/D2: startup refuses an older store unchanged; after carry-forward, read commands and the read-only daemon add new-epoch state", async () => {
  const { base, workspace } = await oldShapedWorkspace();
  const run = (cwd, ...args) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, "--cwd", cwd, ...args], { env, timeout: 60_000 });
  // #566: ordinary startup never converts an older store, and refuses it byte for byte unchanged.
  const untouched = await snapshotRoots({ workspace });
  const refused = await run(workspace, "runs").catch((error) => error);
  expect(refused.stderr).toContain("CARRYOVER_REQUIRED");
  const afterRefusal = compareSnapshots(untouched, await snapshotRoots({ workspace }));
  expect([afterRefusal.added, afterRefusal.removed, afterRefusal.changed]).toEqual([[], [], []]);
  expect((await run(workspace, "store", "carry-forward")).stdout).toMatch(/^carried .* forward from unmarked/);

  const daemonWorkspace = join(base, "daemon", "workspace");
  await mkdir(join(base, "daemon"));
  await copyToNew(workspace, daemonWorkspace);
  const before = await snapshotRoots({ workspace });

  const listed = await run(workspace, "runs");
  expect(listed.stdout).toContain(RUN);
  const afterRead = compareSnapshots(before, await snapshotRoots({ workspace }));
  // Existing bytes are untouched; what is new is key material and a configuration generation.
  expect(afterRead.removed).toEqual([]);
  expect(afterRead.changed).toEqual([]);
  expect(added(afterRead)).toContain(".orca/private-execution/.execution-key");
  expect(added(afterRead).some((path) => /^\.orca\/private-execution\/.+\.generation\.json$/.test(path))).toBe(true);

  const daemonBefore = await snapshotRoots({ workspace: daemonWorkspace });
  const daemon = spawn(
    process.execPath,
    ["--import", "tsx", cli, "--cwd", daemonWorkspace, "serve", "--read-only", "--port", "0"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(daemon);
  const closed = new Promise((done) => daemon.once("close", done));
  let output = "";
  await new Promise((ready, failed) => {
    const timer = setTimeout(() => failed(new Error(`daemon never listened: ${output}`)), 60_000);
    daemon.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("listening on ")) {
        clearTimeout(timer);
        ready();
      }
    });
    daemon.once("close", () => failed(new Error(`daemon exited: ${output}`)));
  });
  daemon.kill("SIGTERM");
  await closed;
  const afterDaemon = compareSnapshots(daemonBefore, await snapshotRoots({ workspace: daemonWorkspace }));
  expect(afterDaemon.removed).toEqual([]);
  expect(afterDaemon.changed).toEqual([]);
  // "Read-only" omits run controls; it does not make the first open write-free.
  expect(added(afterDaemon)).toEqual(
    expect.arrayContaining([
      ".orca/.workspace-identified",
      ".orca/workspace-identity/id",
      ".orca/private-execution/.execution-key",
      "auth/local-client.token",
      "auth/credentials.json",
    ]),
  );
}, 120_000);

it("D5: a full-schema read refuses an unknown event while a filtered read skips it and unknown keys drop", async () => {
  const { store } = await oldShapedWorkspace();
  const future = {
    id: "evt_3",
    seq: 3,
    runId: RUN,
    at: "2026-09-29T00:00:03.000Z",
    type: "future.recorded",
    payload: {},
  };
  const later = { ...OLD_LINES[2], id: "evt_4", seq: 4, futureRef: "opaque" };
  await writeFile(join(store, "runs", `${RUN}.jsonl`), jsonl([...OLD_LINES, future, later]));
  const events = new JsonlEventStore(store);
  await expect(events.read(RUN)).rejects.toThrow();
  const filtered = await events.readTypes(RUN, ["run.created", "run.completed"]);
  expect(filtered.map((event) => event.seq)).toEqual([0, 2, 4]);
  expect(filtered.at(-1)).not.toHaveProperty("futureRef");

  // The rehearsal's measuring tool reports exactly those two outcomes, without opening a store.
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", reader, resolve("."), store], {
    env,
    timeout: 60_000,
  });
  const runEvents = JSON.parse(stdout).families.find((family) => family.name === "run events");
  expect(runEvents).toMatchObject({ records: 5, refused: 1, refusedBy: { "future.recorded: invalid_union": 1 } });
  expect(runEvents.dropped).toEqual({ futureRef: 1 });
}, 90_000);

it("R0: the recovery inventory observes a store without workspace identity but cannot certify it", async () => {
  const { store } = await oldShapedWorkspace();
  const candidateRef = "synthetic-pre-upgrade";
  const result = await inventoryRecoveryRoots({
    candidateRef,
    references: [],
    external: [
      { id: "workspaces", kind: "workspace", state: "not-applicable" },
      { id: "credentials", kind: "credential", state: "not-applicable" },
    ],
    roots: [
      {
        id: "store",
        role: "store",
        path: store,
        components: Object.entries(STORE_COMPONENTS).map(([id, paths]) => ({
          id,
          paths: [...paths],
          candidateRef,
          state: id === "runs" ? "present" : "absent",
        })),
      },
    ],
  });
  expect(result.ok).toBe(true);
  expect(result.manifest.enumeration).toBe("complete");
  expect(result.manifest.reasons).toContain("IDENTITY_MISSING");
  const validation = validateRecoveryManifest(JSON.stringify(result.manifest), { expectedCandidateRef: candidateRef });
  expect(validation.integrity.status).toBe("failed");
  expect(validation.integrity.reasons).toContain("IDENTITY_MISSING");
  expect(validation.recoveryEligibility).toEqual({ status: "unavailable", reasons: ["RECOVERY_DISABLED"] });
});

it("R1-R3: a whole-backup restore matches the pre-upgrade bytes; partial and mixed restores do not", async () => {
  const { base, workspace, store } = await oldShapedWorkspace();
  const backup = join(base, "backup", "workspace");
  await mkdir(join(base, "backup"));
  const pre = await snapshotRoots({ workspace });
  await copyToNew(workspace, backup);

  // A synthetic stand-in for the first upgraded writer, through this checkout's constructors.
  await workspaceIdentity(store);
  const execution = new FileExecutionStore(store);
  // A protected generation record, as the CLI's first open writes (D1): it creates the key.
  await execution.putGeneration("synthetic-generation", { fixture: true });
  const protectedEvents = new ProtectedEventStore(
    new JsonlEventStore(store),
    execution,
    new FileWorkflowVersionStore(store),
  );
  await protectedEvents.append({ type: "vars.set", runId: RUN, payload: { vars: { note: "after the backup" } } });
  await new JsonlEventStore(store).append({
    type: "revision.recorded",
    runId: RUN,
    payload: { destinationId: "synthetic", state: "pending" },
  });
  const upgraded = await snapshotRoots({ workspace });

  // Rollback keeps the upgraded state aside and restores the whole backup to the same path.
  const retained = join(base, "upgraded-retained", "workspace");
  await mkdir(join(base, "upgraded-retained"));
  await rename(workspace, retained);
  await copyToNew(backup, workspace);
  expect(compareSnapshots(pre, await snapshotRoots({ workspace })).equal).toBe(true);
  const restoredEvents = await new JsonlEventStore(store).read(RUN);
  expect(restoredEvents.map((event) => event.type)).toEqual(["run.created", "run.started", "run.completed"]);

  // Writes made after the backup are listed for separate reconciliation, not recovered.
  const reconcile = compareSnapshots(pre, upgraded);
  expect(reconcile.removed).toEqual([]);
  expect(reconcile.changed).toEqual([{ path: `workspace:.orca/runs/${RUN}.jsonl`, fields: ["size", "sha256"] }]);
  expect(added(reconcile)).toEqual(
    expect.arrayContaining([
      ".orca/.workspace-identified",
      ".orca/workspace-identity/id",
      ".orca/private-execution/.execution-key",
    ]),
  );

  const partial = join(base, "partial", "workspace");
  const mixed = join(base, "mixed", "workspace");
  for (const path of [partial, mixed]) {
    await mkdir(join(path, ".."));
    await copyToNew(backup, path);
  }
  await rename(join(partial, ".orca", "runs", `${RUN}.jsonl`), join(base, "partial", "withheld.jsonl"));
  await copyFile(join(retained, ".orca", "runs", `${RUN}.jsonl`), join(mixed, ".orca", "runs", `${RUN}.jsonl`));
  const partialResult = compareSnapshots(pre, await snapshotRoots({ workspace: partial }));
  const mixedResult = compareSnapshots(pre, await snapshotRoots({ workspace: mixed }));
  expect(partialResult.equal).toBe(false);
  expect(partialResult.removed).toEqual([`workspace:.orca/runs/${RUN}.jsonl`]);
  expect(mixedResult.equal).toBe(false);
  expect(mixedResult.changed).toEqual([{ path: `workspace:.orca/runs/${RUN}.jsonl`, fields: ["size", "sha256"] }]);
});
