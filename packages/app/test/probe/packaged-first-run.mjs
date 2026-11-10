/** PROBE ONLY (not for merge): drive first-run setup in the packaged Windows app and print why Connect fails. */
/* global window */
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const [exe, base] = process.argv.slice(2).map((p) => resolve(p));
const root = await mkdtemp(join(base, "orca-probe-"));
const project = join(root, "project");
const parent = join(root, "parent");
const profile = join(root, "profile");
for (const dir of [project, parent, profile]) await mkdir(dir);
const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
git("init", "-b", "main");
await writeFile(join(project, "README.md"), "probe\n");
git("add", "README.md");
git("-c", "user.name=p", "-c", "user.email=p@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "probe");
console.log(`[probe] exe=${exe}\n[probe] project=${project}\n[probe] parent=${parent}`);

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|ELECTRON_RUN_AS_NODE$)/.test(k)));
const app = await electron.launch({
  executablePath: exe,
  args: [`--user-data-dir=${profile}`],
  cwd: root,
  env,
  timeout: 60_000,
});
app.process().stdout?.on("data", (d) => process.stdout.write(`[app stdout] ${d}`));
app.process().stderr?.on("data", (d) => process.stdout.write(`[app stderr] ${d}`));
const page = await app.firstWindow();
page.setDefaultTimeout(30_000);
const status = async () => JSON.stringify(await page.evaluate(() => window.orca.firstRun.status()));
const section = page.getByRole("region", { name: "First-run project setup" });
const step = async (name) => {
  console.log(`[probe] click: ${name}`);
  await section.getByRole("button", { name }).click();
  await page.waitForTimeout(4000);
  console.log(`[probe] status after ${name}: ${await status()}`);
  console.log(`[probe] section text: ${(await section.innerText()).replace(/\s+/g, " ")}`);
};
try {
  await page.waitForFunction(() => window.orca?.firstRun !== undefined);
  await page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name: "Config", exact: true }).click();
  console.log(`[probe] initial status: ${await status()}`);
  await app.evaluate(
    ({ dialog }, paths) => {
      let index = 0;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths[index++]] });
    },
    [project, parent],
  );
  await step("Choose project and empty workspace");
  await step("Create reviewed private workspace and sample files");
  await step("Connect selected local workspace");
  console.log(`[probe] connection: ${JSON.stringify(await page.evaluate(() => window.orca.connection.read()))}`);
  for (const entry of await readdir(parent, { recursive: true })) console.log(`[probe] parent has: ${entry}`);
} catch (error) {
  console.log("[probe] harness error:", error);
} finally {
  await page.screenshot({ path: join(process.cwd(), `probe-${Date.now()}.png`) }).catch(() => {});
  await app.close().catch(() => {});
}
