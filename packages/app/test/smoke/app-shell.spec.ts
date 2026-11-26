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
 * **Every screenshot here is the viewport and not `fullPage`, and that is not a loss.**
 * `app.css` makes `body` `overflow: hidden` at `height: 100%` and the shell is a fixed
 * three-row grid inside it (#275), so the document *is* the window — a full-page capture
 * asks Chromium for exactly the same pixels through `captureBeyondViewport`, which resizes
 * the compositing surface and, on a runner under xvfb, intermittently answers `Unable to
 * capture screenshot` and fails a test over its evidence rather than over its subject. A
 * surface that scrolls scrolls its own region, and no capture of the window would have
 * shown what is below that fold either way.
 *
 * Prerequisite: `pnpm run build`. The app under test is `dist/`, not the sources.
 */
import { fileURLToPath } from "node:url";
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
import { join, resolve } from "node:path";
// The design system's own presentation maps, so the greyscale check compares the screen
// against the source of truth rather than against a second list of glyphs written here
// (RULES.md rule 3). This resolves to the built `dist`, which `pnpm run build` produces.
import {
  CONNECTION_PRESENTATION,
  STATUS_PRESENTATION,
  SURFACE_IDS,
  type RunStatus,
  type SurfaceId,
} from "@orca/design";
import {
  AgentUpdateParamsSchema,
  ArtifactsListResultSchema,
  InputInvalidatedParamsSchema,
  RunsEventsResultSchema,
  RunsGetResultSchema,
  type AgentUpdateParams,
  type InputsAnswerParams,
  type NotificationMessage,
} from "@orca/protocol";
import { FIXTURE, startDemoDaemon, type Daemon } from "./daemon.js";

/**
 * What the renderer sees on `window`. Declared here rather than imported: the bridge's types
 * belong to the renderer's TypeScript project, and this spec is compiled by the root one.
 */
interface SmokeWindow {
  orca?: {
    platform: string;
    scopedPermissions?: { call: unknown };
    daemonConnection: { read: () => { epoch: number } };
    hello: () => Promise<{ ok: true; result: { capabilities: string[] } } | { ok: false; error: unknown }>;
    /** Only the part the pane-boundary test reads back: the sizes a drag left behind (#276). */
    preferences: { read: () => { panes: Record<string, number> } };
    connection: {
      read: () => SmokeConnection;
      subscribe: (listener: (snapshot: SmokeConnection) => void) => () => void;
    };
    notifications: { subscribe: (listener: (message: NotificationMessage) => void) => () => void };
    inputs: {
      answer: (params: InputsAnswerParams) => Promise<{ ok: true; result: unknown } | { ok: false; error: unknown }>;
    };
  };
  liveInputProbe?: {
    notifications: NotificationMessage[];
    connections: SmokeConnection[];
    stop: () => void;
  };
}

interface SmokeConnection {
  state: string;
  generation?: number;
  since: string;
}

/** The app directory Electron is pointed at; its `main` field is `dist/main/index.js`. */
const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * On Linux, Chromium's OS-level sandbox needs unprivileged user namespaces. The
 * workflow checks that prerequisite and xvfb availability; it does not change host
 * security policy or set this local-only opt-out. A passing application smoke test
 * is not an attestation of the host's complete sandbox/security configuration.
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
 * The surfaces axe is run over, each with something to wait for that only exists once the
 * surface has *data*. Which digit reaches a surface is not written here: `gotoSurface` reads
 * it off `SURFACE_IDS`, the same order `renderer/src/chrome/surfaces.ts` numbers.
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
    /* The parked gate the fixture starts. Without it Attention is "nothing needs you" and
       the audit would never see a `GateCard` at all. */
    ready: ".orca-attn__cards .orca-attn__card",
  },
  { id: "runs", ready: ".orca-runs__tree .orca-tree-row" },
  { id: "agents", ready: ".orca-agents__host .orca-agent" },
  /* Config (#175, the studio since #607): the structured form's root group, which only
     exists once the daemon has answered with the document and its shape — the demo daemon
     serves its own `orca.config.yaml`, so there is one. The first-run and diagnostics
     sections above it are the app's own rather than the daemon's, so neither will do. */
  { id: "config", ready: '.orca-config__body [role="group"][aria-label="Configuration"]' },
  /* Plan (#170): a row of the schedule table, which only exists once `plans.list` and
     `items.list` have answered — the demo store's program run registers its work items in a
     plan, so there is one. */
  { id: "plan", ready: '.orca-plan [role="grid"] [role="row"]' },
  /* Workflows (#181): a row of the list, which only exists once `workflows.list` has answered
     with at least one workflow — the demo's three and the fixture's own are all configured.
     Every surface in `SURFACE_IDS` is here, and "no surface is passed off as unbuilt" fails
     on a new one until it is. */
  { id: "workflows", ready: ".orca-wflist__table tbody tr" },
  /* Machines (#882): a row in the focused machine's section, which only exists once the fleet
     has read the focused daemon's runs and asks — the fixture's parked gate is one. With the
     one daemon this smoke runs, its whole content fits a 340px window, so the short-window
     check asks that the last section is on screen rather than that something overflowed. */
  { id: "machines", ready: ".orca-machine--focused .orca-machine__row", fitsWhenShort: true },
] as const satisfies readonly { id: SurfaceId; ready: string; fitsWhenShort?: true }[];

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
  // Fixture credentials only: an operator's environment token must not take precedence.
  delete env.ORCA_DAEMON_TOKEN;
  env.ORCA_DAEMON_TOKEN_FILE = daemon.tokenFile;

  // A throwaway user-data directory, so `preferences.json` starts empty. Without it the app
  // would read whatever the previous run left behind and the theme cycle below would start
  // from somewhere else — which is exactly how this test first failed.
  userData = await mkdtemp(join(tmpdir(), "orca-smoke-profile-"));

  app = await electron.launch({ args: [...osSandboxArgs, `--user-data-dir=${userData}`, appDir], env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // The window is created hidden and revealed on its first paint (`window-reveal.ts`), and a
  // screenshot taken while it is being shown fails with "Unable to capture screenshot". On a
  // cold runner that reveal landed inside the theme test's first screenshot (#892), so no test
  // starts until the main process reports the window visible and it has painted a frame.
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible())), {
      timeout: 10_000,
    })
    .toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
      scopedPermissionMethods: orca?.scopedPermissions ? Object.keys(orca.scopedPermissions).sort() : [],
    };
  });
  expect(bridge.present).toBe(true);
  expect(bridge.platform).toBe(process.platform);
  // Exact, not a superset: this list is everything the sandboxed renderer can reach, and
  // widening it is the kind of change that should have to be written down (ADR 0008).
  // Add the key here in the same PR that adds it to `src/bridge.ts`.
  expect(bridge.methods).toEqual([
    // Durable #331 palette intents expose only start/list/confirmed abandon, never credentials or keys.
    "admissionIntents",
    "agents",
    "alerts",
    "artifacts",
    "claims",
    // `config`, `plan` and `workflows` are v0.5.0's: the Config surface's two documents
    // (#174, #266), the plan's reads and writes (#169, #170, #178) and the workflow the
    // viewer draws (#177). Written down here, in the PR that widened `src/bridge.ts`.
    "config",
    "connection",
    "daemonConnection",
    "deepLink",
    // The seven keys below that no comment introduces — `diagnostics`, `firstRun`,
    // `guidedLaunch`, `macUpdates`, `operator`, `templates` and `workflowDrafts` — were
    // added to `src/bridge.ts` after v0.6.0 (local diagnostics; #542's operator preflight;
    // #607's first-run setup, guided launch, mac updates and templates; #610's workflow
    // drafts) without being written down here, and were recorded late, as they ship.
    "diagnostics",
    "firstRun",
    "guidedLaunch",
    "hello",
    "inputs",
    // #905's "Restart to finish update" for the `.deb`: read, subscribe, and a restart that
    // carries no argument. Main alone decides the target, from dpkg and the package checksum.
    "linuxRestart",
    // #888's Linux `.deb` release notice: read, subscribe, and open/copy of the release page
    // and `apt` command main built. The renderer cannot pass a URL or a command across it.
    "linuxUpdates",
    "macUpdates",
    "notifications",
    "operator",
    "plan",
    "platform",
    "preferences",
    // #357's recovery intents (#932): confirmed retry/abandon of a reviewed checkpoint, whose key
    // lives in main. Added to `src/bridge.ts` without being recorded here; recorded with #905.
    "recoveryIntents",
    // #1206: delegation remotes and their enrollment by the daemon that owns the workspace.
    // Never a token: the renderer sends a fingerprint, and a credential only when one is pasted.
    "remotes",
    "runs",
    // #702/#706's opaque review commands (3f72ee46), validated by the closed main-process
    // dispatcher. This bridge does not register the family on the production daemon.
    "scopedPermissions",
    // #255's daemon search (#911): a query within the daemon's limit and deadline, answered
    // with places, never a file path or a raw log.
    "search",
    // #879's server update over SSH (#918): read the offer, approve it, run it and follow its
    // progress for the focused profile's managed server.
    "serverUpdate",
    // #339's "Switch to SQLite" for the app's own workspace: read, subscribe, and a restart that
    // carries no argument. Main alone decides whether it is offered and which workspace it is.
    "storeSwitch",
    "templates",
    // `updates` is v0.6.0's desktop updater (#306): read, act, subscribe and the unsaved-
    // draft challenge. No feed URL, credential or install command crosses it.
    "updates",
    "workflowDrafts",
    "workflows",
    "workspace",
  ]);
  expect(bridge.scopedPermissionMethods).toEqual(["call"]);

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
      body: await page.screenshot({ path: testInfo.outputPath(`${theme}.png`) }),
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

