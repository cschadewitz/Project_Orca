/** Offline checks for the Windows/Linux private-candidate tester pages: fill-ins, format, links,
 * every quoted UI string against source, and the documented throwaway project against the
 * production first-run setup. No ORCA process, daemon, network, provider or credential. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_SAMPLE,
  FIRST_RUN_SAMPLE_FILES,
  FIRST_RUN_SAMPLE_TASK,
} from "../../packages/app/src/first-run-sample.js";
import { FirstRunSetup } from "../../packages/app/src/main/first-run/setup.js";

const root = new URL("../../", import.meta.url);
const dir = new URL("docs/preparation/private-candidate-windows-linux/", root);
const pages = readdirSync(dir)
  .filter((name) => name.endsWith(".md"))
  .sort();
const text = (name) => readFileSync(new URL(name, dir), "utf8");
const source = (path) => readFileSync(new URL(path, root), "utf8");
/** JSX wraps long sentences across lines; compare words, not layout. */
const flat = (value) => value.replace(/&apos;/g, "'").replace(/\s+/g, " ");
/** Markdown outside fenced code blocks, so fenced `#` comments are not headings. */
const prose = (value) => value.replace(/^```[\s\S]*?^```$/gm, "");
/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .replace(/ /g, "-");
function block(page, marker) {
  const match = text(page).match(new RegExp(`<!-- validate: ${marker} -->\\n\`\`\`\\w+\\n([\\s\\S]*?)\\n\`\`\`\\n`));
  expect(match, `${page} has a ${marker} block`).not.toBeNull();
  return match[1];
}

