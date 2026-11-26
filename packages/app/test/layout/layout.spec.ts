/**
 * Layout acceptance for the 0.8.1 desktop fixes: the built app, pointed at a daemon filled by
 * the demo seed (#1115), driven to each state the visual sweep reported, measured, and
 * screenshotted.
 *
 * - #1193: Runs titles keep at least twenty characters and Tree/Board/Search stay in the
 *   window at 800×600 and at 150% zoom.
 * - #1112: the overlap and clipping sites (Plan header, Risks pins, Decisions columns, the
 *   collapsed sidebar, the status bar, the Config view switcher after Launch work, the
 *   Launch work workflow menu, override keys).
 * - #1194: permission cards name their run and their age counts up.
 * - #1200: Launch work facts sit on their own lines, and an agent whose command is missing
 *   says so instead of "unknown".
 *
 * Every test attaches its screenshots to the report; with `LAYOUT_OUT` set they are also
 * written there as PNGs. Screenshots come from `webContents.capturePage()`, because
 * `page.screenshot` crops a zoomed window to the unzoomed size.
 *
 * Linux only: it needs Xvfb, dbus-daemon and gnome-keyring-daemon (`desktop.ts`). Run with
 * `pnpm run app:layout` after `pnpm run build`; as root, also set `ORCA_SMOKE_NO_SANDBOX=1`.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Desktop, LARGE } from "./desktop.js";
import { startSeededDaemon, type SeededDaemon } from "./seeded-daemon.js";

const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const keyringStore = fileURLToPath(new URL("./keyring-store.cjs", import.meta.url));
const osSandboxArgs = process.env.ORCA_SMOKE_NO_SANDBOX ? ["--no-sandbox"] : [];
const OUT = process.env.LAYOUT_OUT;

test.describe.configure({ mode: "serial" });

let desktop: Desktop;
let daemon: SeededDaemon;
let app: ElectronApplication;
let page: Page;
let profile: string;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  desktop = await Desktop.start();
  daemon = await startSeededDaemon();
  profile = await mkdtemp(join(desktop.root, "profile-"));
  // No permission notifications from the seeded asks; the other tiers are off by default.
  await writeFile(join(profile, "preferences.json"), JSON.stringify({ alerts: { permission: false } }));
  app = await electron.launch({
    // `-r` runs before Playwright's own loader appends `--password-store=basic`; the switch it
    // sets is read later, so the libsecret store wins and Launch work can keep an intent.
    args: ["-r", keyringStore, ...osSandboxArgs, `--user-data-dir=${profile}`, appDir],
    env: { ...desktop.env, ORCA_DAEMON_URL: daemon.url, ORCA_DAEMON_TOKEN_FILE: daemon.tokenFile },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible())))
    .toBe(true);
  // A permission ask takes a focused window to its card whatever the alert preferences say
  // (alerts.ts: it is not a notification), and under Xvfb with no window manager the window is
  // always focused. The seeded asking-builders keep asking, so the window would leave the
  // surface a test is measuring. The window says it is not focused instead; nothing else here
  // reads focus.
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.isFocused = () => false;
  });
  if (OUT) await mkdir(OUT, { recursive: true });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await daemon?.stop();
  await desktop?.stop();
});

/** Sets the window's content size and zoom, then waits until the renderer has laid out at them. */
async function frame(width: number, height: number, zoom = 1) {
  await app.evaluate(
    ({ BrowserWindow }, s) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setContentSize(s.width, s.height);
      win.webContents.setZoomFactor(s.zoom);
    },
    { width, height, zoom },
  );
  await expect
    .poll(() =>
      page.evaluate(() => [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]),
    )
    .toEqual([width, height]);
  await settled();
}

/** Two animation frames: whatever the last change caused has been painted. */
const settled = () =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/**
 * Clicks a button by its exact name. Plan re-renders its mode switcher whenever a live update
 * lands, and the seeded runs are still moving, so a click that found a detached button is
 * tried again rather than waited out.
 */
async function press(name: string) {
  await expect(async () => {
    await page.getByRole("button", { name, exact: true }).first().click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await settled();
}

async function surface(name: string) {
  await page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name }).click();
  await settled();
}

