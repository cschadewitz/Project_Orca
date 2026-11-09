/**
 * The type proof, photographed on every platform ORCA ships to (#213).
 *
 * #144 bundled the faces and proved in `tools/font-build/build-fonts.js` that every
 * declared file contains every codepoint claimed for it. #194 built `#type`, where a person
 * can see the faces and the glyphs next to the words they will sit next to. What neither
 * does is the comparison *across* machines, and that is the one that matters: a glyph that
 * falls through to the operating system still renders, just in another typeface, and on the
 * machine that happens to have that typeface nothing looks wrong. This spec is CI looking
 * at the same page on Linux, macOS and Windows and refusing to accept a change it was not
 * shown.
 *
 * ## Why this spec starts a dev server, and why that is not a workaround
 *
 * `#type` — and `#preview` — are **dev-only by design**. `renderer/src/routes.tsx` puts both
 * behind `import.meta.env.DEV`, which a production build replaces with `false`, so neither
 * the branch nor the dynamic `import()` inside it reaches a shipped bundle. That is a
 * decision, not an oversight: a proof surface is a developer's tool and does not belong in
 * an application a person installs. The other smoke spec launches the *built* app, where
 * `#type` correctly does not exist.
 *
 * So this one launches the same Electron main process against a Vite dev server, through
 * the seam that already exists for exactly this: `ORCA_RENDERER_URL` (`src/main/index.ts`),
 * which is how `pnpm --filter @orca/app dev` runs. `scripts/dev.js` is the working pattern
 * and this file follows it, including building main and preload with
 * `tsc -b packages/app/tsconfig.preload.json` first. **The production bundle is unchanged**
 * and must stay that way.
 *
 * ## Unlike `app-shell.spec.ts`, the pictures here *are* the fixture
 *
 * `toHaveScreenshot` against committed, per-platform baselines. The app's own screenshots
 * are evidence and not goldens because the app draws OS-rendered chrome over live data;
 * `#type` draws a fixed page, renders both themes as `data-theme` subtrees, and exists
 * precisely so that a pixel difference *means* something. The one exception — the two
 * connection rows that tick — is taken out of the picture below (`NO_CLOCK`) rather than
 * budgeted for in the threshold. `docs/DEVELOPMENT.md` ("Screenshot baselines") has how the
 * baselines are created and the one honest way to update them.
 *
 * Linux's fallback picture is a separately pinned test control, because two Linux hosts
 * need not have the same fonts (Tyler run 41972625803). Native fallback still has its own
 * screenshots and actual-font report as evidence. The control never supplies product
 * fonts or changes the dev surface's fallback stacks. See `control-fonts/README.md`.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { controlStyle, controlFontFamilies, controlFontPlugin, renderedFonts } from "./type-proof-control.js";

/**
 * `packages/app` and the repo root, from this file: test/smoke → up two and up four.
 *
 * `resolve` is not decoration — it drops the trailing separator `fileURLToPath` leaves on a
 * directory URL, and on Windows that separator is a bug with a three-minute symptom. The
 * path goes to `electron.launch` as the app to load, Playwright quotes each argument, and
 * `"…\packages\app\"` ends in `\"`, which `CommandLineToArgvW` reads as an escaped quote
 * rather than as the end of the argument. Electron then starts with a mangled argument list,
 * attaches its debugger and loads no app at all, so the launch never resolves and the only
 * evidence is a call log that stops after `Debugger attached.` — no error, no window, no
 * stack. POSIX does not care about the trailing slash, which is why two platforms were green
 * throughout. See `playwright.config.ts` for the sibling Windows path bug in the same file.
 */
const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

/** See `app-shell.spec.ts`: the OS sandbox needs user namespaces a plain container lacks. */
const osSandboxArgs = process.env.ORCA_SMOKE_NO_SANDBOX ? ["--no-sandbox"] : [];

/**
 * The window is sized here rather than left at `BrowserWindow`'s 1200×800, because the two
 * theme columns are `1fr 1fr` of it and a baseline is only comparable if the column it was
 * taken from was the same width. Tall enough that the header does not push the columns'
 * first section off a sensible fold; the columns are captured whole regardless.
 */
const CONTENT = { width: 1280, height: 900 };

