/**
 * #1206 on the installed package: a workspace set up in first-run enrolls a delegation remote
 * from the app, and then delegates to it.
 *
 * Before the fix the only route was `orca remote enroll`, which this workspace's first-run fence
 * refuses ("First-run mutation requires owned daemon admission"), and the app had no enrollment
 * screen. Now, after first-run setup, the remote and an agent that delegates to it are added the
 * way the app offers (Config > Raw, Validate and review, Save, Apply), and Config's Remote daemons
 * section enrolls it: the fingerprint typed in, **Enroll remote**, and the worker issues the
 * credential over ssh. A step then runs exactly once on the worker, and its report comes back.
 *
 * The worker is a real `orca serve` from this checkout's built CLI, reached through a throwaway
 * loopback sshd (`@orca/testing/two-daemons`), as a remote machine would be. The screenshot of
 * the enrolled remote is this spec's evidence. Needs `/usr/sbin/sshd` (the CI job installs it).
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
// `@orca/testing` is not a dependency of the app package and Playwright has no workspace
// alias, so the fixture is imported from its source. It still runs the built CLI (`pnpm run build`).
import {
  CLI_ENTRY,
  loopbackSshd,
  startTestDaemon,
  type LoopbackSshd,
  type TestDaemon,
} from "../../../testing/src/two-daemons.js";
import { repoRoot } from "../../../testing/src/child-bundle.js";
import { NativeSession } from "./session.js";
import { launchInstalled, noneLeft, quit } from "./app.js";
import { disposableWorkspace, firstRunSetup, openConfig } from "./flows.js";

const SCRIPTED = join(repoRoot, "packages", "testing", "dist", "scripted-agent", "main.js");

let session: NativeSession;
let sshd: LoopbackSshd | undefined;
let worker: TestDaemon | undefined;

test.beforeAll(async () => {
  session = await NativeSession.start();
  session.answerPrompts("cancel");
});

test.afterAll(async () => {
  await worker?.close();
  await sshd?.close();
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
  await page.getByRole("button", { name: "Apply saved configuration" }).click();
  await expect(page.getByText(/^Apply outcome:/).first()).toBeVisible({ timeout: 60_000 });
}

/** The worker: a daemon with a scripted agent and the workflow the app workspace delegates to. */
async function startWorker(root: string): Promise<TestDaemon> {
  const wf = await mkdtemp(join(root, "worker-wf-"));
  writeFileSync(
    join(wf, "build.yaml"),
    `
id: build
name: build
start: s
nodes:
  s: { type: start }
  work:
    type: agent
    agent: { id: scripted }
    prompt: "{{ vars.prompt }}"
    produces:
      - { kind: report, name: report, path: "out/report.md" }
  done: { type: end }
edges:
  - { from: s, to: work }
  - { from: work, to: done }
`,
  );
  const playbook = { kinds: { report: [{ data: { status: "done" }, body: "Worker report for: {prompt}" }] } };
  return startTestDaemon({
    name: "native-worker-1206",
    config: JSON.stringify({
      version: 1,
      workflows: [join(wf, "*.yaml")],
      templates: [],
      agents: [
        {
          id: "scripted",
          command: process.execPath,
          args: [SCRIPTED],
          env: { ORCA_PLAYBOOK_JSON: JSON.stringify(playbook) },
          permissions: { default: "allow" },
        },
      ],
    }),
  });
}

