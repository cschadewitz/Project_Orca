/** Bounded readers on benign in-memory fixtures (#772). No artifact is extracted or run. */
import { createHash } from "node:crypto";
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
  asarIntegrity,
  blockmap,
  gnuLongBlock,
  makeAsar,
  makeElf,
  makePe,
  makeTarGz,
  makeZip,
  paxBlock,
  paxRecord,
  tarBlock,
  tarGz,
  tarHeader,
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

// The tar/PAX contract (docs/preparation/windows-linux-release-artifacts/README.md):
// each supported form is read, everything outside it is refused with a named code.
describe("tar.gz contract", () => {
  const read = (blocks, options) => readTarGz(tarGz(blocks, options));
  const names = (blocks) => read(blocks).map((m) => [m.name, m.kind, m.linkName]);
  const longDir = `top/${"d".repeat(150)}/${"e".repeat(150)}`;

  describe("supported", () => {
    it("reads POSIX ustar files, directories, symlinks, hardlinks and the old NUL file type", () => {
      const nulType = tarHeader("top/old", { type: "\0" });
      expect(
        names([
          tarBlock("top/", "", { type: "5" }),
          tarBlock("top/a", "x"),
          tarBlock("top/s", "", { type: "2", linkName: "a" }),
          tarBlock("top/h", "", { type: "1", linkName: "top/a" }),
          nulType,
        ]),
      ).toEqual([
        ["top/", "directory", undefined],
        ["top/a", "file", undefined],
        ["top/s", "symlink", "a"],
        ["top/h", "hardlink", "top/a"],
        ["top/old", "file", undefined],
      ]);
    });
    it("joins the POSIX ustar prefix to the name (paths up to 255 bytes)", () => {
      const prefix = `top/${"p".repeat(140)}`;
      expect(names([tarBlock("file.txt", "x", { prefix })])).toEqual([[`${prefix}/file.txt`, "file", undefined]]);
    });
    it("reads a long PAX path and linkpath on POSIX members", () => {
      const target = `${"t".repeat(200)}/payload`;
      expect(
        names([
          paxBlock([["path", `${longDir}/file`]]),
          tarBlock("ignored-stored-name", "x"),
          paxBlock([
            ["path", `${longDir}/link`],
            ["linkpath", target],
          ]),
          tarBlock("ignored-link", "", { type: "2", linkName: "ignored-target" }),
        ]),
      ).toEqual([
        [`${longDir}/file`, "file", undefined],
        [`${longDir}/link`, "symlink", target],
      ]);
    });
    it("reads multibyte UTF-8 PAX paths with byte-counted record lengths", () => {
      const path = `top/${"é".repeat(80)}/file`;
      expect(names([paxBlock([["path", path]]), tarBlock("x", "y")])).toEqual([[path, "file", undefined]]);
    });
    it("reads GNU L/K long names on GNU members and ignores the GNU header's prefix bytes", () => {
      const target = `${"t".repeat(200)}/payload`;
      // In a GNU header, bytes 345.. are atime/ctime; they must never become a path prefix.
      const atime = "14000000000";
      expect(
        names([
          gnuLongBlock("L", `${longDir}/file`),
          tarBlock("stored", "x", { format: "gnu" }),
          gnuLongBlock("L", `${longDir}/link`),
          gnuLongBlock("K", target),
          tarBlock("stored-link", "", { type: "2", linkName: "x", format: "gnu" }),
          tarBlock("short", "x", { format: "gnu", prefix: atime }),
        ]),
      ).toEqual([
        [`${longDir}/file`, "file", undefined],
        [`${longDir}/link`, "symlink", target],
        ["short", "file", undefined],
      ]);
    });
    it("accepts zero padding after the end-of-archive marker, as tar record blocking writes it", () => {
      expect(names([tarBlock("a", "x")], { end: Buffer.alloc(10240) })).toEqual([["a", "file", undefined]]);
    });
  });

  describe("refused", () => {
    const refuses = (blocks, code, options) => expect(() => read(blocks, options)).toThrow(code);
    it.each([
      ["size", "0"],
      ["size", "99999"],
      ["GNU.sparse.map", "0,512"],
      ["GNU.sparse.major", "1"],
      ["GNU.sparse.name", "top/real"],
      ["GNU.sparse.realsize", "4096"],
      ["mtime", "1700000000.5"],
      ["atime", "1700000000"],
      ["uid", "0"],
      ["hdrcharset", "BINARY"],
      ["SCHILY.xattr.user.x", "y"],
      ["LIBARCHIVE.creationtime", "1"],
    ])("refuses per-member PAX key %s outside the allowlist", (key, value) => {
      refuses([paxBlock([[key, value]]), tarBlock("a", "x")], /tar_pax_key_unsupported/);
      refuses(
        [
          paxBlock([
            ["path", "top/a"],
            [key, value],
          ]),
          tarBlock("a", "x"),
        ],
        /tar_pax_key_unsupported/,
      );
    });
    it.each([
      ["no trailing newline", "12 path=abcd", "record framing"],
      ["length too short", "10 path=abcd\n", "record framing"],
      ["length too long", "14 path=abcd\n", "record framing"],
      ["leading zero", "013 path=abcd\n", "record length"],
      ["signed length", "+13 path=abcd\n", "record length"],
      ["missing space", "13path=abcd\n", "record length"],
      ["no key", paxRecord("=abcd"), "record key"],
      ["no equals", paxRecord("pathabcd"), "record key"],
      ["empty value", paxRecord("path="), "empty path"],
      ["trailing junk", `${paxRecord("path=top/a")}junk`, "record length"],
      [
        "invalid UTF-8",
        Buffer.concat([Buffer.from("11 path="), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]).toString("latin1"),
        "record encoding",
      ],
      ["embedded NUL", paxRecord("path=a\0b"), "record encoding"],
      ["embedded newline", paxRecord("path=a\nb"), "record encoding"],
      ["duplicate key", paxRecord("path=top/a") + paxRecord("path=top/b"), "duplicate path"],
      ["empty header", "", "empty extended header"],
    ])("refuses PAX record framing: %s", (_, body, detail) => {
      const block = tarBlock("PaxHeader", Buffer.from(body, "latin1"), { type: "x" });
      refuses([block, tarBlock("a", "x")], new RegExp(`tar_pax_invalid: ${detail}`));
    });
    it("refuses global PAX headers, even benign ones", () => {
      refuses([tarBlock("g", paxRecord("comment=x"), { type: "g" }), tarBlock("a", "x")], /tar_global_pax_unsupported/);
    });
    it.each([
      ["x", () => [paxBlock([["path", "a"]]), paxBlock([["path", "b"]])]],
      ["L", () => [gnuLongBlock("L", "a"), gnuLongBlock("L", "b")]],
      ["K", () => [gnuLongBlock("K", "a"), gnuLongBlock("K", "b")]],
    ])("refuses a repeated %s header before one member", (_, blocks) => {
      const format = _ === "x" ? "posix" : "gnu";
      refuses([...blocks(), tarBlock("m", "", { type: "2", linkName: "t", format })], /tar_extended_header_repeated/);
    });
    it.each([
      ["x", () => paxBlock([["path", "a"]])],
      ["L", () => gnuLongBlock("L", "a")],
      ["K", () => gnuLongBlock("K", "a")],
    ])("refuses a dangling %s header at the end of the archive", (_, block) => {
      refuses(
        [tarBlock("first", "x", { format: _ === "x" ? "posix" : "gnu" }), block()],
        /tar_extended_header_dangling/,
      );
    });
    it("refuses mixing GNU long names with PAX headers or POSIX members (no precedence rule)", () => {
      refuses(
        [gnuLongBlock("L", "gnu/name"), paxBlock([["path", "pax/name"]]), tarBlock("a", "x")],
        /tar_extended_header_mixed/,
      );
      refuses(
        [paxBlock([["path", "pax/name"]]), gnuLongBlock("L", "gnu/name"), tarBlock("a", "x", { format: "gnu" })],
        /tar_extended_header_mixed/,
      );
      refuses([gnuLongBlock("L", "gnu/name"), tarBlock("a", "x")], /tar_extended_header_mixed/);
      refuses([paxBlock([["path", "pax/name"]]), tarBlock("a", "x", { format: "gnu" })], /tar_extended_header_mixed/);
      const gnuMagicPax = tarBlock("PaxHeader", paxRecord("path=a"), { type: "x", format: "gnu" });
      refuses([gnuMagicPax, tarBlock("a", "x", { format: "gnu" })], /tar_extended_header_mixed/);
    });
    it("refuses link targets supplied for non-link members", () => {
      refuses([paxBlock([["linkpath", "elsewhere"]]), tarBlock("a", "x")], /tar_extended_header_invalid/);
      refuses(
        [gnuLongBlock("K", "elsewhere"), tarBlock("a", "", { type: "5", format: "gnu" })],
        /tar_extended_header_invalid/,
      );
    });
    it.each([
      ["missing NUL", "name"],
      ["embedded NUL", "na\0me\0"],
      ["empty", "\0"],
    ])("refuses a malformed GNU long name: %s", (_, body) => {
      refuses(
        [tarBlock("././@LongLink", body, { type: "L", format: "gnu" }), tarBlock("a", "x", { format: "gnu" })],
        /tar_gnu_long_invalid/,
      );
    });
    it.each([
      ["S", "GNU sparse"],
      ["7", "contiguous"],
      ["3", "character device"],
      ["4", "block device"],
      ["6", "FIFO"],
      ["D", "GNU dumpdir"],
      ["M", "GNU multivolume"],
      ["V", "GNU volume label"],
    ])("refuses member type %s (%s)", (type) => {
      refuses([tarBlock("a", "", { type })], /tar_member_unsupported/);
    });
    it("refuses V7 and unknown header magic", () => {
      refuses([tarBlock("a", "x", { format: "v7" })], /tar_header_unsupported/);
      const odd = tarHeader("a");
      odd.write("ustar\x0001", 257, "latin1");
      let sum = 0;
      odd.fill(0x20, 148, 156);
      for (const byte of odd) sum += byte;
      odd.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
      refuses([odd], /tar_header_unsupported/);
    });
    it("refuses bodies on directory and link members", () => {
      refuses([tarBlock("d/", "x", { type: "5" })], /tar_header_invalid/);
      refuses([tarBlock("s", "x", { type: "2", linkName: "t" })], /tar_header_invalid/);
    });
    it("refuses a missing, short or followed end-of-archive marker", () => {
      refuses([tarBlock("a", "x")], /tar_end_invalid/, { end: Buffer.alloc(0) });
      refuses([tarBlock("a", "x")], /tar_end_invalid/, { end: Buffer.alloc(512) });
      refuses([tarBlock("a", "x")], /tar_end_invalid/, {
        end: Buffer.concat([Buffer.alloc(1024), tarBlock("hidden", "x")]),
      });
      refuses([tarBlock("a", "x")], /tar_end_invalid/, { end: Buffer.concat([Buffer.alloc(1024), Buffer.from([1])]) });
      refuses([tarBlock("a", "x")], /tar_end_invalid/, { end: Buffer.alloc(1100) });
      refuses([tarBlock("a", "x")], /tar_end_invalid/, {
        end: Buffer.concat([Buffer.alloc(512), tarBlock("hidden", "x"), Buffer.alloc(1024)]),
      });
    });
    it("refuses a non-octal (GNU base-256) size field", () => {
      const header = tarHeader("a");
      header[124] = 0x80;
      let sum = 0;
      header.fill(0x20, 148, 156);
      for (const byte of header) sum += byte;
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
      refuses([header], /tar_header_invalid/);
    });
    it.each([
      [
        "a traversing ustar name under PAX path",
        () => [paxBlock([["path", "top/ok"]]), tarBlock("../../../tmp/evil", "x")],
      ],
      [
        "a traversing ustar prefix under PAX path",
        () => [paxBlock([["path", "top/ok"]]), tarBlock("evil", "x", { prefix: "/tmp" })],
      ],
      [
        "a traversing ustar name under GNU L",
        () => [gnuLongBlock("L", "top/ok"), tarBlock("../../../tmp/evil", "x", { format: "gnu" })],
      ],
      [
        "an absolute ustar linkname under PAX linkpath",
        () => [paxBlock([["linkpath", "ok"]]), tarBlock("top/s", "", { type: "2", linkName: "/etc/passwd" })],
      ],
      [
        "a traversing hardlink linkname under PAX linkpath",
        () => [
          tarBlock("top/a", "x"),
          paxBlock([["linkpath", "top/a"]]),
          tarBlock("top/h", "", { type: "1", linkName: "../../etc/shadow" }),
        ],
      ],
      [
        "a traversing ustar linkname under GNU K",
        () => [
          gnuLongBlock("K", "ok"),
          tarBlock("top/s", "", { type: "2", linkName: "../../../etc/passwd", format: "gnu" }),
        ],
      ],
    ])("refuses %s (the shadowed field is checked too)", (_, blocks) => {
      refuses(blocks(), /tar_shadowed_field_unsafe/);
    });
    it("accepts a safe truncated copy in the shadowed ustar fields", () => {
      expect(
        names([
          paxBlock([["path", `${longDir}/file`]]),
          tarBlock(`${longDir}/file`.slice(0, 99), "x"),
          gnuLongBlock("L", `${longDir}/link`),
          gnuLongBlock("K", `${"t".repeat(200)}/payload`),
          tarBlock(`${longDir}/link`.slice(0, 99), "", { type: "2", linkName: "t".repeat(99), format: "gnu" }),
        ]).map(([name, kind]) => [name, kind]),
      ).toEqual([
        [`${longDir}/file`, "file"],
        [`${longDir}/link`, "symlink"],
      ]);
    });
    it.each([
      ["file", "0"],
      ["directory", "5"],
    ])("refuses a ustar linkname on a %s", (_, type) => {
      refuses([tarBlock("top/a", "", { type, linkName: "../../etc/passwd" })], /tar_header_invalid: link target on a/);
    });
    it.each([
      [
        "a missing member",
        () => [tarBlock("top/a", "x"), tarBlock("top/h", "", { type: "1", linkName: "top/missing" })],
      ],
      [
        "a directory",
        () => [tarBlock("top/", "", { type: "5" }), tarBlock("top/h", "", { type: "1", linkName: "top" })],
      ],
      [
        "a directory spelled with its slash",
        () => [tarBlock("top/", "", { type: "5" }), tarBlock("top/h", "", { type: "1", linkName: "top/" })],
      ],
      ["itself", () => [tarBlock("top/h", "", { type: "1", linkName: "top/h" })]],
      ["a later member", () => [tarBlock("top/h", "", { type: "1", linkName: "top/a" }), tarBlock("top/a", "x")]],
      [
        "a symlink",
        () => [
          tarBlock("top/a", "x"),
          tarBlock("top/s", "", { type: "2", linkName: "a" }),
          tarBlock("top/h", "", { type: "1", linkName: "top/s" }),
        ],
      ],
    ])("refuses a hardlink to %s", (_, blocks) => {
      refuses(blocks(), /tar_hardlink_invalid/);
    });
    it.each([
      ["a regular file", () => tarBlock("top/orca/", "ELFBODY")],
      ["an old NUL-type file", () => tarHeader("top/orca/", { type: "\0" })],
      ["a symlink", () => tarBlock("top/s/", "", { type: "2", linkName: "a" })],
      ["a PAX-named file", () => Buffer.concat([paxBlock([["path", "top/orca/"]]), tarBlock("top/orca", "x")])],
    ])("refuses %s whose name ends in /", (_, block) => {
      refuses([block()], /tar_header_invalid: \w+ name ends in \//);
    });
    it.each([
      ["name", 0],
      ["prefix", 345],
      ["linkname", 157],
    ])("refuses invalid UTF-8 in the ustar %s field", (_, at) => {
      const header = tarHeader("top/a", { type: at === 157 ? "2" : "0", linkName: at === 157 ? "b" : "" });
      header.fill(0, at, at + 8);
      header.write("top/", at, "ascii");
      header.set([0xff, 0xfe], at + 4);
      let sum = 0;
      header.fill(0x20, 148, 156);
      for (const byte of header) sum += byte;
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
      refuses([header], /tar_header_invalid: name field is not UTF-8/);
    });
  });

  describe("gzip framing", () => {
    const tar = Buffer.concat([tarBlock("top/a", "x"), tarBlock("top/b", "y"), Buffer.alloc(1024)]);
    it("reads a tar split over concatenated gzip members, as gzip -d does", () => {
      const split = Buffer.concat([gzipSync(tar.subarray(0, 1024)), gzipSync(tar.subarray(1024))]);
      expect(readTarGz(split).map((m) => m.name)).toEqual(["top/a", "top/b"]);
    });
    it("refuses non-gzip bytes after the gzip stream", () => {
      expect(() => readTarGz(Buffer.concat([gzipSync(tar), Buffer.from("trailing junk")]))).toThrow(/tar_gzip_invalid/);
    });
  });
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
  it.each([
    ["true", true],
    ["false", false],
    ['the string "no"', "no"],
    ["the number 1", 1],
    ["null", null],
  ])("refuses any unpacked entry (unpacked: %s), keeping offset and integrity or not", (_, value) => {
    expect(() => readAsar(makeAsar({ "a.js": { unpacked: value, size: 4 } }))).toThrow(
      /asar_unpacked_unsupported: a.js/,
    );
    const packedButFlagged = makeAsar(
      { "a.js": "body", "b.js": "body" },
      {
        edit: (tree) => {
          tree.files["a.js"].unpacked = value;
          delete tree.files["b.js"].integrity;
          tree.files["b.js"].unpacked = value;
        },
      },
    );
    expect(() => readAsar(packedButFlagged)).toThrow(/asar_unpacked_unsupported: a.js/);
    const flaggedDirectory = makeAsar({ "dir/a.js": "x" }, { edit: (tree) => (tree.files.dir.unpacked = value) });
    expect(() => readAsar(flaggedDirectory)).toThrow(/asar_unpacked_unsupported: dir/);
  });
  it.each(["0x0", " 0 ", "0e0", "-0", "+0", "00", "0.0", "", 0])("refuses non-decimal offset %j", (offset) => {
    const asar = makeAsar({ "a.js": "abc" }, { edit: (tree) => (tree.files["a.js"].offset = offset) });
    expect(() => readAsar(asar)).toThrow(/asar_offset_invalid/);
  });
  describe("integrity block layout (@electron/asar 3.4.1 getFileIntegrity)", () => {
    const MiB4 = 4 * 1024 * 1024;
    it.each([
      [0, 1],
      [1, 1],
      [MiB4 - 1, 1],
      [MiB4, 2],
      [MiB4 + 1, 2],
      [2 * MiB4, 3],
    ])("accepts a %i-byte file with %i block hashes, the last empty at exact multiples", (size, count) => {
      const body = Buffer.alloc(size, 0x61);
      const asar = readAsar(makeAsar({ "big.bin": body }));
      expect(asar.files.get("big.bin").integrity.blocks).toHaveLength(count);
      expect(checkAsarIntegrity(asar)).toBe(1);
    });
    it.each([
      ["ceil(len / blockSize) blocks at an exact multiple", MiB4, 1],
      ["an extra block after a partial one", MiB4 + 1, 3],
      ["no blocks for an empty file", 0, 0],
    ])("refuses %s", (_, size, count) => {
      const body = Buffer.alloc(size, 0x61);
      const blocks = Array.from({ length: count }, (_, i) =>
        createHash("sha256")
          .update(body.subarray(i * MiB4, (i + 1) * MiB4))
          .digest("hex"),
      );
      const integrity = { "big.bin": { ...asarIntegrity(body), blocks } };
      expect(() => checkAsarIntegrity(readAsar(makeAsar({ "big.bin": body }, { integrity })))).toThrow(
        /asar_integrity_mismatch: big.bin/,
      );
    });
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
    for (const entry of [null, 0, "x", true, []])
      expect(() => readBlockmap(gzipSync(JSON.stringify({ version: "2", files: [entry] })))).toThrow(
        /blockmap_invalid/,
      );
  });
});
