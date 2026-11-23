/**
 * #339 on the installed package: "Switch to SQLite" and "Switch back to files" in Config's
 * Workspace storage section, each a real restart of the installed app, on a workspace with run
 * history, and the history still there after each.
 *
 * The switch is off by default; this is the acceptance that gates offering it, so the app is
 * started with `ORCA_SQLITE_SWITCH=1` (which `app.relaunch` passes on to the restarted app). The
 * spec completes first-run setup, runs the harmless sample, and then, for each direction:
 *
 * - confirms the switch, which drains and stops the daemon and writes the request;
 * - requires the old app to exit and the installed executable to start again by itself;
 * - waits for the store's format marker to record the other backend (and the database to be
 *   there, or gone), with no switch journal left;
 * - quits the restarted app, opens it again attached, and checks that Config names the backend,
 *   that every run is still listed, and (on SQLite) that a new sample run works there too, so
 *   the switch back has work done on SQLite to bring back.
 */
import { test, expect, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NativeSession } from "./session.js";
import { commandLine, installedProcesses, launchInstalled, noneLeft, quit, type Launched } from "./app.js";
import {
  connected,
  disposableWorkspace,
  firstRunSetup,
  launchSample,
  openConfig,
  openLaunchWork,
  runs,
  type Workspace,
} from "./flows.js";