/**
 * Scrollbars, gone. On Linux they take layout width and on macOS they overlay while
 * scrolling, which is a per-platform difference in the *column widths* rather than in the
 * type — the thing this spec is about. Removing them makes the columns the same box
 * everywhere and removes a capture-time flake.
 */
const NO_SCROLLBARS = "html { scrollbar-width: none } ::-webkit-scrollbar { width: 0; height: 0; display: none }";

/**
 * The one moving thing on `#type`, held still — without which none of this would work.
 *
 * `type-proof.tsx` draws all five connection states from one instant six minutes in the
 * past, and two of the five put a clock on the page: `reconnecting` renders a `Duration`
 * that ticks at 1Hz ("6m 0s", "6m 1s", …) and `disconnected` a relative `Time` that turns
 * over to "7m ago" a minute in. A golden image cannot contain either. Left alone this
 * would not fail loudly — CI's first run would commit a baseline and the *next* run would
 * be red over two lines of elapsed seconds, which is exactly how a screenshot check earns
 * the reputation that gets it deleted.
 *
 * Hidden rather than masked. A Playwright `mask` paints a box the size of the element, and
 * the element is the thing whose size is changing ("6m 9s" and "6m 10s" are different
 * widths in a mono face), so a mask would move too. `visibility: hidden` with the width
 * pinned to zero takes both the pixels and the geometry out of the picture; the `min-width`
 * is there because a flex item's `auto` minimum would otherwise hold it at its content
 * size. The glyph and the word — what `#type` is actually proving about these rows — are
 * untouched, and the three states whose detail is static (`live`, `file`, `mismatch`) still
 * render theirs.
 *
 * This is the spec bending to the page, not the page to the spec: `#type` is a surface a
 * person reads, a live duration belongs on it, and `renderer/src` is another unit's.
 */
const NO_CLOCK = `
.orca-conn--reconnecting > span:last-child,
.orca-conn--disconnected > span:last-child {
  visibility: hidden;
  width: 0;
  min-width: 0;
  overflow: hidden;
}`;

let server: ViteDevServer;
let app: ElectronApplication;
let page: Page;
let userData: string;
let controlInstalled = false;

/** Run a command to completion, failing the suite if it fails (the shape `scripts/dev.js` uses). */
function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${String(code)}`))));
  });
}

test.beforeAll(async () => {
  // Main and preload are tsc's, not Vite's, and Electron loads them off disk. The project
  // reference means this builds `tsconfig.json` (main) first and the CommonJS preload after.
  await run("pnpm", ["exec", "tsc", "-b", "packages/app/tsconfig.preload.json"], repoRoot);

  /* `strictPort: false` overrides the config's `true`: 5273 is the port a developer's own
     `pnpm dev` is sitting on, and a test that cannot run while the app is open is a test
     people stop running. Vite picks the next free port and tells us which. */
  server = await createServer({
    configFile: join(appDir, "vite.config.ts"),
    plugins: process.platform === "linux" ? [controlFontPlugin()] : [],
    server: { host: "127.0.0.1", strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("the Vite dev server did not report a local URL");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // See `app-shell.spec.ts`: this one makes Electron behave as a bare Node.
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.ORCA_RENDERER_URL = `${url}#type`;
  /* A port nothing is listening on. `#type` reads no run data at all, but the main process
     still opens a connection on startup, and pointing it at a closed port is what stops a
     developer's own `orca serve` from being quietly involved in a font test. */
  env.ORCA_DAEMON_URL = "http://127.0.0.1:1";

  userData = await mkdtemp(join(tmpdir(), "orca-type-profile-"));

  app = await electron.launch({
    args: [
      ...osSandboxArgs,
      /* One device pixel per CSS pixel on all three runners. Playwright would capture at
         CSS scale anyway, but forcing it here means the baseline is what Chromium drew
         rather than what Playwright then resampled — and it keeps a retina runner from
         quadrupling the size of a committed PNG. */
      "--force-device-scale-factor=1",
      `--user-data-dir=${userData}`,
      appDir,
    ],
    env,
  });

  /* The app window, by URL. With `ORCA_RENDERER_URL` set, `src/main/index.ts` also opens
     DevTools detached, so "the first window" is not necessarily the one with the page in
     it — asking for the one serving the dev server's URL is the question that has one
     answer however that changes. */
  page = await findAppWindow(app, url);
  await page.waitForLoadState("domcontentloaded");

  const window = await app.browserWindow(page);
  await window.evaluate((win, size) => win.setContentSize(size.width, size.height), CONTENT);

  /* Reduced motion, so nothing is mid-transition when the shutter opens. `#type` has no
     animation of its own; `components.css` does, and a focus ring easing in is exactly the
     kind of one-frame difference that would make a baseline flake. */
  await page.emulateMedia({ reducedMotion: "reduce" });

  await expect(page.locator(".type-proof")).toBeVisible();
  /* The root theme, pinned. Each column carries its own `data-theme`, so this changes
     nothing inside them — but an unpinned root follows the runner's OS setting, and a
     screenshot should not depend on how a runner image was configured. */
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  await page.addStyleTag({ content: `${NO_SCROLLBARS}\n${NO_CLOCK}` });
  await clockIsNeutralised();

  await fontsSettled();
  await layoutSettled();
});

