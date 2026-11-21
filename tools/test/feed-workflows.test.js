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

  it("gates both feed workflows on the bucket variable and one concurrency group", () => {
    for (const name of ["feed-publish.yml", "feed-promote.yml"]) {
      const text = read(name);
      expect(text).toContain("if: github.ref == 'refs/heads/main' && vars.ORCA_FEED_BUCKET != ''");
      expect(text).toContain("group: release-publication");
      expect(text).toContain("environment: desktop-feed");
    }
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