const SAMPLE = "orca-beta-local-check";
const ENABLED = { ORCA_SQLITE_SWITCH: "1" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe.configure({ mode: "serial" });

let session: NativeSession;
let profile: string;
let chosen: Workspace;
let open: Launched | undefined;

const store = () => join(chosen.workspace, ".orca");
const epoch = async () =>
  (JSON.parse(await readFile(join(store(), "store-format.json"), "utf8")) as { epoch: string }).epoch;
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Main (not helper) processes of the installed executable that are not `exclude`. */
async function mainProcesses(exclude: number): Promise<number[]> {
  const out: number[] = [];
  for (const pid of await installedProcesses())
    if (pid !== exclude && !(await commandLine(pid)).includes("--type=")) out.push(pid);
  return out;
}

async function succeededRuns(page: Page, count: number): Promise<string[]> {
  await expect
    .poll(async () => (await runs(page)).map((run) => `${run.workflowId}:${run.status}`), { timeout: 90_000 })
    .toEqual(Array.from({ length: count }, () => `${SAMPLE}:succeeded`));
  return (await runs(page)).map((run) => run.id).sort();
}

async function runSample(page: Page, count: number): Promise<string[]> {
  await openLaunchWork(page);
  await launchSample(page);
  return succeededRuns(page, count);
}

/**
 * Click the offered switch in Workspace storage, confirm it, and follow the restart: the old app
 * exits, the installed one starts by itself, and its daemon switches the store until the marker
 * records `want`. Then the restarted app is quit the way a person does.
 */
async function switchAndRestart(button: string, want: (epoch: string) => boolean): Promise<void> {
  const { app, page } = open!;
  const oldPid = app.process().pid!;
  await openConfig(page);
  const section = page.getByRole("region", { name: "Workspace storage" });
  await section.getByRole("button", { name: button }).click();
  await test.info().attach(`confirm-${button}`, { body: await page.screenshot(), contentType: "image/png" });
  const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
  await section.getByRole("button", { name: "Restart and switch" }).click();
  await Promise.race([
    exited,
    sleep(90_000).then(() => {
      throw new Error(`The app did not exit within 90 s of "${button}"`);
    }),
  ]);
  open = undefined;
  let relaunched: number | undefined;
  const deadline = Date.now() + 60_000;
  while (!relaunched && Date.now() < deadline) {
    relaunched = (await mainProcesses(oldPid))[0];
    if (!relaunched) await sleep(250);
  }
  expect(relaunched, "a new ORCA main process after the restart").toBeDefined();
  await expect.poll(async () => want(await epoch().catch(() => "")), { timeout: 120_000 }).toBe(true);
  expect(await readdir(store())).not.toContain(".sqlite-switch");
  const [window] = await session.visibleWindows("^ORCA$");
  if (window) await session.key(window, "ctrl+q");
  await noneLeft(30_000).catch(async (error: unknown) => {
    for (const pid of await installedProcesses()) process.kill(pid, "SIGKILL");
    throw error;
  });
}

/** Open the installed app again, attached, and check what Config's Workspace storage says. */
async function reopen(backend: "Files" | "SQLite"): Promise<Page> {
  open = await launchInstalled(session, profile, "x11", ENABLED);
  const { page } = open;
  await connected(page);
  await openConfig(page);
  const section = page.getByRole("region", { name: "Workspace storage" });
  await expect(section.getByText(`Run history and plans are kept in: ${backend}`)).toBeVisible({ timeout: 30_000 });
  return page;
}

test.beforeAll(async () => {
  session = await NativeSession.start();
  profile = await mkdtemp(join(session.root, "profile-sqlite-"));
  chosen = await disposableWorkspace(session.root, session.env);
  // A login keyring for run-intent storage, as keyring-prompt.spec.ts sets up: without one,
  // Launch work has nowhere to keep the run's intent and refuses before the sample.
  await session.lockedKeyring();
  session.answerPrompts("unlock");
});

test.afterEach(async () => {
  const info = test.info();
  if (open && info.status !== info.expectedStatus) {
    const shot = await open.page.screenshot().catch(() => undefined);
    if (shot) await info.attach("orca-window", { body: shot, contentType: "image/png" });
  }
  if (open) {
    await quit(session, open, "x11").catch(() => open?.app.close());
    open = undefined;
  }
  for (const pid of await installedProcesses()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test.afterAll(async () => {
  await session?.stop();
});

let history: string[] = [];

test("a new workspace on files, with run history", async () => {
  test.setTimeout(240_000);
  await noneLeft();
  open = await launchInstalled(session, profile, "x11", ENABLED);
  await firstRunSetup(open.app, open.page, chosen);
  history = await runSample(open.page, 1);
  expect(await epoch()).not.toMatch(/-sqlite$/);
  await openConfig(open.page);
  const section = open.page.getByRole("region", { name: "Workspace storage" });
  await expect(section.getByText("Run history and plans are kept in: Files")).toBeVisible({ timeout: 30_000 });
  await expect(section.getByRole("button", { name: "Switch to SQLite" })).toBeVisible();
});

test("Switch to SQLite restarts the installed app, which switches the store and keeps its history", async () => {
  test.setTimeout(420_000);
  open = await launchInstalled(session, profile, "x11", ENABLED);
  await connected(open.page);
  await switchAndRestart("Switch to SQLite", (value) => value.endsWith("-sqlite"));
  expect(await exists(join(store(), "metadata.sqlite"))).toBe(true);

  const page = await reopen("SQLite");
  await expect(page.getByRole("button", { name: "Switch back to files" })).toBeVisible();
  expect(await succeededRuns(page, 1)).toEqual(history);
  // Work done on SQLite, for the switch back to bring along.
  history = await runSample(page, 2);
  await test.info().attach("on-sqlite", { body: await page.screenshot(), contentType: "image/png" });
});

test("Switch back to files restarts the installed app, which brings everything back to files", async () => {
  test.setTimeout(420_000);
  open = await launchInstalled(session, profile, "x11", ENABLED);
  await connected(open.page);
  await switchAndRestart("Switch back to files", (value) => value !== "" && !value.endsWith("-sqlite"));
  expect(await exists(join(store(), "metadata.sqlite"))).toBe(false);
  expect(await exists(join(store(), "runs"))).toBe(true);

  const page = await reopen("Files");
  await expect(page.getByRole("button", { name: "Switch to SQLite" })).toBeVisible();
  expect(await succeededRuns(page, 2)).toEqual(history);
  // And it keeps working on files.
  await runSample(page, 3);
  await test.info().attach("back-on-files", { body: await page.screenshot(), contentType: "image/png" });
});
