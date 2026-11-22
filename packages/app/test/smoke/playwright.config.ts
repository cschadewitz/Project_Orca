/**
 * Playwright's config for the Electron smoke, type and native acceptance specs.
 *
 * It lives here rather than at the repo root so that the root TypeScript project, whose
 * `include` already reaches every package's test folder, typechecks and lints it along
 * with the specs it configures.
 *
 * Only the Electron driver is used, so no browser project is declared and nothing needs
 * `playwright install`: the binary under test is the workspace's own `electron`
 * dependency. One worker, because there is one app, one daemon and one X display.
 *
 * ## Separate projects for independent checks
 *
 * - **`smoke`** (`pnpm run app:smoke`) launches the *built* app against a real daemon and
 *   audits every surface. It runs on Linux only: what it is about is the app coming up at
 *   all, and three runners would be paying three times for one answer.
 * - **`upgrade-launch`** (`pnpm run app:upgrade-launch`) opens the built app on a store that
 *   ORCA 0.6.0 wrote, served by this commit's daemon (#863). Unlike the projects here it
 *   runs in `ci.yml` on pull requests, because it is small and an upgrade break is the kind
 *   nothing else catches before a release.
 * - **`type-proof`** (`pnpm run app:type-proof`) launches the renderer's dev server at
 *   `#type` and diffs committed per-platform screenshots. It runs on all three runners,
 *   because "do the bundled faces render the same on Linux, macOS and Windows" is a
 *   question only three machines can answer (#213).
 * - **`admission-intents`** launches the built app twice against one authenticated daemon
 *   and one disposable profile. Native safeStorage must encrypt and decrypt its retained
 *   intent across process exit. The existing macOS/Windows jobs run this independent gate.
 *
 * - **`revision-workflow`** uses real UI controls and a protected daemon for revision
 *   save/restart/CAS/review/delivery acceptance, on those same macOS/Windows runners.
 *
 * - **`linux-native`** (`pnpm run app:linux-native`) drives the *installed* `.deb` from
 *   `/opt/ORCA` in a disposable desktop session: Xvfb and headless Weston, a session bus, a
 *   locked GNOME keyring and its real unlock prompt (#857, #858). Linux only, on a
 *   GitHub-hosted runner; `packages/app/test/native-linux/README.md` has the details.
 *
 * - **`windows-update`** (`pnpm run app:windows-update`) updates an *installed* Windows
 *   build from N to N+1 through a local copy of the feed Worker (#863), in
 *   `feed-update-e2e.yml` on a GitHub-hosted Windows runner.
 *
 * Separate projects in one config let the workflow say `--project=<name>`
 * and lets `toHaveScreenshot` put the project's name in a baseline's filename, beside the
 * platform it already puts there.
 *
 * ## Two things this file briefly said, and does not say any more
 *
 * The first Windows run of `type-proof` timed out in `beforeAll` at 180s with a log that
 * ended on Vite's `[optimizer] scanning dependencies`, and this project was given a 300s
 * budget for a cold start. It was not a cold start. With the larger budget the failure
 * renamed itself `electron.launch: Timeout 180000ms exceeded` — Playwright's own cap on the
 * launch call — and the trace had said so from the beginning: one call entered and never
 * returned, `Launch electron`, at +5.9s, with `createServer` and `listen` already resolved
 * behind it. The 300s is gone; Linux runs this hook in about 50s and macOS in about 30s, so
 * the shared budget was never the constraint.
 *
 * The second guess was that `electron.launch` was blocking on the binary download that
 * `node_modules/electron/index.js` does on first `require` — real, and worth keeping out of
 * a test hook, which is why `app-smoke.yml` now has a step for it. Also not the cause: that
 * step takes five seconds on Windows. The cause was a trailing path separator, and it is
 * written up where it lives, at the top of `type-proof.spec.ts`.
 *
 * Both are recorded because the logs will look like both again. A timeout that moves when
 * you raise it is naming a different call, not asking for a bigger number.
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
  // The default HTML folder is relative to the nearest package.json (packages/app),
  // while the workflow uploads the repo-root folder. Pin it so passing attachments
  // survive too; native acceptance's explicit output-directory environment still wins.
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: here("../../../../playwright-report") }]]
    : [["list"]],
  outputDir: here("../../../../test-results/app-smoke"),
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "smoke", testMatch: "app-shell.spec.ts" },
    { name: "upgrade-launch", testMatch: "upgrade-launch.spec.ts" },
    {
      name: "type-proof",
      testMatch: "type-proof.spec.ts",
    },
    {
      name: "admission-intents",
      testMatch: "admission-intents.spec.ts",
      outputDir: here("../../../../test-results/admission-intents"),
      // Only allowlisted evidence is attached. Never archive a profile, daemon store,
      // token file, protected journal, main-process arguments or network payloads.
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "revision-workflow",
      testMatch: "revision-workflow.spec.ts",
      outputDir: here("../../../../test-results/revision-workflow"),
      // Synthetic public IDs, hashes, booleans and counts only; no protected content.
      use: { trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "windows-update",
      testDir: here("../windows-update"),
      testMatch: "*.spec.ts",
      outputDir: here("../../../../test-results/windows-update"),
      // The feed tokens are files the spec only names; never record requests or a profile.
      use: { trace: "off", video: "off", screenshot: "off" },
    },
    {
      name: "linux-native",
      testDir: here("../native-linux"),
      testMatch: "*.spec.ts",
      outputDir: here("../../../../test-results/linux-native"),
      // Screenshots of ORCA's own window only; never a profile, keyring or daemon store.
      use: { trace: "off", video: "off" },
    },
  ],
});
