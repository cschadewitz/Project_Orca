/** The desktop feed's workflow wiring: only verified signed bytes for a tagged commit enter it. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const read = (name) => readFileSync(`.github/workflows/${name}`, "utf8");

describe("desktop feed workflows", () => {
  it("never feeds the unsigned release publication output", () => {
    const publish = read("release-publish.yml");
    expect(publish).not.toMatch(/feed-r2\.sh|ORCA_FEED_|publish-feed/);
  });

  it("feeds only a published release's signed artifact, after re-verifying it", () => {
    const feed = read("feed-publish.yml");
    expect(feed).toContain("refs/tags/v$VERSION^{commit}");
    expect(feed).toContain('releases/tags/v$VERSION" > release.json');
    expect(feed).toContain("name: ${{ steps.source.outputs.artifact }}");
    const order = [
      "tools/deploy/feed-source.js",
      "tools/deploy/feed-arches.js",
      "Get-AuthenticodeSignature",
      'tools/deploy/release-assets.py signed "$VERSION" "$ARCHES"',
      "Match the published release's installers",
      'tools/deploy/feed-r2.sh snapshot signed "$VERSION" "$ARCHES"',
    ].map((needle) => feed.indexOf(needle));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gates both feed workflows on the bucket variable, main and the feed environment", () => {
    for (const name of ["feed-publish.yml", "feed-promote.yml"]) {
      const text = read(name);
      expect(text).toContain("if: github.ref == 'refs/heads/main' && vars.ORCA_FEED_BUCKET != ''");
      expect(text).toContain("environment: desktop-feed");
    }
    expect(read("feed-promote.yml")).toContain("group: release-publication");
  });

  it("refuses to publish, or to offer anything, while the feed is paused (#863, item 8)", () => {
    const steps = (name) => read(name).split("    steps:\n")[1];
    const publish = steps("feed-publish.yml");
    expect(publish.indexOf("Refuse while the feed is paused")).toBeLessThan(publish.indexOf("actions/checkout@"));
    expect(publish).toContain('if [ "$PAUSE" = "true" ]; then');
    const promote = steps("feed-promote.yml");
    expect(promote.indexOf("Refuse while the feed is paused")).toBeLessThan(promote.indexOf("actions/checkout@"));
    // Halting (percent 0) is how a bad rollout is stopped, so it still runs while paused.
    expect(promote).toContain('if [ "$PAUSE" = "true" ] && [ "$PERCENT" != "0" ]; then');
    for (const name of ["feed-publish.yml", "feed-promote.yml"])
      expect(read(name)).toContain("PAUSE: ${{ vars.ORCA_FEED_PAUSE }}");
  });

  it("serves x64, and arm64 only with verified acceptance, matching the published release", () => {
    const feed = read("feed-publish.yml");
    expect(feed).toMatch(/^env:\n {2}FEED_ARCHES: x64 arm64\n/m);
    expect(feed).toContain('arches=$(node tools/deploy/feed-arches.js serve "$VERSION" "$REPO"');
    expect(feed).toContain("--name arm64-acceptance-evidence");
    expect(feed).toContain("gh api --paginate \"repos/$REPO/releases\" --jq '.[]' | jq -s .");
    // Every step after the choice uses the chosen list, never the upper bound.
    const after = feed.slice(feed.indexOf("Choose the architectures to serve"));
    expect(after.match(/ARCHES: \$\{\{ steps\.arches\.outputs\.arches \}\}/g)).toHaveLength(4);
    expect(after.split("\n").filter((line) => line.includes("$FEED_ARCHES") && !line.includes("[["))).toEqual([]);
    expect(feed).toContain('[[ "$actual" == "$published" ]]');
    expect(feed).toContain(".digest");
  });

  it("uploads exactly the architectures the Worker serves", async () => {
    const { SERVED_ARCHES } = await import("../deploy/feed-worker/worker.js");
    const arches = /^ {2}FEED_ARCHES: (.+)$/m.exec(read("feed-publish.yml"))[1];
    expect(arches.split(" ")).toEqual(SERVED_ARCHES);
  });
});

describe("automatic feed dispatch", () => {
  const auto = read("feed-auto.yml");

  it("runs on a published release and a daily reconcile, only when switched on", () => {
    expect(auto).toContain("types: [published]");
    expect(auto).toMatch(/cron: "41 7 \* \* \*"/);
    expect(auto).not.toContain("workflow_run");
    expect(auto).toContain("if: vars.ORCA_FEED_AUTO == 'true' && vars.ORCA_FEED_BUCKET != ''");
    expect(auto).not.toMatch(/^concurrency:/m);
  });

  it("dispatches nothing while the feed is paused", () => {
    expect(auto).toContain("if: vars.ORCA_FEED_PAUSE == 'true'");
    expect(auto.match(/if: steps\.pause\.outcome == 'skipped'/g)).toHaveLength(2);
  });

  it("holds no feed credentials and runs main's script", () => {
    expect(auto).not.toMatch(/secrets\.|environment:/);
    expect(auto).toMatch(/ref: main\n/);
    expect(auto).toContain("run: bash tools/deploy/feed-auto.sh");
    expect(auto).toMatch(/permissions:\n {2}contents: read\n {2}actions: write\n/);
  });

  it("queues feed-publish per version so no version's dispatch replaces another's", () => {
    expect(read("feed-publish.yml")).toContain("group: feed-publish-${{ inputs.version }}");
  });
});

describe("server bundle channel workflows (#877)", () => {
  const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
  const workflow = (name) => parse(read(name));

  it("publishes the server bundle to internal servers before the desktop job runs", () => {
    const wf = workflow("feed-publish.yml");
    const { server, publish } = wf.jobs;
    expect(publish.needs).toBe("server");
    expect(server.if).toBe("github.ref == 'refs/heads/main' && vars.ORCA_FEED_BUCKET != ''");
    expect(server.environment).toBe("desktop-feed");
    const names = server.steps.map((s) => s.name ?? s.uses);
    expect(names[0]).toBe("Refuse while the feed is paused");
    expect(server.steps[0].run).toContain('if [ "$PAUSE" = "true" ]; then');
    const run = server.steps.map((s) => s.run ?? "").join("\n");
    // Main's tooling only, the same verification a server runs, the tag's commit, then upload.
    expect(server.steps[1].with).toMatchObject({ ref: "main", "persist-credentials": false });
    const order = [
      "hasServer",
      "python3 -I tools/deploy/orca-release.py fetch-bundle",
      "refs/tags/v$VERSION^{commit}",
      "tools/deploy/feed-server.js channel",
      "tools/deploy/feed-r2.sh probe",
      'tools/deploy/feed-r2.sh server-snapshot "$RUNNER_TEMP/server" "$VERSION"',
    ].map((needle) => run.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Versions before the 0.8 line skip every step after the check, so the desktop job runs.
    for (const step of server.steps.slice(server.steps.findIndex((s) => s.id === "applies") + 1))
      expect(step.if).toBe("steps.applies.outputs.applies == 'true'");
  });

  it("promotes either channel, refusing everything but a halt while paused", () => {
    const wf = workflow("feed-promote.yml");
    const channel = wf.on.workflow_dispatch.inputs.channel;
    expect(channel).toMatchObject({ type: "choice", options: ["desktop", "server"], default: "desktop" });
    const run = wf.jobs.promote.steps.find((s) => s.name === "Update the rings").run;
    expect(run).toContain('desktop) bash tools/deploy/feed-r2.sh promote "$RING" "$VERSION" "$PERCENT" ;;');
    expect(run).toContain('server) bash tools/deploy/feed-r2.sh promote-server "$RING" "$VERSION" "$PERCENT" ;;');
    expect(wf.jobs.promote.steps[0].name).toBe("Refuse while the feed is paused");
  });

  it("has the watchdog read the live ring state, with no ring-state artifacts", () => {
    for (const name of ["feed-publish.yml", "feed-promote.yml", "feed-watchdog.yml"])
      expect(read(name)).not.toMatch(/FEED_RINGS_RECORD|feed-rings-/);
    expect(read("feed-watchdog.yml")).not.toMatch(/upload-artifact|download-artifact/);
    const watchdog = workflow("feed-watchdog.yml");
    expect(watchdog.permissions).toEqual({ contents: "read" });
    const { rings, watch } = watchdog.jobs;
    expect(rings.environment).toBe("desktop-feed");
    expect(rings.outputs).toEqual({ rings: "${{ steps.read.outputs.rings }}" });
    expect(rings.steps.find((s) => s.id === "read").run).toContain("feed-r2.sh read-rings");
    expect(watch.needs).toBe("rings");
    expect(watch.environment).toBe("feed-canary");
    const check = watch.steps.find((s) => s.name === "Check every ring and architecture");
    expect(check.env).toMatchObject({
      FEED_RINGS: "${{ needs.rings.outputs.rings }}",
      FEED_COMMISSIONED: "${{ vars.ORCA_FEED_BUCKET != '' }}",
    });
    expect(JSON.stringify(watch)).not.toMatch(/ORCA_FEED_ACCESS_KEY|ORCA_FEED_SECRET/);
  });
});
