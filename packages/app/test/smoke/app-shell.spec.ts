/**
 * The Electron smoke test: the built app, a real daemon, one window, both themes.
 *
 * Everything the renderer unit tests cannot reach is here — the preload actually being
 * loaded as CommonJS into a sandboxed window (#198), the main process actually reaching a
 * daemon over HTTP, the fonts and the stylesheet actually resolving off `file://`, and the
 * theme actually changing when a person presses the shortcut. None of that can fail in
 * happy-dom, and all of it has failed in an Electron window.
 *
 * It runs `pnpm run app:smoke`, from its own workflow (`.github/workflows/app-smoke.yml`)
 * and never from `ci.yml`, which sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and so has no
 * Electron to launch.
 *
 * Prerequisite: `pnpm run build`. The app under test is `dist/`, not the sources.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
// Named, not default: the package's types resolve as CommonJS, where the default import is
// the module namespace rather than the class.
import { AxeBuilder } from "@axe-core/playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDemoDaemon, type Daemon } from "./daemon.js";

/**
 * What the renderer sees on `window`. Declared here rather than imported: the bridge's types
 * belong to the renderer's TypeScript project, and this spec is compiled by the root one.
 */
interface SmokeWindow {
  orca?: {
    platform: string;
    hello: () => Promise<{ ok: true; result: { capabilities: string[] } } | { ok: false; error: unknown }>;
  };
}

/** The app directory Electron is pointed at; its `main` field is `dist/main/index.js`. */
const appDir = new URL("../../", import.meta.url).pathname;

/**
 * The OS-level Chromium sandbox needs unprivileged user namespaces, which a plain container
 * usually does not have — hence the opt-out for a local run. It is *not* set in CI, where
 * the workflow clears the AppArmor restriction instead and the real sandbox stays on.
 *
 * This is unrelated to `webPreferences.sandbox: true`, which is the renderer's isolation
 * from Node and stays on everywhere; the smoke test would be pointless without it, since
 * that is the mode in which an ESM preload silently fails to install `window.orca`.
 */
const osSandboxArgs = process.env.ORCA_SMOKE_NO_SANDBOX ? ["--no-sandbox"] : [];

let daemon: Daemon;
let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  daemon = await startDemoDaemon();

  // `ELECTRON_RUN_AS_NODE` makes the binary behave as a bare Node and never open a window.
  // Some agent and CI environments export it, so it is stripped rather than assumed absent.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.ORCA_DAEMON_URL = daemon.url;

  // A throwaway user-data directory, so `preferences.json` starts empty. Without it the app
  // would read whatever the previous run left behind and the theme cycle below would start
  // from somewhere else — which is exactly how this test first failed.
  userData = await mkdtemp(join(tmpdir(), "orca-smoke-profile-"));

  app = await electron.launch({ args: [...osSandboxArgs, `--user-data-dir=${userData}`, appDir], env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  await daemon?.stop();
  if (userData) await rm(userData, { recursive: true, force: true });
});

test("the window comes up on the built renderer with a bridge in it", async () => {
  expect(await page.title()).toBe("ORCA");

  // The preload is the whole point: a sandboxed window with an ESM preload has no
  // `window.orca` at all, and every screen below would then render "disconnected".
  const bridge = await page.evaluate(() => {
    const { orca } = window as unknown as SmokeWindow;
    return {
      present: typeof orca === "object",
      platform: orca?.platform,
      methods: orca ? Object.keys(orca).sort() : [],
    };
  });
  expect(bridge.present).toBe(true);
  expect(bridge.platform).toBe(process.platform);
  // Exact, not a superset: this list is everything the sandboxed renderer can reach, and
  // widening it is the kind of change that should have to be written down (ADR 0008).
  // Add the key here in the same PR that adds it to `src/bridge.ts`.
  expect(bridge.methods).toEqual([
    "agents",
    "alerts",
    "artifacts",
    "claims",
    "connection",
    "deepLink",
    "hello",
    "inputs",
    "notifications",
    "platform",
    "preferences",
    "runs",
    "workspace",
  ]);

  // Renderer assets really loaded off file://, rather than the CSP blocking them.
  await expect(page.locator(".orca-body")).toBeVisible();
});

test("the handshake reaches the daemon, and the status bar says which one", async () => {
  // The main process handshakes as soon as its subscription becomes a stream (#163); the
  // version in the status bar is that answer travelling renderer ← preload ← main ← HTTP,
  // pushed over the `connection` channel, which is the whole connection path.
  await expect(page.locator(".orca-statusbar")).toContainText(/orca-daemon \d+\.\d+\.\d+/);
  await expect(page.getByText("disconnected")).toHaveCount(0);

  const hello = await page.evaluate(() => (window as unknown as SmokeWindow).orca!.hello());
  expect(hello.ok).toBe(true);
  expect(hello.ok && hello.result.capabilities).toContain("runs.read");
});

// `test.info()` rather than the second callback argument: taking that argument means
// declaring the first one too, and Playwright insists it be a destructuring pattern —
// which for a test using no fixtures can only be the empty one ESLint rejects.
test("both themes render, and the shortcut is what switches them", async () => {
  const testInfo = test.info();
  const canvas = () =>
    page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      canvas: getComputedStyle(document.documentElement).getPropertyValue("--surface-canvas").trim(),
      ink: getComputedStyle(document.body).color,
    }));

  // No preference yet, so no attribute: the app is following the OS. Asserted rather than
  // assumed, because the cycle below counts presses from here.
  expect((await canvas()).theme).toBeNull();

  const shots: Record<string, { canvas: string; ink: string }> = {};
  // ⌘⇧L / Ctrl+⇧L cycles system → light → dark (renderer/src/appearance.ts).
  for (const theme of ["light", "dark"]) {
    await page.keyboard.press("ControlOrMeta+Shift+KeyL");
    await expect.poll(async () => (await canvas()).theme).toBe(theme);

    const state = await canvas();
    shots[theme] = { canvas: state.canvas, ink: state.ink };
    // Attached to the report rather than committed: a screenshot is evidence when this
    // fails, not a fixture to diff against. There is no golden image here on purpose —
    // fonts and subpixel rendering differ between this box and a runner.
    await testInfo.attach(`${theme}.png`, {
      body: await page.screenshot({ path: testInfo.outputPath(`${theme}.png`), fullPage: true }),
      contentType: "image/png",
    });
  }

  // Each theme resolved a real token, and the two are genuinely different: a `data-theme`
  // that changed while the cascade did not would pass the attribute check alone.
  expect(shots.light?.canvas).toMatch(/^#[0-9a-f]{6}$/i);
  expect(shots.dark?.canvas).toMatch(/^#[0-9a-f]{6}$/i);
  expect(shots.light?.canvas).not.toBe(shots.dark?.canvas);
  expect(shots.light?.ink).not.toBe(shots.dark?.ink);
});

for (const theme of ["light", "dark"] as const) {
  test(`the shell has no accessibility violations in ${theme}`, async () => {
    const testInfo = test.info();
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);

    // `setLegacyMode` is not about old axe: it stops AxeBuilder opening a second page to
    // scan cross-origin frames with, and Electron's context refuses `newPage` ("Target.
    // createTarget: Not supported"). The app has no frames, so there is nothing to lose.
    const results = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    await testInfo.attach(`axe-${theme}.json`, {
      body: JSON.stringify(results.violations, null, 2),
      contentType: "application/json",
    });
    // The message carries the rule ids, so a red run says what broke without opening the report.
    expect(results.violations.map((violation) => `${violation.id} (${violation.nodes.length})`)).toEqual([]);
  });
}
