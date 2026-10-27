/**
 * The inspector against a synthetic candidate (#772): one consistent set, then each kind of
 * mismatch or absent evidence it must refuse. Fixtures are benign placeholders; nothing is
 * launched, installed, signed or fetched.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOT_ESTABLISHED, classify, daemonVersion, inspect } from "../../package-validation/inspect.js";
import {
  appAsar,
  appImage,
  blockmap,
  daemon,
  linuxArchive,
  makePe,
  makeSource,
  rendererHtml,
  updateMetadata,
  windowsArchive,
  windowsNative,
  writeCandidate,
} from "./fixtures.js";

const VERSION = "9.8.7";
const cleanup = [];
let source;

beforeAll(() => {
  source = makeSource(VERSION);
  cleanup.push(source.root);
});
afterAll(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "orca-package-validation-artifacts-"));
  cleanup.push(dir);
  return dir;
}

function fullSet(overrides = {}) {
  const installer = makePe("x86");
  return {
    [`ORCA-${VERSION}-linux-x64.tar.gz`]: linuxArchive(VERSION, "x64"),
    [`ORCA-${VERSION}-linux-arm64.tar.gz`]: linuxArchive(VERSION, "arm64"),
    [`ORCA-${VERSION}-linux-x86_64.AppImage`]: appImage(),
    [`ORCA-${VERSION}-win-x64.zip`]: windowsArchive(VERSION, "x64", source),
    [`ORCA-${VERSION}-win-x64.exe`]: installer,
    [`ORCA-${VERSION}-win-x64.exe.blockmap`]: blockmap(installer.length),
    "latest-x64.yml": updateMetadata(VERSION, "x64", installer),
    [`orca-daemon-${VERSION}.mjs`]: daemon(VERSION),
    ...overrides,
  };
}

function run(artifacts, options = {}) {
  const dir = scratch();
  const { manifestPath, paths } = writeCandidate(dir, options.commit ?? source.commit, VERSION, artifacts, options);
  return inspect({
    candidatePath: manifestPath,
    sourceRoot: options.sourceRoot ?? source.root,
    artifactPaths: options.only ? paths.filter((p) => options.only.some((n) => p.endsWith(n))) : paths,
    allowPartial: options.allowPartial,
  });
}

const refusal = (report, file) => report.artifacts.find((a) => a.file === file)?.refusal;

describe("a consistent synthetic candidate", () => {
  it("is consistent and complete, and says what it does not establish", () => {
    const report = run(fullSet());
    expect(report.artifacts.filter((a) => a.status !== "consistent")).toEqual([]);
    expect(report.crossChecks.failures).toEqual([]);
    expect(report).toMatchObject({
      status: "consistent",
      complete: true,
      absent: [],
      candidate: { commit: source.commit, version: VERSION },
    });
    expect(report.notEstablished).toBe(NOT_ESTABLISHED);
    const windows = report.artifacts.find((a) => a.kind === "windows-archive");
    expect(windows.checks).toContain("native-diagnostics:resources/native/diagnostics/win32-x64/");
    expect(windows.observations.appUpdateConfig).toEqual({ publisherName: "absent", url: "https://updates.invalid/" });
    const linux = report.artifacts.find((a) => a.file.endsWith("linux-x64.tar.gz"));
    expect(linux.checks).toEqual(
      expect.arrayContaining(["bundled-daemon-version", "renderer-csp-matches-source", "renderer-font-count"]),
    );
    expect(report.crossChecks.checks).toEqual(
      expect.arrayContaining([
        "latest-x64.yml:sha512",
        `ORCA-${VERSION}-win-x64.exe:blockmap-covers-installer`,
        "daemon-identical:linux-archive+daemon",
      ]),
    );
  });

  it("reports an unsigned installer as unsigned and an embedded certificate as unverified, never signed", () => {
    const unsigned = run(fullSet()).artifacts.find((a) => a.kind === "windows-installer");
    expect(unsigned.observations.authenticode).toBe("absent-unsigned");
    const installer = makePe("x86", { certificate: true });
    const report = run(
      fullSet({
        [`ORCA-${VERSION}-win-x64.exe`]: installer,
        [`ORCA-${VERSION}-win-x64.exe.blockmap`]: blockmap(installer.length),
        "latest-x64.yml": updateMetadata(VERSION, "x64", installer),
      }),
    );
    expect(report.status).toBe("consistent");
    expect(report.artifacts.find((a) => a.kind === "windows-installer").observations.authenticode).toBe(
      "certificate-table-present-unverified",
    );
    expect(JSON.stringify(report)).not.toMatch(/"signed"|"trusted"|"accepted"/);
  });
});

describe("identity refusals", () => {
  it("refuses a hash that differs from the candidate manifest", () => {
    const dir = scratch();
    const { manifestPath, paths } = writeCandidate(dir, source.commit, VERSION, fullSet());
    writeFileSync(paths[0], Buffer.concat([readFileSync(paths[0]), Buffer.from([0])]));
    expect(() => inspect({ candidatePath: manifestPath, sourceRoot: source.root, artifactPaths: paths })).toThrow(
      /artifact_hash_mismatch/,
    );
  });

  it("refuses an artifact the manifest does not name", () => {
    const dir = scratch();
    const { manifestPath, paths } = writeCandidate(dir, source.commit, VERSION, {
      [`orca-daemon-${VERSION}.mjs`]: daemon(VERSION),
    });
    const stray = join(dir, "stray.bin");
    writeFileSync(stray, "x");
    expect(() =>
      inspect({ candidatePath: manifestPath, sourceRoot: source.root, artifactPaths: [...paths, stray] }),
    ).toThrow(/artifact_not_in_candidate/);
  });

  it("refuses absent artifacts unless partial inspection is explicit, and then reports it", () => {
    const only = [`orca-daemon-${VERSION}.mjs`];
    expect(() => run(fullSet(), { only })).toThrow(/candidate_artifacts_absent/);
    const partial = run(fullSet(), { only, allowPartial: true });
    expect(partial.complete).toBe(false);
    expect(partial.absent).toHaveLength(7);
  });

  it("refuses a source checkout at another commit, with local changes, or at another version", () => {
    expect(() => run(fullSet(), { commit: "0".repeat(40) })).toThrow(/source_commit_mismatch/);
    const dirty = makeSource(VERSION);
    cleanup.push(dirty.root);
    dirty.write("packages/app/renderer/index.html", rendererHtml("default-src *"));
    expect(() => run(fullSet(), { commit: dirty.commit, sourceRoot: dirty.root })).toThrow(/source_modified/);
    const other = makeSource("9.8.8");
    cleanup.push(other.root);
    expect(() => run(fullSet(), { commit: other.commit, sourceRoot: other.root })).toThrow(/source_version_mismatch/);
  });

  it("refuses malformed manifests and out-of-scope names", () => {
    expect(() => run(fullSet(), { manifestOverride: { commit: "ABC" } })).toThrow(/candidate_manifest_invalid/);
    expect(() => run(fullSet(), { manifestOverride: { extra: true } })).toThrow(/candidate_manifest_invalid/);
    expect(() => classify(`ORCA-${VERSION}-mac-arm64.dmg`, VERSION)).toThrow(/artifact_out_of_scope/);
    expect(() => classify(`ORCA-1.0.0-win-x64.exe`, VERSION)).toThrow(/artifact_unrecognized/);
  });
});

describe("content refusals", () => {
  const linux = `ORCA-${VERSION}-linux-x64.tar.gz`;
  const windows = `ORCA-${VERSION}-win-x64.zip`;
  const cases = [
    ["app version", linux, linuxArchive(VERSION, "x64", { asar: appAsar("0.1.0") }), /asar_version_mismatch/],
    [
      "bundled daemon version",
      linux,
      linuxArchive(VERSION, "x64", { daemonBody: daemon("9.8.6") }),
      /bundled_daemon_version_mismatch/,
    ],
    [
      "weakened CSP",
      linux,
      linuxArchive(VERSION, "x64", {
        asar: appAsar(VERSION, { "dist/renderer/index.html": rendererHtml("default-src 'self' 'unsafe-inline'") }),
      }),
      /csp_mismatch/,
    ],
    [
      "inline script",
      linux,
      linuxArchive(VERSION, "x64", {
        asar: appAsar(VERSION, { "dist/renderer/index.html": rendererHtml(undefined, "    <script>1</script>\n") }),
      }),
      /renderer_inline_script/,
    ],
    [
      "missing font",
      linux,
      linuxArchive(VERSION, "x64", {
        asar: appAsar(VERSION, { "dist/renderer/assets/Synthetic-Bold-h4sh.woff2": undefined }),
      }),
      /renderer_font_missing/,
    ],
    [
      "development package",
      linux,
      linuxArchive(VERSION, "x64", { asar: appAsar(VERSION, { "node_modules/vite/package.json": "{}" }) }),
      /asar_forbidden_entry: development package/,
    ],
    [
      "source map",
      linux,
      linuxArchive(VERSION, "x64", { asar: appAsar(VERSION, { "dist/main/index.js.map": "{}" }) }),
      /asar_forbidden_entry: source map/,
    ],
    [
      "missing preload",
      linux,
      linuxArchive(VERSION, "x64", { asar: appAsar(VERSION, { "dist/preload/index.cjs": undefined }) }),
      /asar_entry_missing/,
    ],
    [
      "path traversal",
      linux,
      linuxArchive(VERSION, "x64", { extra: [{ name: "../escape", body: "x" }] }),
      /archive_path_escapes/,
    ],
    [
      "escaping symlink",
      linux,
      linuxArchive(VERSION, "x64", {
        extra: [{ name: `ORCA-${VERSION}/evil`, kind: "symlink", linkName: "../../etc/passwd" }],
      }),
      /archive_link_escapes/,
    ],
    [
      "native resources on Linux",
      linux,
      linuxArchive(VERSION, "x64", {
        extra: [{ name: `ORCA-${VERSION}/resources/native/diagnostics/x.node`, body: "x" }],
      }),
      /native_resources_unexpected/,
    ],
    [
      "executable architecture",
      `ORCA-${VERSION}-linux-arm64.tar.gz`,
      linuxArchive(VERSION, "x64"),
      /executable_arch_mismatch/,
    ],
  ];
  it.each(cases)("refuses %s", (_label, file, bytes, pattern) => {
    const report = run(fullSet({ [file]: bytes }));
    expect(report.status).toBe("refused");
    expect(refusal(report, file)).toMatch(pattern);
  });

  it("refuses Windows native addons for another architecture and a stale native manifest", () => {
    const wrongArch = run(
      fullSet({
        [windows]: windowsArchive(VERSION, "x64", source, {
          native: windowsNative(source, "x64", { addonArch: "arm64" }),
        }),
      }),
    );
    expect(refusal(wrongArch, windows)).toMatch(/native_addon_invalid/);
    const native = windowsNative(source, "x64");
    native["manifest.json"] = native["manifest.json"].replace(
      /"sourceSha256":"[0-9a-f]+"/,
      `"sourceSha256":"${"0".repeat(64)}"`,
    );
    const stale = run(fullSet({ [windows]: windowsArchive(VERSION, "x64", source, { native }) }));
    expect(refusal(stale, windows)).toMatch(/native_manifest_mismatch/);
  });

  it("refuses extra native resources, a second daemon file and a wrong-architecture Windows executable", () => {
    const extra = run(
      fullSet({
        [windows]: windowsArchive(VERSION, "x64", source, {
          extra: [{ name: "resources/native/mac-validator/tools/x.py", body: "x" }],
        }),
      }),
    );
    expect(refusal(extra, windows)).toMatch(/native_resources_unexpected/);
    const second = run(
      fullSet({
        [windows]: windowsArchive(VERSION, "x64", source, {
          extra: [{ name: "resources/daemon/orca-daemon.mjs.bak", body: "x" }],
        }),
      }),
    );
    expect(refusal(second, windows)).toMatch(/bundled_daemon_layout/);
    const arm = `ORCA-${VERSION}-win-arm64.zip`;
    const wrong = run(fullSet({ [arm]: windowsArchive(VERSION, "x64", source) }));
    expect(refusal(wrong, arm)).toMatch(/executable_arch_mismatch/);
  });

  it("refuses update metadata that does not match the supplied installer, or with no installer", () => {
    const wrong = run(fullSet({ "latest-x64.yml": updateMetadata(VERSION, "x64", makePe("x86"), { sha512: "AAAA" }) }));
    expect(wrong.crossChecks.failures).toContain("latest-x64.yml:sha512");
    const missing = run(fullSet(), { only: ["latest-x64.yml"], allowPartial: true });
    expect(missing.status).toBe("refused");
    expect(missing.crossChecks.failures[0]).toMatch(/installer-supplied/);
  });

  it("refuses a prerelease-channel file for a stable version", () => {
    const set = fullSet();
    set["prerelease-x64.yml"] = set["latest-x64.yml"];
    delete set["latest-x64.yml"];
    expect(run(set).crossChecks.failures).toContain("prerelease-x64.yml:channel: prerelease");
  });

  it("refuses an installer with no blockmap and a blockmap that does not cover it", () => {
    const set = fullSet();
    delete set[`ORCA-${VERSION}-win-x64.exe.blockmap`];
    expect(run(set).crossChecks.failures).toContain(`ORCA-${VERSION}-win-x64.exe:blockmap-supplied`);
    const short = run(fullSet({ [`ORCA-${VERSION}-win-x64.exe.blockmap`]: blockmap(10) }));
    expect(short.crossChecks.failures).toContain(`ORCA-${VERSION}-win-x64.exe:blockmap-covers-installer`);
  });

  it("refuses a standalone daemon that differs from the same runner's bundled daemon", () => {
    const report = run(
      fullSet({ [`orca-daemon-${VERSION}.mjs`]: Buffer.concat([daemon(VERSION), Buffer.from("// other build\n")]) }),
    );
    expect(report.crossChecks.failures[0]).toMatch(/^daemon-identical:linux-archive\+daemon/);
  });
});

describe("daemon version stamp", () => {
  it("reads exactly one esbuild-substituted stamp", () => {
    expect(daemonVersion(daemon("1.2.3"))).toBe("1.2.3");
    expect(() => daemonVersion(Buffer.from("no stamp"))).toThrow(/daemon_version_unstamped/);
    expect(() => daemonVersion(Buffer.concat([daemon("1.2.3"), daemon("1.2.4")]))).toThrow(/2 version stamps/);
  });
});

describe("command line", () => {
  const cli = new URL("../../package-validation/inspect.js", import.meta.url).pathname;
  it("writes a report, exits 0 when consistent, and never overwrites existing evidence", () => {
    const dir = scratch();
    const { manifestPath, paths } = writeCandidate(dir, source.commit, VERSION, {
      [`orca-daemon-${VERSION}.mjs`]: daemon(VERSION),
    });
    const out = join(dir, "report.json");
    const args = [cli, "--candidate", manifestPath, "--source", source.root, "--artifact", paths[0], "--out", out];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(first.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).status).toBe("consistent");
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/EEXIST/);
  });
  it("exits 1 on refusal and 2 without explicit inputs", () => {
    const dir = scratch();
    const { manifestPath, paths } = writeCandidate(dir, source.commit, VERSION, {
      [`orca-daemon-${VERSION}.mjs`]: daemon(VERSION),
    });
    writeFileSync(paths[0], daemon("0.0.1"));
    const refused = spawnSync(
      process.execPath,
      [cli, "--candidate", manifestPath, "--source", source.root, "--artifact", paths[0]],
      {
        encoding: "utf8",
      },
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/artifact_hash_mismatch/);
    expect(spawnSync(process.execPath, [cli, "--artifact", paths[0]], { encoding: "utf8" }).status).toBe(2);
  });
  it("leaves the source checkout untouched", () => {
    run(fullSet());
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: source.root, encoding: "utf8" })).toBe("");
  });
});
