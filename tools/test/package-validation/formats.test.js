/** Bounded readers on benign in-memory fixtures (#772). No artifact is extracted or run. */
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  checkAsarIntegrity,
  containedLink,
  containedPath,
  readAsar,
  readBlockmap,
  readElf,
  readPe,
  readTarGz,
  readUpdateMetadata,
  readZip,
} from "../../package-validation/formats.js";
import {
  blockmap,
  makeAsar,
  makeElf,
  makePe,
  makeTarGz,
  makeZip,
  unicodePathExtra,
  updateMetadata,
  zipExtra,
} from "./fixtures.js";

describe("containment", () => {
  it.each(["a/b", "dir/", "ORCA-1.0.0/resources/app.asar"])("accepts %s", (name) =>
    expect(containedPath(name)).toBe(true),
  );
  it.each(["", "/etc/passwd", "../x", "a/../../x", "a\\b", "C:/x", "a//b", "./a", "a/./b"])("refuses %j", (name) =>
    expect(containedPath(name)).toBe(false),
  );
  it("resolves link targets against the member", () => {
    expect(containedLink("a/b/link", "../c")).toBe(true);
    expect(containedLink("a/link", "../../c")).toBe(false);
    expect(containedLink("a/link", "/usr/lib/x")).toBe(false);
  });
  it.each(["C:/outside", "c:outside", "./C:/outside", "//server/share", "\\\\server\\share", "a\0b"])(
    "refuses nonportable link target %j, including in ASAR",
    (target) => {
      expect(containedLink("dir/link", target)).toBe(false);
      expect(() => readAsar(makeAsar({ "dir/link": { link: target } }))).toThrow(/asar_link_escapes/);
    },
  );
});

describe("tar.gz", () => {
  it("reads files, directories, links, modes and pax long names", () => {
    const long = `top/${"d".repeat(120)}/file.txt`;
    const members = readTarGz(
      makeTarGz([
        { name: "top/", kind: "directory", mode: 0o755 },
        { name: "top/run", body: "x", mode: 0o755 },
        { name: "top/link", kind: "symlink", linkName: "run" },
        { name: long, body: "long" },
      ]),
    );
    expect(members.map((m) => [m.name, m.kind])).toEqual([
      ["top/", "directory"],
      ["top/run", "file"],
      ["top/link", "symlink"],
      [long, "file"],
    ]);
    expect(members[1].mode & 0o111).toBeTruthy();
    expect(members[2].linkName).toBe("run");
    expect(members[3].body.toString()).toBe("long");
  });
  it("refuses a corrupted header and non-gzip input", () => {
    const tar = makeTarGz([{ name: "a", body: "x" }]);
    const raw = Buffer.from(gunzipSync(tar));
    raw[0] ^= 1;
    expect(() => readTarGz(gzipSync(raw))).toThrow(/tar_header_invalid/);
    expect(() => readTarGz(Buffer.from("not gzip"))).toThrow(/tar_gzip_invalid/);
  });
  it.each([{ linkpath: "../../outside" }, { path: "../outside" }, { size: "0" }, { mtime: "0" }])(
    "refuses unsupported global PAX attributes %j",
    (globalPax) => {
      const bytes = makeTarGz([{ name: "safe/link", kind: "symlink", linkName: "payload" }], { globalPax });
      expect(() => readTarGz(bytes)).toThrow(/tar_global_pax_unsupported/);
    },
  );
});

