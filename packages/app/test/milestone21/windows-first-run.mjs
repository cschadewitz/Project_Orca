/** Focused real Electron first-run: isolated runtime/profile, native picker seam only, no agents or installs. */
/* global window */
import assert from "node:assert/strict";
import { _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { windowsPrivateChild } from "@orca/protocol/first-run-fence";

assert.equal(process.platform, "win32");
const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const repo = resolve(appDir, "../..");
const require = createRequire(join(appDir, "package.json"));
const installed = join(dirname(require.resolve("electron")), "dist");
const fixtureParent = process.env.ORCA_WINDOWS_TEST_PARENT ?? tmpdir();
const root = await mkdtemp(join(fixtureParent, "orca-win-first-run-electron-"));
assert.equal(dirname(root), fixtureParent);
const runtime = join(root, "runtime"),
  project = join(root, "project"),
  profile = join(root, "profile"),
  parent = join(root, "selected");
const checks = {};
const result = {
  version: 1,
  scope: "isolated source-built Windows x64 Electron first-run; harmless sample only",
  checks,
};
let application,
  page,
  workspace,
  phase = "fixture";
const check = (name, value) => {
  assert.ok(value, name);
  checks[name] = true;
};
const hash = (text) => createHash("sha256").update(text).digest("hex");
const environment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(ORCA_|GIT_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_|OPENAI_|AZURE_OPENAI_|GOOGLE_API_|GEMINI_|CODEX_API_|CLAUDE_)/i.test(
          name,
        ),
    ),
  );
