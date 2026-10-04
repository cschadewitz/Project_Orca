/** Standalone Chromium fixture check. Launches Vite only; no Electron, daemon or resource transport. */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "resources-browser.spec.ts",
  outputDir: "/tmp/orca-resource-browser-results",
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:5274",
    viewport: { width: 1280, height: 960 },
    reducedMotion: "reduce",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  webServer: {
    command: "pnpm --filter @orca/app exec vite --host 127.0.0.1 --port 5274",
    cwd: "../../../..",
    url: "http://127.0.0.1:5274",
    reuseExistingServer: false,
  },
});
