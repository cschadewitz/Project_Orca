/** The desktop feed's workflow wiring: only verified signed bytes for a tagged commit enter it. */
import { readFileSync } from "node:fs";
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
      "Get-AuthenticodeSignature",
      'tools/deploy/release-assets.py signed "$VERSION" "$FEED_ARCHES"',
      "Match the published release's installers",
      'tools/deploy/feed-r2.sh snapshot signed "$VERSION" "$FEED_ARCHES"',
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

  it("serves only the natively accepted x64 installer, matching the published release", () => {
    const feed = read("feed-publish.yml");
    expect(feed).toMatch(/^env:\n {2}FEED_ARCHES: x64\n/m);
    expect(feed).not.toMatch(/FEED_ARCHES: .*arm64/);
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
