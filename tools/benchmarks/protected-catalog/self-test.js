/** Verify observers forward identity/arguments/errors and a real compiled small catalog meets count oracles. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installProbe } from "./probe.js";

test("transparent observers count I/O and authentication without retaining data", async () => {
  const root = await mkdtemp(join(tmpdir(), "orca-c3-probe-test-"));
  const original = fs.open;
  const probe = installProbe();
  try {
    probe.begin();
    const handle = await fs.open(join(root, "synthetic"), "wx", 0o600);
    await handle.writeFile("synthetic");
    await handle.sync();
    await handle.close();
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12));
    assert.equal(cipher.setAAD(Buffer.from("synthetic")), cipher);
    const ciphertext = Buffer.concat([cipher.update("synthetic"), cipher.final()]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12));
    assert.equal(decipher.setAAD(Buffer.from("synthetic")), decipher);
    decipher.setAuthTag(cipher.getAuthTag());
    assert.equal(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(), "synthetic");
    await assert.rejects(fs.open(join(root, "missing"), "r"), { code: "ENOENT" });
    await assert.rejects(fs.open({}, "r"), { code: "ERR_INVALID_ARG_TYPE" });
    const result = probe.end();
    assert.equal(result["crypto.encrypt.create"].count, 1);
    assert.equal(result["crypto.decrypt.final"].count, 1);
    assert.equal(result["handle.writeFile.other"].count, 1);
    assert.ok(!JSON.stringify(result).includes(root));
    assert.ok(!JSON.stringify(result).includes("synthetic"));
  } finally {
    probe.restore();
    assert.equal(fs.open, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled runtime count oracle and uninstrumented positive oracle", async () => {
  const root = await mkdtemp(join(tmpdir(), "orca-c3-worker-test-"));
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const source = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  function run(action, path, observer) {
    const output = execFileSync(
      process.execPath,
      [worker, action, source, path, JSON.stringify({ history: 8, catalog: 4 }), "warm", observer],
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(output);
  }
  try {
    for (const observer of ["counts", "off"]) {
      const path = await mkdtemp(join(root, "fixture-"));
      assert.equal(run("generate", path, "off").oracle, "passed");
      assert.equal(run("measure", path, observer).oracle, "passed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
