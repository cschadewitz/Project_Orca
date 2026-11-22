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
  // on the default branch or its version's release line (any commit on them, so a
  // fix-forward release still works). release-lines.test.js runs the check itself.
  const sha = release.findIndex((s) => s.id === "sha");
  const reviewed = release[sha + 1];
  expect(reviewed.name).toBe("A real release builds a reviewed commit from the default branch or its line");
  expect(reviewed.if).toBe("${{ !inputs.dry_run }}");
  expect(reviewed.run).toContain('git merge-base --is-ancestor "$SHA" "refs/remotes/origin/$DEFAULT_BRANCH"');
  expect(reviewed.run).toContain('if [ "$EVENT" = "workflow_dispatch" ] && [ "$REF" != "refs/heads/$DEFAULT_BRANCH" ]');
  expect(release.findIndex((s) => s.run === "pnpm install --frozen-lockfile")).toBeGreaterThan(sha + 1);

  // Only the two writers get contents write (sign and server-bundle may only dispatch), and
  // every checkout drops its credentials.
  for (const [name, job] of Object.entries(file.jobs)) {
    if (job.uses) continue;
    const expected = ["publish", "rehearsal"].includes(name)
      ? { contents: "write" }
      : ["sign", "server-bundle"].includes(name)
        ? { actions: "write" }
        : name === "sync-main"
          ? { contents: "write", "pull-requests": "write" }
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

it("attaches only re-verified signed x64 and arm64 installers, through the re-validating script", () => {
  const text = readFileSync(".github/workflows/release-attach-signed.yml", "utf8");
  const wf = workflow("release-attach-signed.yml");
  expect(text).toContain('workflows: ["Windows signed (spike)"]');
  // Attachment and publication share one queue, so they never interleave; reconcile, which
  // only dispatches, queues on its own.
  expect(wf.jobs.attach.concurrency).toEqual({
    group: "release-draft-writes",
    "cancel-in-progress": false,
    queue: "max",
  });
  expect(workflow("release-publish-final.yml").concurrency).toEqual({
    group: "release-draft-writes",
    "cancel-in-progress": false,
    queue: "max",
  });
  expect(wf.jobs.reconcile.concurrency.group).toBe("release-attach-reconcile");
  expect(wf.permissions).toEqual({ contents: "read" });
  // The automatic paths are behind their own default-off switch; a dispatch by run id is not.
  expect(wf.jobs.attach.if).toContain("github.event_name == 'workflow_run' && vars.ORCA_RELEASE_AUTO_SIGN == 'true'");
  expect(wf.jobs.attach.if).toContain("github.event.workflow_run.head_branch == 'main'");
  expect(wf.jobs.reconcile.if).toContain("github.event_name == 'schedule' && vars.ORCA_RELEASE_AUTO_SIGN == 'true'");
  const steps = wf.jobs.attach.steps.map((s) => s.name ?? s.uses);
  const verify = steps.indexOf("Verify both installers' signatures, timestamps and publisher");
  const attachStep = steps.findIndex((n) => n?.startsWith("Attach it to the draft by id"));
  expect(verify).toBeGreaterThan(0);
  expect(attachStep).toBeGreaterThan(verify);
  expect(wf.jobs.attach.steps[verify].run).toContain("foreach ($arch in 'x64', 'arm64')");
  expect(wf.jobs.attach.steps[attachStep].run).toContain(
    'bash tools/deploy/release-attach.sh attach "$ID" "$SHA" "$VERSION" "$RUN_ID" "$file" "$arm_file"',
  );
  expect(wf.jobs.reconcile.steps.at(-2).run).toBe("bash tools/deploy/release-attach.sh reconcile");
  expect(text).not.toMatch(/draft=false|make_latest|feed-r2/);
  const script = readFileSync("tools/deploy/release-attach.sh", "utf8");
  // The signing run itself is checked before any draft is selected, on every path.
  expect(script).toContain(
    'if [[ "$facts" != ".github/workflows/windows-signed.yml $REPO $REPO workflow_dispatch main completed success" ]]; then',
  );
  expect(script).toContain('marker="<!-- orca-signed-run: $run $want -->"');
  expect(script).toContain('arm_marker="<!-- orca-signed-run-arm64: $run $arm_want -->"');
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

it("dispatches the signed server bundle for every real release, never a rehearsal (#876)", () => {
  const job = workflow("release-publish.yml").jobs["server-bundle"];
  expect(job.needs).toEqual(["check", "publish"]);
  expect(job.if).toBe("${{ !inputs.dry_run }}");
  expect(job.steps.some((step) => step.uses)).toBe(false);
  expect(job.steps[0].run).toContain(
    'gh workflow run release-server-bundle.yml --repo "$GITHUB_REPOSITORY" --ref main \\\n  -f version="$VERSION" -f source_sha="$SHA"',
  );
});

it("signs the server bundle only from main, in a job that runs none of the release commit (#876)", () => {
  const file = workflow("release-server-bundle.yml");
  expect(file.permissions).toEqual({ contents: "read" });
  expect(Object.keys(file.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  const { resolve, build, sign, verify, attach, reconcile } = file.jobs;
  expect(resolve.if).toBe("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  expect(reconcile.if).toBe("github.event_name == 'schedule' && github.ref == 'refs/heads/main'");

  // id-token only where nothing from the release commit runs, and nowhere else.
  for (const [name, job] of Object.entries(file.jobs))
    expect(job.permissions?.["id-token"] ?? null, name).toBe(name === "sign" ? "write" : null);
  expect(sign.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(sign.steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
  expect(sign.steps.some((step) => /pnpm|node /.test(step.run ?? ""))).toBe(false);
  const signing = sign.steps.find((step) => step.name === "Sign").run;
  expect(signing).toContain('cosign sign-blob --yes --bundle "$manifest.sigstore.json" "$manifest"');

  // The release commit is built with a read-only token; main's tooling does everything else.
  expect(build.permissions).toEqual({ contents: "read" });
  expect(build.steps[0].with).toEqual({ ref: "${{ inputs.source_sha }}", "persist-credentials": false });
  for (const job of [resolve, verify, attach, reconcile])
    expect(job.steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });

  // The clean-host check gates the attach, and the attach shares the draft-writes queue: it
  // rewrites the release notes like every other member, so it must never interleave with one.
  expect(verify.needs).toEqual(["resolve", "sign"]);
  expect(attach.needs).toEqual(["resolve", "verify"]);
  expect(attach.concurrency).toEqual({ group: "release-draft-writes", "cancel-in-progress": false, queue: "max" });
  expect(file.concurrency).toEqual({
    group: "release-server-bundle-${{ inputs.version || 'reconcile' }}",
    "cancel-in-progress": false,
  });
  const staging = verify.steps.find((step) => step.name === "Stage it with Python 3 alone").run;
  expect(staging).toContain("python:3.12-slim-bookworm");
  expect(staging).toContain("stage --bundle");
  expect(staging).toContain("for tool in gh git mise pnpm node; do");
});

it("pins the same signer identity in the workflow and the adapter (#876)", () => {
  const adapter = readFileSync(new URL("../../tools/deploy/orca-release.py", import.meta.url), "utf8");
  expect(adapter).toContain('BUNDLE_REPOSITORY = "cschadewitz/Project_Orca"');
  expect(adapter).toContain(
    'BUNDLE_SIGNER = f"https://github.com/{BUNDLE_REPOSITORY}/.github/workflows/release-server-bundle.yml@refs/heads/main"',
  );
  expect(adapter).toContain('BUNDLE_TRIGGER = "workflow_dispatch"');
  const sign = workflow("release-server-bundle.yml").jobs.sign.steps;
  expect(sign.find((step) => step.uses?.startsWith("sigstore/cosign-installer@")).with).toEqual({
    "cosign-release": "v3.1.4",
  });
  expect(adapter).toContain('COSIGN_VERSION = "v3.1.4"');
});

it("accepts the signed arm64 installer on a GitHub-hosted arm64 machine, unattended (#889)", () => {
  const text = readFileSync(".github/workflows/release-accept-arm64.yml", "utf8");
  const wf = workflow("release-accept-arm64.yml");
  expect(wf.on.workflow_run).toEqual({ workflows: ["Release (attach signed installer)"], types: ["completed"] });
  expect(wf.permissions).toEqual({ contents: "read" });
  expect(wf.jobs.select.if).toContain("vars.ORCA_RELEASE_AUTO_SIGN == 'true'");
  expect(wf.jobs.select.if).toContain("github.event.workflow_run.head_branch == 'main'");
  expect(wf.jobs.select.if).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  // Only the jobs that read drafts and write the record may write; the installer runs read-only.
  expect(wf.jobs.select.permissions).toEqual({ contents: "write" });
  expect(wf.jobs.accept.permissions).toBeUndefined();
  expect(wf.jobs.accept["runs-on"]).toBe("windows-11-arm");
  expect(wf.jobs.record.permissions).toEqual({ contents: "write" });
  expect(wf.jobs.record.concurrency).toEqual({
    group: "release-draft-writes",
    "cancel-in-progress": false,
    queue: "max",
  });
  expect(wf.jobs.record.needs).toEqual(["select", "accept"]);
  expect(wf.jobs.record.steps.at(-1).run).toBe(
    'bash tools/deploy/release-attach.sh accept "$ID" "$SHA" "$VERSION" "$GITHUB_RUN_ID" "$DIGEST"',
  );
  const accept = wf.jobs.accept.steps.map((s) => s.run ?? "").join("\n");
  for (const needle of ["Get-AuthenticodeSignature", "0xAA64", "'/S'", "tools/deploy/windows-launch-check.js"])
    expect(accept).toContain(needle);
  // The downloaded bytes are the recorded ones, checked before anything runs them.
  expect(text).toContain('== "$DIGEST" ]] || { echo "::error::downloaded bytes are not $DIGEST"; exit 1; }');
  expect(text).not.toMatch(/secrets\.|draft=false|make_latest|feed-r2/);
  // The baseline is read from the full release list, failing closed; the evidence is kept
  // before the record that points at it.
  expect(text).toContain("gh api --paginate \"repos/$REPO/releases\" --jq '.[]' | jq -s . > releases.json");
  expect(text).toContain('node tools/deploy/feed-arches.js baseline-run "$VERSION" releases.json');
  expect(text).toContain(
    'node tools/deploy/feed-arches.js baseline "$VERSION" "$REPO" releases.json baseline-run.json',
  );
  expect(text).not.toContain("releases/latest");
  const record = wf.jobs.record.steps.map((s) => s.name ?? s.uses);
  expect(record.indexOf("Keep the evidence with this run")).toBeLessThan(
    record.indexOf("Record it, re-validating the draft first"),
  );
  const keep = wf.jobs.record.steps.find((s) => s.name === "Keep the evidence with this run");
  expect(keep.with).toMatchObject({ name: "arm64-acceptance-evidence", "retention-days": 90, overwrite: true });
  // The x64-only decision: dispatch only, from main, in the draft-writes queue.
  expect(wf.jobs["x64-only"].if).toBe(
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.x64_only",
  );
  expect(wf.jobs["x64-only"].concurrency).toEqual({
    group: "release-draft-writes",
    "cancel-in-progress": false,
    queue: "max",
  });
  expect(wf.jobs["x64-only"].steps.at(-1).run).toContain('bash tools/deploy/release-attach.sh x64-only "$ID" "$sha"');
  expect(wf.jobs.select.if).toContain("!inputs.x64_only");
});

it("binds each server bundle run to its version and commit (#876)", () => {
  const file = workflow("release-server-bundle.yml");
  expect(file["run-name"]).toBe("Release (server bundle) v${{ inputs.version }} at ${{ inputs.source_sha }}");
  const script = readFileSync("tools/deploy/release-attach.sh", "utf8");
  expect(script).toContain("|Release (server bundle) v$version at $sha");
  // The receipt names the jobs exactly as the workflow does.
  for (const job of ["sign", "verify"]) expect(script).toContain(`"${file.jobs[job].name}"`);
  expect(file.jobs.attach.name).toBe(
    "server bundle receipt: release ${{ needs.resolve.outputs.id }} v${{ inputs.version }} ${{ inputs.source_sha }} ${{ needs.verify.outputs.receipt }}",
  );
  expect(script).toContain('receipt="server bundle receipt: release $id v$version $sha $(receipt_hash');
  // The receipt is computed only after the clean-host stage, and the attach uploads only those bytes.
  const steps = file.jobs.verify.steps.map((step) => step.name ?? step.uses);
  expect(steps.indexOf("The receipt for exactly these bytes")).toBeGreaterThan(
    steps.indexOf("Stage it with Python 3 alone"),
  );
  expect(file.jobs.attach.needs).toEqual(["resolve", "verify"]);
  expect(file.jobs.attach.steps.at(-1).env.VERIFIED).toBe("${{ needs.verify.outputs.digests }}");
});

it("starts the server bundle with the 0.8 line in the dispatch and in release-attach.sh alike (#876)", () => {
  const dispatch = workflow("release-publish.yml").jobs["server-bundle"].steps[0].run;
  const script = readFileSync("tools/deploy/release-attach.sh", "utf8");
  const from = script.match(/^SERVER_FROM=(\S+)$/m)[1];
  expect(from).toBe("0.8.0");
  expect(dispatch).toContain(`SERVER_FROM=${from}`);
  expect(dispatch.indexOf("SERVER_FROM=")).toBeLessThan(dispatch.indexOf("gh workflow run"));
  expect(dispatch).toContain('"${VERSION%%-*}" | sort -V | head -n1)" != "$SERVER_FROM"');
});
