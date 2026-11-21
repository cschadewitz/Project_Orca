/**
 * The upgrade launch check: the built app and the built daemon from this commit, opened on a
 * store that ORCA 0.6.0 wrote (#863).
 *
 * `app-shell.spec.ts` audits every surface, but it builds its store with today's `orca demo`,
 * so it can never notice that today's code stopped reading yesterday's data. This spec is the
 * other half: it is small, it runs in `ci.yml` on every pull request that can affect startup,
 * and its store is an old release's on purpose (see the fixture's README). A daemon that
 * cannot open the store, or an app that cannot render what it serves, fails here before a
 * release does.
 *
 * Prerequisite: `pnpm run build`. The app under test is `dist/`, the daemon is
 * `packages/cli/dist/main.js`.
 */
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { SURFACE_IDS, type SurfaceId } from "@orca/design";
import { startStoreFixtureDaemon, type StoreFixtureDaemon } from "./daemon.js";

/** The oldest release this check proves an upgrade from. */
const FIXTURE = fileURLToPath(new URL("../fixtures/store-v0.6.0/store", import.meta.url));

/** What 0.6.0's `orca demo` recorded, by id, name and workflow. */
const OLD_RUNS = [
  { id: "run_01M7Y4N25RKWC5S4YPWMJX1R3M", name: "Add authentication", workflowId: "program" },
  { id: "run_01M7Y4N2QXGB1VCH3WXQZYSAHD", name: "Add authentication", workflowId: "program::decide" },
  { id: "run_01M7Y4N32Q3PRX2KNSA630DJZH", name: "Database schema", workflowId: "ai-sdlc" },
  { id: "run_01M7Y4N336C1FQ2QWTB2PN2TTK", name: "Docs", workflowId: "ai-sdlc" },
  { id: "run_01M7Y4N4MRGM7GV5WJGJ61QX84", name: "Login API", workflowId: "ai-sdlc" },
] as const;

const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Same local-only opt-out as `app-shell.spec.ts`; CI never sets it. */
const osSandboxArgs = process.env.ORCA_SMOKE_NO_SANDBOX ? ["--no-sandbox"] : [];

interface UpgradeWindow {
  orca?: {
    hello: () => Promise<{ ok: true; result: { capabilities: string[] } } | { ok: false; error: unknown }>;
  };
}

let daemon: StoreFixtureDaemon;
let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  daemon = await startStoreFixtureDaemon(FIXTURE);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.ORCA_DAEMON_URL = daemon.url;
  delete env.ORCA_DAEMON_TOKEN;
  env.ORCA_DAEMON_TOKEN_FILE = daemon.tokenFile;

  userData = await mkdtemp(join(tmpdir(), "orca-upgrade-profile-"));
  app = await electron.launch({ args: [...osSandboxArgs, `--user-data-dir=${userData}`, appDir], env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  await daemon?.stop();
  if (userData) await rm(userData, { recursive: true, force: true });
});

test("the current daemon serves every run the 0.6.0 store recorded", async () => {
  const result = (await daemon.rpc("runs.list")) as {
    runs?: { id: string; name: string; workflowId: string; status: string }[];
  };
  const runs = [...(result.runs ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  expect(runs.map(({ id, name, workflowId }) => ({ id, name, workflowId }))).toEqual(OLD_RUNS);
  for (const run of runs) expect(run.status, `${run.id} after the upgrade`).toBe("succeeded");
});

test("the built app connects and handshakes on the old store", async () => {
  expect(await page.title()).toBe("ORCA");
  await expect(page.locator(".orca-statusbar")).toContainText(/orca-daemon \d+\.\d+\.\d+/);
  await expect(page.getByText("disconnected")).toHaveCount(0);

  const hello = await page.evaluate(() => (window as unknown as UpgradeWindow).orca!.hello());
  expect(hello.ok, "hello over the app's own bridge").toBe(true);
});

async function gotoSurface(id: SurfaceId) {
  await page.keyboard.press(`ControlOrMeta+Digit${SURFACE_IDS.indexOf(id) + 1}`);
  const pane = page.locator(`main.orca-main[data-surface="${id}"]`);
  await expect(pane).toBeVisible();
  return pane;
}

test("Runs lists the program run the old release recorded", async () => {
  const pane = await gotoSurface("runs");
  await expect(pane.locator(".orca-runs__tree .orca-tree-row").first()).toBeVisible();
  await expect(pane.locator(".orca-runs__tree")).toContainText("Add authentication");
  await expect(pane.getByText("disconnected")).toHaveCount(0);
});

test("Plan shows the old release's work items", async () => {
  const pane = await gotoSurface("plan");
  const grid = pane.locator('[role="grid"]');
  await expect(grid.locator('[role="row"]').first()).toBeVisible();
  for (const item of ["Database schema", "Docs", "Login API"]) await expect(grid).toContainText(item);
});
