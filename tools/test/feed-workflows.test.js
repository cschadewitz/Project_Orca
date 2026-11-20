/** The desktop feed's workflow wiring: only verified signed bytes for a tagged commit enter it. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name) => readFileSync(`.github/workflows/${name}`, "utf8");

describe("desktop feed workflows", () => {
  it("never feeds the unsigned release publication output", () => {
    const publish = read("release-publish.yml");
    expect(publish).not.toMatch(/feed-r2\.sh|ORCA_FEED_|publish-feed/);
  });

  it("feeds only a successful signed run's artifact for the tagged commit, after re-verifying it", () => {
    const feed = read("feed-publish.yml");
    expect(feed).toContain("refs/tags/v$VERSION^{commit}");
    expect(feed).toContain('".github/workflows/windows-signed.yml"');
    expect(feed).toContain('"$(jq -r .head_branch run.json)" == "main"');
    expect(feed).toContain('"$(jq -r .conclusion run.json)" == "success"');
    expect(feed).toContain("name: windows-signed-${{ steps.source.outputs.sha }}");
    const order = [
      "Get-AuthenticodeSignature",
      "tools/deploy/release-assets.py signed",
      "tools/deploy/feed-r2.sh snapshot signed",
    ].map((needle) => feed.indexOf(needle));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gates both feed workflows on the bucket variable and one concurrency group", () => {
    for (const name of ["feed-publish.yml", "feed-promote.yml"]) {
      const text = read(name);
      expect(text).toContain("if: vars.ORCA_FEED_BUCKET != ''");
      expect(text).toContain("group: release-publication");
      expect(text).toContain("environment: desktop-feed");
    }
  });
});
