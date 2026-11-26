/**
 * Visual sweep of the installed app on a seeded fresh install: first-run setup, the demo seed
 * (tools/demo-seed) applied through Config > Raw, then every surface and the main detail views,
 * at several window sizes and 150% zoom. Each capture also records an in-page layout audit
 * (overlapping, covered, clipped and off-window controls) in audit.json.
 *
 * Opt-in and slow (about 8 minutes), so it runs only when SWEEP_OUT is set:
 *   node tools/demo-seed/build.mjs
 *   SWEEP_OUT=/tmp/sweep pnpm exec playwright test --config packages/app/test/smoke/playwright.config.ts \
 *     --project=linux-native visual-sweep
 * SWEEP_SEED: the packed seed.mjs (default: the repo's dist). SWEEP_NODE: Node 22+ (default: this one).
 * SWEEP_LEGACY_BIND=1: only for builds without the #1192 fix (#1202), such as 0.8.0-rc.2, which
 * reopen after a config save only if the saved config is bound while the daemon is live.
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NativeSession } from "./session.js";
import { launchInstalled, quit, type Launched } from "./app.js";
import { connected, disposableWorkspace, firstRunSetup, type Workspace } from "./flows.js";

const execute = promisify(execFile);
const OUT = process.env.SWEEP_OUT ?? "";
const SEED =
  process.env.SWEEP_SEED ??
  fileURLToPath(new URL("../../../../tools/demo-seed/dist/orca-demo-seed/seed.mjs", import.meta.url));
const NODE = process.env.SWEEP_NODE ?? process.execPath;
const LEGACY_BIND = process.env.SWEEP_LEGACY_BIND === "1";

let session: NativeSession;
/** Registers the test only when SWEEP_OUT names where its screenshots go. */
function sweep(title: string, body: () => Promise<void>) {
  if (OUT) test(title, body);
}

// Opt-in: nothing registers without SWEEP_OUT, so the linux-native CI project skips this file.
if (OUT) {
  test.beforeAll(async () => {
    session = await NativeSession.start();
    // A login keyring that exists and is locked, unlocked when the app asks: a signed-in desktop.
    await session.lockedKeyring();
    session.answerPrompts("unlock");
  });
  test.afterEach(async () => {
    const app = running;
    running = undefined;
    if (app) await quit(session, app, "x11").catch(() => app.app.close().catch(() => undefined));
  });
  test.afterAll(async () => {
    await session?.stop();
  });
}

const audits: Record<string, unknown> = {};

/** Overlaps, occlusion and overflow of every visible control, measured in the page. */
async function audit(page: Page) {
  return page.evaluate(() => {
    const selector =
      'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="link"]';
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
      return !el.closest('[aria-hidden="true"], [inert]');
    };
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""} "${(
        el.getAttribute("aria-label") ||
        (el as HTMLElement).innerText ||
        el.getAttribute("title") ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 50)}"`;
    const els = [...document.querySelectorAll(selector)].filter(visible);
    const issues: { kind: string; a: string; b?: string; detail?: string }[] = [];
    const W = innerWidth;
    const H = innerHeight;
    for (const [i, a] of els.entries()) {
      const ra = a.getBoundingClientRect();
      // Off the window.
      if (ra.right > W + 1 || ra.left < -1 || ra.bottom > H + 1)
        if (ra.top < H && ra.bottom > 0)
          issues.push({
            kind: "off-window",
            a: name(a),
            detail: `${Math.round(ra.left)},${Math.round(ra.top)} ${Math.round(ra.width)}x${Math.round(ra.height)}`,
          });
      // Clipped by a scroll/clip ancestor, or sticking out of a dialog.
      for (let p = a.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        const clips = s.overflowX !== "visible" || s.overflowY !== "visible";
        const dialog = p.getAttribute("role") === "dialog" || p.tagName === "DIALOG";
        if (!clips && !dialog) continue;
        const rp = p.getBoundingClientRect();
        const scrollsX = /auto|scroll/.test(s.overflowX);
        const scrollsY = /auto|scroll/.test(s.overflowY);
        const outX = !scrollsX && (ra.left < rp.left - 1 || ra.right > rp.right + 1);
        const outY = !scrollsY && (ra.top < rp.top - 1 || ra.bottom > rp.bottom + 1);
        if (outX || outY)
          issues.push({
            kind: dialog ? "outside-dialog" : "clipped",
            a: name(a),
            b: `${p.tagName.toLowerCase()}.${[...p.classList].slice(0, 2).join(".")}`,
            detail: `${outX ? "x" : ""}${outY ? "y" : ""}`,
          });
        if (dialog || clips) break;
      }
      // Covered: the topmost element at its centre is neither it nor inside it.
      const cx = Math.min(Math.max(ra.left + ra.width / 2, 0), W - 1);
      const cy = Math.min(Math.max(ra.top + ra.height / 2, 0), H - 1);
      if (cy >= 0 && cy < H) {
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== a && !a.contains(top) && !top.contains(a)) {
          const coverer = top.closest(selector) ?? top;
          issues.push({ kind: "covered", a: name(a), b: name(coverer) });
        }
      }
      // Overlaps another control (neither inside the other).
      for (const b of els.slice(i + 1)) {
        if (a.contains(b) || b.contains(a)) continue;
        const rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 2 && h > 2)
          issues.push({ kind: "overlap", a: name(a), b: name(b), detail: `${Math.round(w)}x${Math.round(h)}` });
      }
    }
    return { controls: els.length, issues };
  });
}

