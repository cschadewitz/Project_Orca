/**
 * The tester's path through the installed app, as named controls: first-run setup of a
 * disposable Git project and empty workspace, then Launch work with the harmless sample.
 * Locators are roles and accessible names, which the smoke spec's axe audit keeps honest.
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface Workspace {
  project: string;
  workspace: string;
}

/** A Git project with one commit and a separate empty folder for the app workspace. */
export async function disposableWorkspace(root: string, env: Record<string, string>): Promise<Workspace> {
  const project = join(root, "work/project");
  const workspace = join(root, "work/workspace");
  await mkdir(project, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const git = ["-c", "user.name=ORCA native acceptance", "-c", "user.email=native@orca.invalid"];
  await execute("git", ["init", "-q", "-b", "main"], { cwd: project, env });
  await execute("git", [...git, "commit", "-q", "--allow-empty", "-m", "initial"], { cwd: project, env });
  return { project, workspace };
}

/**
 * Answer the next directory choices from main. The GTK chooser is GTK's to test; what this
 * suite is about is what ORCA does with the folders a person picks.
 */
export async function stubDirectoryChoices(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, queue) => {
    const pending = [...queue];
    const choose = () => {
      const next = pending.shift();
      return Promise.resolve(next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] });
    };
    (dialog as unknown as { showOpenDialog: typeof choose }).showOpenDialog = choose;
  }, paths);
}

export async function openConfig(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name: "Config" }).click();
}

/** First-run: choose, review, create the sample files and connect the bundled daemon. */
export async function firstRunSetup(app: ElectronApplication, page: Page, chosen: Workspace): Promise<void> {
  await stubDirectoryChoices(app, [chosen.project, chosen.workspace]);
  await openConfig(page);
  const setup = page.getByRole("region", { name: "First-run project setup" });
  await setup.getByRole("button", { name: "Choose project and empty workspace" }).click();
  await setup.getByRole("button", { name: "Create reviewed sample files" }).click();
  await setup.getByRole("button", { name: "Connect selected local workspace" }).click();
  await connected(page);
}

/** Wait for the bridge to report a live daemon connection (a reopen reconnects by itself). */
export async function connected(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { orca?: { connection: { read(): { state: string } } } }).orca?.connection.read().state ===
      "live",
    undefined,
    { timeout: 30_000 },
  );
}

export async function openLaunchWork(page: Page): Promise<void> {
  await openConfig(page);
  await page.getByRole("button", { name: "Launch work", exact: true }).click();
  try {
    await expect(page.getByRole("region", { name: "Guided launch" })).toBeVisible();
  } catch (error) {
    // #1177: this once timed out on a page that was right. While a keyring prompt is up, the
    // app's main process is inside the synchronous keyring call, and Playwright reaches the
    // window through that process: it sees nothing until the prompt is answered, and the page
    // in its own error context is the one from before the prompt. Record what the page shows
    // and what each guided-launch read answers once the app answers again, so a failure here
    // says whether the page was wrong or the wait was. `keyring-prompt.spec.ts` adds the
    // prompt log.
    await test.info().attach("launch-work-aria", {
      body: await page
        .getByLabel("Launch work workspace")
        .ariaSnapshot()
        .catch((e: unknown) => `aria snapshot failed: ${String(e)}`),
      contentType: "text/plain",
    });
    const reads = await page
      .evaluate(async () => {
        const bridge = (
          window as unknown as {
            orca?: {
              guidedLaunch?: Record<"snapshot" | "retained", () => Promise<{ ok: boolean; error?: unknown }>>;
            };
          }
        ).orca?.guidedLaunch;
        const shape = async (read?: () => Promise<{ ok: boolean; error?: unknown }>) => {
          if (!read) return "absent";
          const result = await read();
          return result.ok ? "ok" : result.error;
        };
        return { snapshot: await shape(bridge?.snapshot), retained: await shape(bridge?.retained) };
      })
      .catch((e: unknown) => ({ failed: String(e) }));
    await test
      .info()
      .attach("guided-launch-reads", { body: JSON.stringify(reads, null, 2), contentType: "application/json" });
    throw error;
  }
}

/** Pick the harmless sample, confirm the permission review, and press Launch. */
export async function launchSample(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Choose harmless launch smoke check" }).click();
  const guided = page.getByRole("region", { name: "Guided launch" });
  const preview = guided.getByRole("button", { name: "Preview launch" });
  await expect(preview).toBeEnabled();
  await preview.click();
  const review = page.getByRole("checkbox", { name: /I reviewed the configured permission policy/ });
  await review.check();
  const launch = guided.getByRole("button", { name: "Launch", exact: true });
  await expect(launch).toBeEnabled();
  await launch.click();
}

export interface RunSummary {
  id: string;
  workflowId: string;
  status: string;
}

/** The daemon's run list through the app's own bridge. */
export async function runs(page: Page): Promise<RunSummary[]> {
  return page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        orca: { runs: { list(params?: object): Promise<{ ok: boolean; result?: { runs: RunSummary[] } }> } };
      }
    ).orca;
    const answer = await bridge.runs.list({});
    if (!answer.ok || !answer.result) throw new Error("runs.list failed");
    return answer.result.runs.map(({ id, workflowId, status }) => ({ id, workflowId, status }));
  });
}
