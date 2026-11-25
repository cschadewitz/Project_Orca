#!/usr/bin/env node
// Runs right after `codemod.mjs --apply`, on the renamed working tree, before anything is checked
// or committed (rename-preview.yml, and the cutover runbook in tools/rename/README.md):
//
//   node tools/rename/codemod.mjs --apply && node tools/rename/post-codemod.mjs [--base REV]
//
// Some committed files pin digests of bytes the rename changes. Each is re-derived here the way
// its own generator or checker documents it, and nothing else: every other digest in the same
// files must still match its bytes, or this fails loudly and changes nothing more. --base names
// the commit the codemod ran over (default HEAD; the mechanical layer is never committed first).
//
// 1. The native Mac fixture (tools/deploy/tests/native-mac/fixtures/valid): the daemon stub's
//    sha256 (in the build identity and the artifact manifest), identitySha256, and the manifest's
//    line in SHA256SUMS, as make_fixture.py derives them; then the fixture validator must pass.
// 2. The enforcement receipts (tools/guard-qualification/receipts): signed as attested, so their
//    pre-rename bytes are kept beside each rewritten one (<receipt>.pre-rename, verified by
//    attestation.js), and the qualification profiles of the renamed requirements are mapped to
//    the profiles of the same requirements before the rename (renamed-profiles.json).
//
// Idempotent: a second run finds nothing to re-derive.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMap, renameText } from "./lib.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const at = (...parts) => join(ROOT, ...parts);
const changed = [];

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};

/** Replaces the one occurrence of `from` in the file; anything but one is refused. */
function replaceOnce(path, from, to) {
  const text = readFileSync(path, "utf8");
  const count = text.split(from).length - 1;
  if (count !== 1) refuse(`${relative(ROOT, path)}: expected ${from} once, found it ${count} times`);
  writeFileSync(path, text.replace(from, to));
  changed.push(`${relative(ROOT, path)}: ${from.slice(0, 12)}… -> ${to.slice(0, 12)}…`);
}

