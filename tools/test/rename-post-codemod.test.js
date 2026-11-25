// tools/rename/post-codemod.mjs on a copy of the native Mac fixture: a changed daemon stub (what the
// codemod does to it) re-derives exactly the digests make_fixture.py derives from it, a rerun
// changes nothing, and any other digest that no longer matches is refused.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nativeMacFixture } from "../rename/post-codemod.mjs";

const FIXTURE = resolve("tools/deploy/tests/native-mac/fixtures/valid");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let dir;
let paths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rename-post-codemod-"));
  cpSync(FIXTURE, dir, { recursive: true });
  // The codemod moves files, so a renamed tree may still hold the old .app's empty directories.
  const app = readdirSync(dir).find(
    (name) => name.endsWith(".app") && existsSync(join(dir, name, "Contents/Info.plist")),
  );
  const resources = join(dir, app, "Contents/Resources");
  paths = {
    stub: join(resources, "daemon", readdirSync(join(resources, "daemon"))[0]),
    build: join(
      resources,
      readdirSync(resources).find((name) => name.endsWith("-build.json")),
    ),
    manifest: join(dir, "delivery/native-mac-artifact.json"),
    sums: join(dir, "delivery/SHA256SUMS"),
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const snapshot = () =>
  Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]));

it("changes nothing on a fixture whose digests already hold", () => {
  const before = snapshot();
  nativeMacFixture(dir);
  expect(snapshot()).toEqual(before);
});

it("re-derives the daemon digest, identitySha256 and the manifest's SHA256SUMS line, and nothing else", () => {
  appendFileSync(paths.stub, "// renamed\n");
  const before = snapshot();
  nativeMacFixture(dir);
  const after = snapshot();
  const build = JSON.parse(after.build);
  const manifest = JSON.parse(after.manifest);
  expect(build.daemon.sha256).toBe(sha(readFileSync(paths.stub)));
  expect(manifest.identity).toEqual(build);
  expect(manifest.identitySha256).toBe(sha(readFileSync(paths.build)));
  const lines = (text) => text.split("\n").filter(Boolean);
  const changed = lines(after.sums).filter((line, i) => line !== lines(before.sums)[i]);
  expect(changed).toEqual([`${sha(readFileSync(paths.manifest))}  native-mac-artifact.json`]);
  // Only the digests moved: the same bytes with the old digests put back are the originals.
  const oldDaemon = JSON.parse(before.build).daemon.sha256;
  expect(after.build.replace(build.daemon.sha256, oldDaemon)).toBe(before.build);

  const settled = snapshot();
  nativeMacFixture(dir);
  expect(snapshot()).toEqual(settled);
});

it("refuses when an artifact or evidence file no longer matches its recorded digest", () => {
  const evidence = JSON.parse(readFileSync(paths.manifest, "utf8")).evidence[0].path;
  appendFileSync(join(dir, "delivery", evidence), "changed\n");
  expect(() => nativeMacFixture(dir)).toThrow(/no longer matches its recorded digest/);
});

it("refuses when a SHA256SUMS line other than the manifest's no longer matches", () => {
  const text = readFileSync(paths.sums, "utf8");
  const line = text.split("\n").find((entry) => entry && !entry.endsWith("  native-mac-artifact.json"));
  writeFileSync(paths.sums, text.replace(line, `${"0".repeat(64)}${line.slice(64)}`));
  expect(() => nativeMacFixture(dir)).toThrow(/SHA256SUMS: .* no longer matches/);
});