test("a pane boundary drags, and the width it is left at is remembered", async () => {
  /* The one thing the renderer tests cannot claim (#276). happy-dom has no layout and no
     pointer, so `pane-splitter.test.tsx` asserts the markup, the keys and the preference over
     stubbed rects; whether a real drag moves a real grid track, at a real `col-resize` cursor,
     is only answerable in a window. */
  const sidebar = page.locator(".orca-sidebar");
  const handle = page.getByRole("separator", { name: "Resize the sidebar" });
  await expect(handle).toBeVisible();

  const before = await sidebar.boundingBox();
  const grip = await handle.boundingBox();
  expect(before && grip).toBeTruthy();
  if (!before || !grip) return;

  // The cursor says what the boundary is before it is touched, which is half the affordance.
  expect(await handle.evaluate((node) => getComputedStyle(node).cursor)).toBe("col-resize");

  const y = grip.y + grip.height / 2;
  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  // In steps, so the drag is a stream of moves as a hand's is and not one jump.
  await page.mouse.move(grip.x + grip.width / 2 + 80, y, { steps: 8 });
  await page.mouse.up();

  const widened = Math.round(before.width) + 80;
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(widened);
  // The separator says where it is, and the preferences file has it: a resize that reset on
  // relaunch would be worse than no resize.
  await expect(handle).toHaveAttribute("aria-valuenow", String(widened));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as SmokeWindow).orca!.preferences.read().panes.sidebar))
    .toBe(widened);

  // And back: a double-click is the boundary going home, which is a deletion rather than a
  // write of the token's value, so the property comes off the element entirely.
  await handle.dblclick();
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(before.width));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as SmokeWindow).orca!.preferences.read().panes.sidebar))
    .toBeUndefined();
});

