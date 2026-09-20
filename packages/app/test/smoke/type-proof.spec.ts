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
 * are evidence and not goldens because the app draws OS-rendered chrome over data with a
 * clock in it; `#type` has no clock in its type and glyph sections, renders both themes as
 * `data-theme` subtrees, and exists precisely so that a pixel difference *means* something.
 * `docs/DEVELOPMENT.md` ("Screenshot baselines") has how they are created and the one
 * honest way to update them.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

/** `packages/app`, from this file: test/smoke → up two. */
const appDir = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** See `app-shell.spec.ts`: the OS sandbox needs user namespaces a plain container lacks. */
const osSandboxArgs = process.env.ORCA_SMOKE_NO_SANDBOX ? ["--no-sandbox"] : [];

/**
 * The window is sized here rather than left at `BrowserWindow`'s 1200×800, because the two
 * theme columns are `1fr 1fr` of it and a baseline is only comparable if the column it was
 * taken from was the same width. Tall enough that the header does not push the columns'
 * first section off a sensible fold; the columns are captured whole regardless.
 */
const CONTENT = { width: 1280, height: 900 };

let server: ViteDevServer;
let app: ElectronApplication;
let page: Page;
let userData: string;

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

  /* Scrollbars, gone. On Linux they take layout width and on macOS they overlay while
     scrolling, which is a per-platform difference in the *column widths* rather than in the
     type — the thing this spec is about. Removing them makes the columns the same box
     everywhere and removes a capture-time flake. */
  await page.addStyleTag({
    content: "html { scrollbar-width: none } ::-webkit-scrollbar { width: 0; height: 0; display: none }",
  });

  await fontsSettled();
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
async function setFaces(faces: "bundled" | "fallback"): Promise<void> {
  const toggle = page.getByRole("button", { name: /Bundled faces/ });
  const current = await page.locator(".type-proof").getAttribute("data-faces");
  if (current !== faces) await toggle.click();
  await expect(page.locator(".type-proof")).toHaveAttribute("data-faces", faces);
  await fontsSettled();
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

test("the toggle changes what is drawn, which is what makes the fallback column a control", async () => {
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
  const fallback = await widths();
  await setFaces("bundled");

  expect(bundled.length, "the page declared no glyphs, so there is nothing to prove").toBeGreaterThan(0);
  expect(bundled.length).toBe(fallback.length);
  const changed = bundled.filter((w, i) => w !== fallback[i]).length;
  expect(changed, "turning the bundled faces off changed nothing, so they were never on").toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ the pictures */

for (const faces of ["bundled", "fallback"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`the ${theme} column with the bundled faces ${faces === "bundled" ? "on" : "off"}`, async () => {
      await setFaces(faces);
      /* The column as a locator, not the page: it bounds the image to the thing under test
         and leaves out the header, whose toggle caption changes with the state and whose
         link is the only interactive element on the page. */
      const column = page.locator(`.type-proof__theme[data-theme="${theme}"]`);
      await expect(column).toBeVisible();
      await expect(column).toHaveScreenshot(`type-${faces}-${theme}.png`, { animations: "disabled" });
    });
  }
}