async function until(read, limit = 20_000) {
  const deadline = Date.now() + limit;
  do {
    if (await read()) return;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error("condition unavailable");
}
async function launch() {
  application = await electron.launch({
    executablePath: join(runtime, "electron.exe"),
    args: [`--user-data-dir=${profile}`, appDir],
    cwd: parent,
    env: environment(),
    timeout: 20_000,
  });
  const actual = await application.evaluate(({ app }) => ({
    path: app.getPath("userData"),
    getuid: typeof process.getuid,
    electron: process.versions.electron,
  }));
  check("isolated-profile", actual.path === profile);
  check("genuine-Windows-principal", actual.getuid === "undefined");
  check("real-Electron-runtime", actual.electron === "44.4.5");
  page = await application.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => window.orca?.firstRun !== undefined);
  await page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name: "Config", exact: true }).click();
}
async function firstStatus() {
  const response = await page.evaluate(() => window.orca.firstRun.status());
  assert.ok(response.ok);
  return response.result;
}
async function runs() {
  const response = await page.evaluate(() => window.orca.runs.list({ limit: 10 }));
  assert.ok(response.ok);
  return response.result.runs;
}
async function close() {
  if (!application) return;
  const active = application;
  application = undefined;
  await active.close();
}
try {
  await mkdir(profile);
  await mkdir(parent);
  windowsPrivateChild(project);
  await cp(installed, runtime, { recursive: true });
  const native = join(runtime, "resources", "native", "diagnostics", "win32-x64");
  await mkdir(native, { recursive: true });
  for (const name of ["first_run_windows.node", "diagnostics_clock.node"])
    await cp(join(appDir, "native/diagnostics/build/Release", name), join(native, name));
  await writeFile(join(root, "empty-git-config"), "");
  const git = (...args) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", project, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
      timeout: 5000,
      env: {
        ...environment(),
        GIT_CONFIG_GLOBAL: join(root, "empty-git-config"),
        GIT_CONFIG_SYSTEM: join(root, "empty-git-config"),
        GIT_TERMINAL_PROMPT: "0",
      },
    }).trim();
  git("init", "-b", "prepared");
  await writeFile(join(project, "sentinel.txt"), "unchanged\n");
  git("add", "sentinel.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  const beforeProject = git("status", "--porcelain");
  phase = "create";
  await launch();
  check("fresh-selection-required", (await firstStatus()).state === "selection-required");
  await application.evaluate(
    ({ dialog }, paths) => {
      let index = 0;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths[index++]] });
    },
    [project, parent],
  );
  const section = page.getByRole("region", { name: "First-run project setup" });
  await section.getByRole("button", { name: "Choose project and empty workspace" }).click();
  await section.getByRole("button", { name: "Create reviewed private workspace and sample files" }).waitFor();
  const review = await firstStatus();
  assert.equal(review.state, "review");
  workspace = review.review.workspace;
  check("reviewed-private-child", review.review.creation?.parent === parent && dirname(workspace) === parent);
  check("review-has-no-workspace-write", (await readdir(parent)).length === 0);
  await section.getByRole("button", { name: "Create reviewed private workspace and sample files" }).click();
  await section.getByRole("button", { name: "Connect selected local workspace" }).waitFor();
  check("native-files-prepared", (await firstStatus()).state === "prepared");
  const receiptPath = join(profile, "first-run", "selection.json"),
    receipt = await readFile(receiptPath, "utf8");
  const selected = JSON.parse(receipt);
  check("tagged-verified-SID", selected.workspace.uid.startsWith("win32:sid:S-1-"));
  check(
    "tagged-physical-file-and-volume",
    selected.workspace.ino.startsWith("win32:file:") && selected.workspace.dev.startsWith("win32:ntfs:"),
  );
  phase = "connect-and-sample";
  await section.getByRole("button", { name: "Connect selected local workspace" }).click();
  await until(async () => (await page.evaluate(() => window.orca.connection.read())).state === "live");
  check("owned-authenticated-daemon-live", (await firstStatus()).state === "prepared");
  await page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name: "Config", exact: true }).click();
  await page.getByRole("button", { name: "Launch work", exact: true }).click();
  const launchPanel = page.getByRole("region", { name: "Guided launch", exact: true });
  await page.getByRole("button", { name: "Choose harmless launch smoke check", exact: true }).click();
  await until(
    async () => !(await launchPanel.getByRole("button", { name: "Preview launch", exact: true }).isDisabled()),
  );
  await launchPanel.getByRole("button", { name: "Preview launch", exact: true }).click();
  await launchPanel
    .getByText("Review the exact target, workflow and inputs before launching.", { exact: true })
    .waitFor();
  await launchPanel.getByRole("checkbox").check();
  await launchPanel.getByRole("button", { name: "Launch", exact: true }).click();
  await until(async () => {
    const list = await runs();
    return list.length === 1 && list[0].status === "succeeded";
  });
  const sample = (await runs())[0];
  check(
    "exactly-one-harmless-sample-admitted",
    sample.workflowId === "orca-beta-local-check" && sample.status === "succeeded", // rename-keep: the first-run sample's id, kept so existing workspaces still match
  );
  result.runId = sample.id ?? sample.runId;
  const child = spawn(
    process.execPath,
    [
      join(appDir, "dist/daemon/orca-daemon.mjs"),
      "--config",
      join(workspace, "orca.config.yaml"),
      "serve",
      "--port",
      "0",
    ],
    {
      cwd: workspace,
      env: environment(),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  child.stderr.resume();
  const [exit] = await once(child, "exit");
  check("duplicate-writer-refused", exit !== 0);
  check("receipt-preserved-after-admission", (await readFile(receiptPath, "utf8")) === receipt);
  check("prepared-project-unchanged", git("status", "--porcelain") === beforeProject);
  phase = "reopen";
  await close();
  await launch();
  check("restart-verified-selection", (await firstStatus()).state === "prepared");
  await page.getByRole("button", { name: "Connect selected local workspace" }).click();
  await until(async () => (await page.evaluate(() => window.orca.connection.read())).state === "live");
  const reopened = await runs();
  check(
    "restart-retains-original-run",
    reopened.length === 1 &&
      (reopened[0].id ?? reopened[0].runId) === result.runId &&
      reopened[0].status === "succeeded",
  );
  check("restart-receipt-byte-preservation", (await readFile(receiptPath, "utf8")) === receipt);
  check("restart-project-unchanged", git("status", "--porcelain") === beforeProject);
  result.receiptSha256 = hash(receipt);
  result.passed = true;
} catch {
  result.passed = false;
  result.failedPhase = phase;
  process.exitCode = 1;
} finally {
  await close();
  // Only the exact mkdtemp fixture is removed. All addon/runtime copies and profiles are disposable.
  assert.ok(root.startsWith(join(fixtureParent, "orca-win-first-run-electron-")));
  await rm(root, { recursive: true, force: true });
  const output = join(repo, "test-results/first-run-windows-electron.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
}
