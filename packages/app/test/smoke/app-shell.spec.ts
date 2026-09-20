/**
 * The Electron smoke test: the built app, a real daemon, one window, both themes, every
 * surface that has been built.
 *
 * Everything the renderer unit tests cannot reach is here — the preload actually being
 * loaded as CommonJS into a sandboxed window (#198), the main process actually reaching a
 * daemon over HTTP, the fonts and the stylesheet actually resolving off `file://`, and the
 * theme actually changing when a person presses the shortcut. None of that can fail in
 * happy-dom, and all of it has failed in an Electron window.
 *
 * It runs `pnpm run app:smoke` (the `smoke` Playwright project), from its own workflow
 * (`.github/workflows/app-smoke.yml`) and never from `ci.yml`, which sets
 * `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and so has no Electron to launch.
 *
 * ## On screenshots, which this file takes two kinds of
 *
 * **Nothing here is a golden image, and that is deliberate.** Every screenshot this spec
 * takes is attached to the report as *evidence* — what the window looked like when an
 * assertion about it failed — and none is committed or diffed. The app's chrome is drawn
 * with the operating system's text rendering over data with real timestamps in it, so
 * fonts and subpixel rendering differ between a developer's box and a runner and a pixel
 * baseline would fail for reasons that are not bugs.
 *
 * **`type-proof.spec.ts` is the opposite case and has real baselines**, which is the whole
 * point of #213: `#type` renders the bundled faces and the declared glyphs and nothing
 * else, with no clock in it, and a glyph that falls through to the OS is *invisible* to
 * every assertion except a picture. So that spec commits per-platform baselines and diffs
 * against them, and this one does not. If you are looking at one of the two and think the
 * other is a mistake, it is not — see `docs/DEVELOPMENT.md`, "Screenshot baselines".
 *
 * Prerequisite: `pnpm run build`. The app under test is `dist/`, not the sources.
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
// Named, not default: the package's types resolve as CommonJS, where the default import is
// the module namespace rather than the class.
import { AxeBuilder } from "@axe-core/playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The design system's own presentation maps, so the greyscale check compares the screen
// against the source of truth rather than against a second list of glyphs written here
// (RULES.md rule 3). This resolves to the built `dist`, which `pnpm run build` produces.
import { CONNECTION_PRESENTATION, STATUS_PRESENTATION, type RunStatus } from "@orca/design";
import { FIXTURE, startDemoDaemon, type Daemon } from "./daemon.js";

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

/** The two themes, in the order the shortcut cycles them. */
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/**
 * The surfaces axe is run over, with the digit `renderer/src/chrome/surfaces.ts` gives each
 * one and something to wait for that only exists once the surface has *data*.
 *
 * The wait is the point. Every one of these screens renders a `StateView` while it loads
 * and another if the daemon will not answer, and auditing either of those would be auditing
 * a spinner: three rules pass trivially on a page with one `role="status"` on it. So each
 * entry names a node that only the real content produces, and the demo store plus the
 * fixture in `daemon.ts` is what guarantees there is some.
 */
const AUDITED = [
  {
    id: "attention",
    shortcut: 1,
    /* The parked gate the fixture starts. Without it Attention is "nothing needs you" and
       the audit would never see a `GateCard` at all. */
    ready: ".orca-attn__cards .orca-attn__card",
  },
  { id: "runs", shortcut: 2, ready: ".orca-runs__tree .orca-tree-row" },
  { id: "agents", shortcut: 4, ready: ".orca-agents__host .orca-agent" },
] as const;

/**
 * Plan and Config, which are `StateView`s in v0.4.0 and are asserted as such below rather
 * than audited. A surface that says "this has not been built yet" would pass an axe run
 * and mean nothing by it; when one of them grows content, the assertion fails and whoever
 * built it moves the entry up into `AUDITED`.
 */
