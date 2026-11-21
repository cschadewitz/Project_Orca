/**
 * A real update, end to end, on Windows (#863, item 5; adopted from T3 Code's mock update
 * server). The installed version N asks this machine's copy of the feed Worker
 * (`tools/deploy/feed-local.js`, the Worker's own `handle` over a directory) for an update:
 *
 * - with a `preview` token, whose ring still holds N, it is told it is current;
 * - with an `internal` token, whose ring holds N+1, it is offered N+1, downloads it through
 *   the Worker and restarts into the installer, after which Windows reports N+1 installed.
 *
 * That covers the Worker's ring choice and authorization, the app's update driver and
 * electron-updater on an unsigned per-user install, with nothing published. It does not
 * prove the updated app relaunches, that Range requests were used (a full download passes
 * too), signed-feed acceptance or the prerelease opt-in. The feed workflow
 * (`feed-update-e2e.yml`) packages N and N+1, installs N, trusts a throwaway certificate for
 * `localhost` and starts the feed before this runs; the environment below says where.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; feed-update-e2e.yml sets it`);
  return value;
}

const EXECUTABLE = required("ORCA_UPDATE_EXECUTABLE");
const FEED_URL = required("ORCA_UPDATE_URL");
const FROM = required("ORCA_UPDATE_FROM");
const TO = required("ORCA_UPDATE_TO");
const TOKEN_FILES = {
  internal: required("ORCA_UPDATE_TOKEN_INTERNAL"),
  preview: required("ORCA_UPDATE_TOKEN_PREVIEW"),
};

interface Snapshot {
  phase: string;
  current: string;
  version?: string;
}
interface UpdatesWindow {
  orca: {
    connection: { read(): { state: string } };
    updates: { act(action: string): Promise<{ ok: boolean; result?: Snapshot }> };
  };
}

async function launch(ring: keyof typeof TOKEN_FILES): Promise<{ app: ElectronApplication; page: Page }> {
  const root = await mkdtemp(join(tmpdir(), `orca-update-${ring}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    ORCA_UPDATE_URL: FEED_URL,
    ORCA_UPDATE_TOKEN_FILE: TOKEN_FILES[ring],
    // The bundled daemon gives the restart guards something real to stop.
    ORCA_WORKSPACE: workspace,
  });
  delete env.ORCA_UPDATE_PRERELEASE;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [`--user-data-dir=${join(root, "profile")}`],
    env,
    timeout: 60_000,
  });
  // The main process's own output, in the workflow log beside the feed's request log.
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${ring}] ${chunk.toString()}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[${ring}] ${chunk.toString()}`));
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(
    () => (window as unknown as UpdatesWindow).orca?.connection.read().state === "live",
    undefined,
    {
      timeout: 60_000,
    },
  );
  return { app, page };
}

async function act(page: Page, action: string): Promise<Snapshot> {
  const reply = await page.evaluate((a) => (window as unknown as UpdatesWindow).orca.updates.act(a), action);
  expect(reply.ok, `updates.act(${action})`).toBe(true);
  return reply.result!;
}

/** DisplayVersion of the per-user ORCA install, as Apps & features shows it. */
async function installedVersion(): Promise<string> {
  const { stdout } = await execute("powershell", [
    "-NoProfile",
    "-Command",
    "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | " +
      "Where-Object DisplayName -like 'ORCA*' | Select-Object -First 1).DisplayVersion",
  ]);
  return stdout.trim();
}

test.describe.configure({ mode: "serial" });

test("the installed version is the one being updated from", async () => {
  expect(await installedVersion()).toBe(FROM);
});

test("a preview token, whose ring holds the installed version, is not offered the update", async () => {
  const { app, page } = await launch("preview");
  try {
    const state = await act(page, "check");
    expect(state).toMatchObject({ phase: "current", current: FROM });
    expect(state.version).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("an internal token is offered the next version, downloads it and installs it", async () => {
  // Each step has its own bound, so a hang names the step; the feed's request log is in the
  // workflow output.
  test.setTimeout(900_000);
  const { app, page } = await launch("internal");
  let closed = false;
  app.on("close", () => (closed = true));
  // Node prints this once the main process has run out of work, which is how an app that has
  // quit looks while Playwright's inspector session still holds the process open.
  let quit = false;
  app.process().stderr?.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("Waiting for the debugger to disconnect")) quit = true;
  });
  try {
    await test.step(
      "check",
      async () => {
        expect(await act(page, "check")).toMatchObject({ phase: "available", current: FROM, version: TO });
      },
      { timeout: 120_000 },
    );
    await test.step(
      "download",
      async () => {
        expect(await act(page, "download")).toMatchObject({ phase: "ready" });
      },
      { timeout: 360_000 },
    );
    await test.step("restart into the installer", async () => {
      // Restart hands over to the installer and quits, so a successful call never answers. An
      // answer is a refusal or an unknown installer outcome: fail with it rather than wait.
      let answer: unknown;
      void page
        .evaluate(() => (window as unknown as UpdatesWindow).orca.updates.act("restart"))
        .then((reply) => (answer = reply))
        .catch(() => undefined);
      await expect.poll(() => closed || quit || answer !== undefined, { timeout: 120_000 }).toBe(true);
      expect(closed || quit, `the app quits into the installer; restart answered ${JSON.stringify(answer)}`).toBe(true);
      // Only the inspector keeps it alive now, and the installer waits for it to exit: let it.
      if (!closed) app.process().kill();
      await expect.poll(() => closed, { timeout: 30_000, message: "the quit app exits" }).toBe(true);
    });
  } finally {
    if (!closed) await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
  }
  await test.step("installed version", async () => {
    await expect
      .poll(installedVersion, { timeout: 300_000, intervals: [2_000], message: `Windows reports ${TO} installed` })
      .toBe(TO);
  });
});
