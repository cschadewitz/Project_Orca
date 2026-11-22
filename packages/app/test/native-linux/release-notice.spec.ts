/**
 * #888 on the installed package: the `.deb` has no updater, so it checks the public release
 * list and shows a notice in the title bar when a newer release has a package for it.
 *
 * The release list is a local stub (`ORCA_RELEASES_URL`, loopback only) so the test never
 * depends on what is published. One launch is offered a newer release with an amd64 `.deb`
 * and must show the notice with the `apt` command; one is offered only the installed version
 * and must show nothing; one has every connection cut and must start as fast as ever and show
 * nothing. Nothing is downloaded either way: the stub only serves the list.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { NativeSession } from "./session.js";
import { launchInstalled, noneLeft, quit, VISIBLE_BUDGET_MS } from "./app.js";

/** The first check waits for startup to settle (FIRST_CHECK_MS, 15 s). */
const NOTICE_BUDGET_MS = 45_000;

let session: NativeSession;
let server: Server;
let releases: unknown[] = [];
let requests = 0;
let url = "";

test.beforeAll(async () => {
  session = await NativeSession.start();
  session.answerPrompts("cancel");
  server = createServer((request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(releases));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
});

test.afterAll(async () => {
  server?.close();
  await session?.stop();
});

const release = (version: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [{ name: `ORCA-${version}-linux-amd64.deb` }],
});

function next(version: string): string {
  const [major, minor, patch] = version.split("-")[0]!.split(".").map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

async function launch(env: Record<string, string>) {
  await noneLeft();
  const profile = await mkdtemp(join(session.root, "profile-notice-"));
  const launched = await launchInstalled(session, profile, "x11", env);
  const version = await launched.app.evaluate(({ app }) => app.getVersion());
  return { launched, version };
}

test("an older install shows the notice with the install command", async () => {
  test.setTimeout(120_000);
  // The installed version is only known after launch, so the stub answers from it.
  releases = [];
  const { launched, version } = await launch({ ORCA_RELEASES_URL: url });
  try {
    const newer = next(version);
    releases = [release(newer), release(version)];
    // Set well before the first check, which waits FIRST_CHECK_MS after the window.
    const notice = launched.page.getByRole("button", { name: `ORCA ${newer} is available` });
    await expect(notice).toBeVisible({ timeout: NOTICE_BUDGET_MS });
    await notice.click();
    await expect(launched.page.getByText(`sudo apt install ./ORCA-${newer}-linux-amd64.deb`)).toBeVisible();
    await expect(launched.page.getByRole("menuitem", { name: "Open release page" })).toBeVisible();
    await test.info().attach("release-notice", { body: await launched.page.screenshot(), contentType: "image/png" });
    await launched.page.keyboard.press("Escape");
  } catch (error) {
    await launched.app.close().catch(() => undefined);
    throw error;
  }
  await quit(session, launched, "x11");
});

test("a current install shows nothing", async () => {
  test.setTimeout(120_000);
  releases = [];
  const { launched, version } = await launch({ ORCA_RELEASES_URL: url });
  try {
    releases = [release(version)];
    requests = 0;
    await expect.poll(() => requests, { timeout: NOTICE_BUDGET_MS }).toBeGreaterThan(0);
    // The decision itself is unit-tested; here the installed app read the list and still
    // shows no notice.
    await expect(launched.page.getByRole("button", { name: /is available$/ })).toHaveCount(0);
  } catch (error) {
    await launched.app.close().catch(() => undefined);
    throw error;
  }
  await quit(session, launched, "x11");
});

test("a failed check is silent and does not delay startup", async () => {
  test.setTimeout(120_000);
  // Every connection is cut before a response: the check fails and must say nothing.
  let attempts = 0;
  const refusing = createNetServer((socket) => {
    attempts++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
  const port = (refusing.address() as AddressInfo).port;
  const { launched } = await launch({ ORCA_RELEASES_URL: `http://127.0.0.1:${port}/releases` });
  try {
    expect(launched.msToVisible).toBeLessThanOrEqual(VISIBLE_BUDGET_MS);
    await expect.poll(() => attempts, { timeout: NOTICE_BUDGET_MS }).toBeGreaterThan(0);
    await expect(launched.page.getByRole("button", { name: /is available$/ })).toHaveCount(0);
  } catch (error) {
    await launched.app.close().catch(() => undefined);
    throw error;
  }
  await quit(session, launched, "x11");
  refusing.close();
});
