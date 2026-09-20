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

export default defineConfig({
  testDir: new URL(".", import.meta.url).pathname,
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
  outputDir: new URL("../../../../test-results/app-smoke", import.meta.url).pathname,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "smoke", testMatch: "app-shell.spec.ts" },
    { name: "type-proof", testMatch: "type-proof.spec.ts" },
  ],
});
