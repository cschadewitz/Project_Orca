/** Hold release verification to ci.yml's full path: build before tests, and the same strict checks. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

// Borrowed from the CLI, which already installs it, rather than added to the root manifest.
const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));

const release = workflow("release-publish.yml").jobs.check.steps;
const ci = workflow("ci.yml").jobs.check.steps;
const RETRY = "Retry admission acceptance (CLI and ACP)";
const position = (steps, run) => steps.findIndex((step) => step.run === run);
const named = (steps, name) => steps.find((step) => step.name === name);

it("builds before it tests, since production MCP acceptance launches the emitted entry points", () => {
  const build = position(release, "pnpm run build");
  expect(build).toBeGreaterThan(-1);
  for (const later of [
    position(release, "pnpm test"),
    release.findIndex((step) => step.name === RETRY),
    position(release, "node packages/cli/dist/main.js demo"),
  ])
    expect(later).toBeGreaterThan(build);
});

it("requires production MCP acceptance rather than letting it skip", () => {
  expect(release[position(release, "pnpm test")].env).toEqual({ ORCA_MCP_REQUIRE_PRODUCTION: "1" });
});

it("runs every static check ci.yml's full path runs", () => {
  for (const run of ["pnpm run typecheck", "pnpm run design:check", "pnpm run format:check", "pnpm run lint"])
    expect(position(release, run), run).toBeGreaterThan(-1);
  expect(release[position(release, "pnpm run lint")].env).toEqual(ci[position(ci, "pnpm run lint")].env);
});

it("bounds workers and runs the no-skip retry acceptance exactly as ci.yml does", () => {
  for (const name of ["Bound test workers", RETRY]) {
    const ours = named(release, name);
    const theirs = named(ci, name);
    expect(ours, name).toBeDefined();
    expect(theirs, name).toBeDefined();
    // ci.yml's steps carry its docs-only `if`; the release has no docs-only path to skip.
    expect({ ...ours, if: undefined }).toEqual({ ...theirs, if: undefined });
  }
  expect(release.indexOf(named(release, "Bound test workers"))).toBeLessThan(position(release, "pnpm test"));
});

it("rehearses a release on dry_run without tagging, publishing or feeding anything (#863)", () => {
  const file = workflow("release-publish.yml");
  const input = file.on.workflow_dispatch.inputs.dry_run;
  expect(input).toMatchObject({ type: "boolean", default: false, required: false });

  const version = named(release, "The version being released");
  expect(version.env).toEqual({ DRY_RUN: "${{ inputs.dry_run }}" });
  // The ref's version is validated as data before it names anything.
  expect(version.run.indexOf("=~ ^[0-9]+")).toBeLessThan(version.run.indexOf('"$DRY_RUN"'));
  // The rehearsal gets its own version, decided before the tag refusal could apply.
  expect(version.run).toMatch(
    /if \[ "\$DRY_RUN" = "true" \]; then\s+# [^\n]*\n\s+version="\$\{version%%-\*\}-dryrun\.\$GITHUB_RUN_NUMBER"/,
  );

  // A real release and a rehearsal are separate jobs; neither runs on the other's dispatch.
  expect(file.jobs.publish.if).toBe("${{ !inputs.dry_run }}");
  const rehearsal = file.jobs.rehearsal;
  expect(rehearsal.if).toBe("${{ inputs.dry_run }}");
  expect(rehearsal.needs).toEqual(["check", "desktop", "app-verification"]);
  const upload = named(rehearsal.steps, "Upload the rehearsal to a draft prerelease");
  expect(upload.run).toContain("--draft --prerelease --latest=false");
  expect(upload.run).toContain("-dryrun\\.[0-9]+$");
  expect(upload.run).not.toContain("--draft=false");
  expect(upload.run).not.toMatch(/git (tag|push)/);
  expect(upload.run).not.toContain("${{");
});

it("never hands a write token to the ref under test (#863)", () => {
  const file = workflow("release-publish.yml");
  expect(file.permissions).toEqual({ contents: "read" });

  // A rehearsal may name any ref, so its writer trusts only a default-branch workflow.
  const guard = release[0];
  expect(guard.name).toBe("A dry run is dispatched from the default branch");
  expect(guard.if).toBe("${{ inputs.dry_run }}");
  expect(guard.env.DEFAULT).toBe("refs/heads/${{ github.event.repository.default_branch }}");

  // Only the two writers get write, and every checkout drops its credentials.
  for (const [name, job] of Object.entries(file.jobs)) {
    if (job.uses) continue;
    expect(job.permissions ?? null, name).toEqual(
      ["publish", "rehearsal"].includes(name) ? { contents: "write" } : null,
    );
    for (const step of job.steps.filter((s) => s.uses?.startsWith("actions/checkout@")))
      expect(step.with["persist-credentials"], name).toBe(false);
  }
  // The rehearsal writer runs this workflow's revision, not the rehearsed ref.
  expect(file.jobs.rehearsal.steps[0].with.ref).toBe("${{ github.sha }}");

  // The rehearsed ref is built on hosted runners and its version reaches desktop as data.
  expect(file.jobs["app-verification"].with.hosted_only).toBe("${{ inputs.dry_run == true }}");
  const stamp = workflow("desktop.yml").jobs.package.steps.find((s) => s.name === "The version to stamp");
  expect(stamp.env).toEqual({ VERSION: "${{ inputs.version }}" });
  expect(stamp.run).not.toContain("${{");
});
