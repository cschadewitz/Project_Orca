/** release-upgrade-check.yml (#566): the native Windows upgrade check that gates a final. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const text = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const workflow = (name) => parse(text(name));
const STAGE = "Stage native addons for all requested Windows architectures";

const check = workflow("release-upgrade-check.yml");
const step = (job, name) => check.jobs[job].steps.find((s) => s.name === name);

it("stages native addons for the rehearsal exactly as desktop.yml does", () => {
  const desktop = workflow("desktop.yml").jobs.package.steps.find((s) => s.name === STAGE);
  expect(step("rehearse", STAGE).run).toBe(desktop.run);
});

it("is read-only except for reading drafts and writing the record, and holds no secret", () => {
  expect(check.permissions).toEqual({ contents: "read" });
  expect(check.jobs.target.permissions).toEqual({ contents: "write" });
  expect(check.jobs.record.permissions).toEqual({ contents: "write" });
  expect(check.jobs.check.permissions).toBeUndefined();
  expect(check.jobs.rehearse.permissions).toBeUndefined();
  expect(text("release-upgrade-check.yml")).not.toContain("secrets.");
  for (const job of ["check", "rehearse"]) expect(check.jobs[job]["runs-on"]).toBe("windows-latest");
});

it("runs only this revision's tooling where it can write", () => {
  for (const job of ["target", "record"]) {
    const checkout = check.jobs[job].steps[0];
    expect(checkout.with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    const scripts = check.jobs[job].steps.filter((s) => s.run).map((s) => s.run);
    expect(scripts.join("\n")).not.toMatch(/pnpm|node /);
  }
  expect(check.jobs.target.if).toContain("github.ref == 'refs/heads/main'");
  expect(check.jobs.record.needs).toEqual(["target", "check"]);
  expect(check.jobs.record.concurrency).toEqual({ group: "release-draft-writes", "cancel-in-progress": false });
});

it("checks the installers' signatures before installing either, then runs the upgrade spec", () => {
  const names = check.jobs.check.steps.map((s) => s.name);
  const verify = names.indexOf("Both installers are the expected bytes, validly signed by the publisher");
  const run = names.indexOf("Install the previous release, then the candidate over it");
  expect(verify).toBeGreaterThan(0);
  expect(run).toBeGreaterThan(verify);
  expect(check.jobs.check.steps[run].run).toBe("pnpm run app:windows-store-upgrade");
  expect(step("rehearse", "Install the previous release, then the candidate over it").run).toBe(
    "pnpm run app:windows-store-upgrade",
  );
});

it("is dispatched by the attach for the draft it attached to", () => {
  const attach = workflow("release-attach-signed.yml");
  const job = attach.jobs["upgrade-check"];
  expect(job.needs).toBe("attach");
  expect(job.permissions).toEqual({ actions: "write" });
  expect(job.steps.every((s) => !s.uses)).toBe(true);
  expect(job.steps[0].run).toContain(
    'gh workflow run release-upgrade-check.yml --repo "$GITHUB_REPOSITORY" --ref main -f release_id="$ID"',
  );
  expect(attach.jobs.attach.outputs).toEqual({ id: "${{ steps.attached.outputs.id }}" });
});
