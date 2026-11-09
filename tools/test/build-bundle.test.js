/** The signing job's bundle verifier: whole-archive checks before any write, under packages/<pkg>/dist only. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readEntries, verifyAndExtract } from "../packaged-windows/build-bundle.js";

const scriptPath = fileURLToPath(new URL("../packaged-windows/build-bundle.js", import.meta.url));
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
let work;
let root;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "orca-build-bundle-"));
  root = join(work, "checkout");
  mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools", "hook.js"), "original\n");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** A real GNU tar archive of `files` (relative path → content), built in a scratch tree. */
function gnuTar(files, extra = []) {
  const src = mkdtempSync(join(work, "src-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), content);
  }
  const out = join(work, `bundle-${Math.random().toString(16).slice(2)}.tar`);
  // Relative archive and source names: GNU tar in Git Bash reads a drive-letter path as host:path.
  execFileSync("tar", ["-cf", basename(out), ...extra, "-C", basename(src), ...Object.keys(files)], { cwd: work });
  return out;
}

/** A hand-built ustar archive, for entries GNU tar will not write on request. */
function rawTar(entries) {
  const blocks = [];
  for (const { name, type = "0", data = Buffer.alloc(0), linkname = "" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write(type, 156);
    header.write(linkname, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const out = join(work, `raw-${Math.random().toString(16).slice(2)}.tar`);
  writeFileSync(out, Buffer.concat(blocks));
  return out;
}

const run = (archive, digest = sha(readFileSync(archive))) => verifyAndExtract(archive, digest, root);

it("unpacks a genuine bundle, including long names", () => {
  const long = `packages/app/dist/${"deep/".repeat(30)}file.js`;
  const archive = gnuTar({
    "packages/app/dist/main.js": "main\n",
    "packages/design/dist/index.js": "d\n",
    [long]: "l\n",
  });
  expect(run(archive)).toBeGreaterThanOrEqual(3);
  expect(readFileSync(join(root, "packages/app/dist/main.js"), "utf8")).toBe("main\n");
  expect(readFileSync(join(root, long), "utf8")).toBe("l\n");
});

it("refuses a digest mismatch before reading entries", () => {
  const archive = gnuTar({ "packages/app/dist/main.js": "main\n" });
  expect(() => run(archive, "0".repeat(64))).toThrow(/does not match/);
  expect(() => run(archive, "not-a-digest")).toThrow(/SHA-256 is required/);
  expect(existsSync(join(root, "packages/app/dist"))).toBe(false);
});

it("refuses a large archive of outside paths and writes nothing (the pipefail bypass)", () => {
  const files = {};
  for (let i = 0; i < 5000; i++) files[`tools/overwrite-${i}.js`] = "x\n";
  const archive = gnuTar(files);
  expect(() => run(archive)).toThrow(/not a path under packages/);
  expect(existsSync(join(root, "tools/overwrite-0.js"))).toBe(false);
});

it("refuses one bad entry anywhere, even after thousands of good ones, and writes nothing", () => {
  const files = {};
  for (let i = 0; i < 3000; i++) files[`packages/app/dist/f-${i}.js`] = "ok\n";
  files["tools/hook.js"] = "replaced\n";
  const archive = gnuTar(files);
  expect(() => run(archive)).toThrow(/tools\/hook\.js/);
  expect(existsSync(join(root, "packages/app/dist/f-0.js"))).toBe(false);
  expect(readFileSync(join(root, "tools/hook.js"), "utf8")).toBe("original\n");
});

it.each([
  ["a parent-directory segment", "packages/app/dist/../../../tools/hook.js"],
  ["an absolute path", "/tmp/evil.js"],
  ["a backslash path", "packages/app/dist\\..\\..\\tools\\hook.js"],
  ["a drive or stream colon", "packages/app/dist/x.js:stream"],
  ["a dot segment", "packages/app/./dist/x.js"],
  ["the package directory itself", "packages/app/package.json"],
  ["an uppercase package name", "packages/APP/dist/x.js"],
])("refuses %s", (_, name) => {
  const archive = rawTar([{ name, data: Buffer.from("x\n") }]);
  expect(() => run(archive)).toThrow();
  expect(readFileSync(join(root, "tools/hook.js"), "utf8")).toBe("original\n");
});

it.each([
  ["a symlink", "2"],
  ["a hard link", "1"],
  ["a character device", "3"],
  ["a FIFO", "6"],
  ["a GNU long link", "K"],
  ["a global pax header", "g"],
])("refuses %s entry", (_, type) => {
  const archive = rawTar([{ name: "packages/app/dist/link", type, linkname: "../../../tools/hook.js" }]);
  expect(() => run(archive)).toThrow(/not a file or directory|not accepted|malformed/);
  expect(existsSync(join(root, "packages/app/dist"))).toBe(false);
});

it("refuses a real GNU tar symlink entry", () => {
  const src = mkdtempSync(join(work, "link-"));
  mkdirSync(join(src, "packages/app/dist"), { recursive: true });
  symlinkSync("../../../tools", join(src, "packages/app/dist/tools"));
  const archive = join(work, "link.tar");
  execFileSync("tar", ["-cf", basename(archive), "-C", basename(src), "packages"], { cwd: work });
  expect(() => run(archive)).toThrow(/not a file or directory/);
});

it("refuses duplicates, case-insensitively, and existing files", () => {
  const dup = rawTar([
    { name: "packages/app/dist/a.js", data: Buffer.from("1") },
    { name: "packages/app/dist/A.js", data: Buffer.from("2") },
  ]);
  expect(() => run(dup)).toThrow(/more than once/);
  mkdirSync(join(root, "packages/app/dist"), { recursive: true });
  writeFileSync(join(root, "packages/app/dist/a.js"), "existing");
  const one = rawTar([{ name: "packages/app/dist/a.js", data: Buffer.from("new") }]);
  expect(() => run(one)).toThrow(/already exists/);
  expect(readFileSync(join(root, "packages/app/dist/a.js"), "utf8")).toBe("existing");
});

it("refuses to write through a symlinked dist directory", () => {
  symlinkSync(join(root, "tools"), join(root, "packages/app/dist"));
  const archive = rawTar([{ name: "packages/app/dist/hook.js", data: Buffer.from("replaced") }]);
  expect(() => run(archive)).toThrow(/not a plain directory/);
  expect(readFileSync(join(root, "tools/hook.js"), "utf8")).toBe("original\n");
});

it("refuses truncated, corrupted and empty archives", () => {
  const archive = gnuTar({ "packages/app/dist/main.js": "main\n" });
  const bytes = readFileSync(archive);
  const truncated = join(work, "truncated.tar");
  writeFileSync(truncated, bytes.subarray(0, 600));
  expect(() => run(truncated)).toThrow();
  const corrupt = Buffer.from(bytes);
  corrupt[10] ^= 0xff;
  const corrupted = join(work, "corrupt.tar");
  writeFileSync(corrupted, corrupt);
  expect(() => run(corrupted)).toThrow(/checksum/);
  const empty = join(work, "empty.tar");
  writeFileSync(empty, Buffer.alloc(1024));
  expect(() => run(empty)).toThrow(/empty/);
});

it("honours a pax path override and judges the overriding name", () => {
  const record = (key, value) => {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 2;
    while (`${length}${body}`.length !== length) length++;
    return `${length}${body}`;
  };
  const archive = rawTar([
    { name: "PaxHeader", type: "x", data: Buffer.from(record("path", "tools/hook.js")) },
    { name: "packages/app/dist/innocent.js", data: Buffer.from("replaced") },
  ]);
  expect(readEntries(readFileSync(archive))[0].name).toBe("tools/hook.js");
  expect(() => run(archive)).toThrow(/tools\/hook\.js/);
});

it("refuses a file entry that is also another entry's parent, before writing either", () => {
  const archive = rawTar([
    { name: "packages/app/dist/a", data: Buffer.from("file") },
    { name: "packages/app/dist/a/child.js", data: Buffer.from("child") },
  ]);
  expect(() => run(archive)).toThrow(/sits under a file entry/);
  expect(existsSync(join(root, "packages/app/dist"))).toBe(false);
});

it("reads pax records by byte length, so a Unicode path round-trips", () => {
  const name = `packages/app/dist/${"ü".repeat(60)}/ファイル.js`;
  const record = (key, value) => {
    const body = Buffer.from(` ${key}=${value}\n`);
    let length = body.length + 2;
    while (Buffer.byteLength(`${length}`) + body.length !== length) length++;
    return Buffer.concat([Buffer.from(`${length}`), body]);
  };
  const archive = rawTar([
    {
      name: "PaxHeader",
      type: "x",
      data: Buffer.concat([record("mtime", "1"), record("path", name), record("uname", "ü")]),
    },
    { name: "packages/app/dist/placeholder", data: Buffer.from("u") },
  ]);
  expect(run(archive)).toBe(1);
  expect(readFileSync(join(root, name), "utf8")).toBe("u");
});

it("refuses a pax record whose byte length is wrong", () => {
  const archive = rawTar([
    { name: "PaxHeader", type: "x", data: Buffer.from("99 path=packages/app/dist/x.js\n") },
    { name: "packages/app/dist/x.js", data: Buffer.from("x") },
  ]);
  expect(() => run(archive)).toThrow(/malformed pax/);
});

it("fails closed through the command line the workflow runs", () => {
  const files = {};
  for (let i = 0; i < 5000; i++) files[`tools/overwrite-${i}.js`] = "x\n";
  const archive = gnuTar(files);
  const args = [scriptPath, "--bundle", archive, "--sha256", sha(readFileSync(archive)), "--root", root];
  expect(() => execFileSync(process.execPath, args, { stdio: "pipe" })).toThrow();
  expect(existsSync(join(root, "tools/overwrite-0.js"))).toBe(false);
  const good = gnuTar({ "packages/app/dist/main.js": "main\n" });
  const out = execFileSync(process.execPath, [
    scriptPath,
    "--bundle",
    good,
    "--sha256",
    sha(readFileSync(good)),
    "--root",
    root,
  ]);
  expect(String(out)).toMatch(/unpacked \d+ verified entries/);
});
