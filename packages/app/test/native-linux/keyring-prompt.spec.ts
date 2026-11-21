/**
 * #857 on the installed package: what ORCA does when GNOME's keyring prompt is cancelled,
 * and that the advertised way out (quit, reopen, unlock) admits the launch exactly once.
 *
 * One serial story over one profile, workspace and keyring, because each step depends on
 * what the last one left on disk, exactly as it would for a tester:
 *
 * 1. Fresh install, locked keyring, Cancel at the prompt: Launch work opens with the
 *    keyring refusal and "No run was submitted"; Launch shows the same refusal, offers no
 *    in-app Retry (Chromium caches the refusal per process) and admits nothing.
 * 2. Quit and reopen, Unlock at the prompt, launch: one run, and it succeeds.
 * 3. Reopen with the keyring still unlocked: still exactly one run, no duplicate.
 * 4. Lock the keyring again (as a new login would), reopen, Cancel: now that a journal
 *    exists the screen says an earlier launch may still exist, offers Recover and not
 *    Launch, and nothing new is admitted.
 *
 * Every launch also has to show its window and every quit has to leave no process behind,
 * which is the #858 check repeated across the flow, as Cal asked for in that retest.
 */
import { test, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { NativeSession } from "./session.js";
import { launchInstalled, quit, type Launched } from "./app.js";
import {
  connected,
  disposableWorkspace,
  firstRunSetup,
  launchSample,
  openLaunchWork,
  runs,
  type Workspace,
} from "./flows.js";

const KEYRING_TITLE = "Keyring locked, not set up, or prompt cancelled";
const SAMPLE = "orca-beta-local-check";

test.describe.configure({ mode: "serial" });

let session: NativeSession;
let profile: string;
let chosen: Workspace;
let open: Launched | undefined;

test.beforeAll(async () => {
  session = await NativeSession.start();
  profile = await mkdtemp(join(session.root, "profile-"));
  chosen = await disposableWorkspace(session.root, session.env);
  await session.lockedKeyring();
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
});

test.afterAll(async () => {
  await session?.stop();
});

test("fresh install, cancel the keyring prompt: refused before send, no run", async () => {
  session.answerPrompts("cancel");
  open = await launchInstalled(session, profile);
  const { app, page } = open;
  await firstRunSetup(app, page, chosen);
  await openLaunchWork(page);

  const launch = page.getByRole("region", { name: "Guided launch" });
  // Opening Launch work reads the (absent) journal, which asks the keyring.
  await expect(page.getByText(/Secure run-intent storage is unavailable\. No run was submitted\./).first()).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByText(/quit and reopen ORCA/).first()).toBeVisible();
  expect(session.prompts.length).toBeGreaterThan(0);

  await launchSample(page);
  await expect(page.getByText(KEYRING_TITLE).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/No run was submitted/).first()).toBeVisible();
  await expect(page.getByText("The launch operation is unavailable")).toHaveCount(0);
  // A retry in the same process stays refused, so Linux is told to reopen instead.
  await expect(page.getByRole("button", { name: "Retry launch" })).toHaveCount(0);
  await expect(launch.getByRole("button", { name: "Recover original launch" })).toHaveCount(0);
  expect(await runs(page)).toEqual([]);
  await test.info().attach("cancelled-before-send", { body: await page.screenshot(), contentType: "image/png" });
});

test("reopen and unlock: the sample is admitted once and succeeds", async () => {
  session.answerPrompts("unlock");
  open = await launchInstalled(session, profile);
  const { page } = open;
  await connected(page);
  expect(await runs(page)).toEqual([]);
  await openLaunchWork(page);
  await expect(page.getByText(KEYRING_TITLE)).toHaveCount(0);

  await launchSample(page);
  await expect
    .poll(async () => (await runs(page)).map((run) => `${run.workflowId}:${run.status}`), { timeout: 60_000 })
    .toEqual([`${SAMPLE}:succeeded`]);
  // The unlock really went through the system prompt, not a keyring that was never locked.
  expect(session.prompts.at(-1)?.action).toBe("unlock");
});

test("reopen with the keyring unlocked: still exactly one run", async () => {
  const before = session.prompts.length;
  open = await launchInstalled(session, profile);
  const { page } = open;
  await connected(page);
  const list = await runs(page);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ workflowId: SAMPLE, status: "succeeded" });
  await openLaunchWork(page);
  await expect(page.getByText(KEYRING_TITLE)).toHaveCount(0);
  // Unlocked for the rest of this keyring daemon's life, as after a real unlock.
  expect(session.prompts.length).toBe(before);
});

test("locked again with a journal on disk, cancel: recovery only, nothing new admitted", async () => {
  await session.lockedKeyring();
  session.answerPrompts("cancel");
  open = await launchInstalled(session, profile);
  const { page } = open;
  await connected(page);
  await openLaunchWork(page);

  const launch = page.getByRole("region", { name: "Guided launch" });
  await expect(page.getByText(/An earlier launch may still exist; do not start new work/).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/No run was submitted/)).toHaveCount(0);

  // Trying anyway is refused without a send: recovery is the only way on.
  await launchSample(page);
  await expect(page.getByRole("button", { name: "Recover original launch" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(launch.getByRole("button", { name: "Launch", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry launch" })).toHaveCount(0);
  await expect(page.getByText(/No run was submitted/)).toHaveCount(0);

  const list = await runs(page);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ workflowId: SAMPLE, status: "succeeded" });
  await test.info().attach("cancelled-unconfirmed", { body: await page.screenshot(), contentType: "image/png" });
});
