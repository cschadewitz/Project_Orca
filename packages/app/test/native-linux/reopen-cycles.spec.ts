/**
 * #858 on the installed package: quit and reopen, over and over, on X11 and on Wayland, and
 * require a visible window every time and no process left after every quit.
 *
 * #858's window was created hidden and shown on `ready-to-show`, which a hidden Wayland
 * toplevel may never get. It was intermittent and never reproduced under Xvfb, so this
 * runs on a headless Weston as well, and repeats (`ORCA_NATIVE_CYCLES`, default 5) because
 * one good launch proves little about an intermittent failure. Retries stay off for the
 * same reason: a retry is exactly what would hide it.
 *
 * "Visible" is the main process's `BrowserWindow.isVisible()`, not Playwright's
 * `firstWindow()`, which resolves as soon as the window exists. On X11 the window must also
 * be mapped, by name, as the X server sees it.
 *
 * The app is given an explicit workspace (`ORCA_WORKSPACE`), so it starts its bundled daemon
 * and each quit also has to take that daemon down.
 */
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { NativeSession } from "./session.js";
import { launchInstalled, noneLeft, quit, VISIBLE_BUDGET_MS, type Backend } from "./app.js";
import { connected } from "./flows.js";

const CYCLES = Number(process.env.ORCA_NATIVE_CYCLES ?? 5);

let session: NativeSession;

test.beforeAll(async () => {
  session = await NativeSession.start();
  // Nothing here should need the keyring; if something asks anyway, it is refused, never hung.
  session.answerPrompts("cancel");
});

test.afterAll(async () => {
  await session?.stop();
});

for (const backend of ["x11", "wayland"] as Backend[]) {
  test(`${backend}: ${CYCLES} quit/reopen cycles each show the window and leave nothing running`, async () => {
    test.setTimeout(CYCLES * 60_000);
    await noneLeft();
    const profile = await mkdtemp(join(session.root, `profile-${backend}-`));
    const workspace = join(session.root, `workspace-${backend}`);
    await mkdir(workspace, { recursive: true });
    const timings: number[] = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await test.step(`cycle ${cycle}`, async () => {
        const launched = await launchInstalled(session, profile, backend, { ORCA_WORKSPACE: workspace });
        try {
          timings.push(launched.msToVisible);
          expect(launched.msToVisible).toBeLessThanOrEqual(VISIBLE_BUDGET_MS);
          if (backend === "x11") expect(await session.visibleWindows("^ORCA$")).toHaveLength(1);
          await connected(launched.page);
          // The window is usable, not just mapped: the shell rendered and answers.
          await expect(launched.page.getByRole("navigation", { name: "Surfaces" })).toBeVisible();
          if (cycle === 1)
            await test.info().attach(`${backend}-window`, {
              body: await launched.page.screenshot(),
              contentType: "image/png",
            });
        } catch (error) {
          await launched.app.close().catch(() => undefined);
          throw error;
        }
        await quit(session, launched, backend);
      });
    }
    await test.info().attach(`${backend}-timings.json`, {
      body: JSON.stringify({ backend, cycles: CYCLES, msToVisible: timings }),
      contentType: "application/json",
    });
  });
}