const UNBUILT = [
  { id: "plan", shortcut: 3, label: "Plan" },
  { id: "config", shortcut: 5, label: "Config" },
] as const;

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
    // Attached to the report rather than committed: see the file header. A screenshot of
    // the app is evidence when this fails, not a fixture to diff against.
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

/* ---------------------------------------------------------------- the surfaces */

/** Put the window on a surface the way a person does — ⌘<n> — and wait for it to arrive. */
async function gotoSurface(id: string, shortcut: number): Promise<Locator> {
  await page.keyboard.press(`ControlOrMeta+Digit${shortcut}`);
  const pane = page.locator(`main.orca-main[data-surface="${id}"]`);
  await expect(pane).toBeVisible();
  return pane;
}

/** Draw the whole window in one theme, whatever the preference cycle left behind. */
async function setTheme(theme: Theme): Promise<void> {
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
}

for (const surface of AUDITED) {
  for (const theme of THEMES) {
    test(`${surface.id} has no accessibility violations in ${theme}`, async () => {
      const testInfo = test.info();
      await setTheme(theme);
      await gotoSurface(surface.id, surface.shortcut);
      // The surface with its data in it, not its loading state — see `AUDITED`.
      await expect(page.locator(surface.ready).first()).toBeVisible();

      // `setLegacyMode` is not about old axe: it stops AxeBuilder opening a second page to
      // scan cross-origin frames with, and Electron's context refuses `newPage` ("Target.
      // createTarget: Not supported"). The app has no frames, so there is nothing to lose.
      const results = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      await testInfo.attach(`axe-${surface.id}-${theme}.json`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: "application/json",
      });
      // The message carries the rule ids, so a red run says what broke without opening the
      // report. It is the whole shell that is scanned, not just the pane: the title bar,
      // the sidebar and the status bar are on screen with every surface and a violation in
      // one of them is a violation a person meets there.
      expect(results.violations.map((violation) => `${violation.id} (${violation.nodes.length})`)).toEqual([]);
    });
  }
}

test("Plan and Config are unbuilt, and are not being passed off as audited", async () => {
  for (const surface of UNBUILT) {
    const pane = await gotoSurface(surface.id, surface.shortcut);
    /* `StateView kind="empty"`, with the surface's own label and the sentence `App.tsx`
       gives it. Asserted rather than skipped silently, so that the day one of these grows
       a screen this test fails and says which one — that is when it joins `AUDITED`. */
    const state = pane.locator(".orca-state.orca-state--empty");
    await expect(state).toBeVisible();
    await expect(state).toContainText(surface.label);
    await expect(state).toContainText("This surface has not been built yet.");
  }
});

/* ---------------------------------------------------------------- greyscale (#167) */

/** One status indicator as it is actually drawn: which status, its glyph, and its word. */
interface StatusMark {
  status: string;
  glyph: string;
  word: string;
}

/**
 * Every `StatusChip` inside `region`, read out of the DOM.
 *
 * The word is the visible label when there is one and the chip's own `aria-label` when the
 * chip is `glyphOnly` — which is the contract `StatusChip` documents: the word leaves the
 * page but never the accessible name. `orca-chip--plain` and `orca-chip--glyph-only` are
 * not statuses and are dropped here, so a new modifier class cannot quietly become one.
 */
async function statusMarks(region: Locator): Promise<StatusMark[]> {
  return region.locator(".orca-chip").evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const modifiers = [...node.classList]
          .filter((c) => c.startsWith("orca-chip--"))
          .map((c) => c.slice("orca-chip--".length))
          .filter((c) => c !== "plain" && c !== "glyph-only");
        return {
          status: modifiers[0] ?? "",
          glyph: node.querySelector(".orca-chip__glyph")?.textContent?.trim() ?? "",
          word: (node.querySelector(".orca-chip__label")?.textContent ?? node.getAttribute("aria-label") ?? "").trim(),
        };
      })
      .filter((mark) => mark.status !== ""),
  );
}

