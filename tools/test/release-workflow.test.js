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

it("drafts a final with the Ubuntu .deb only, leaving tag and publication to a maintainer", () => {
  const publish = named(workflow("release-publish.yml").jobs.publish.steps, "Tag and release").run;
  // Only a version without a prerelease suffix is a final.
  expect(publish).toContain('case "$version" in *-*) final=false ;; esac');
  const start = publish.indexOf('if [ "$final" = true ]; then');
  const stop = publish.indexOf("exit 0", start);
  expect(start).toBeGreaterThan(-1);
  expect(stop).toBeGreaterThan(start);
  const final = publish.slice(start, stop);
  // Exactly one asset: the Ubuntu amd64 .deb.
  expect(final).toContain('debs=(artifacts/*-"$version"-linux-amd64.deb)');
  expect(final).toContain("if [ ${#debs[@]} -ne 1 ]; then");
  // No second draft: earlier drafts are found by title too, since a draft's tag can read
  // back as `untagged-…`.
  const duplicate = final.indexOf('select(.draft and (.name == \\"v$version\\" or .tag_name == \\"v$version\\"))');
  const create = final.indexOf('gh api -X POST "repos/$GITHUB_REPOSITORY/releases" --input - --jq .id');
  expect(duplicate).toBeGreaterThan(-1);
  expect(create).toBeGreaterThan(duplicate);
  // A draft, never latest, and the id from creation is required and used from then on.
  expect(final).toContain("draft: true");
  expect(final).toContain('make_latest: "false"');
  expect(final).toContain('if ! [[ "$id" =~ ^[0-9]+$ ]]; then');
  expect(final).toContain("releases/$id/assets?name=");
  // Read back by id before reporting success: draft, target and the .deb digest.
  expect(final).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/$id"');
  expect(final).toContain('if [ "$check" != "true true true" ]; then');
  expect(final).not.toContain("--draft=false");
  expect(final).not.toContain("gh release create");
  // The publishing edit comes after the final has stopped; a prerelease still attaches
  // everything and is never latest.
  expect(publish.indexOf('gh release edit "v$version" --draft=false')).toBeGreaterThan(stop);
  expect(publish.slice(stop)).toContain("--prerelease");
});

it("runs nothing after a final's draft that could ship its unsigned build output", () => {
  const steps = workflow("release-publish.yml").jobs.publish.steps;
  const after = steps.slice(steps.findIndex((step) => step.name === "Tag and release") + 1);
  // Any later step (today the legacy feed) must be gated to prereleases.
  for (const step of after) expect(step.if ?? "", step.name).toContain("contains(needs.check.outputs.version, '-')");
});

