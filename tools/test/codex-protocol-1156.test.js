/**
 * The checked-in Codex app-server protocol (#1156): its files match the SHA256SUMS written when
 * it was generated (so a hand edit fails here, with no Codex needed), the generator's
 * transforms, and, when ORCA_CODEX_BIN names the pinned Codex (the Codex app-server protocol
 * workflow sets it), that regenerating from that Codex gives the checked-in copy byte for byte.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  codexVersion,
  compareTrees,
  generate,
  methodsOf,
  PROTOCOL_ROOT,
  verifySums,
  withExtensions,
} from "../codex-protocol.mjs";

const PINNED = "0.171.0";
const checkedIn = join(PROTOCOL_ROOT, PINNED);
const scratch = mkdtempSync(join(tmpdir(), "orca-1156-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the checked-in protocol", () => {
  it("matches the SHA256SUMS it was generated with, file for file", () => {
    expect(verifySums(checkedIn)).toEqual([]);
  });

  it("catches a hand edit, an added file and a removed one", () => {
    const copy = join(scratch, "edited");
    cpSync(checkedIn, copy, { recursive: true });
    writeFileSync(join(copy, "RequestId.ts"), readFileSync(join(copy, "RequestId.ts"), "utf8") + "\n");
    writeFileSync(join(copy, "Extra.ts"), "export {};\n");
    rmSync(join(copy, "ClientInfo.ts"));
    expect(verifySums(copy)).toEqual([
      "not in SHA256SUMS: Extra.ts",
      "changed since generation: RequestId.ts",
      "listed but missing: ClientInfo.ts",
    ]);
  });

  it("lists the methods ORCA's client checks against", () => {
    const manifest = readFileSync(join(checkedIn, "manifest.ts"), "utf8");
    expect(manifest).toContain(`export const CODEX_PROTOCOL_VERSION = "${PINNED}";`);
    for (const m of ['"initialize"', '"account/read"', '"thread/revert"', '"item/commandExecution/requestApproval"'])
      expect(manifest).toContain(m);
    // Removed upstream, and experimental: neither is on the stable surface ORCA pins.
    expect(manifest).not.toContain('"thread/rollback"');
    expect(manifest).not.toContain('"environment/add"');
  });
});

describe("the generator's transforms", () => {
  it("adds the .js NodeNext needs, and names a directory's index", () => {
    const dir = mkdtempSync(join(scratch, "ext-"));
    cpSync(join(checkedIn, "v2"), join(dir, "v2"), { recursive: true });
    const src = [
      'import type { A } from "./A";',
      'export * as v2 from "./v2";',
      'import type { B } from "../B";',
      'import type { C } from "./C.js";',
      'import type { D } from "zod";',
    ].join("\n");
    expect(withExtensions(src, dir)).toBe(
      [
        'import type { A } from "./A.js";',
        'export * as v2 from "./v2/index.js";',
        'import type { B } from "../B.js";',
        'import type { C } from "./C.js";',
        'import type { D } from "zod";',
      ].join("\n"),
    );
  });

  it("reads a union's methods in order, once each", () => {
    expect(methodsOf('{ "method": "a", id } | { "method": "b/c" } | { "method": "a" }')).toEqual(["a", "b/c"]);
  });

  it("compares trees byte for byte", () => {
    const a = mkdtempSync(join(scratch, "a-"));
    const b = mkdtempSync(join(scratch, "b-"));
    writeFileSync(join(a, "same.ts"), "x");
    writeFileSync(join(b, "same.ts"), "x");
    writeFileSync(join(a, "diff.ts"), "x");
    writeFileSync(join(b, "diff.ts"), "y");
    writeFileSync(join(a, "gone.ts"), "x");
    writeFileSync(join(b, "new.ts"), "x");
    expect(compareTrees(a, b)).toEqual([
      "missing from generated output: gone.ts",
      "not checked in: new.ts",
      "differs: diff.ts",
    ]);
  });
});

const codex = process.env.ORCA_CODEX_BIN;
describe.skipIf(!codex)("against the pinned Codex (ORCA_CODEX_BIN)", () => {
  it("is the pinned version", () => {
    expect(codexVersion(codex)).toBe(PINNED);
  });

  it("regenerates to the checked-in copy byte for byte", () => {
    const out = join(scratch, "generated", PINNED);
    expect(generate(codex, out)).toBe(PINNED);
    expect(compareTrees(checkedIn, out)).toEqual([]);
  });
});
