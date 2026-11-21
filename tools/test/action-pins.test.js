/**
 * Every third-party action is pinned to a full commit SHA with its version in a comment
 * (#863, as T3 Code does). A tag can be moved to other code after review; a SHA cannot.
 * Dependabot's github-actions updater (.github/dependabot.yml) keeps the pins and their
 * comments current.
 */
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const dir = new URL("../../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

it.each(files)("%s pins every external action to a SHA and names its version", (name) => {
  const lines = readFileSync(new URL(name, dir), "utf8").split("\n");
  const uses = lines.map((line) => line.match(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/)).filter(Boolean);
  for (const [, ref, rest] of uses) {
    if (ref.startsWith("./")) continue;
    expect(ref, `${name}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    expect(rest.trim(), `${name}: ${ref} needs a "# vX.Y.Z" comment`).toMatch(/^# v\d+\.\d+\.\d+$/);
  }
});
