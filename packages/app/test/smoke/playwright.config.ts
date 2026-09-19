/**
 * Playwright's config for the Electron smoke test (`pnpm run app:smoke`).
 *
 * It lives here rather than at the repo root so that the root TypeScript project, whose
 * `include` already reaches every package's test folder, typechecks and lints it along
 * with the spec it configures.
 *
 * Only the Electron driver is used, so no browser project is declared and nothing needs
 * `playwright install`: the binary under test is the workspace's own `electron`
 * dependency. One worker, because there is one app, one daemon and one X display.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: new URL(".", import.meta.url).pathname,
  testMatch: "**/*.spec.ts",
  // Launching Electron, building a demo store and serving it is slower than a browser test;
  // the daemon's own startup has its own deadline inside `daemon.ts`.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: new URL("../../../../test-results/app-smoke", import.meta.url).pathname,
  use: { trace: "retain-on-failure" },
});