it("covers the expected pages, each with one title and clean UTF-8/LF formatting", () => {
  expect(pages).toEqual([
    "README.md",
    "coordinator-checklist.md",
    "feedback-template.md",
    "first-success-sample.md",
    "linux.md",
    "tester-guide.md",
    "when-something-goes-wrong.md",
    "windows.md",
  ]);
  for (const page of pages) {
    const raw = readFileSync(new URL(page, dir));
    const value = raw.toString("utf8");
    expect(Buffer.from(value, "utf8").equals(raw), page).toBe(true);
    expect(value.endsWith("\n") && !value.endsWith("\n\n"), page).toBe(true);
    expect(value.includes("\r") || value.includes("\t"), page).toBe(false);
    expect(
      value.split("\n").filter((line) => line !== line.trimEnd()),
      page,
    ).toEqual([]);
    expect((value.match(/^```/gm) ?? []).length % 2, `${page} fences`).toBe(0);
    expect(prose(value).match(/^# /gm), page).toHaveLength(1);
  }
});

it("resolves every relative link and heading fragment", () => {
  let links = 0;
  for (const page of pages) {
    for (const [, target] of prose(text(page)).matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      if (target.startsWith("https://")) continue;
      const [path, fragment] = target.split("#");
      const destination = path ? new URL(path, new URL(page, dir)) : new URL(page, dir);
      expect(statSync(destination, { throwIfNoEntry: false }), `${page} -> ${target}`).toBeDefined();
      if (fragment) {
        const headings = [...prose(readFileSync(destination, "utf8")).matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
          slug(m[1]),
        );
        expect(headings, `${page} -> ${target}`).toContain(fragment);
      }
      links++;
    }
  }
  expect(links).toBeGreaterThan(30);
});

it("uses only fill-ins the coordinator checklist declares, and uses every declared one", () => {
  const declared = [...text("coordinator-checklist.md").matchAll(/^\| `(\{\{[A-Z_]+\}\})` \|/gm)].map((m) => m[1]);
  expect(new Set(declared).size).toBe(declared.length);
  expect(declared).toEqual(
    expect.arrayContaining([
      "{{CANDIDATE_VERSION}}",
      "{{CANDIDATE_COMMIT}}",
      "{{ARTIFACT_TABLE}}",
      "{{SUPPORTED_PLATFORMS}}",
      "{{SUPPORT_ROUTE}}",
      "{{RETENTION_POLICY}}",
    ]),
  );
  const testerPages = pages.filter((page) => page !== "README.md" && page !== "coordinator-checklist.md");
  const used = new Set();
  for (const page of pages) {
    for (const [token] of text(page).matchAll(/\{\{[^}]*\}\}/g)) {
      expect(declared, `${page} uses ${token}`).toContain(token);
      if (testerPages.includes(page)) used.add(token);
    }
  }
  expect([...used].sort()).toEqual([...declared].sort());
});

/** Every on-screen string a tester is told to look for, and the source that renders it. */
const QUOTED = [
  [
    "packages/app/renderer/src/first-run/first-run-section.tsx",
    [
      "Dedicated project setup",
      "Choose project and empty workspace",
      "Create reviewed sample files",
      "Create reviewed private workspace and sample files",
      "Connect selected local workspace",
      "Read setup again",
      "Review same-boot recovery",
      "Mark previous session ended",
      "Reconcile same-boot ownership",
      "Writer ownership is unknown",
      "Sample files prepared. Connect the selected local workspace when ready.",
      "Selected workspace connected. Open Launch work and choose the harmless sample; review permissions before launching.",
      "Create the displayed new private folder and sample files. Existing parent and project permissions stay unchanged.",
      "The last session ended without closing cleanly, before this computer restarted.",
      "Setup was refused. Check directory ownership, writable access and Git",
    ],
  ],
  [
    "packages/app/src/main/index.ts",
    [
      "Choose a prepared Git project",
      "Choose a separate empty app workspace",
      "Choose a parent for a new private app workspace",
      "Review selection",
    ],
  ],
  ["packages/app/src/main/first-run/directories.ts", ["Choose owned writable directories with verifiable identity"]],
  ["packages/app/renderer/src/config/configuration-studio-surface.tsx", ["Launch work"]],
  ["packages/app/renderer/src/guided-launch/launch-route.tsx", ["Choose harmless launch smoke check"]],
  [
    "packages/app/renderer/src/guided-launch/controller.ts",
    ["Review the exact target, workflow and inputs before launching."],
  ],
  [
    "packages/app/renderer/src/guided-launch/guided-launch.tsx",
    [
      "Preview launch",
      "Permission review",
      "Recover original launch",
      "Restore protected launch",
      "I reviewed the configured permission policy. This work may execute commands in the prepared checkout; permission requests still require their own confirmation.",
    ],
  ],
  [
    "packages/app/renderer/src/diagnostics/diagnostics-section.tsx",
    ["Local diagnostics", "production capture is unavailable"],
  ],
  ["packages/app/renderer/src/chrome/status-bar.tsx", ["orca-daemon "]],
  ["packages/app/src/main/app-menu.ts", ["Open a store…", "Connect to a daemon…"]],
  [
    "packages/app/src/first-run-sample.ts",
    ["Harmless local sample completed. No agent was started and no project files were changed.", FIRST_RUN_SAMPLE_TASK],
  ],
];

it("quotes only UI strings that the current source renders", () => {
  const docs = flat(pages.map(text).join("\n"));
  for (const [path, strings] of QUOTED) {
    const code = flat(source(path)).toLowerCase();
    for (const value of strings) {
      expect(code, `${value} in ${path}`).toContain(flat(value).toLowerCase());
      expect(docs.toLowerCase(), `${value} quoted in the pages`).toContain(flat(value).toLowerCase());
    }
  }
  const sample = text("first-success-sample.md");
  for (const value of [
    FIRST_RUN_SAMPLE.id,
    FIRST_RUN_SAMPLE.revision,
    `${FIRST_RUN_SAMPLE.id} / ${FIRST_RUN_SAMPLE.version} / ${FIRST_RUN_SAMPLE.revision}`,
  ])
    expect(sample).toContain(value);
  const semantics = JSON.parse(source("packages/design/semantics.json"));
  const words = [
    semantics.runStatus.succeeded,
    semantics.connectionState.live,
    semantics.connectionState.disconnected,
    semantics.connectionState.mismatch,
  ];
  for (const { glyph, word } of words) expect(docs).toContain(`${glyph} ${word}`);
});

it("states timing, installer and diagnostics facts that still match the source", () => {
  // If one of these changes, the tester pages and the coordinator's gate G8 must be revised.
  expect(source("packages/app/src/diagnostics-contract.ts")).toContain(
    "export const DIAGNOSTICS_PRODUCTION_ENABLED = false;",
  );
  expect(source("packages/app/src/main/index.ts")).toContain("const SHUTDOWN_DEADLINE_MS = 10_000;");
  expect(source("packages/app/src/main/index.ts")).toContain('app.on("window-all-closed"');
  expect(source("packages/app/src/main/daemon-process.ts")).toContain("startTimeoutMs = 30_000");
  expect(source("packages/app/src/main/daemon-process.ts")).toContain("stopTimeoutMs = 5_000");
  const builder = source("packages/app/electron-builder.yml");
  for (const line of [
    "perMachine: false",
    "oneClick: false",
    'artifactName: "${productName}-${version}-${os}-${arch}.${ext}"',
  ])
    expect(builder).toContain(line);
  expect(Buffer.byteLength(Object.values(FIRST_RUN_SAMPLE_FILES).join(""))).toBeLessThan(5_500);
});

it("keeps the Windows project commands equivalent to the executed Linux ones", () => {
  const linux = block("first-success-sample.md", "linux-project").split("\n");
  const windows = block("first-success-sample.md", "windows-project").split("\n");
  const git = (lines) => lines.filter((line) => line.startsWith("git "));
  expect(git(windows)).toEqual(git(linux));
  expect(git(linux)).toHaveLength(5);
  const readme = linux.find((line) => line.startsWith("printf "))?.match(/^printf '(.*)\\n' > README\.txt$/)?.[1];
  expect(windows).toContain(`Set-Content -Path README.txt -Value "${readme}"`);
  expect(windows.filter((line) => line.startsWith("New-Item "))).toEqual([
    'New-Item -ItemType Directory "$env:USERPROFILE\\orca-trial"',
    'New-Item -ItemType Directory "$env:USERPROFILE\\orca-trial\\project"',
  ]);
});

const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32" || typeof process.getuid !== "function")(
  "the documented Linux throwaway project",
  () => {
    it("runs without user Git config and passes the production first-run review and prepare", async () => {
      const base = await realpath(await mkdtemp(join(tmpdir(), "orca-onboarding-")));
      temporary.push(base);
      const home = join(base, "home");
      execFileSync("mkdir", [home]);
      const globalConfig = join(base, "absent-global-gitconfig");
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_TERMINAL_PROMPT: "0",
      };
      const script = block("first-success-sample.md", "linux-project");
      const output = execFileSync("bash", ["--norc", "--noprofile", "-euo", "pipefail", "-c", script], {
        cwd: base,
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
      const project = join(home, "orca-trial", "project");
      const workspace = join(home, "orca-trial", "workspace");
      const git = (...args) => execFileSync("git", ["-C", project, ...args], { env, encoding: "utf8" }).trim();
      // The documented expectation: an empty status, then exactly one "Trial project" commit.
      expect(output.trimEnd().split("\n").at(-1)).toMatch(/^[0-9a-f]{7,} Trial project$/);
      expect(git("status", "--porcelain")).toBe("");
      expect(git("log", "--format=%an <%ae>|%s")).toBe("ORCA trial <trial@example.invalid>|Trial project");
      expect(git("remote")).toBe("");
      // Nothing was written to the person's Git configuration.
      await expect(access(globalConfig)).rejects.toThrow();
      await expect(access(join(home, ".gitconfig"))).rejects.toThrow();
      expect((await readdir(workspace)).length).toBe(0);

      const head = git("rev-parse", "HEAD");
      const choose = vi.fn().mockResolvedValueOnce(project).mockResolvedValueOnce(workspace);
      const prepareConnection = vi.fn();
      const setup = new FirstRunSetup({
        home,
        receiptPath: join(base, "profile", "first-run", "selection.json"),
        choose,
        prepareConnection,
        current: () => false,
      });
      const current = () => {};
      const review = await setup.choose(current);
      expect(choose.mock.calls).toEqual([["project"], ["workspace"]]);
      expect(review).toEqual({
        state: "review",
        review: {
          id: expect.any(String),
          project,
          workspace,
          branch: "trial",
          baseCommit: head,
          sample: FIRST_RUN_SAMPLE,
        },
      });
      // F4 says nothing is written by selection or review.
      expect(await readdir(workspace)).toEqual([]);
      const prepared = await setup.prepare(review.review.id, current);
      expect(prepared).toEqual({ state: "prepared", project, workspace, sample: FIRST_RUN_SAMPLE });
      expect(prepareConnection).not.toHaveBeenCalled();
      expect((await readdir(workspace)).sort()).toEqual(["first-run", "orca.config.yaml"]);
      const assets = (await readdir(join(workspace, "first-run"))).sort();
      expect(assets).toEqual(["instruction.md", "result.json", "task.json", "workflow.yaml"]);
      let bytes = (await stat(join(workspace, "orca.config.yaml"))).size;
      for (const name of assets) bytes += (await stat(join(workspace, "first-run", name))).size;
      // "about 5.5 KB in total" in the sample's resource table.
      expect(bytes).toBeGreaterThan(5_000);
      expect(bytes).toBeLessThan(6_000);
      // The project is untouched: same commit, clean status, no new files.
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(git("status", "--porcelain", "--ignored")).toBe("");
      expect((await readdir(project)).sort()).toEqual([".git", "README.txt"]);
    });
  },
);