/** Captures the window as it is painted and attaches it; written to `LAYOUT_OUT` too when set. */
async function shot(name: string) {
  await settled();
  const png = Buffer.from(
    await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"),
    ),
    "base64",
  );
  await test.info().attach(name, { body: png, contentType: "image/png" });
  if (OUT) await writeFile(join(OUT, `${name}.png`), png);
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const overlaps = (a: Box, b: Box) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (inner: Box, outer: Box) =>
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5;

test("#1193 Runs keeps twenty characters of title and its toolbar at 800×600 and 150%", async () => {
  await surface("Runs");
  await expect(page.locator(".orca-runs__tree .orca-tree-row").first()).toBeVisible({ timeout: 30_000 });
  for (const [width, height, zoom, name] of [
    [800, 600, 1, "1193-runs-800x600"],
    [...LARGE, 1.5, `1193-runs-${LARGE[0]}x${LARGE[1]}-150`],
    // Both at once: about 530 CSS pixels, where the step detail folds under the tree.
    [800, 600, 1.5, "1193-runs-800x600-150"],
  ] as const) {
    await frame(width, height, zoom);
    await expect(page.locator(".orca-runs__tree .orca-runs__name").first()).toBeVisible({ timeout: 30_000 });
    const measured = await page.evaluate(() => {
      const names = [...document.querySelectorAll<HTMLElement>(".orca-runs__tree .orca-runs__name")];
      // Twenty characters of the title's own face and size.
      const probe = document.createElement("span");
      probe.className = names[0]!.className;
      probe.style.position = "absolute";
      probe.style.whiteSpace = "pre";
      probe.textContent = "x".repeat(20);
      document.body.append(probe);
      const twenty = probe.getBoundingClientRect().width;
      probe.remove();
      const views = [...document.querySelectorAll<HTMLElement>(".orca-runs__views button")].map((button) => {
        const r = button.getBoundingClientRect();
        return { label: button.textContent ?? "", right: r.right, bottom: r.bottom };
      });
      return {
        twenty,
        // What can be read without scrolling sideways: the title as its scrolling pane clips it.
        narrowest: Math.min(
          ...names.slice(0, 10).map((n) => {
            const r = n.getBoundingClientRect();
            let pane = n.parentElement;
            while (pane && getComputedStyle(pane).overflowX === "visible") pane = pane.parentElement;
            const edge = pane ? pane.getBoundingClientRect().left + pane.clientWidth : innerWidth;
            return Math.min(r.right, edge) - r.left;
          }),
        ),
        views,
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      };
    });
    await shot(name);
    expect(measured.narrowest, `${name}: narrowest title`).toBeGreaterThanOrEqual(measured.twenty);
    expect(measured.views.map((v) => v.label)).toEqual(["Tree", "Board", "Search"]);
    for (const view of measured.views) {
      expect(view.right, `${name}: ${view.label}`).toBeLessThanOrEqual(measured.width);
      expect(view.bottom, `${name}: ${view.label}`).toBeLessThanOrEqual(measured.height);
    }
  }
  await frame(...LARGE);
});