describe("zip", () => {
  it.each([
    [0, 0],
    [1, 1],
    [1, 2],
    [2, 1],
    [3, 3],
  ])("refuses EOCD counts %s/%s that disagree with the two stored records", (diskCount, totalCount) => {
    const zip = makeZip([
      { name: "safe/name", body: "x" },
      { name: "../unseen", body: "y" },
    ]);
    zip.writeUInt16LE(diskCount, zip.length - 22 + 8);
    zip.writeUInt16LE(totalCount, zip.length - 22 + 10);
    expect(() => readZip(zip)).toThrow(/zip_directory_invalid/);
  });
  it("requires the central directory size to consume every parsed record", () => {
    const zip = makeZip([{ name: "safe/name", body: "x" }]);
    zip.writeUInt32LE(zip.readUInt32LE(zip.length - 22 + 12) - 1, zip.length - 22 + 12);
    expect(() => readZip(zip)).toThrow(/zip_directory_invalid/);
  });
  it.each(["local", "central", "both"])("refuses Unicode-path overrides in %s extra fields", (location) => {
    for (const effectiveName of ["../unicode-escape", "ORCA.exe", "safe/name"]) {
      const extra = unicodePathExtra("safe/name", effectiveName);
      const entry = { name: "safe/name", body: "x" };
      if (location !== "central") entry.localExtra = extra;
      if (location !== "local") entry.centralExtra = extra;
      expect(() => readZip(makeZip([entry]))).toThrow(/zip_extra_unsupported/);
    }
  });
  it.each(["localExtra", "centralExtra"])("refuses malformed or unknown %s fields", (field) => {
    for (const extra of [
      Buffer.from([0x55]),
      Buffer.from([0x55, 0x54, 5, 0]),
      zipExtra(0x9999, "x"),
      zipExtra(1, ""),
    ]) {
      expect(() => readZip(makeZip([{ name: "safe/name", body: "x", [field]: extra }]))).toThrow(
        /zip_extra_(?:invalid|unsupported)/,
      );
    }
  });
  it("preserves supported timestamp/owner extra fields and ordinary ZIP comments", () => {
    const extra = Buffer.concat([
      zipExtra(0x5455, Buffer.alloc(5)),
      zipExtra(0x000a, Buffer.alloc(32)),
      zipExtra(0x7875, Buffer.from([1, 1, 0, 1, 0])),
    ]);
    const zip = makeZip([{ name: "safe/name", body: "x", localExtra: extra, centralExtra: extra }]);
    zip.writeUInt16LE(7, zip.length - 2);
    expect(readZip(Buffer.concat([zip, Buffer.from("comment")]))[0].body.toString()).toBe("x");
  });
  it.each(["../evilxx", "different-length/name", "SAFE/name"])(
    "refuses a local filename %j that differs from the central filename",
    (localName) => {
      expect(() => readZip(makeZip([{ name: "safe/name", localName, body: "x" }]))).toThrow(
        /zip_local_header_mismatch/,
      );
    },
  );
  it.each([
    [6, 1],
    [8, 0],
  ])("refuses a local flag/method mismatch at offset %s", (offset, value) => {
    const zip = makeZip([{ name: "safe/name", body: "x" }]);
    zip.writeUInt16LE(value, offset);
    expect(() => readZip(zip)).toThrow(/zip_local_header_mismatch/);
  });
  it("inflates and CRC-checks members", () => {
    const entries = readZip(makeZip([{ name: "a/b.txt", body: "hello" }, { name: "dir/" }]));
    expect(entries.map((e) => [e.name, e.kind, e.body.toString()])).toEqual([
      ["a/b.txt", "file", "hello"],
      ["dir/", "directory", ""],
    ]);
  });
  it("refuses a CRC mismatch, a missing directory and Zip64 markers", () => {
    expect(() => readZip(makeZip([{ name: "a", body: "x" }], { corruptCrc: "a" }))).toThrow(/zip_crc_mismatch/);
    expect(() => readZip(Buffer.alloc(100))).toThrow(/zip_directory_missing/);
    const zip = makeZip([{ name: "a", body: "x" }]);
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
    expect(() => readZip(zip)).toThrow(/zip64_unsupported/);
  });
});

describe("asar", () => {
  it("interprets nested ASAR links relative to the archive root", () => {
    expect(() => readAsar(makeAsar({ "extra/link": { link: "../outside" } }))).toThrow(/asar_link_escapes/);
    const asar = readAsar(makeAsar({ "root.js": "root", "extra/link": { link: "root.js" } }));
    expect(asar.files.get("extra/link").link).toBe("root.js");
  });
  it("reads bodies by path and verifies recorded integrity", () => {
    const asar = readAsar(makeAsar({ "package.json": "{}", "dist/a.js": "a", "dist/link": { link: "dist/a.js" } }));
    expect(asar.read("dist/a.js").toString()).toBe("a");
    expect(asar.files.get("dist").kind).toBe("directory");
    expect(asar.files.get("dist/link")).toEqual({ kind: "symlink", link: "dist/a.js" });
    expect(checkAsarIntegrity(asar)).toBe(2);
  });
  it("refuses tampered bodies, escaping links and invalid headers", () => {
    expect(() => checkAsarIntegrity(readAsar(makeAsar({ "a.js": "abc" }, { tamper: true })))).toThrow(
      /asar_integrity_mismatch/,
    );
    expect(() => readAsar(makeAsar({ "a/link": { link: "../../outside" } }))).toThrow(/asar_link_escapes/);
    expect(() => readAsar(Buffer.alloc(32))).toThrow(/asar_header_invalid/);
  });
});

