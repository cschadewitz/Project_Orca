/** `orca --help` is a request, not a mistake: it exits 0. A bare `orca` is a mistake and exits 1. */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORCA_VERSION } from "../src/commands/index.js";
import { main } from "../src/main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe("orca --help", () => {
  it("prints usage to stdout and exits 0", async () => {
    const { out, err } = capture();
    expect(await main(["--help"])).toBe(0);
    expect(out.join("")).toMatch(/^orca - /);
    expect(err.join("")).toBe("");
  });

  it("exits 0 with a command too", async () => {
    const { out } = capture();
    expect(await main(["runs", "--help"])).toBe(0);
    expect(out.join("")).toMatch(/usage: orca/);
  });

  it("a bare `orca` prints usage to stderr and exits 1", async () => {
    const { out, err } = capture();
    expect(await main([])).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/usage: orca/);
  });

  it("an unknown command exits 1", async () => {
    const { err } = capture();
    expect(await main(["nope"])).toBe(1);
    expect(err.join("")).toMatch(/unknown command 'nope'/);
  });
});

describe("orca --version", () => {
  // The root manifest is the release version and the only source of it: the packages under
  // packages/ stay at 0.1.0 (docs/RELEASING.md), so reading one of those reported a number
  // no release ever carried (#229). `hello.orcaVersion` and the `orca serve` banner are the
  // same constant, so pinning it here pins all three.
  const root = createRequire(import.meta.url)("../../../package.json") as { version: string };

  it("prints the root package.json version and exits 0", async () => {
    const { out, err } = capture();
    expect(await main(["--version"])).toBe(0);
    expect(out.join("")).toBe(`${root.version}\n`);
    expect(err.join("")).toBe("");
  });

  it("is the version the daemon hands out", () => {
    expect(ORCA_VERSION).toBe(root.version);
  });
});