test("a first-run app workspace enrolls a remote from Config and delegates to it once", async () => {
  test.setTimeout(6 * 60_000);
  await noneLeft();
  // The fixture key runs what the client asked for, as a login shell would: the worker's ORCA
  // CLI, which issues the app workspace's credential during enrollment.
  const bin = await mkdtemp(join(session.root, "bin-"));
  writeFileSync(
    join(bin, "shell"),
    '#!/bin/sh\n[ -n "$SSH_ORIGINAL_COMMAND" ] || exit 0\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "orca"), `#!/bin/sh\nexec '${process.execPath}' '${CLI_ENTRY}' "$@"\n`, { mode: 0o755 });
  sshd = await loopbackSshd({ forcedCommand: join(bin, "shell") });
  // Never a skip: the suite's README and its CI job install sshd, so a missing one is a failure.
  if (!sshd) throw new Error("remote-enroll.spec.ts needs /usr/sbin/sshd (apt-get install openssh-server)");
  worker = await startWorker(session.root);

  const parentWorkflows = await mkdtemp(join(session.root, "parent-wf-"));
  writeFileSync(
    join(parentWorkflows, "delegate.yaml"),
    `
id: delegate
name: delegate
start: s
nodes:
  s: { type: start }
  hand:
    type: agent
    agent: { id: builder }
    prompt: "Build {{ vars.target }}"
    produces:
      - { kind: report, name: report, path: "delegated/report.md" }
  done: { type: end }
edges:
  - { from: s, to: hand }
  - { from: hand, to: done }
`,
  );

  const profile = await mkdtemp(join(session.root, "profile-remote-enroll-"));
  const chosen = await disposableWorkspace(join(session.root, "remote-enroll"), session.env);
  const launched = await launchInstalled(session, profile, "x11");
  const page = launched.page;
  try {
    await firstRunSetup(launched.app, page, chosen);
    const doc = JSON.parse(await readFile(join(chosen.workspace, "orca.config.yaml"), "utf8")) as {
      workflows?: string[];
      agents: unknown[];
      remotes?: unknown[];
    };
    doc.workflows = [...(doc.workflows ?? []), join(parentWorkflows, "*.yaml")];
    doc.remotes = [
      {
        id: "build-box",
        name: "Build box",
        destination: `${userInfo().username}@127.0.0.1`,
        sshPort: sshd.port,
        identityFile: sshd.identity,
        remotePort: worker.port,
        serverCommand: join(bin, "orca"),
        serverConfig: join(worker.dir, "orca.config.yaml"),
      },
    ];
    doc.agents = [...doc.agents, { id: "builder", type: "orca-daemon", profile: "build-box", workflow: "build" }];
    await saveRawConfig(page, JSON.stringify(doc, null, 2));

    // Config > Remote daemons: the remote, not enrolled.
    await openConfig(page);
    const section = page.getByRole("region", { name: "Remote daemons" });
    await section.getByRole("button", { name: "Refresh" }).click();
    const row = section.locator('[data-remote="build-box"]');
    await expect(row).toHaveAttribute("data-enrollment", "none", { timeout: 30_000 });
    await row.getByRole("button", { name: "Enroll build-box" }).click();
    const form = page.getByRole("form", { name: "Enroll remote build-box" });
    await form.getByLabel(/Host key fingerprint/).fill(sshd.hostKeyFingerprint);
    await form.getByRole("button", { name: "Enroll remote" }).click();
    await expect(row).toHaveAttribute("data-enrollment", "enrolled", { timeout: 60_000 });
    await expect(row.getByText(sshd.hostKeyFingerprint)).toBeVisible();
    await expect(row.getByText(/issued by the remote/)).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await test.info().attach("remote-enrolled", { body: await page.screenshot(), contentType: "image/png" });

    // The app's daemon wrote the record in the app's own workspace; nothing was hand-edited.
    expect(existsSync(join(chosen.workspace, "auth", "remotes", "build-box.json"))).toBe(true);

    // Delegate once, through the app's own bridge, and see the worker run it exactly once.
    const started = await page.evaluate(async () => {
      const bridge = (
        window as unknown as {
          orca: { runs: { start(p: object): Promise<{ ok: boolean; result?: { runId?: string; status?: string } }> } };
        }
      ).orca;
      return bridge.runs.start({ workflowId: "delegate", vars: { target: "from the app workspace" } });
    });
    expect(started.ok).toBe(true);
    await expect
      .poll(
        async () => {
          const answer = await worker!.call("runs.list", {});
          if (!answer.ok) return [];
          return (answer.result as { runs: { workflowId: string; status: string }[] }).runs
            .filter((r) => r.workflowId === "build")
            .map((r) => r.status);
        },
        { timeout: 90_000 },
      )
      .toEqual(["succeeded"]);
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const bridge = (
              window as unknown as {
                orca: {
                  runs: {
                    list(
                      p: object,
                    ): Promise<{ ok: boolean; result?: { runs: { workflowId: string; status: string }[] } }>;
                  };
                };
              }
            ).orca;
            const answer = await bridge.runs.list({});
            return (answer.result?.runs ?? []).filter((r) => r.workflowId === "delegate").map((r) => r.status);
          }),
        { timeout: 60_000 },
      )
      .toEqual(["succeeded"]);
    await test.info().attach("delegated-run", { body: await page.screenshot(), contentType: "image/png" });
  } catch (error) {
    await test
      .info()
      .attach("remote-enroll-failure", { body: await page.screenshot(), contentType: "image/png" })
      .catch(() => undefined);
    await launched.app.close().catch(() => undefined);
    throw error;
  }
  await quit(session, launched, "x11");
});