test.afterAll(async () => {
  await app?.close();
  await server?.close();
  if (userData) await rm(userData, { recursive: true, force: true });
});

/**
 * Wait for every face the document wants to be loaded or to have given up.
 *
 * `document.fonts.ready` resolves *with* the `FontFaceSet`, which has nothing Playwright
 * can serialise — so it is awaited inside the page and nothing is returned from it.
 */
async function fontsSettled(): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * Wait until the page has stopped changing shape, and fail loudly if it never does.
 *
 * The first run on each platform showed why this is needed. On macOS the *first* column
 * captured came out 640×2801 and the three after it 640×2769 — not light versus dark, since
 * the light fallback column was 2769 too, and not bundled versus fallback, since Linux drew
 * all four at 2801. Only the first picture differed, which is the signature of a page still
 * settling when the shutter opened: the window is given its content size in `beforeAll`, and
 * a platform that applies that asynchronously reflows underneath the test that follows.
 *
 * That is worth a wait rather than a tolerance, because `toHaveScreenshot` does not compare
 * images of different sizes at all — it fails on the dimensions, before `maxDiffPixelRatio`
 * is consulted. A baseline committed from the unsettled frame would have gone red on the
 * very next run, with a message about geometry rather than about type, which is the fastest
 * way to teach a team to distrust a screenshot check.
 *
 * Stability, not a sleep: three consecutive identical readings of the viewport and the
 * document's height. A fixed `waitForTimeout` would be a guess that gets raised the first
 * time a slower runner misses it, and this page is static once it has settled — so if the
 * readings never agree, something on `#type` is genuinely animating and the right outcome is
 * this throwing with the series in hand, not a picture of a moving target.
 */
async function layoutSettled(): Promise<void> {
  const sample = (): Promise<string> =>
    page.evaluate(() => [innerWidth, innerHeight, document.documentElement.scrollHeight].join("x"));

  const seen: string[] = [await sample()];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    seen.push(await sample());
    const tail = seen.slice(-3);
    if (tail.length === 3 && tail[0] === tail[1] && tail[1] === tail[2]) return;
  }
  throw new Error(
    "the page never held still: `#type` is supposed to be a static page, and a screenshot of one that " +
      `is still reflowing is not a baseline. Readings, as innerWidth x innerHeight x scrollHeight: ${seen.join(", ")}`,
  );
}

/**
 * Check that `NO_CLOCK` found what it was written for, and say so if it did not.
 *
 * A CSS rule that matches nothing is silent, and the failure it would let through is a
 * baseline that goes red a minute after it was written. So the ticking rows are counted and
 * then measured: a detail span that still has width is a detail span that is still on the
 * picture.
 */
