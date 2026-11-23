/**
 * #905 on the installed package: `apt` upgrades `orca-desktop` beneath the running app, and
 * "Restart to finish update" hands the workspace store to the installed version and starts it.
 *
 * Needs two regression packages of this ref: `ORCA_NATIVE_CURRENT_DEB` (installed before the
 * suite runs) and `ORCA_NATIVE_NEXT_DEB`, the same build stamped with a higher version. The
 * spec completes first-run setup so the bundled daemon owns an app workspace, upgrades with
 * `sudo apt-get install` underneath the running app, waits for the title-bar offer, clicks it,
 * and requires:
 *
 * - `update-handoff.json.<claim>` published into the store naming the stopped version and the installed
 *   one, before the old app exits;
 * - the old app exiting and a new main process of the installed executable starting by itself;
 * - the new version's daemon spending the handoff (same store format: nothing to carry), which
 *   it does only under the proof: it holds the first-run fence, its claim follows the stopped
 *   daemon's, and it is the version the record names.
 *
 * A second launch, with no app workspace to hand off, follows the offer as apt moves the package
 * up, back and up again, then clicks it: the handoff is refused after the stop, so nothing new
 * starts, the old app stays with admission closed, and its message names the recovery
 * (quit and reopen; else reinstall the running version with apt).
 *
 * The original package is reinstalled afterwards, so the other specs see the version under test.
 */
import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { NativeSession } from "./session.js";
import { commandLine, installedProcesses, launchInstalled, noneLeft } from "./app.js";
import { disposableWorkspace, firstRunSetup } from "./flows.js";

const execute = promisify(execFile);
const CURRENT_DEB = process.env.ORCA_NATIVE_CURRENT_DEB;
const NEXT_DEB = process.env.ORCA_NATIVE_NEXT_DEB;

let session: NativeSession;

const debVersion = async (deb: string) =>
  (await execute("dpkg-deb", ["-f", deb, "Version"])).stdout.trim().replace("~", "-");