describe("executables", () => {
  it("reports PE machine, DLL flag and the certificate table without verifying it", () => {
    expect(readPe(makePe("x64"))).toMatchObject({ machine: "x64", dll: false, certificate: { present: false } });
    expect(readPe(makePe("arm64", { dll: true }))).toMatchObject({ machine: "arm64", dll: true });
    expect(readPe(makePe("x86", { certificate: true })).certificate).toMatchObject({ present: true, size: 64 });
    expect(() => readPe(Buffer.from("MZ not really"))).toThrow(/pe_invalid/);
  });
  it("refuses a certificate table that points past the file", () => {
    const pe = makePe("x86", { certificate: true });
    pe.writeUInt32LE(pe.length, 0x40 + 24 + 112 + 32);
    expect(() => readPe(pe)).toThrow(/pe_certificate_table_invalid/);
  });
  it("reads ELF machine", () => {
    expect(readElf(makeElf("x64")).machine).toBe("x64");
    expect(readElf(makeElf("arm64")).machine).toBe("arm64");
    expect(() => readElf(makePe("x64"))).toThrow(/elf_invalid/);
  });
});

describe("update metadata and blockmap", () => {
  it.each(["[unterminated", "{bad", "'unterminated", '"unterminated', "&anchor timestamp"])(
    "refuses malformed/unsupported releaseDate scalar %j",
    (value) => {
      const metadata = updateMetadata("1.2.3", "x64", Buffer.from("x")).replace(
        /^releaseDate:.*$/m,
        `releaseDate: ${value}`,
      );
      expect(() => readUpdateMetadata(metadata)).toThrow(/update_metadata_invalid/);
    },
  );
  it.each(["blockMapSize: [unterminated", "blockMapSize: !!int 3", "blockMapSize: NaN", "unknown: [unterminated"])(
    "refuses unsupported files-entry scalar %j",
    (field) => {
      const metadata = updateMetadata("1.2.3", "x64", Buffer.from("x")).replace(/^path:/m, `    ${field}\npath:`);
      expect(() => readUpdateMetadata(metadata)).toThrow(/update_metadata_invalid/);
    },
  );
  it("accepts optional numeric blockMapSize and simple quoted scalar values", () => {
    const text = updateMetadata("1.2.3", "x64", Buffer.from("x")).replace(
      "    size: 1",
      '    size: "1"\n    blockMapSize: 42',
    );
    expect(readUpdateMetadata(text).files[0]).toMatchObject({ size: 1 });
  });
  it.each(["files:\n", "files: []\n", '"files": []\n', "releaseDate: again\n", '"version": 1.2.3\n'])(
    "refuses duplicate or alternate YAML mapping keys: %j",
    (suffix) => {
      const metadata = updateMetadata("1.2.3", "x64", Buffer.from("x"));
      expect(() => readUpdateMetadata(metadata + suffix)).toThrow(/update_metadata_invalid/);
    },
  );
  it("parses the flat electron-builder 26 shape", () => {
    const installer = Buffer.from("installer bytes");
    expect(readUpdateMetadata(updateMetadata("1.2.3", "x64", installer))).toMatchObject({
      version: "1.2.3",
      path: "ORCA-1.2.3-win-x64.exe",
      files: [{ url: "ORCA-1.2.3-win-x64.exe", size: installer.length }],
    });
  });
  it("refuses duplicated keys, CRLF and malformed entries", () => {
    const text = updateMetadata("1.2.3", "x64", Buffer.from("x"));
    expect(() => readUpdateMetadata(text + "version: 9.9.9\n")).toThrow(/version must appear once/);
    expect(() => readUpdateMetadata(text.replaceAll("\n", "\r\n"))).toThrow(/update_metadata_invalid/);
    expect(() => readUpdateMetadata(text.replace(/ {4}size: \d+\n/, ""))).toThrow(/files\[\] entry/);
    expect(() => readUpdateMetadata(text.replace("    size:", "    sha512: again\n    size:"))).toThrow(
      /duplicate sha512/,
    );
  });
  it("sums blockmap chunks and refuses other shapes", () => {
    expect(readBlockmap(blockmap(200))).toMatchObject({ chunks: 4, coveredBytes: 200 });
    expect(() => readBlockmap(gzipSync("{}"))).toThrow(/blockmap_invalid/);
    expect(() => readBlockmap(Buffer.from("x"))).toThrow(/blockmap_invalid/);
  });
});
