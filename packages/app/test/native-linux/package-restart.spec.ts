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
 * - `update-handoff.json` written into the store naming the stopped version and the installed
 *   one, before the old app exits;
 * - the old app exiting and a new main process of the installed executable starting by itself;
 * - the new version's daemon spending the handoff (same store format: nothing to carry), which
 *   it does only under the proof: it holds the first-run fence, its claim follows the stopped
 *   daemon's, and it is the version the record names.
 *
 * The original package is reinstalled afterwards, so the other specs see the version under test.
 */
import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
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
    const handoffPath = join(chosen.workspace, ".orca", "update-handoff.json");
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
          handoff = await readFile(handoffPath, "utf8")
            .then((text) => JSON.parse(text) as typeof handoff)
            .catch(() => undefined);
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
      await expect
        .poll(
          () =>
            readFile(handoffPath).then(
              () => "present",
              () => "spent",
            ),
          { timeout: 90_000 },
        )
        .toBe("spent");
      watching = false;
      await watcher;
      expect(handoff, "update-handoff.json was written before the old app exited").toMatchObject({
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
}
