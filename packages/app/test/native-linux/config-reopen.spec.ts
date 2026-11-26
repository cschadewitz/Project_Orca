/**
 * #1192 on the installed package: an agent added the way the app offers it, in Config > Raw
 * (Validate and review, Save reviewed changes, Apply saved configuration), must survive a quit
 * and reopen. Before the fix the reopened app never started its bundled daemon, because the
 * saved configuration was never bound for reopening, and the first screen said only "Start one
 * with orca serve".
 *
 * The reopened app must connect by itself, with no Project setup step in between, and the
 * agent must be on Agents. The screenshot of that Agents surface is this spec's evidence.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeSession } from "./session.js";
import { launchInstalled, noneLeft, quit } from "./app.js";
import { connected, disposableWorkspace, firstRunSetup, openConfig } from "./flows.js";

let session: NativeSession;

test.beforeAll(async () => {
  session = await NativeSession.start();
  // Nothing here should need the keyring; if something asks anyway, it is refused, never hung.
  session.answerPrompts("cancel");
});

test.afterAll(async () => {
  await session?.stop();
});

/** Config > Raw: replace the document, Validate and review, Save, Apply, as a person would. */
async function saveRawConfig(page: Page, text: string): Promise<void> {
  await openConfig(page);
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await page.getByRole("textbox", { name: "orca.config.yaml" }).fill(text);
  const bar = page.getByRole("group", { name: "Unsaved configuration changes" });
  await bar.getByRole("button", { name: "Validate and review" }).click();
  const save = bar.getByRole("button", { name: "Save reviewed changes" });
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  await save.click();
  // The save binds the saved configuration for reopening; nothing else is asked of the person.
  await expect(page.locator('[data-reopen-binding="bound"]')).toBeVisible({ timeout: 60_000 });
  const apply = page.getByRole("button", { name: "Apply saved configuration" });
  await apply.click();
  await expect(page.getByText(/^Apply outcome:/).first()).toBeVisible();
}

test("an agent added in Config > Raw, saved and applied, is there after quit and reopen", async () => {
  test.setTimeout(5 * 60_000);
  await noneLeft();
  const profile = await mkdtemp(join(session.root, "profile-config-reopen-"));
  const chosen = await disposableWorkspace(join(session.root, "config-reopen"), session.env);

  const first = await launchInstalled(session, profile, "x11");
  try {
    await firstRunSetup(first.app, first.page, chosen);
    const doc = JSON.parse(await readFile(join(chosen.workspace, "orca.config.yaml"), "utf8")) as {
      agents: unknown[];
    };
    doc.agents = [{ id: "echo", name: "Echo", command: "/bin/cat", args: [], roles: [] }];
    await saveRawConfig(first.page, JSON.stringify(doc, null, 2));
  } catch (error) {
    await first.app.close().catch(() => undefined);
    throw error;
  }
  await quit(session, first, "x11");

  const reopened = await launchInstalled(session, profile, "x11");
  try {
    await connected(reopened.page);
    await reopened.page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name: "Agents" }).click();
    await expect(reopened.page.getByText(/^echo$/i).first()).toBeVisible({ timeout: 30_000 });
    await test.info().attach("reopened-agents", {
      body: await reopened.page.screenshot(),
      contentType: "image/png",
    });
  } catch (error) {
    await test
      .info()
      .attach("reopen-failure", { body: await reopened.page.screenshot(), contentType: "image/png" })
      .catch(() => undefined);
    await reopened.app.close().catch(() => undefined);
    throw error;
  }
  await quit(session, reopened, "x11");
});