it("never hands a write token to the ref under test (#863)", () => {
  const file = workflow("release-publish.yml");
  expect(file.permissions).toEqual({ contents: "read" });

  // A rehearsal may name any ref, so its writer trusts only a default-branch workflow.
  const guard = release[0];
  expect(guard.name).toBe("A dry run is dispatched from the default branch");
  expect(guard.if).toBe("${{ inputs.dry_run }}");
  expect(guard.env.DEFAULT).toBe("refs/heads/${{ github.event.repository.default_branch }}");

  // A real release runs the released commit's tooling with write, so that commit must be
  // on the default branch (any commit on it, so a fix-forward release still works).
  const sha = release.findIndex((s) => s.id === "sha");
  const reviewed = release[sha + 1];
  expect(reviewed.name).toBe("A real release builds a reviewed commit from the default branch");
  expect(reviewed.if).toBe("${{ !inputs.dry_run }}");
  expect(reviewed.run).toContain('git merge-base --is-ancestor "$SHA" "refs/remotes/origin/$DEFAULT_BRANCH"');
  expect(reviewed.run).toContain('if [ "$EVENT" = "workflow_dispatch" ] && [ "$REF" != "refs/heads/$DEFAULT_BRANCH" ]');
  expect(release.findIndex((s) => s.run === "pnpm install --frozen-lockfile")).toBeGreaterThan(sha + 1);

  // Only the two writers get contents write (sign may only dispatch), and every checkout drops its credentials.
  for (const [name, job] of Object.entries(file.jobs)) {
    if (job.uses) continue;
    const expected = ["publish", "rehearsal"].includes(name)
      ? { contents: "write" }
      : name === "sign"
        ? { actions: "write" }
        : null;
    expect(job.permissions ?? null, name).toEqual(expected);
    for (const step of job.steps.filter((s) => s.uses?.startsWith("actions/checkout@")))
      expect(step.with["persist-credentials"], name).toBe(false);
  }
  // The rehearsal writer runs this workflow's revision, not the rehearsed ref.
  expect(file.jobs.rehearsal.steps[0].with.ref).toBe("${{ github.sha }}");

  // The rehearsed ref is built on hosted runners, without the runner health endpoint.
  for (const call of ["desktop", "app-verification"]) {
    expect(file.jobs[call].with.hosted_only, call).toBe("${{ inputs.dry_run == true }}");
    expect(file.jobs[call].secrets, call).toEqual({
      CI_RUNNER_HEALTH_URL: "${{ !inputs.dry_run && secrets.CI_RUNNER_HEALTH_URL || '' }}",
    });
  }
  // Required for a release; a rehearsal of a ref that predates it reports not applicable.
  expect(file.jobs["app-verification"].with.upgrade_launch_required).toBe("${{ !inputs.dry_run }}");

  // Desktop picks runners and its matrix with the workflow revision's tooling, not the ref's.
  const desktop = workflow("desktop.yml");
  expect(desktop.on.workflow_call.inputs.hosted_only).toMatchObject({ type: "boolean", default: false });
  const targets = desktop.jobs.targets.steps;
  expect(targets[0].with).toEqual({ "sparse-checkout": "tools", "persist-credentials": false });
  expect(targets.find((s) => s.id === "pick").env.FORCE_HOSTED).toMatch(/^(true|\$\{\{ inputs\.hosted_only && .+)$/);

  // Its version reaches desktop as data.
  const stamp = workflow("desktop.yml").jobs.package.steps.find((s) => s.name === "The version to stamp");
  expect(stamp.env).toEqual({ VERSION: "${{ inputs.version }}" });
  expect(stamp.run).not.toContain("${{");
});

it("signs a final's commit right after staging its draft, and only a final", () => {
  const sign = workflow("release-publish.yml").jobs.sign;
  expect(sign.needs).toEqual(["check", "publish"]);
  expect(sign.if).toBe(
    "${{ !inputs.dry_run && !contains(needs.check.outputs.version, '-') && vars.ORCA_RELEASE_AUTO_SIGN == 'true' }}",
  );
  expect(sign.steps.some((s) => s.uses)).toBe(false);
  expect(sign.steps[0].run).toContain(
    'gh workflow run windows-signed.yml --repo "$GITHUB_REPOSITORY" --ref main -f source_sha="$SHA"',
  );
});

it("attaches only a re-verified signed x64 installer, through the re-validating script", () => {
  const text = readFileSync(".github/workflows/release-attach-signed.yml", "utf8");
  const wf = workflow("release-attach-signed.yml");
  expect(text).toContain('workflows: ["Windows signed (spike)"]');
  // Attachment and publication share one queue, so they never interleave; reconcile, which
  // only dispatches, queues on its own.
  expect(wf.jobs.attach.concurrency).toEqual({ group: "release-draft-writes", "cancel-in-progress": false });
  expect(workflow("release-publish-final.yml").concurrency).toEqual({
    group: "release-draft-writes",
    "cancel-in-progress": false,
  });
  expect(wf.jobs.reconcile.concurrency.group).toBe("release-attach-reconcile");
  expect(wf.permissions).toEqual({ contents: "read" });
  // The automatic paths are behind their own default-off switch; a dispatch by run id is not.
  expect(wf.jobs.attach.if).toContain("github.event_name == 'workflow_run' && vars.ORCA_RELEASE_AUTO_SIGN == 'true'");
  expect(wf.jobs.attach.if).toContain("github.event.workflow_run.head_branch == 'main'");
  expect(wf.jobs.reconcile.if).toContain("github.event_name == 'schedule' && vars.ORCA_RELEASE_AUTO_SIGN == 'true'");
  const steps = wf.jobs.attach.steps.map((s) => s.name ?? s.uses);
  const verify = steps.indexOf("Verify the x64 installer's signature, timestamp and publisher");
  const attachStep = steps.findIndex((n) => n?.startsWith("Attach it to the draft by id"));
  expect(verify).toBeGreaterThan(0);
  expect(attachStep).toBeGreaterThan(verify);
  expect(wf.jobs.attach.steps[attachStep].run).toContain("bash tools/deploy/release-attach.sh attach");
  expect(wf.jobs.reconcile.steps.at(-1).run).toBe("bash tools/deploy/release-attach.sh reconcile");
  expect(text).not.toMatch(/draft=false|make_latest|feed-r2/);
  const script = readFileSync("tools/deploy/release-attach.sh", "utf8");
  // The signing run itself is checked before any draft is selected, on every path.
  expect(script).toContain(
    'if [[ "$facts" != ".github/workflows/windows-signed.yml $REPO $REPO workflow_dispatch main completed success" ]]; then',
  );
  expect(script).toContain('marker="<!-- orca-signed-run: $run $want -->"');
  // Only `publish` (Release (publish final)) publishes; attach and reconcile never do.
  const attachPart = script.slice(script.indexOf("\n  attach)"), script.indexOf("\n  publish)"));
  expect(attachPart).not.toMatch(/draft=false|make_latest|"draft": *false/);
});

it("publishes a final only from main, through the checking script, and hands over to the feed", () => {
  const wf = workflow("release-publish-final.yml");
  expect(wf.on).toEqual({
    workflow_dispatch: {
      inputs: {
        release_id: { description: "The accepted draft's release id", required: true },
        version: { description: "Version (X.Y.Z)", required: true },
        source_sha: { description: "The commit native acceptance was run for (40 hex)", required: true },
        deb_sha256: { description: "SHA-256 of the Ubuntu .deb that passed native acceptance", required: true },
        exe_sha256: {
          description: "SHA-256 of the Windows x64 installer that passed native acceptance",
          required: true,
        },
      },
    },
  });
  expect(wf.permissions).toEqual({ contents: "read" });
  const job = wf.jobs.publish;
  expect(job.if).toBe("github.ref == 'refs/heads/main'");
  expect(job.permissions).toEqual({ contents: "write", actions: "write" });
  expect(job.steps[1].run).toBe('bash tools/deploy/release-attach.sh publish "$ID" "$VERSION" "$SHA" "$DEB" "$EXE"');
  expect(job.steps[1].run).not.toContain("${{");
  expect(job.steps[2].run).toBe('gh workflow run feed-auto.yml --repo "$GITHUB_REPOSITORY" --ref main');
});