test("#1193 at 800×600 and 150% the step detail folds under the tree, and only once a run is selected", async () => {
  await surface("Runs");
  await frame(800, 600, 1.5);
  const tree = page.locator(".orca-runs__tree");
  const detail = page.locator(".orca-runs__detail");
  await expect(tree.locator(".orca-runs__name").first()).toBeVisible({ timeout: 30_000 });
  await expect(detail).toBeHidden();
  // The seeded runs are still moving: a click that met a row being redrawn is tried again.
  await expect(async () => {
    await page.getByRole("treeitem").first().click({ timeout: 2_000 });
    await expect(detail).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const [treeBox, detailBox] = await Promise.all([tree.boundingBox(), detail.boundingBox()]);
  await shot("1193-runs-800x600-150-selected");
  // One column: the detail under the tree, as wide as it, not beside it.
  expect(detailBox!.y).toBeGreaterThanOrEqual(treeBox!.y + treeBox!.height - 0.5);
  expect(Math.abs(detailBox!.width - treeBox!.width)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await frame(...LARGE);
});

test("#1112 Plan schedule header cells never overlap", async () => {
  await frame(...LARGE);
  await surface("Plan");
  const head = page.locator(".orca-plan__head").first();
  await expect(head).toBeVisible({ timeout: 30_000 });
  const cells = await head.evaluate((el) =>
    [...el.children].map((c) => {
      const r = c.getBoundingClientRect();
      return {
        text: c.textContent ?? "",
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        clipped: c.scrollWidth > c.clientWidth,
      };
    }),
  );
  await shot("1112-plan-schedule");
  for (let i = 1; i < cells.length; i++)
    expect(overlaps(cells[i - 1]!, cells[i]!), `${cells[i - 1]!.text} / ${cells[i]!.text}`).toBe(false);
  for (const name of ["Title", "Request"]) {
    const cell = cells.find((c) => c.text === name);
    expect(cell, name).toBeDefined();
    expect(cell!.clipped, `${name} fits`).toBe(false);
  }
});

test("#1112 Risks pins stay in their cell and off the score", async () => {
  await surface("Plan");
  await press("Risks");
  const pins = page.locator(".orca-risk__pin");
  await expect(pins.first()).toBeVisible({ timeout: 30_000 });
  const measured = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".orca-risk__pin")].map((pin) => {
      const cell = pin.closest("td")!;
      const score = cell.querySelector(".orca-risk__score");
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      return { pin: box(pin), cell: box(cell), score: score ? box(score) : null, title: pin.title };
    }),
  );
  await shot("1112-plan-risks");
  for (const { pin, cell, score, title } of measured) {
    expect(inside(pin, cell), `${title} inside its cell`).toBe(true);
    if (score) expect(overlaps(pin, score), `${title} off the score`).toBe(false);
    expect(title, "the pin names the whole risk on hover").toMatch(/\S+ \S/);
  }
});

test("#1112 Decisions has column headers and room for the question", async () => {
  await surface("Plan");
  await press("Decisions");
  const head = page.locator(".orca-plan__decision-head").first();
  await expect(head).toBeVisible({ timeout: 30_000 });
  await expect(head.locator(":scope > span")).toHaveText([
    "Status",
    "Decision",
    "Question",
    "Due",
    "Outcome",
    "Supersedes",
  ]);
  const question = await page
    .locator(".orca-plan__decision-head > span", { hasText: "Question" })
    .evaluate((el) => el.getBoundingClientRect().width / parseFloat(getComputedStyle(el).fontSize));
  await shot("1112-plan-decisions");
  // 24ch at the app's half-em `ch`: the "Ho…" column is gone.
  expect(question).toBeGreaterThanOrEqual(12);
});

test("#1112 at 800 the collapsed sidebar has no clipped label or sideways scroll, and the status bar sits below content", async () => {
  await frame(800, 600);
  await surface("Runs");
  const measured = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".orca-sidebar")!;
    const eyebrow = sidebar.querySelector<HTMLElement>(":scope > .orca-eyebrow");
    const bar = document.querySelector<HTMLElement>(".orca-statusbar")!.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>(".orca-body")!.getBoundingClientRect();
    const buttons = [...document.querySelectorAll<HTMLElement>(".orca-statusbar button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    return {
      collapsed: document.querySelector(".orca-body")?.getAttribute("data-sidebar"),
      eyebrowShown: eyebrow ? eyebrow.getClientRects().length > 0 : false,
      sideways: sidebar.scrollWidth > sidebar.clientWidth,
      bar: { top: bar.top, bottom: bar.bottom },
      bodyBottom: body.bottom,
      buttons,
    };
  });
  await shot("1112-sidebar-statusbar-800");
  expect(measured.collapsed).toBe("collapsed");
  expect(measured.eyebrowShown, "no clipped SURFACES eyebrow").toBe(false);
  expect(measured.sideways, "no sideways scroll in the rail").toBe(false);
  expect(measured.bodyBottom).toBeLessThanOrEqual(measured.bar.top + 0.5);
  for (const b of measured.buttons) {
    expect(b.top).toBeGreaterThanOrEqual(measured.bar.top - 0.5);
    expect(b.bottom).toBeLessThanOrEqual(measured.bar.bottom + 0.5);
  }
  await frame(...LARGE);
});

