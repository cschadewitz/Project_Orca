/** feed-update-e2e.yml (#863, item 5): build like desktop.yml, run the real update spec. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const STAGE = "Stage native addons for all requested Windows architectures";

const e2e = workflow("feed-update-e2e.yml");
const steps = e2e.jobs.update.steps;
const named = (name) => steps.find((step) => step.name === name);

it("stages native addons exactly as desktop.yml does", () => {
  const desktop = workflow("desktop.yml").jobs.package.steps.find((step) => step.name === STAGE);
  expect(named(STAGE).run).toBe(desktop.run);
});

it("is GitHub-hosted, read-only and secret-free", () => {
  expect(e2e.permissions).toEqual({ contents: "read" });
  expect(e2e.jobs.update["runs-on"]).toBe("${{ matrix.runner }}");
  expect(readFileSync(new URL("../../.github/workflows/feed-update-e2e.yml", import.meta.url), "utf8")).not.toContain(
    "secrets.",
  );
});

it("packages two versions, installs the older and updates through the local feed", () => {
  expect(e2e.env).toEqual({ FROM_VERSION: "99.0.0", TO_VERSION: "99.0.1" });
  const order = ["Package N and N+1", "Install N", "Trust a throwaway localhost certificate", "Lay out the local feed"];
  const positions = order.map((name) => steps.indexOf(named(name)));
  expect(positions.every((p) => p > 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  const run = named("Update N to N+1 through the local feed");
  expect(run.run).toContain("node tools/deploy/feed-local.js serve");
  expect(run.run.trimEnd().split("\n").at(-1).trim()).toBe("pnpm run app:windows-update");
  expect(run.env.ORCA_UPDATE_URL).toMatch(/^https:\/\/localhost:\d+\/$/);
});

it("runs on pull requests that touch the feed Worker or the update driver", () => {
  for (const path of ["tools/deploy/feed-worker/**", "packages/app/src/main/update-driver.ts"])
    expect(e2e.on.pull_request.paths).toContain(path);
});

it("packages into dist/release, which electron-builder.yml keeps out of the app", () => {
  // Elsewhere under dist/, N+1 would package N's installer into its own app.asar.
  expect(readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8")).toContain(
    '- "!dist/release"',
  );
  expect(named("Package N and N+1").run).toContain('-c.directories.output="dist/release/update-e2e/$version"');
});

it("updates every architecture the feed serves, arm64 on a native arm64 runner (#889)", async () => {
  const { SERVED_ARCHES } = await import("../deploy/feed-worker/worker.js");
  const { include } = e2e.jobs.update.strategy.matrix;
  expect(include).toEqual([
    { arch: "x64", runner: "windows-latest" },
    { arch: "arm64", runner: "windows-11-arm" },
  ]);
  expect(include.map((entry) => entry.arch)).toEqual(SERVED_ARCHES);
  expect(e2e.jobs.update.strategy["fail-fast"]).toBe(false);
  expect(e2e.jobs.update.env).toEqual({ ARCH: "${{ matrix.arch }}" });
  expect(named("Package N and N+1").run).toContain('--"$ARCH"');
  expect(named("Package N and N+1").run).toContain('-c.publish.channel="latest-$ARCH"');
  expect(named("Lay out the local feed").run).toContain('"$dir/latest-$ARCH.yml"');
  expect(steps.map((step) => step.run ?? "").join("\n")).not.toMatch(/win-x64\.exe|latest-x64/);
});