/** Two painted frames with no animation running: what a person would see once the view stops moving. */
async function settled(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => done(document.getAnimations().every((a) => a.playState !== "running"))),
        ),
      ),
  );
}

let shot = 0;
async function capture(page: Page, label: string) {
  const file = `${String(++shot).padStart(3, "0")}-${label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}.png`;
  await settled(page);
  await page.screenshot({ path: join(OUT, file) });
  const result = await audit(page);
  audits[file] = result;
  await writeFile(join(OUT, "audit.json"), JSON.stringify(audits, null, 2));
  return result;
}

async function seed(workspace: Workspace, phase: string, extra: string[] = []) {
  // Any non-zero exit fails the sweep: prepare with --config-out exits 0, and so does populate.
  const result = await execute(NODE, [SEED, "--workspace", workspace.workspace, "--phase", phase, ...extra], {
    timeout: 400_000,
  }).then(
    ({ stdout, stderr }) => ({ ok: true, output: stdout + stderr }),
    (error: { stdout?: string; stderr?: string; message: string }) => ({
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`,
    }),
  );
  await writeFile(join(OUT, `seed-${phase}.log`), result.output);
  if (!result.ok) throw new Error(`demo seed ${phase} failed:\n${result.output}`);
}

async function relaunch(profile: string, old?: Launched): Promise<Launched> {
  if (old) {
    await quit(session, old, "x11");
  }
  const launched = await launchInstalled(session, profile, "x11");
  running = launched;
  const log = join(OUT, `main-${++launches}.log`);
  for (const stream of [launched.app.process().stdout, launched.app.process().stderr])
    stream?.on("data", (chunk: Buffer) => void appendFile(log, chunk).catch(() => undefined));
  return launched;
}
let launches = 0;
/** The app this test launched last, quit after the test whatever happened. */
let running: Launched | undefined;

const SURFACES = ["Attention", "Runs", "Plan", "Workflows", "Agents", "Config", "Machines"];

async function openSurface(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name }).click();
}

async function setSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), {
    width,
    height,
  });
}

/** Steps that failed: each is written down so the rest of the sweep still runs, and the test fails at the end. */
const failures: string[] = [];
async function attempt(label: string, step: () => Promise<unknown>) {
  try {
    await step();
  } catch (error) {
    failures.push(label);
    await writeFile(join(OUT, `error-${++shot}-${label.replace(/[^a-z0-9-]+/gi, "-")}.txt`), String(error));
  }
}

async function closeOverlays(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape").catch(() => undefined);
}

/** Each surface with its first item selected, and every menu or popover trigger on it opened. */
async function explore(page: Page, surface: string) {
  const main = page.locator("main").first();
  await attempt(`${surface}-select`, async () => {
    const row = main
      .locator(
        '[role="treeitem"], [role="row"] [role="gridcell"], [role="option"], [role="listitem"] button, li button, article button',
      )
      .first();
    if (await row.isVisible({ timeout: 2000 })) {
      await row.click({ timeout: 3000 });
      await capture(page, `${surface}-selected`);
    }
  });
  await attempt(`${surface}-tabs`, async () => {
    const tabs = main.locator('[role="tab"]');
    const count = Math.min(await tabs.count(), 8);
    for (let t = 0; t < count; t++) {
      const tab = tabs.nth(t);
      if (!(await tab.isVisible())) continue;
      const label = ((await tab.innerText()) || String(t)).slice(0, 20);
      await tab.click({ timeout: 3000 });
      await capture(page, `${surface}-tab-${label}`);
    }
  });
  const triggers = main.locator('button[aria-haspopup], button[aria-expanded="false"], select');
  const count = Math.min(await triggers.count().catch(() => 0), 10);
  for (let t = 0; t < count; t++)
    await attempt(`${surface}-trigger-${t}`, async () => {
      await openSurface(page, surface);
      const trigger = main.locator('button[aria-haspopup], button[aria-expanded="false"], select').nth(t);
      if (!(await trigger.isVisible())) return;
      const label = ((await trigger.getAttribute("aria-label")) || (await trigger.innerText()) || String(t)).slice(
        0,
        24,
      );
      await trigger.click({ timeout: 3000 });
      await capture(page, `${surface}-open-${label}`);
      await closeOverlays(page);
    });
}

/** Config > Raw: replace the document, Validate and review, Save, Apply, as a person would. */
async function saveRawConfig(page: Page, text: string, label: string) {
  await openSurface(page, "Config");
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await page.getByRole("textbox", { name: "orca.config.yaml" }).fill(text);
  await capture(page, `${label}-raw-pasted`);
  const bar = page.getByRole("group", { name: "Unsaved configuration changes" });
  await bar.getByRole("button", { name: "Validate and review" }).click({ timeout: 10_000 });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save reviewed changes" && b.getAttribute("aria-disabled") !== "true",
    ),
  );
  await capture(page, `${label}-raw-reviewed`);
  await bar.getByRole("button", { name: "Save reviewed changes" }).click({ timeout: 10_000 });
  const apply = page.getByRole("button", { name: "Apply saved configuration" });
  await apply.waitFor();
  await capture(page, `${label}-raw-saved`);
  if (await apply.isEnabled()) {
    await apply.click();
    await page
      .getByText(/^Apply outcome:/)
      .first()
      .waitFor();
  }
  await capture(page, `${label}-applied`);
}

/** Config's "Review saved configuration for reopening" and Bind, while the daemon that saved it is live. */
async function bindWhileLive(page: Page, label: string) {
  await openSurface(page, "Config");
  await page.getByRole("button", { name: "Form", exact: true }).click();
  await page.getByRole("button", { name: "Review saved configuration for reopening" }).click();
  const bind = page.getByRole("button", { name: "Bind reviewed saved configuration" });
  await bind.waitFor({ timeout: 60_000 });
  await capture(page, `${label}-bind-review`);
  await bind.click();
  await page.getByText("Saved configuration bound for reopening", { exact: false }).first().waitFor();
  await capture(page, `${label}-bound-live`);
}

/** Named views a person reaches by clicking: each one captured, a failure recorded and skipped. */
async function deepViews(page: Page, prefix: string) {
  const click = async (name: string | RegExp, exact = true) =>
    page.getByRole("button", { name, exact }).first().click({ timeout: 5000 });
  const step = (label: string, surface: string, action: () => Promise<unknown>) =>
    attempt(`${prefix}-${label}`, async () => {
      await openSurface(page, surface);
      await action();
      await capture(page, `${prefix}-${label}`);
      await writeFile(join(OUT, `${prefix}-${label}.txt`), await page.locator("body").innerText());
    });
  await step("runs-select-first", "Runs", () => page.getByRole("treeitem").first().click({ timeout: 5000 }));
  await step("runs-select-waiting", "Runs", () =>
    page.getByRole("treeitem").filter({ hasText: "waiting" }).first().click({ timeout: 5000 }),
  );
  await step("runs-select-failed", "Runs", async () => {
    await click(/^Filter by status/, false);
    await page.getByRole("menuitem", { name: "failed", exact: true }).click({ timeout: 5000 });
    await page.getByRole("treeitem").first().click({ timeout: 5000 });
    await click(/^Filter by status/, false);
    await page.getByRole("menuitem", { name: "All statuses" }).click({ timeout: 5000 });
  });
  await step("runs-expand-program", "Runs", async () => {
    const row = page.getByRole("treeitem").filter({ hasText: "Platform upgrade" }).first();
    await row.click({ timeout: 5000 });
    await page.keyboard.press("ArrowRight");
  });
  await step("runs-board", "Runs", () => click("Board"));
  await step("runs-search", "Runs", async () => {
    await click("Search");
    await page.keyboard.type("export");
  });
  for (const tab of ["Risks", "Decisions", "Dependencies", "Journal"])
    await step(`plan-${tab}`, "Plan", () => click(tab));
  await step("plan-switch", "Plan", () => click(/NFQ|Requests|plan/i, false));
  for (const name of [
    "Release train",
    "Weekly bug triage",
    "Parallel security audit",
    "Hotfix with a nested release train",
  ])
    await step(`workflow-${name}`, "Workflows", () =>
      page
        .getByRole("row")
        .filter({ hasText: name })
        .first()
        .getByRole("button", { name: "Open" })
        .click({ timeout: 5000 }),
    );
  await step("workflow-edit-wide", "Workflows", () =>
    page
      .getByRole("row")
      .filter({ hasText: "Weekly bug triage" })
      .getByRole("button", { name: "Edit" })
      .click({ timeout: 5000 }),
  );
  await step("agents-first", "Agents", () =>
    page.locator("main article, main [role=listitem]").first().click({ timeout: 5000 }),
  );
  await step("config-templates", "Config", () => click("Templates"));
  await step("config-raw", "Config", () => click("Raw"));
  await step("config-form", "Config", () => click("Form"));
  await step("machines-watch", "Machines", () => click(/^Watch a machine/, false));
  await closeOverlays(page);
  // Last of the Config views: opening Launch work collapses Config's view switcher (#1112).
  await step("config-launch-work", "Config", () => click("Launch work"));
  await step("connect-add-profile", "Runs", async () => {
    await click(/Connect to a daemon/, false);
    await click("Add profile…");
  });
  await closeOverlays(page);
  await step("connect-add-machine", "Runs", async () => {
    await click(/Connect to a daemon/, false);
    await click("Add a machine…");
  });
  await closeOverlays(page);
  await step("palette-typed", "Runs", async () => {
    await page.keyboard.press("Control+K");
    await page.keyboard.type("run");
  });
  await closeOverlays(page);
}

async function everySurface(page: Page, prefix: string) {
  for (const surface of SURFACES)
    await attempt(`${prefix}-${surface}`, async () => {
      await openSurface(page, surface);
      await capture(page, `${prefix}-${surface}`);
    });
}

sweep("seed a fresh install and capture every surface", async () => {
  test.setTimeout(60 * 60_000);
  await mkdir(join(OUT, "logs"), { recursive: true });
  const workspace = await disposableWorkspace(session.root, session.env);
  const profile = join(session.root, "profile");
  let launched = await relaunch(profile);
  await capture(launched.page, "first-screen");
  await firstRunSetup(launched.app, launched.page, workspace);
  await capture(launched.page, "after-first-run");
  // The whole workspace config: kept with the session, not with the shareable screenshots.
  const configText = join(session.root, "seeded-config.json");
  await seed(workspace, "prepare", ["--config-out", configText]);
  await saveRawConfig(launched.page, await readFile(configText, "utf8"), "seed");
  // Builds before the #1192 fix (#1202) reopen only with this extra bind; fixed builds must not need it.
  if (LEGACY_BIND) await bindWhileLive(launched.page, "seed");
  launched = await relaunch(profile, launched);
  await connected(launched.page);
  await seed(workspace, "populate");
  const { page, app } = launched;
  await setSize(app, 1280, 900);
  // The seed's data is there before any of it is judged by eye.
  await openSurface(page, "Runs");
  await expect
    .poll(async () => Number(/(\d+)\s+runs\b/.exec(await page.locator("body").innerText())?.[1] ?? 0), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(40)
    .finally(() => capture(page, "seeded-runs"));
  await openSurface(page, "Agents");
  for (const agent of ["atlas", "asking-builder", "planner-billing"])
    await expect(page.getByText(agent, { exact: true }).first()).toBeVisible();
  await openSurface(page, "Attention");
  await expect(page.getByText(/^PERMISSION$/i).first()).toBeVisible();
  await openSurface(page, "Workflows");
  await expect(page.getByText("release-train", { exact: true }).first()).toBeVisible();
  await everySurface(page, "1280");
  for (const surface of SURFACES) {
    await attempt(surface, () => openSurface(page, surface));
    await explore(page, surface);
    await closeOverlays(page);
  }
  await deepViews(page, "deep");
  await attempt("palette", async () => {
    await openSurface(page, "Runs");
    await page.keyboard.press("Control+K");
    await capture(page, "commands-palette");
    await closeOverlays(page);
  });
  await attempt("connect-dialog", async () => {
    await page.getByRole("button", { name: /Connect to a daemon/ }).click({ timeout: 3000 });
    await capture(page, "connect-dialog");
    await closeOverlays(page);
  });
  for (const [w, h] of [
    [1024, 700],
    [800, 600],
  ] as const) {
    await setSize(app, w, h);
    await everySurface(page, `${w}`);
  }
  await setSize(app, 1280, 900);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.5));
  await everySurface(page, "zoom150");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1));
  expect(failures, "sweep steps that failed (see error-*.txt in SWEEP_OUT)").toEqual([]);
});