const apt = (deb: string) =>
  execute("sudo", ["apt-get", "install", "-y", "-q", "--allow-downgrades", deb], { timeout: 180_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Main (not helper) processes of the installed executable that are not `exclude`. */
async function mainProcesses(exclude: number): Promise<number[]> {
  const out: number[] = [];
  for (const pid of await installedProcesses())
    if (pid !== exclude && !(await commandLine(pid)).includes("--type=")) out.push(pid);
  return out;
}

// Defined only with both packages: a local run of the suite without them has nothing to upgrade.
if (CURRENT_DEB && NEXT_DEB) defineUpgradeTest();

function defineUpgradeTest(): void {
  test.beforeAll(async () => {
    session = await NativeSession.start();
    session.answerPrompts("unlock");
  });
  test.afterAll(async () => {
    await session?.stop();
  });

  test("an apt upgrade beneath the running app is finished by the restart, which hands the store over", async () => {
    test.setTimeout(420_000);
    const next = await debVersion(NEXT_DEB!);
    await noneLeft();
    const profile = await mkdtemp(join(session.root, "profile-restart-"));
    const chosen = await disposableWorkspace(session.root, session.env);
    const launched = await launchInstalled(session, profile, "x11");
    const oldPid = launched.app.process().pid!;
    const store = join(chosen.workspace, ".orca");
    // One record per stopped claim: `update-handoff.json.<claimHash>`.
    const handoffPath = async () =>
      (await readdir(store).catch(() => [] as string[]))
        .filter((name) => /^update-handoff\.json\.[0-9a-f]{64}$/.test(name))
        .map((name) => join(store, name))[0];
    try {
      const current = await launched.app.evaluate(({ app }) => app.getVersion());
      expect(next).not.toBe(current);
      await firstRunSetup(launched.app, launched.page, chosen);

      await apt(NEXT_DEB!);
      const restart = launched.page.getByRole("button", { name: `Restart to finish update to ${next}` });
      // dpkg's status is read every 30 s.
      await expect(restart).toBeVisible({ timeout: 75_000 });
      await test.info().attach("restart-offer", { body: await launched.page.screenshot(), contentType: "image/png" });

      // The record exists only between the old daemon's stop and the new daemon's start: watch.
      let handoff: { from?: string; to?: string; drained?: boolean } | undefined;
      let watching = true;
      const watcher = (async () => {
        while (watching && !handoff) {
          const path = await handoffPath();
          handoff = path
            ? await readFile(path, "utf8")
                .then((text) => JSON.parse(text) as typeof handoff)
                .catch(() => undefined)
            : undefined;
          await sleep(20);
        }
      })();
      const exited = new Promise<void>((resolve) => launched.app.process().once("exit", () => resolve()));
      await restart.click();
      await Promise.race([
        exited,
        sleep(60_000).then(() => {
          throw new Error("The old app did not exit within 60 s of Restart to finish update");
        }),
      ]);

      // The installed version starts by itself (app.relaunch), with no Playwright attached.
      let relaunched: number | undefined;
      const deadline = Date.now() + 60_000;
      while (!relaunched && Date.now() < deadline) {
        relaunched = (await mainProcesses(oldPid))[0];
        if (!relaunched) await sleep(250);
      }
      expect(relaunched, "a new ORCA main process after the restart").toBeDefined();
      // Its daemon spends the record it was handed, once it has proved the claim chain.
      await expect.poll(async () => ((await handoffPath()) ? "present" : "spent"), { timeout: 90_000 }).toBe("spent");
      watching = false;
      await watcher;
      expect(handoff, "the handoff record was published before the old app exited").toMatchObject({
        from: current,
        to: next,
        drained: true,
      });

      // Close the relaunched app the way a person does.
      const [window] = await session.visibleWindows("^ORCA$");
      if (window) await session.key(window, "ctrl+q");
      await noneLeft(30_000).catch(async (error: unknown) => {
        for (const pid of await installedProcesses()) process.kill(pid, "SIGKILL");
        throw error;
      });
    } finally {
      await launched.app.close().catch(() => undefined);
      for (const pid of await installedProcesses()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await apt(CURRENT_DEB!);
    }
  });

  test("the offer follows apt, and a restart the handoff refuses starts nothing and keeps the app", async () => {
    test.setTimeout(420_000);
    const next = await debVersion(NEXT_DEB!);
    await noneLeft();
    const profile = await mkdtemp(join(session.root, "profile-refused-"));
    // No first-run setup: there is no app-owned workspace whose daemon could be handed off.
    const launched = await launchInstalled(session, profile, "x11");
    const oldPid = launched.app.process().pid!;
    try {
      const current = await launched.app.evaluate(({ app }) => app.getVersion());
      const offer = launched.page.getByRole("button", { name: `Restart to finish update to ${next}` });
      await apt(NEXT_DEB!);
      await expect(offer).toBeVisible({ timeout: 75_000 });
      // apt moves back to the running version: the offer goes away.
      await apt(CURRENT_DEB!);
      await expect(offer).toHaveCount(0, { timeout: 75_000 });
      await apt(NEXT_DEB!);
      await expect(offer).toBeVisible({ timeout: 75_000 });
      await offer.click();
      // Refused after the stop: nothing starts, the old app stays, and the person is told how
      // to recover without assuming this version can be reopened from /opt/ORCA.
      await expect(launched.page.getByRole("button", { name: `Restart to finish update to ${next}` })).toHaveAttribute(
        "title",
        new RegExp(`could not be given this workspace's data safely.*reinstall ORCA ${current.replace(/\./g, "\\.")}`),
        { timeout: 30_000 },
      );
      await sleep(5_000);
      expect(await mainProcesses(oldPid)).toEqual([]);
      expect(launched.app.process().exitCode).toBeNull();
      await test.info().attach("refused-handoff", { body: await launched.page.screenshot(), contentType: "image/png" });
    } finally {
      await launched.app.close().catch(() => undefined);
      for (const pid of await installedProcesses()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await apt(CURRENT_DEB!);
    }
  });
}