export function nativeMacFixture(root = at("tools/deploy/tests/native-mac/fixtures/valid")) {
  // The codemod moves files, not directories: the old .app stays behind as empty directories.
  const apps = readdirSync(root).filter(
    (name) => name.endsWith(".app") && existsSync(join(root, name, "Contents/Info.plist")),
  );
  if (apps.length !== 1) refuse(`${relative(ROOT, root)}: expected one .app, found ${apps.join(", ") || "none"}`);
  const resources = join(root, apps[0], "Contents/Resources");
  const stubs = readdirSync(join(resources, "daemon")).filter((name) => name.endsWith("-daemon.mjs.txt"));
  const builds = readdirSync(resources).filter((name) => name.endsWith("-build.json"));
  if (stubs.length !== 1 || builds.length !== 1)
    refuse(`${relative(ROOT, resources)}: expected one daemon stub and one build identity`);
  const stub = join(resources, "daemon", stubs[0]);
  const build = join(resources, builds[0]);
  const delivery = join(root, "delivery");
  const manifestPath = join(delivery, "native-mac-artifact.json");

  // The daemon digest the identity records is the stub's bytes (make_fixture.py: sha(daemon_bytes)).
  const recorded = JSON.parse(readFileSync(build, "utf8")).daemon?.sha256;
  const daemon = sha(readFileSync(stub));
  if (recorded !== daemon) {
    replaceOnce(build, recorded, daemon);
    replaceOnce(manifestPath, recorded, daemon);
  }
  // identitySha256 is the identity file's bytes, and the manifest carries the same identity.
  const identityBytes = readFileSync(build);
  let manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (JSON.stringify(manifest.identity) !== JSON.stringify(JSON.parse(identityBytes)))
    refuse("native-mac-artifact.json's identity is not the build identity");
  if (manifest.identitySha256 !== sha(identityBytes))
    replaceOnce(manifestPath, manifest.identitySha256, sha(identityBytes));
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // Every artifact and evidence digest is of bytes the rename does not touch: they must still hold.
  for (const record of [...manifest.artifacts, ...manifest.evidence]) {
    const bytes = readFileSync(join(delivery, record.path));
    if (record.sha256 !== sha(bytes) || record.bytes !== bytes.length)
      refuse(`native-mac-artifact.json: ${record.path} no longer matches its recorded digest`);
  }
  // SHA256SUMS: only the manifest's own line may move (make_fixture.py writes every line from bytes).
  const sumsPath = join(delivery, "SHA256SUMS");
  const lines = readFileSync(sumsPath, "utf8").split("\n").filter(Boolean);
  const next = lines.map((line) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) refuse(`SHA256SUMS: unreadable line ${line}`);
    const actual = sha(readFileSync(join(delivery, match[2])));
    if (actual === match[1]) return line;
    if (match[2] !== "native-mac-artifact.json")
      refuse(`SHA256SUMS: ${match[2]} no longer matches, and the rename does not explain it`);
    return `${actual}  ${match[2]}`;
  });
  if (next.join("\n") !== lines.join("\n")) {
    writeFileSync(sumsPath, `${next.join("\n")}\n`);
    changed.push(`${relative(ROOT, sumsPath)}: native-mac-artifact.json line`);
  }
  // The fixture's own validator is the acceptance check.
  const scratch = mkdtempSync(join(tmpdir(), "post-codemod-mac-"));
  try {
    const out = join(scratch, "fixture");
    execFileSync("python3", ["-B", at("tools/deploy/tests/native-mac/make_fixture.py"), out], { stdio: "pipe" });
    execFileSync(
      "python3",
      [
        "-B",
        at("tools/deploy/native-mac-verify.py"),
        "--mode",
        "fixture",
        "--fixture-app",
        join(out, apps[0]),
        join(out, "delivery"),
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    refuse(
      `the native Mac fixture validator refuses the re-derived fixture: ${String(error.stderr ?? error.message).trim()}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });

export async function enforcementReceipts(base = "HEAD") {
  const dir = "tools/guard-qualification";
  const checker = await import(pathToFileURL(at(dir, "check-support-matrix.js")).href);
  const map = loadMap();
  // Receipts: keep the attested bytes beside each one the codemod rewrote, and check the rewrite.
  for (const name of readdirSync(at(dir, "receipts")).filter(
    (n) => n.endsWith(".json") && !n.endsWith(".sigstore.json"),
  )) {
    const path = `${dir}/receipts/${name}`;
    let before;
    try {
      before = git("show", `${base}:${path}`);
    } catch {
      continue; // a receipt the base does not have was written after the rename
    }
    const now = readFileSync(at(path), "utf8");
    if (now === before) continue;
    if (renameText(map, before).text !== now) refuse(`${path} differs from its base by more than the rename`);
    if (!existsSync(at(`${path}.pre-rename`)) || readFileSync(at(`${path}.pre-rename`), "utf8") !== before) {
      writeFileSync(at(`${path}.pre-rename`), before);
      changed.push(`${path}.pre-rename: the attested bytes`);
    }
  }
  // Profiles: the same requirements, before (base) and after (working tree) the rename.
  const read = (file) => ({
    old: JSON.parse(git("show", `${base}:${dir}/${file}`)),
    now: JSON.parse(readFileSync(at(dir, file), "utf8")),
  });
  const matrix = read("support-matrix.json");
  const catalogue = read("cases.json");
  const assertions = read("connected/assertions.json");
  const aliases = {};
  for (const agent of matrix.now.agents) {
    const oldAgent = matrix.old.agents.find((a) => a.id === agent.id);
    if (!oldAgent) refuse(`support-matrix.json: agent ${agent.id} is not in the base`);
    for (const path of matrix.now.paths) {
      const oldPath = matrix.old.paths.find((p) => p.id === path.id);
      if (!oldPath) refuse(`support-matrix.json: path ${path.id} is not in the base`);
      const before = checker.qualificationProfile(matrix.old, catalogue.old, assertions.old, oldAgent, oldPath);
      const after = checker.qualificationProfile(matrix.now, catalogue.now, assertions.now, agent, path);
      if (before !== after) aliases[after] = before;
    }
  }
  // The renamed requirements must be exactly the rename of the base ones.
  for (const file of ["support-matrix.json", "cases.json", "connected/assertions.json"])
    if (renameText(map, git("show", `${base}:${dir}/${file}`)).text !== readFileSync(at(dir, file), "utf8"))
      refuse(`${dir}/${file} differs from its base by more than the rename`);
  const target = at(dir, "renamed-profiles.json");
  const merged = { ...JSON.parse(readFileSync(target, "utf8")), ...aliases };
  const text = `${JSON.stringify(Object.fromEntries(Object.entries(merged).sort()), null, 2)}\n`;
  if (text !== readFileSync(target, "utf8")) {
    writeFileSync(target, text);
    changed.push(`${dir}/renamed-profiles.json: ${Object.keys(aliases).length} profile(s)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const base = args[0] === "--base" ? args[1] : "HEAD";
  try {
    nativeMacFixture();
    await enforcementReceipts(base);
    for (const line of changed) process.stdout.write(`re-derived ${line}\n`);
    process.stdout.write(`post-codemod: ${changed.length} re-derived, everything else still matches\n`);
  } catch (error) {
    console.error(`post-codemod: ${error.message}`);
    process.exit(1);
  }
}
