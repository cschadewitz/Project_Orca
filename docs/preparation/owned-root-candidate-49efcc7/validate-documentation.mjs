#!/usr/bin/env node
// Dependency-free packet checks; execute only the marked guards on disposable fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const bash = process.argv[2] || "bash";
const individual = "ef7861dfa9e894a04087fc78d1313b4054051c735d82b613e25cba338b9ee78a";
const manifest = "ffc4e42345db96f5103613ac3a82be16409770f9b6df1a14c755d1a00b6aaf5f";
const read = (name) => readFileSync(join(directory, name), "utf8").replaceAll("\r\n", "\n");
let historicalExceptions = 0;
let digestCount = 0;
for (const name of readdirSync(directory).filter((name) => /\.(md|txt|json|yaml)$/u.test(name))) {
  for (const line of read(name).split("\n")) {
    for (const [value] of line.matchAll(/\b[0-9a-fA-F]{32,}\b/gu)) {
      if (name === "correction-2026-10-04.md" && line.startsWith("Historical invalid digest (63 characters;")) {
        assert.equal(value.length, 63);
        assert.equal(value, individual.slice(0, -6) + "2814a");
        historicalExceptions++;
      } else {
        assert.ok([40, 64].includes(value.length), `${name}: invalid digest length ${value.length}`);
        assert.match(value, /^[0-9a-f]+$/u, `${name}: digest must be lowercase hexadecimal`);
        if (value.length === 64) digestCount++;
      }
    }
  }
}
assert.equal(historicalExceptions, 1, "retain exactly one explicitly labelled original invalid digest");
for (const name of ["activation-preflight.md", "validation-report.txt", "correction-2026-10-04.md"]) {
  const text = read(name);
  assert.ok(text.includes(individual), `${name}: missing corrected individual digest`);
  assert.ok(text.includes(manifest), `${name}: missing reviewed manifest digest`);
}

const preflight = read("activation-preflight.md");
for (const [, pin] of preflight.matchAll(/^(?:hash_is|digest_is) (\S+)/gmu)) {
  assert.match(pin, /^[0-9a-f]{64}$/u, "each reusable checksum call requires a full SHA-256 pin");
}
const blocks = [...preflight.matchAll(/```bash\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
assert.ok(blocks.length > 0);
const run = (script, args, cwd) => {
  const result = spawnSync(bash, ["--noprofile", "--norc", ...args], {
    input: script + "\n",
    encoding: "utf8",
    cwd,
    timeout: 10000,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
};
for (const block of blocks) {
  const result = run(block, ["-n"], directory);
  assert.equal(result.status, 0, result.stderr);
}
const guards = preflight.match(/# BEGIN reusable checksum guards\n([\s\S]*?)# END reusable checksum guards/u)?.[1];
assert.ok(guards, "missing marked reusable guards");
assert.ok(guards.includes("set -Eeuo pipefail"));
assert.ok(guards.includes(" ERR"));
const fixtureDirectory = mkdtempSync(join(tmpdir(), "orca-doc-check-"));
try {
  const body = "documentation fixture\n";
  writeFileSync(join(fixtureDirectory, "fixture.txt"), body);
  const expected = createHash("sha256").update(body).digest("hex");
  const cases = [
    ["matching file", `hash_is ${expected} fixture.txt`, 0],
    ["malformed expected", `hash_is ${expected.slice(1)} fixture.txt`, 1],
    ["nonhex expected", `hash_is z${expected.slice(1)} fixture.txt`, 1],
    ["mismatch", `hash_is ${"0".repeat(64)} fixture.txt`, 1],
    ["malformed actual", `digest_is ${expected} ${expected.slice(1)}`, 1],
    ["missing file", `hash_is ${expected} missing.txt`, 1],
    ["pipeline failure", `sha256sum() { return 7; }\nhash_is ${expected} fixture.txt`, 7],
    ["manifest capture failure", "compiled_manifest=$(false | cat)", 1],
    ["nested helper failure", "fail_helper() { return 9; }\nouter() { fail_helper; }\nouter", 9],
  ];
  for (const [label, command, status] of cases) {
    const result = run(`${guards}\n${command}\nprintf 'REACHED_SENTINEL\\n'`, ["-s"], fixtureDirectory);
    assert.equal(result.status, status, `${label}: ${result.stderr}`);
    assert.equal(result.stdout.includes("REACHED_SENTINEL"), status === 0, label);
    assert.equal(result.stderr.includes("STOP:"), status !== 0, label);
    console.log(`PASS: ${label} (exit ${status})`);
  }
  console.log(`PASS: ${digestCount} SHA-256 literals, 1 historical exception, ${blocks.length} Bash syntax checks`);
} finally {
  // Only the unique directory created by mkdtempSync above is removed.
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