/**
 * The guarantee greyscale is about: a status is readable with the colour taken away.
 *
 * Colour is the third channel and never the only one (RULES.md rule 4), so what has to be
 * true of every status on screen is that it carries the glyph *and* the word the design
 * system declares for it. Checked against `STATUS_PRESENTATION` rather than against a copy:
 * a chip drawing some other glyph is as wrong as one drawing none, and only the real map
 * can say so.
 */
function expectLegibleInGreyscale(marks: StatusMark[], where: string): void {
  expect(marks.length, `${where} rendered no status at all, so there is nothing to prove`).toBeGreaterThan(0);
  const wrong = marks
    .filter((mark) => {
      const declared = STATUS_PRESENTATION[mark.status as RunStatus] as { glyph: string; word: string } | undefined;
      return declared === undefined || mark.glyph !== declared.glyph || mark.word !== declared.word;
    })
    .map((mark) => `${mark.status}: glyph ${JSON.stringify(mark.glyph)}, word ${JSON.stringify(mark.word)}`);
  expect(wrong, `${where} drew a status that colour alone would have to carry`).toEqual([]);
}

for (const theme of THEMES) {
  test(`statuses survive greyscale on every list in ${theme}`, async () => {
    const testInfo = test.info();
    await setTheme(theme);

    /* Paint the window greyscale for the pictures below. It is applied before the reads as
       well as before the screenshots on purpose: whatever this test asserts, it asserts
       about the same rendering a person is looking at in the attachment. */
    await page.evaluate(() => document.documentElement.style.setProperty("filter", "grayscale(1)"));

    const shoot = async (name: string): Promise<void> => {
      await testInfo.attach(`greyscale-${name}-${theme}.png`, {
        body: await page.screenshot({ path: testInfo.outputPath(`greyscale-${name}-${theme}.png`), fullPage: true }),
        contentType: "image/png",
      });
    };

    try {
      // The attention list: the fixture's parked gate above, its failed run below.
      const attention = await gotoSurface("attention", 1);
      await expect(attention.locator(".orca-attn__cards .orca-attn__card").first()).toBeVisible();
      await expect(attention.getByText(FIXTURE.gate.question)).toBeVisible();
      expectLegibleInGreyscale(
        await statusMarks(attention.locator('section[aria-label="Failed runs"]')),
        "the attention list's failures",
      );
      await shoot("attention");

      // The run tree: the demo's completed program beside the fixture's two runs, so there
      // is more than one status on screen and "distinguishable" means something.
      const runs = await gotoSurface("runs", 2);
      const tree = runs.locator(".orca-runs__tree");
      await expect(tree.locator(".orca-tree-row").first()).toBeVisible();
      const marks = await statusMarks(tree);
      expectLegibleInGreyscale(marks, "the run tree");
      expect(
        new Set(marks.map((m) => m.status)).size,
        "the run tree showed one status, so nothing was being told apart",
      ).toBeGreaterThan(1);
      await shoot("run-tree");

      /* The status bar: a connection state, which is the same rule on a different map —
         `ConnectionIndicator` draws the glyph `aria-hidden` beside the word, so greyscale
         leaves the glyph and a screen reader hears the word. */
      const connection = page.locator(".orca-statusbar .orca-conn");
      await expect(connection).toBeVisible();
      const shown = await connection.evaluate((node) => ({
        state: [...node.classList].find((c) => c.startsWith("orca-conn--"))?.slice("orca-conn--".length) ?? "",
        glyph: node.querySelector("[aria-hidden='true']")?.textContent?.trim() ?? "",
        text: node.textContent ?? "",
      }));
      const declared = CONNECTION_PRESENTATION[shown.state as keyof typeof CONNECTION_PRESENTATION] as
        { glyph: string; word: string } | undefined;
      expect(declared, `the status bar drew '${shown.state}', which the design system does not declare`).toBeDefined();
      expect(shown.glyph).toBe(declared?.glyph);
      expect(shown.text).toContain(declared?.word);
    } finally {
      await page.evaluate(() => document.documentElement.style.removeProperty("filter"));
    }
  });
}