/* ---------------------------------------------------------------- the surfaces */

/**
 * Put the window on a surface the way a person does — ⌘<n> — and wait for it to arrive. The
 * digit is the surface's place in `SURFACE_IDS`, 1-indexed, as the app binds it, so a surface
 * added or moved in `semantics.json` moves the key here too.
 */
async function gotoSurface(id: SurfaceId): Promise<Locator> {
  await page.keyboard.press(`ControlOrMeta+Digit${SURFACE_IDS.indexOf(id) + 1}`);
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
      await gotoSurface(surface.id);
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

/* ---------------------------------------------------------------- scrolling (#277) */

/**
 * The half of "scrolling is structural" that only a layout engine can answer.
 *
 * `renderer/test/scroll-sweep.test.tsx` walks every surface under happy-dom, which has no
 * layout, so it can assert the *declaration* — a scroll region exists in the subtree and
 * every box between it and `.orca-main` is bounded — and nothing about height. That is the
 * gap between "the CSS says the right words" and "the screen works": a rule that takes its
 * height from an unexpected place (a `position: absolute` up the tree, a grid track that
 * resolved differently, a `height: 100%` against a parent nobody gave a height to) passes
 * the sweep and still hides content, with no scrollbar, no wheel and no keyboard way down.
 *
 * So this makes the window **too short for any surface** and asks the two questions the
 * sweep cannot: does the box that is supposed to scroll actually overflow, and having
 * scrolled it to its end, is the last thing in it on the screen? The second is the one that
 * catches a scroller that scrolls the wrong box — a region can overflow and still be the
 * wrong element, in which case the content below it never comes into view.
 *
 * Keep the unit sweep. It runs in a second and fails on a new surface that declares nothing,
 * which is the common case; this covers the rarer, harder one and is worth its runtime here
 * rather than in `pnpm test`.
 */
const SHORT_WINDOW = { width: 1280, height: 340 } as const;

/** What one scroll region measured, after being scrolled to its end. */
interface ScrollProof {
  /** The region's class, so a failure names the box rather than "an element". */
  region: string;
  overflows: boolean;
  /** `scrollTop + clientHeight` reached `scrollHeight`: the region really took the scroll. */
  reachedEnd: boolean;
  /** The last thing in the region is inside the region's own box once it is at the end. */
  lastVisible: boolean;
  last: string;
}

/**
 * Every scroll region inside `selector` that has more content than height, scrolled to its
 * end and measured. The regions are found the way the sweep finds them — a computed
 * `overflow`/`overflow-y` of `auto`, `scroll` or `overlay` — so the two tests are looking at
 * the same set of boxes and neither has its own list.
 */
async function scrollProofs(selector: string): Promise<ScrollProof[]> {
  return page.evaluate((root) => {
    const scrollable = new Set(["auto", "scroll", "overlay"]);
    const host = document.querySelector(root);
    if (!host) return [];
    const regions = [host, ...host.querySelectorAll("*")].filter((element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return scrollable.has(style.overflowY) || scrollable.has(style.overflow);
    });
    return regions
      .filter((element) => element.scrollHeight > element.clientHeight + 1)
      .map((element) => {
        element.scrollTop = element.scrollHeight;
        const box = element.getBoundingClientRect();
        /* The last child with a box of its own is the end of the region's content: a
           virtualised list's spacer, a surface's final section, the inspector's last block.
           Asking about *it* rather than about `scrollTop` is what makes this an assertion
           about the screen — a region that scrolls while its content is drawn somewhere
           else fails here and passes every arithmetic check. */
        const children = [...element.children].filter((child) => child.getBoundingClientRect().height > 0);
        const last = children.at(-1);
        const lastBox = last?.getBoundingClientRect();
        return {
          region: element.className || element.tagName,
          overflows: true,
          /* Two pixels of slack on both, and no more: a fractional device pixel ratio moves
             a rounded `clientHeight` and a `getBoundingClientRect` by under one. Anything
             larger is content off the bottom of the box, which is the bug. */
          reachedEnd: Math.abs(element.scrollTop + element.clientHeight - element.scrollHeight) <= 2,
          last: last?.className ?? "",
          lastVisible: lastBox !== undefined && lastBox.bottom <= box.bottom + 2 && lastBox.bottom > box.top,
        };
      });
  }, selector);
}

/** Set the window's content size and wait for the renderer to have been laid out at it. */
async function setWindowSize(width: number, height: number): Promise<void> {
  // Not `window`: that name is the renderer's inside the `page.evaluate` below, and shadowing
  // it here is how this first failed to compile.
  const browserWindow = await app.browserWindow(page);
  await browserWindow.evaluate((win, size) => win.setContentSize(size.width, size.height), { width, height });
  // Within a couple of pixels: a window manager may round, and the point is "short", not "340".
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(height + 4);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeGreaterThanOrEqual(height - 4);
}

test.describe("a window too short for what is in it", () => {
  test.beforeAll(async () => {
    /* Short, and still wide: the sidebar collapses and the dock becomes an overlay below
       their breakpoints, which would be a different layout rather than a shorter one. */
    await setWindowSize(SHORT_WINDOW.width, SHORT_WINDOW.height);
  });

  test.afterAll(async () => {
    // Back to what the main process opens, so the specs after this see the window they expect.
    await setWindowSize(1200, 800);
  });

  for (const surface of AUDITED) {
    test(`${surface.id} scrolls the box it says it scrolls, and its end is reachable`, async () => {
      await gotoSurface(surface.id);
      await expect(page.locator(surface.ready).first()).toBeVisible();

      const proofs = await scrollProofs(`main.orca-main[data-surface="${surface.id}"]`);
      if ("fitsWhenShort" in surface && proofs.length === 0) {
        /* Nothing to scroll: then all of it has to be on screen, its last section included. */
        const fits = await page.evaluate((selector) => {
          const main = document.querySelector(selector);
          const sections = main ? [...main.querySelectorAll("section")] : [];
          const last = sections.at(-1)?.getBoundingClientRect();
          const box = main?.getBoundingClientRect();
          return Boolean(last && box && last.bottom <= box.bottom + 2 && last.top >= box.top - 2);
        }, `main.orca-main[data-surface="${surface.id}"]`);
        expect(fits, `${surface.id}: its last section is cut off with nothing to scroll`).toBe(true);
        return;
      }
      /* Not "a region exists" but "a region overflowed": at this height every surface has
         more content than window, so a surface with nothing overflowing is a surface whose
         content went somewhere other than into the box that scrolls. */
      expect(proofs.length, `${surface.id} overflowed nothing in a ${SHORT_WINDOW.height}px window`).toBeGreaterThan(0);
      for (const proof of proofs) {
        expect(proof.reachedEnd, `${surface.id}: .${proof.region} would not scroll to its end`).toBe(true);
        expect(
          proof.lastVisible,
          `${surface.id}: .${proof.region} scrolled but .${proof.last} never came into view`,
        ).toBe(true);
      }
    });
  }

  test("the docked panel scrolls the Plan inspector rather than clipping it", async () => {
    /* The content that most easily outgrows its column: a work item's dependencies, risks
       and journal in a 420px-wide dock, in a window this short. The panel's own
       `overflow: hidden` is the clip that keeps the enter animation inside the column, so
       the region that has to take this is `.orca-panel__body` and nothing else. */
    const plan = await gotoSurface("plan");
    await expect(plan.locator('[role="grid"] [role="row"]').first()).toBeVisible();
    // Selecting a row is what opens the dock on this surface, the way a person opens it.
    await plan.locator('[role="grid"] [role="row"]').first().click();
    await expect(page.locator(".orca-panel")).toBeVisible();
    await expect(page.locator(".orca-panel .orca-pane__head")).toContainText("Work item");

    const proofs = await scrollProofs(".orca-panel");
    expect(proofs.map((proof) => proof.region.includes("orca-panel__body"))).toContain(true);
    for (const proof of proofs) {
      expect(proof.reachedEnd, `.${proof.region} would not scroll to its end`).toBe(true);
      expect(proof.lastVisible, `.${proof.region} scrolled but .${proof.last} never came into view`).toBe(true);
    }
  });
});

test("no surface is passed off as unbuilt", async () => {
  /* Through v0.4.0 the surfaces that had no screen yet were asserted to be the empty
     `StateView` `App.tsx` gives them, so that the day one grew content the assertion failed
     and its author moved it into `AUDITED`. Every surface is audited now, and this keeps
     both halves of that promise: every surface `SURFACE_IDS` names is in `AUDITED`, so a
     new one cannot join the rail unaudited the way Workflows did, and none of them still
     shows the placeholder. */
  expect(AUDITED.map((surface) => surface.id).sort()).toEqual([...SURFACE_IDS].sort());
  for (const id of SURFACE_IDS) {
    const pane = await gotoSurface(id);
    /* A count rather than `not.toContainText`: a surface that has been built has no
       `.orca-state--empty` at all, and a negated text assertion against an element that is
       not there fails on "element(s) not found" rather than passing. What is being claimed
       is that the placeholder is nowhere on the pane. */
    await expect(pane.getByText("This surface has not been built yet.")).toHaveCount(0);
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
 * page but never the accessible name. `orca-chip--plain`, `orca-chip--glyph-only` and
 * `orca-chip--aligned` are not statuses and are dropped here, so a new modifier class cannot
 * quietly become one.
 */
async function statusMarks(region: Locator): Promise<StatusMark[]> {
  return region.locator(".orca-chip").evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const modifiers = [...node.classList]
          .filter((c) => c.startsWith("orca-chip--"))
          .map((c) => c.slice("orca-chip--".length))
          .filter((c) => c !== "plain" && c !== "glyph-only" && c !== "aligned");
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
        body: await page.screenshot({ path: testInfo.outputPath(`greyscale-${name}-${theme}.png`) }),
        contentType: "image/png",
      });
    };

    try {
      // The attention list: the fixture's parked gate above, its failed run below.
      const attention = await gotoSurface("attention");
      await expect(attention.locator(".orca-attn__cards .orca-attn__card").first()).toBeVisible();
      await expect(attention.getByText(FIXTURE.gate.question)).toBeVisible();
      expectLegibleInGreyscale(
        await statusMarks(attention.locator('section[aria-label="Failed runs"]')),
        "the attention list's failures",
      );
      await shoot("attention");

      // The run tree: the demo's completed program beside the fixture's two runs, so there
      // is more than one status on screen and "distinguishable" means something.
      const runs = await gotoSurface("runs");
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

test("a connected live permission expires without dispatching a stale answer", async () => {
  // Last: the visual audits retain their original durable-gate/failed-run fixture.
  const attention = await gotoSurface("attention");
  const before = await page.evaluate(() => {
    const target = window as unknown as SmokeWindow;
    const orca = target.orca!;
    const snapshot = orca.connection.read();
    const notifications: NotificationMessage[] = [];
    const connections = [snapshot];
    const offNotifications = orca.notifications.subscribe((message) => notifications.push(message));
    const offConnection = orca.connection.subscribe((next) => connections.push(next));
    target.liveInputProbe = {
      notifications,
      connections,
      stop: () => {
        offNotifications();
        offConnection();
      },
    };
    return snapshot;
  });
  expect(before.state).toBe("live");
  expect(before.generation).toBeGreaterThan(0);

  let live: Awaited<ReturnType<Daemon["startLivePermission"]>> | undefined;
  let cancelled = false;
  try {
    live = await daemon.startLivePermission();
    const { input } = live;
    expect(input.kind).toBe("permission");
    expect(input.live?.state).toBe("pending");
    expect(input.live?.target).toMatchObject({
      runId: input.runId,
      stepRunId: input.stepRunId,
      requestId: input.id,
    });
    expect(input.question).toContain(FIXTURE.live.subject);
    // Focus/Enter belong to the inner card body, not its non-focusable alert shell.
    const card = attention.locator(`.orca-attn__card-body[id="attention-card-${input.id}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(input.question);
    const allow = card.getByRole("button", { name: /^1\s*Allow$/ });
    const answer = card.getByRole("button", { name: "Answer", exact: true });
    await expect(allow).toBeEnabled();
    // The waiting section must contain its cards at both heights. A shrinkable flex
    // section can leave them visible outside its box while Failed runs intercepts
    // every click. Visibility/scroll arithmetic alone cannot detect that overlap.
    for (const size of [{ width: 1200, height: 800 }, SHORT_WINDOW]) {
      await setWindowSize(size.width, size.height);
      const geometry = await attention.locator('.orca-attn__section[aria-label="Waiting"]').evaluate((section) => {
        const waiting = section.getBoundingClientRect();
        const cards = section.querySelector(".orca-attn__cards")!.getBoundingClientRect();
        const failures = section.parentElement!.querySelector(".orca-attn__failures")!.getBoundingClientRect();
        return { waitingBottom: waiting.bottom, cardsBottom: cards.bottom, failuresTop: failures.top };
      });
      expect(geometry.waitingBottom, `Waiting must contain its cards at ${size.height}px`).toBeGreaterThanOrEqual(
        geometry.cardsBottom - 1,
      );
      expect(geometry.failuresTop, `Failed runs must follow the cards at ${size.height}px`).toBeGreaterThanOrEqual(
        geometry.cardsBottom,
      );
      for (const control of [allow, answer]) {
        await control.scrollIntoViewIfNeeded();
        const hit = await control.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          const root = button.closest(".orca-attn-surface")!.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y);
          return {
            inScroller: x >= root.left && x < root.right && y >= root.top && y < root.bottom,
            receivesPointer: target !== null && button.contains(target),
            hit: target?.className ?? "none",
          };
        });
        expect(hit.inScroller, `Control must scroll into the root at ${size.height}px`).toBe(true);
        expect(hit.receivesPointer, `Control is covered by ${hit.hit} at ${size.height}px`).toBe(true);
      }
      // Real pointer action at both heights, with Playwright's hit testing intact.
      await allow.click();
      await test.info().attach(`live-permission-${size.height}px.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
    await setWindowSize(1200, 800);
    await expect(answer).toBeEnabled();
    await expect(card.getByRole("button", { name: "Always allow", exact: true })).toBeEnabled();
    await card.focus();
    await expect(card).toBeFocused();
    await test.info().attach("live-permission-pending.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Cancel at the owning daemon while leaving the window and socket alone. Awaiting
    // the original runs.start also proves its interpreter has finished, not just that
    // the read model has briefly painted an expired state.
    await live.cancel();
    cancelled = true;
    await expect(answer).toBeDisabled();
    await expect(answer).toHaveAttribute("title", /callback is expired/);
    await expect(allow).toBeDisabled();
    await expect(card.getByRole("button", { name: "Always allow", exact: true })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Always deny", exact: true })).toBeDisabled();

    const pushed = () =>
      page.evaluate(() => {
        const probe = (window as unknown as SmokeWindow).liveInputProbe!;
        return probe.notifications.filter((message) => message.method === "input.invalidated");
      });
    await expect.poll(async () => (await pushed()).length).toBe(1);
    const invalidation = (await pushed())[0]!;
    expect(InputInvalidatedParamsSchema.parse(invalidation.params).target).toEqual(input.live!.target);
    expect(invalidation.params).not.toHaveProperty("seq");

    // The disabled control remains keyboard-focusable to explain its reason. Exercise
    // both handlers anyway: neither may turn the stale selection into an approval.
    await answer.click({ force: true });
    await card.focus();
    await page.keyboard.press("Enter");
    // Even a caller retaining the complete old identity cannot deliver to the agent.
    const stale = await page.evaluate((params) => (window as unknown as SmokeWindow).orca!.inputs.answer(params), {
      runId: input.runId,
      requestId: input.id,
      optionId: "allow",
      live: input.live!.target,
      resume: true,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "RUN_STATE", details: { liveInputState: "expired" } } });

    const events = RunsEventsResultSchema.parse(
      await daemon.rpc("runs.events", { runId: input.runId, limit: 500 }),
    ).events;
    expect(events.filter((event) => event.type === "human.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "human.answered")).toEqual([]);
    expect(events.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "agent.permission" && String(event.payload.decision).includes("allow")),
    ).toEqual([]);
    expect(
      ArtifactsListResultSchema.parse(await daemon.rpc("artifacts.list", { runId: input.runId })).artifacts,
    ).toEqual([]);
    const connections = await page.evaluate(() => (window as unknown as SmokeWindow).liveInputProbe!.connections);
    expect(
      connections.every((snapshot) => snapshot.state === "live" && snapshot.generation === before.generation),
    ).toBe(true);
    await expect(page.locator(".orca-statusbar .orca-conn--live")).toBeVisible();
    const gate = attention.getByRole("region", { name: `gate, ${FIXTURE.gate.question}`, exact: true });
    await expect(gate.getByRole("button", { name: "Answer", exact: true })).toBeEnabled();
    await expect(answer).toBeDisabled();
    // A disabled-click/keyboard regression would expose its rejected dispatch here;
    // the direct stale bridge call above deliberately does not invoke card handlers.
    await expect(card.locator('.orca-card__hint[role="status"]')).toHaveCount(0);
    await test.info().attach("live-permission-expired.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    if (live && !cancelled) await live.cancel();
    await setWindowSize(1200, 800);
    await page.evaluate(() => {
      const target = window as unknown as SmokeWindow;
      target.liveInputProbe?.stop();
      delete target.liveInputProbe;
    });
  }
});

test("a mounted live step keeps tool disclosures and focus through live update bursts", async () => {
  // Keep the real interpreter active at its existing permission checkpoint. Only this
  // test's public agent.update envelopes are synthetic: send them from Playwright's
  // Electron driver through the existing sandboxed preload, never a renderer/product hook.
  // This isolates the GUI regression; daemon ACP/coalescing remains the real smoke's job.
  const live = await daemon.startLivePermission();
  try {
    const { input } = live;
    // Permission checkpoints project as waiting, while the agent callback and output
    // stream remain active. Match the public read model rather than assuming running.
    await expect
      .poll(async () => {
        const snapshot = RunsGetResultSchema.parse(await daemon.rpc("runs.get", { runId: input.runId }));
        return snapshot.steps.find((step) => step.id === input.stepRunId);
      })
      .toMatchObject({ nodeId: "write", status: "waiting" });
    const runs = await gotoSurface("runs");
    const tree = runs.getByRole("tree", { name: "Run tree" });
    const root = tree.locator(`[id="tree-row-${input.runId}"]`);
    await expect(root).toHaveCount(1);
    await root.locator(".orca-tree-row__twisty").click();
    const step = tree.locator(`[id="tree-row-${input.runId}/${input.stepRunId}"]`);
    await step.click();
    const detail = runs.locator(".orca-step");
    await expect(detail.locator(".orca-inspector__title")).toHaveText("write");
    await expect(detail.locator(".orca-inspector__head .orca-chip--waiting")).toBeVisible();
    await expect(detail.locator(".orca-inspector__head .orca-chip__label")).toHaveText("waiting");
    // The first tool and output prove the initial read has committed before injection.
    await expect(detail.locator(".orca-tool")).toHaveCount(1);
    await expect(detail.getByRole("searchbox", { name: "Search the output held in memory" })).toBeVisible();
    const mounted = await detail.elementHandle();
    const events = RunsEventsResultSchema.parse(
      await daemon.rpc("runs.events", { runId: input.runId, stepRunId: input.stepRunId, limit: 500 }),
    ).events;
    const session = events.find((event) => event.type === "agent.session.opened");
    expect(session?.payload.sessionId).toEqual(expect.any(String));
    const epoch = await page.evaluate(() => (window as unknown as SmokeWindow).orca!.daemonConnection.read().epoch);
    const win = await app.browserWindow(page);
    let seq = Math.max(...events.map((event) => event.seq));
    const push = async (updates: AgentUpdateParams["updates"]) => {
      const fromSeq = seq + 1;
      seq += updates.length;
      const params = AgentUpdateParamsSchema.parse({
        subscriptionId: "smoke-mounted-tools",
        runId: input.runId,
        stepRunId: input.stepRunId,
        sessionId: session!.payload.sessionId,
        fromSeq,
        seq,
        at: new Date().toISOString(),
        updates,
      });
      await win.evaluate(
        (window, payload) => {
          window.webContents.send("orca:notification", payload.notification, payload.epoch);
        },
        { notification: { kind: "notification", method: "agent.update", params }, epoch },
      );
    };
    const tool = (name: string) =>
      detail.locator(".orca-tool").filter({
        has: page.locator(".orca-tool__name", { hasText: name }),
      });
    await push([
      {
        kind: "tool_call",
        toolCallId: "smoke-read",
        title: "Read smoke source",
        toolKind: "read",
        status: "in_progress",
        args: { text: "synthetic source", length: 16 },
      },
    ]);
    const read = tool("Read smoke source");
    await expect(read.locator(".orca-tool__meta")).toHaveText("running");
    await read.locator("summary").click();
    await expect(read).toHaveAttribute("open", "");
    await expect(read.locator("summary")).toBeFocused();
    const originalRow = await read.elementHandle();
    await push([
      {
        kind: "tool_call_update",
        toolCallId: "smoke-read",
        title: "Read updated smoke source",
        status: "in_progress",
      },
    ]);
    const updated = tool("Read updated smoke source");
    await expect(updated.locator(".orca-tool__meta")).toHaveText("running");
    // One coalesced burst changes two calls and output, without touching selection.
    await push([
      {
        kind: "tool_call_update",
        toolCallId: "smoke-read",
        status: "completed",
        result: { text: "read complete", length: 13 },
      },
      {
        kind: "tool_call",
        toolCallId: "smoke-exec",
        title: "Execute smoke check",
        toolKind: "execute",
        status: "in_progress",
      },
      { kind: "agent_message_chunk", text: "Synthetic mounted-step burst\n" },
      {
        kind: "tool_call_update",
        toolCallId: "smoke-exec",
        status: "failed",
        result: { text: "check failed", length: 12 },
      },
    ]);
    await expect(updated.locator(".orca-tool__meta")).toHaveText("done");
    await expect(updated).toContainText("read complete");
    await expect(tool("Execute smoke check").locator(".orca-tool__meta")).toHaveText("failed");
    await expect(detail.locator(".orca-tool")).toHaveCount(3);
    await expect(updated).toHaveAttribute("open", "");
    await expect(updated.locator("summary")).toBeFocused();
    expect(await originalRow.evaluate((node) => node.isConnected)).toBe(true);
    expect(await mounted.evaluate((node) => node.isConnected)).toBe(true);
    await expect(step).toHaveAttribute("aria-selected", "true");
    await test
      .info()
      .attach("mounted-live-tool-burst.png", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await live.cancel();
  }
});
