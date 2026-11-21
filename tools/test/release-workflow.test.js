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
  // The rehearsal gets its own version, decided before the tag refusal could apply.
  expect(version.run).toMatch(
    /if \[ "\$DRY_RUN" = "true" \]; then\s+# [^\n]*\n\s+version="\$\{version%%-\*\}-dryrun\.\$GITHUB_RUN_NUMBER"/,
  );

  const publish = file.jobs.publish.steps;
  expect(named(publish, "Tag and release").if).toBe("${{ !inputs.dry_run }}");
  for (const step of publish.filter((s) => /feed/i.test(s.name ?? ""))) expect(step.if).toContain("!inputs.dry_run");

  const rehearsal = named(publish, "Upload the rehearsal to a draft prerelease");
  expect(rehearsal.if).toBe("${{ inputs.dry_run }}");
  expect(rehearsal.run).toContain("--draft --prerelease --latest=false");
  expect(rehearsal.run).toContain('*-dryrun.*) ;; *) echo "::error::');
  expect(rehearsal.run).not.toContain("--draft=false");
  expect(rehearsal.run).not.toMatch(/git (tag|push)/);
});
