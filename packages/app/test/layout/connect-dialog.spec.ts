/**
 * #1112: the Connect to a daemon dialog, where the class of bug was first seen in rc.1 testing:
 * the Add buttons under a status chip, a profile row's buttons running past the dialog onto the
 * backdrop, and modal content mixed with page content.
 *
 * Its own app, because the dialog only lists SSH profiles when no daemon is named by
 * ORCA_DAEMON_URL (`layout.spec.ts` names one). The profile is added through the dialog, as a
 * person would; nothing connects, so the destination is a placeholder. Then, at common window
 * sizes and at 100%, 125% and 150% zoom, every control in the dialog must sit inside it, overlap
 * no other control, and be the element the window hits at its centre, which is what puts it on
 * the modal's layer rather than under the backdrop.
 *
 * Linux only, like `layout.spec.ts`; `pnpm run app:layout` runs both.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Desktop, LARGE } from "./desktop.js";

const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const keyringStore = fileURLToPath(new URL("./keyring-store.cjs", import.meta.url));
const osSandboxArgs = process.env.ORCA_SMOKE_NO_SANDBOX ? ["--no-sandbox"] : [];
const OUT = process.env.LAYOUT_OUT;

test.describe.configure({ mode: "serial" });

let desktop: Desktop;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  desktop = await Desktop.start();
  const profile = await mkdtemp(join(desktop.root, "profile-"));
  await writeFile(join(profile, "preferences.json"), JSON.stringify({ alerts: { permission: false } }));
  const env = { ...desktop.env };
  delete env.ORCA_DAEMON_URL;
  delete env.ORCA_DAEMON_TOKEN_FILE;
  app = await electron.launch({
    args: ["-r", keyringStore, ...osSandboxArgs, `--user-data-dir=${profile}`, appDir],
    env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  if (OUT) await mkdir(OUT, { recursive: true });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await desktop?.stop();
});

async function frame(width: number, height: number, zoom: number) {
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
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function shot(name: string) {
  const png = Buffer.from(
    await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"),
    ),
    "base64",
  );
  await test.info().attach(name, { body: png, contentType: "image/png" });
  if (OUT) await writeFile(join(OUT, `${name}.png`), png);
}

test("#1112 Connect to a daemon: a profile row and its controls stay inside the dialog, apart, and on top", async () => {
  const dialog = page.getByRole("dialog", { name: "Connect to a daemon" });
  await expect(async () => {
    await page.getByRole("button", { name: "Connect to a daemon…" }).first().click({ timeout: 2_000 });
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Add profile…" }).click();
  await dialog.getByRole("textbox", { name: "Name profiles.name" }).fill("Build server with a long profile name");
  await dialog
    .getByRole("textbox", { name: "Server profiles.destination" })
    .fill("builder@build-server-01.internal.example.test");
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(dialog.getByText("Build server with a long profile name")).toBeVisible({ timeout: 30_000 });

  for (const [width, height, zoom] of [
    [...LARGE, 1],
    [...LARGE, 1.25],
    [...LARGE, 1.5],
    [800, 600, 1],
    [800, 600, 1.25],
    [800, 600, 1.5],
  ] as const) {
    const name = `1112-connect-dialog-${width}x${height}-${Math.round(zoom * 100)}`;
    await frame(width, height, zoom);
    // Each control in turn is scrolled into the dialog's view and measured there, so the check
    // covers the controls below the fold too.
    const count = await dialog.locator("button, input, select, .orca-chip").count();
    const found: { label: string; inside: boolean; onTop: boolean; overlaps: string[] }[] = [];
    for (let i = 0; i < count; i++) {
      found.push(
        await dialog
          .locator("button, input, select, .orca-chip")
          .nth(i)
          .evaluate((el) => {
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
            const box = el.getBoundingClientRect();
            const dialogBox = el.closest('[role="dialog"]')!.getBoundingClientRect();
            const label =
              el.getAttribute("aria-label") ?? (el.textContent || (el as HTMLInputElement).name || el.tagName).trim();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            const hit = document.elementFromPoint(x, y);
            const others = [...el.closest('[role="dialog"]')!.querySelectorAll("button, input, select, .orca-chip")]
              .filter((o) => o !== el && !o.contains(el) && !el.contains(o) && o.getClientRects().length > 0)
              .filter((o) => {
                const r = o.getBoundingClientRect();
                return (
                  box.left < r.right - 0.5 &&
                  r.left < box.right - 0.5 &&
                  box.top < r.bottom - 0.5 &&
                  r.top < box.bottom - 0.5
                );
              })
              .map((o) => (o.textContent ?? o.tagName).trim());
            return {
              label,
              inside:
                box.width === 0 ||
                (box.left >= dialogBox.left - 0.5 &&
                  box.right <= dialogBox.right + 0.5 &&
                  box.top >= dialogBox.top - 0.5 &&
                  box.bottom <= dialogBox.bottom + 0.5),
              onTop: box.width === 0 || (hit !== null && (hit === el || el.contains(hit) || hit.contains(el))),
              overlaps: others,
            };
          }),
      );
    }
    await dialog.evaluate((el) => el.scrollTo({ top: 0 }));
    await shot(name);
    const window = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: innerHeight }));
    const box = (await dialog.boundingBox())!;
    expect(box.x, `${name}: dialog in the window`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, `${name}: dialog in the window`).toBeLessThanOrEqual(window.w + 0.5);
    expect(box.y + box.height, `${name}: dialog in the window`).toBeLessThanOrEqual(window.h + 0.5);
    expect(found.length, name).toBeGreaterThan(5);
    for (const control of found) {
      expect(control.inside, `${name}: ${control.label} inside the dialog`).toBe(true);
      expect(control.onTop, `${name}: ${control.label} on the modal's layer`).toBe(true);
      expect(control.overlaps, `${name}: ${control.label} overlaps`).toEqual([]);
    }
  }
});