async function clockIsNeutralised(control = false): Promise<void> {
  /* Waited for, not assumed: `evaluateAll` does not auto-wait, and a zero count would
     otherwise read as "the markup moved" when it only meant "not painted yet". */
  const ticker = page.locator(".orca-conn--reconnecting, .orca-conn--disconnected").first();
  await expect(ticker).toBeAttached();

  const widths = await page
    .locator(".orca-conn--reconnecting > span:last-child, .orca-conn--disconnected > span:last-child")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));

  /* Counted off the page rather than written here: the number of ticking rows is the number
     of theme columns times the states that carry a clock, and both are the design system's
     to change. What has to hold is that every one of them was hidden. */
  const ticking = await page.locator(".orca-conn--reconnecting, .orca-conn--disconnected").count();

  expect(
    widths.length,
    "the rule that hides `#type`'s two live clocks matched nothing of what is on the page — " +
      "`ConnectionIndicator`'s markup has moved and the baselines below are about to start drifting by a " +
      "second a second. Fix `NO_CLOCK`; do not delete this check.",
  ).toBe(ticking);
  expect(
    ticking,
    "`#type` drew no reconnecting or disconnected row, so this spec is looking at the wrong page",
  ).toBeGreaterThan(0);
  expect(
    widths.filter((width) => width !== 0),
    "a ticking connection detail still occupies the picture",
  ).toEqual([]);
  if (control) {
    const details = page.locator(
      ".orca-conn--reconnecting > span:last-child, .orca-conn--disconnected > span:last-child",
    );
    // Exercise the minute boundary that changes a hidden clock from one unit to two.
    // Its geometry must stay absent regardless of the live ticker's current value.
    for (const value of ["6m", "6m 1s ago"]) {
      const heights = await details.evaluateAll((nodes, text) => {
        return nodes.map((node) => {
          const children = [...node.childNodes];
          node.textContent = text;
          const height = node.getBoundingClientRect().height;
          node.replaceChildren(...children);
          return height;
        });
      }, value);
      expect(heights, "a hidden control clock still changes row height").toEqual(widths.map(() => 0));
    }
  }
}