test("#1112 #1200 Launch work: facts on their own lines, a menu inside its pane, and a switcher that comes back", async () => {
  await frame(...LARGE);
  await surface("Config");
  await press("Launch work");
  const trigger = page.locator("button", { hasText: "Choose a workflow" }).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await shot("1200-launch-work");

  // The workflow menu opens inside the pane that scrolls it, and its long names are cut, not spilled.
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const placement = await menu.evaluate((el) => {
    let pane: HTMLElement | null = el.parentElement;
    while (pane && getComputedStyle(pane).overflowY === "visible") pane = pane.parentElement;
    const box = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    return {
      menu: box(el.getBoundingClientRect()),
      pane: box((pane ?? document.documentElement).getBoundingClientRect()),
      spilled: [...el.querySelectorAll<HTMLElement>(".orca-menu__label")].some(
        (label) => label.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5,
      ),
    };
  });
  await shot("1112-launch-work-workflow-menu");
  expect(inside(placement.menu, placement.pane), "menu inside its pane").toBe(true);
  expect(placement.spilled, "no label past the menu's edge").toBe(false);
  await page.getByRole("menuitem").first().click();

  // Each fact of the two cards is its own line: nothing runs into the next sentence.
  const facts = page.locator(".orca-guided-launch__facts");
  await expect(facts.first()).toBeVisible({ timeout: 30_000 });
  await facts.first().scrollIntoViewIfNeeded();
  await shot("1200-launch-work-facts");
  await expect(page.locator(".orca-guided-launch")).not.toContainText(/unavailable\.[A-Z]/);
  const lines = await facts.evaluateAll((cards) =>
    cards.map((card) => {
      const tops = [...card.querySelectorAll(":scope > *, :scope > * > *")]
        .filter((el) => el.textContent?.trim())
        .map((el) => Math.round(el.getBoundingClientRect().top));
      return new Set(tops).size;
    }),
  );
  for (const count of lines) expect(count).toBeGreaterThan(2);

  // Override keys break between words, not inside one.
  const paths = await page.locator(".orca-field__path").evaluateAll((els) =>
    els.map((el) => ({
      text: el.textContent ?? "",
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || "1")),
    })),
  );
  for (const path of paths) expect(path.lines, path.text).toBeLessThanOrEqual(1);

  // The view switcher is still there after Launch work, and takes you back to Raw.
  const raw = page.getByRole("button", { name: "Raw", exact: true }).first();
  await expect(raw).toBeVisible();
  await raw.click();
  const editor = page.locator(".orca-config__rawview textarea").first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await shot("1112-config-raw-after-launch-work");
  // The file itself. The demo seed writes its config back as JSON when the daemon refuses
  // structured edits, so the YAML the desktop's own first run now writes (#1200) is asserted in
  // `../first-run.test.ts` instead of here.
  expect(await editor.inputValue()).toContain('"version": 1');
});

test("#1194 permission cards name their run and show how long they have waited", async () => {
  await frame(...LARGE);
  await surface("Attention");
  const cards = page.locator(".orca-attn__card", { hasText: "permission" });
  await expect(cards.nth(1)).toBeVisible({ timeout: 30_000 });
  const subtitles = await cards.locator(".orca-card__sub").allInnerTexts();
  // Same-shape asks from different runs no longer read the same.
  expect(new Set(subtitles).size).toBe(subtitles.length);
  // The asks have waited through the seed's settle, so every card reads a real, non-zero age
  // rather than the "waiting 0s" each poll used to reset it to. That the label keeps counting
  // between polls is `renderer/test/attention-waited-age.test.tsx`, with a fake clock.
  const ages = await cards.locator(".orca-attn__age").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
  for (const age of ages) expect(age).toMatch(/^waiting (?:[1-9]\d*s|\d+[mhd])/);
  await shot("1194-attention-permission-cards");
});

test("#1200 an agent whose command is missing says so", async () => {
  await surface("Agents");
  const missing = page.locator(".orca-agent", { hasText: "Command not found on this host" });
  await expect(missing.first()).toBeVisible({ timeout: 30_000 });
  await missing.first().scrollIntoViewIfNeeded();
  await shot("1200-agents-command-missing");
});

