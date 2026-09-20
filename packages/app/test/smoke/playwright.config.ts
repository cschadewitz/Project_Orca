/**
 * Playwright's config for the two Electron specs.
 *
 * It lives here rather than at the repo root so that the root TypeScript project, whose
 * `include` already reaches every package's test folder, typechecks and lints it along
 * with the specs it configures.
 *
 * Only the Electron driver is used, so no browser project is declared and nothing needs
 * `playwright install`: the binary under test is the workspace's own `electron`
 * dependency. One worker, because there is one app, one daemon and one X display.
 *
 * ## Two projects, because they are two jobs
 *
 * - **`smoke`** (`pnpm run app:smoke`) launches the *built* app against a real daemon and
 *   audits every surface. It runs on Linux only: what it is about is the app coming up at
 *   all, and three runners would be paying three times for one answer.
 * - **`type-proof`** (`pnpm run app:type-proof`) launches the renderer's dev server at
 *   `#type` and diffs committed per-platform screenshots. It runs on all three runners,
 *   because "do the bundled faces render the same on Linux, macOS and Windows" is a
 *   question only three machines can answer (#213).
 *
 * Two projects rather than two config files is what lets the workflow say `--project=<name>`
 * and lets `toHaveScreenshot` put the project's name in a baseline's filename, beside the
 * platform it already puts there.
 */
import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, never `new URL(...).pathname` — on Windows the latter yields
// `/D:/a/Project_Orca/...`, with a leading slash before the drive letter, which Playwright
// resolves against the cwd into `D:\D:\a\Project_Orca\...`. The first run of the three-OS
// type-proof job found this the only way it can be found: Linux and macOS were fine and
// Windows reported "No tests found" and an ENOENT on a doubled drive letter. `vitest.config.ts`
// already uses this helper for the same reason.
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  testDir: here("."),
  // Launching Electron, building a demo store and serving it is slower than a browser test;
  // the daemon's own startup has its own deadline inside `daemon.ts`, and the type proof
  // compiles main and preload and starts a Vite dev server before its first test.
  timeout: 180_000,
  expect: {
    timeout: 15_000,
    /**
     * A budget for the runner image moving under us, and nothing more.
     *
     * Antialiasing along a few edges is what a graphics driver or a Chromium point release
     * can move without anything being wrong. A face falling through to the OS changes whole
     * words and is orders of magnitude above this. When a diff does not fit here the answer
     * is a **deliberate baseline update with the reason in the commit message** — never a
     * larger number. `docs/DEVELOPMENT.md` says so at more length, because this is the line
     * that gets quietly raised.
     */
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", scale: "css" },
  },
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: here("../../../../test-results/app-smoke"),
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "smoke", testMatch: "app-shell.spec.ts" },
    {
      name: "type-proof",
      testMatch: "type-proof.spec.ts",
      /**
       * Headroom over `smoke`'s budget, because this project's `beforeAll` also builds
       * preload with `tsc -b` and starts a Vite dev server before it launches anything.
       *
       * **An earlier version of this comment blamed the Windows timeout on that cold start,
       * and was wrong** — worth recording, because the log reads as though it were right.
       * The first Windows run printed `Downloading Electron binary...` and then Vite's
       * `[optimizer] scanning dependencies`, and stopped there for 174 seconds, which looks
       * like a dev server that never finished. The trace says otherwise: the one call that
       * was entered and never returned is `Launch electron`, at +5.9s. `createServer` and
       * `listen` had already resolved by then, and the optimizer line is the dev server's
       * background dependency scan, which does not block. Vite was never the cost.
       *
       * What was: `node_modules/electron/index.js` downloads the binary on first `require`
       * if the postinstall never placed it, through a *synchronous* `spawnSync`. That is why
       * the hook went quiet — and why no budget here is the real fix. `app-smoke.yml` now
       * puts the binary on disk in its own step, where the download has no hook timeout over
       * it and its own duration is legible.
       *
       * So this number is insurance on a genuinely cold runner and nothing more. It is not
       * the same kind of number as `maxDiffPixelRatio` above: raising *that* would hide a
       * real rendering change, whereas a hook that needs four minutes once is just a hook
       * that needs four minutes. If a run exceeds this, read the trace for the call that
       * never returned before touching the number — that is what found this one.
       */
      timeout: 300_000,
    },
  ],
});