/** The window showing the renderer, rather than whichever window opened first. */
async function findAppWindow(application: ElectronApplication, url: string): Promise<Page> {
  const origin = new URL(url).origin;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const found = application.windows().find((w) => w.url().startsWith(origin));
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `no Electron window loaded ${origin}; saw ${JSON.stringify(application.windows().map((w) => w.url()))}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** What `#type` says it is rendering with, read off the page rather than assumed. */
interface FaceReport {
  /** Every family the page declares as bundled — `BUNDLED_FAMILIES`, via the toggle's caption. */
  families: string[];
  /** `FontFace.family` → the statuses of its faces, as the document sees them. */
  statuses: Record<string, string[]>;
}

async function faceReport(): Promise<FaceReport> {
  return page.evaluate(() => {
    const statuses: Record<string, string[]> = {};
    for (const face of document.fonts) {
      const family = face.family.replace(/^["']|["']$/g, "");
      (statuses[family] ??= []).push(face.status);
    }
    return { families: Object.keys(statuses), statuses };
  });
}

/** Flip the bundled-faces toggle and wait for the page to say it has flipped. */
async function setFaces(faces: "bundled" | "fallback", controlled = false): Promise<void> {
  const toggle = page.getByRole("button", { name: /Bundled faces/ });
  const current = await page.locator(".type-proof").getAttribute("data-faces");
  if (current !== faces) await toggle.click();
  await expect(page.locator(".type-proof")).toHaveAttribute("data-faces", faces);
  if (process.platform === "linux") {
    if (faces === "fallback" && controlled && !controlInstalled) {
      await page.addStyleTag({ content: controlStyle() });
      controlInstalled = true;
    }
    await page.locator(".type-proof").evaluate(
      (root, enabled) => {
        root.toggleAttribute("data-control-fonts", enabled);
      },
      faces === "fallback" && controlled,
    );
  }
  await fontsSettled();
  /* Every picture goes through here, so this is the one place that guarantees none of them
     is taken mid-reflow — the toggle swaps whole families, which moves the page's height. */
  await layoutSettled();
  if (process.platform === "linux" && faces === "fallback" && controlled) await clockIsNeutralised(true);
}

/* ------------------------------------------------------------------ the machine checks */

test("every bundled face actually loaded, rather than falling through to the OS", async () => {
  const report = await faceReport();

  // A face the browser tried and could not use is the failure #213 exists to catch, and it
  // is silent on screen: the text still renders, in something else.
  const failed = Object.entries(report.statuses)
    .filter(([, states]) => states.includes("error"))
    .map(([family, states]) => `${family}: ${states.join(", ")}`);
  expect(failed, "a bundled @font-face failed to load and the page fell back to the OS").toEqual([]);

  /* And at least one face per declared family was actually *used*. A face nothing on the
     page drew would sit at `unloaded` forever, and `#type` draws every family — so a family
     with nothing loaded means the page stopped covering it, or the stack stopped reaching
     it. Either is worth a red run. */
  const unused = Object.entries(report.statuses)
    .filter(([, states]) => !states.includes("loaded"))
    .map(([family, states]) => `${family}: ${states.join(", ")}`);
  expect(unused, "a declared family was never drawn from, so the stacks are not reaching it").toEqual([]);
});

test("the native toggle changes what is drawn without a font control", async () => {
  /* The width of every declared glyph, bundled and then fallback. If the two agree the page
     was already rendering the fallback — the bundled symbol face carries glyphs Plex and
     the OS stacks do not, so their advances cannot match by accident across the whole set.
     This is the assertion that does not need a baseline, and so the one that still works on
     a platform whose baseline has not been committed yet. */
  const widths = async (): Promise<number[]> =>
    page.locator(".type-proof__glyph-large").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().width));

  await setFaces("bundled");
  const bundled = await widths();
  await setFaces("fallback");
  expect(await page.locator(".type-proof").getAttribute("data-control-fonts")).toBeNull();
  const fallback = await widths();
  await setFaces("bundled");

  expect(bundled.length, "the page declared no glyphs, so there is nothing to prove").toBeGreaterThan(0);
  expect(bundled.length).toBe(fallback.length);
  const changed = bundled.filter((w, i) => w !== fallback[i]).length;
  expect(changed, "turning the bundled faces off changed nothing, so they were never on").toBeGreaterThan(0);
});

if (process.platform === "linux") {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring; Electron owns the page.
  test("native Linux fallback remains visible as evidence", async ({}, testInfo) => {
    await setFaces("fallback", false);
    for (const theme of ["light", "dark"]) {
      const path = testInfo.outputPath(`native-fallback-${theme}.png`);
      await page.locator(`.type-proof__theme[data-theme="${theme}"]`).screenshot({ path });
      await testInfo.attach(`native-fallback-${theme}`, {
        path,
        contentType: "image/png",
      });
    }
    const path = testInfo.outputPath("native-fallback-fonts.json");
    await writeFile(path, JSON.stringify(await renderedFonts(page), null, 2));
    await testInfo.attach("native-fallback-fonts", {
      path,
      contentType: "application/json",
    });
    await setFaces("bundled");
  });
}

/* ------------------------------------------------------------------ the pictures */

for (const faces of ["bundled", "fallback"] as const) {
  for (const theme of ["light", "dark"] as const) {
    // eslint-disable-next-line no-empty-pattern -- Do not request Playwright's separate browser/page fixture.
    test(`the ${theme} column with the bundled faces ${faces === "bundled" ? "on" : "off"}`, async ({}, testInfo) => {
      const control = process.platform === "linux" && faces === "fallback";
      await setFaces(faces, control);
      if (control) {
        const report = await renderedFonts(page);
        await testInfo.attach("control-fonts", {
          body: JSON.stringify(report, null, 2),
          contentType: "application/json",
        });
        expect(report.length, "the control must cover the glyphs large, sans and mono").toBeGreaterThan(0);
        for (const entry of report) {
          expect(entry.fonts.length, entry.element).toBeGreaterThan(0);
          for (const font of entry.fonts) {
            expect(
              font.isCustomFont,
              `host font leaked into the control: ${JSON.stringify(font)} ${entry.element}`,
            ).toBe(true);
            expect(controlFontFamilies, entry.element).toContain(font.familyName);
          }
        }
      }
      /* The column as a locator, not the page: it bounds the image to the thing under test
         and leaves out the header, whose toggle caption changes with the state and whose
         link is the only interactive element on the page. */
      const column = page.locator(`.type-proof__theme[data-theme="${theme}"]`);
      await expect(column).toBeVisible();
      await expect(column).toHaveScreenshot(`type-${control ? "fallback-control" : faces}-${theme}.png`, {
        animations: "disabled",
      });
    });
  }
}