test("#1112 Workflows: a wide graph opens fitted, every node in the canvas", async () => {
  await frame(...LARGE);
  await surface("Workflows");
  const row = page.locator("tr", { hasText: "wide-graph" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Open", exact: true }).click();
  const canvas = page.locator(".orca-wfcanvas__viewport, [role='listbox'][aria-label$='graph']").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await settled();
  const measured = await canvas.evaluate((el) => {
    const view = el.getBoundingClientRect();
    const nodes = [...el.querySelectorAll<HTMLElement>("[role='option']")].map((node) => {
      const r = node.getBoundingClientRect();
      return { id: node.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    return { view: { left: view.left, right: view.right, top: view.top, bottom: view.bottom }, nodes };
  });
  await shot("1112-workflows-wide-graph");
  expect(measured.nodes.length, "wide-graph's nodes").toBeGreaterThanOrEqual(10);
  for (const node of measured.nodes) expect(inside(node, measured.view), `${node.id} in the canvas`).toBe(true);
  await page.keyboard.press("Escape");
});

/*
 * #1112's scope: the whole app at common window sizes and at 100%, 125% and 150%. Every surface
 * is opened at each size and zoom; the page never scrolls sideways, and no two visible buttons
 * are drawn over each other. The surface-specific checks above cover the sites the sweeps found.
 */
test("#1112 every surface at a large window and 800×600, at 100%, 125% and 150%: no sideways page and no button on a button", async () => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  for (const [width, height] of [LARGE, [800, 600] as const]) {
    for (const zoom of [1, 1.25, 1.5]) {
      await frame(width, height, zoom);
      for (const name of ["Attention", "Runs", "Plan", "Workflows", "Agents", "Config", "Machines"]) {
        await surface(name);
        const found = await page.evaluate(() => {
          /* What of an element the window can show: its box cut by every ancestor that clips,
             so a row scrolled out of its pane is not "under" the status bar. */
          const shown = (el: Element) => {
            const r = el.getBoundingClientRect();
            let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            for (let p = el.parentElement; p; p = p.parentElement) {
              const style = getComputedStyle(p);
              if (style.overflowX === "visible" && style.overflowY === "visible") continue;
              const c = p.getBoundingClientRect();
              box = {
                left: Math.max(box.left, c.left),
                right: Math.min(box.right, c.right),
                top: Math.max(box.top, c.top),
                bottom: Math.min(box.bottom, c.bottom),
              };
            }
            return box;
          };
          const visible = (el: Element) => {
            const style = getComputedStyle(el);
            if (style.visibility === "hidden" || style.opacity === "0") return false;
            const b = shown(el);
            return b.right - b.left > 1 && b.bottom - b.top > 1;
          };
          const buttons = [...document.querySelectorAll("button")].filter(visible);
          const pairs: string[] = [];
          for (let i = 0; i < buttons.length; i++)
            for (let j = i + 1; j < buttons.length; j++) {
              const a = buttons[i]!;
              const b = buttons[j]!;
              if (a.contains(b) || b.contains(a)) continue;
              const ra = shown(a);
              const rb = shown(b);
              if (
                Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 1 &&
                Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 1
              )
                pairs.push(`"${(a.textContent ?? "").trim()}" / "${(b.textContent ?? "").trim()}"`);
            }
          return {
            // Whether the window can actually be scrolled sideways, which is what a person sees.
            sideways: (() => {
              const top = scrollY;
              scrollTo(10_000, top);
              const moved = scrollX > 0;
              scrollTo(0, top);
              return moved;
            })(),
            // What reaches the scrolled edge, to name in the failure.
            wide: [...document.body.querySelectorAll<HTMLElement>("*")]
              .filter((el) => Math.abs(el.getBoundingClientRect().right - document.documentElement.scrollWidth) < 2)
              .slice(0, 3)
              .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`),
            pairs,
          };
        });
        const where = `${name} at ${width}×${height} ${Math.round(zoom * 100)}%`;
        if (found.sideways) problems.push(`${where}: the page scrolls sideways (${found.wide.join("; ")})`);
        for (const pair of found.pairs) problems.push(`${where}: ${pair} overlap`);
        if (zoom === 1.5) await shot(`1112-audit-${name.toLowerCase()}-${width}x${height}-150`);
      }
    }
  }
  await frame(...LARGE);
  expect(problems).toEqual([]);
});
