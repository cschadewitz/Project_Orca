/**
 * Offline, static inspection of Windows/Linux release artifacts against an explicit
 * candidate manifest (#772). Plan and procedures: docs/preparation/windows-linux-release-artifacts/.
 *
 *   node tools/package-validation/inspect.js --candidate <manifest.json> --source <checkout> \
 *     --artifact <file> [--artifact <file> ...] [--allow-partial] [--out <report.json>]
 *
 * It reads bytes and a git checkout. It does not extract archives to their destination,
 * execute, install, launch, sign, verify signatures, publish or touch the network. A
 * "consistent" result means only that the supplied bytes agree with the manifest, with each
 * other and with the source checkout; it is not candidate acceptance and not a native run.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkNativePE, verifyNativePackage } from "../../packages/app/scripts/diagnostics-native-package.js";
import {
  ValidationError,
  checkAsarIntegrity,
  containedLink,
  containedPath,
  fail,
  readAsar,
  readBlockmap,
  readElf,
  readPe,
  readTarGz,
  readUpdateMetadata,
  readZip,
  sha256,
  sha512Base64,
} from "./formats.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** What this inspection cannot establish, whatever it finds. Copied into every report. */
export const NOT_ESTABLISHED = Object.freeze([
  "Build provenance: no commit is embedded in the artifacts. Commit identity rests on the retained workflow run (head SHA, run id) and these hashes; consistency with the source checkout is supporting evidence only.",
  "Authenticode validity, publisher identity or SmartScreen trust. An embedded certificate table is reported as present and unverified; absence means unsigned.",
  "Launch, rendering, font use, CSP enforcement, logs, shutdown, install, uninstall, update, failure recovery and rollback. These need the native runtime procedures.",
  "AppImage contents (squashfs). Inspect the same-architecture tar.gz and run the AppImage in a disposable environment.",
  "Full production dependency closure and blockmap chunk checksums (BLAKE2b-144).",
  "macOS artifacts, which are out of scope here.",
]);

// The Electron runtime files every packaged tree needs beside the executable. Checked by
// presence only; their versions come from the pinned electron package.
const ELECTRON_RUNTIME = {
  linux: [
    "resources.pak",
    "icudtl.dat",
    "v8_context_snapshot.bin",
    "libffmpeg.so",
    "chrome-sandbox",
    "locales/en-US.pak",
  ],
  win: ["resources.pak", "icudtl.dat", "v8_context_snapshot.bin", "ffmpeg.dll", "locales/en-US.pak"],
};
const WINDOWS_ADDONS = [
  "diagnostics_clock.node",
  "diagnostics_storage.node",
  "first_run_windows.node",
  "manifest.json",
];
const ASAR_REQUIRED = [
  "package.json",
  "dist/main/index.js",
  "dist/preload/index.cjs",
  "dist/bridge.js",
  "dist/renderer/index.html",
];
// Mirrors the exclusions in packages/app/electron-builder.yml `files`, plus development
// packages that must never be production dependencies and native addons, which live outside.
const ASAR_FORBIDDEN = [
  [/\.map$/, "source map"],
  [/\.d\.ts$/, "declaration"],
  [/\.tsbuildinfo$/, "tsc build state"],
  [/^dist\/(?:daemon|release|diagnostics-native)(?:\/|$)/, "excluded build output"],
  [/\.node$/, "native addon inside asar"],
  [
    /(?:^|\/)node_modules\/(?:vite|vitest|happy-dom|electron|electron-builder|app-builder-lib|typescript|esbuild|@vitejs|@testing-library)\//,
    "development package",
  ],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The candidate manifest: commit, version and the SHA-256 of every artifact, nothing else. */
export function readCandidate(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) fail("candidate_manifest_invalid", "not a small regular file");
  const bytes = readFileSync(path);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("candidate_manifest_invalid", "not JSON");
  }
  const keys = Object.keys(manifest ?? {})
    .sort()
    .join(",");
  if (keys !== "artifacts,commit,format,version" || manifest.format !== 1) fail("candidate_manifest_invalid", "fields");
  if (!COMMIT.test(manifest.commit)) fail("candidate_manifest_invalid", "commit must be a full lowercase SHA-1");
  if (!VERSION.test(manifest.version)) fail("candidate_manifest_invalid", "version");
  const entries = Object.entries(manifest.artifacts ?? {});
  if (!entries.length) fail("candidate_manifest_invalid", "no artifacts");
  for (const [name, digest] of entries)
    if (basename(name) !== name || !HEX64.test(digest))
      fail("candidate_manifest_invalid", `artifact ${JSON.stringify(name)}`);
  return { ...manifest, manifestSha256: sha256(bytes) };
}

/** The checkout the artifacts claim to come from: exactly the manifest commit, unmodified. */
export function readSource(
  root,
  commit,
  git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }),
) {
  let head;
  try {
    head = git(["rev-parse", "HEAD"]).trim();
  } catch {
    fail("source_unavailable", "not a git checkout");
  }
  if (head !== commit) fail("source_commit_mismatch", `${head} is not ${commit}`);
  const dirty = git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "package.json",
    "packages/app",
    "packages/design/fonts",
  ]);
  if (dirty.trim()) fail("source_modified", "uncommitted changes under the compared paths");
  const read = (path) => readFileSync(join(root, path));
  const fonts = readdirSync(join(root, "packages/design/fonts"))
    .filter((name) => name.endsWith(".woff2"))
    .sort()
    .map((name) => ({ name, sha256: sha256(read(`packages/design/fonts/${name}`)) }));
  return {
    root,
    head,
    version: JSON.parse(read("package.json")).version,
    app: JSON.parse(read("packages/app/package.json")),
    csp: contentSecurityPolicy(read("packages/app/renderer/index.html").toString("utf8")),
    fonts,
    appRoot: join(root, "packages/app"),
  };
}

export function contentSecurityPolicy(html) {
  const metas = [...html.matchAll(/<meta\s[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi)];
  if (metas.length !== 1) fail("csp_missing", "exactly one CSP meta required");
  const content = /content="([^"]*)"/i.exec(metas[0][0])?.[1];
  if (!content) fail("csp_missing");
  return content.replace(/\s+/g, " ").trim();
}

/** Name → kind/platform/arch, from the electron-builder artifactName and the release names. */
export function classify(name, version) {
  const v = escape(version);
  const rules = [
    [new RegExp(`^ORCA-${v}-linux-(x64|arm64)\\.tar\\.gz$`), "linux-archive", "linux"],
    [new RegExp(`^ORCA-${v}-linux-(x86_64)\\.AppImage$`), "appimage", "linux"],
    [new RegExp(`^ORCA-${v}-win-(x64|arm64)\\.zip$`), "windows-archive", "win"],
    [new RegExp(`^ORCA-${v}-win-(x64|arm64)\\.exe$`), "windows-installer", "win"],
    [new RegExp(`^ORCA-${v}-win-(x64|arm64)\\.exe\\.blockmap$`), "blockmap", "win"],
    [/^(?:latest|prerelease)-(x64|arm64)\.yml$/, "update-metadata", "win"],
    [new RegExp(`^orca-daemon-${v}\\.mjs$`), "daemon", "any"],
  ];
  for (const [pattern, kind, platform] of rules) {
    const match = pattern.exec(name);
    if (match) return { kind, platform, arch: match[1] === "x86_64" ? "x64" : match[1] };
  }
  if (/\.(?:dmg|pkg)$|-mac-|-darwin-/.test(name)) fail("artifact_out_of_scope", "macOS artifacts are excluded");
  fail("artifact_unrecognized", name);
}

/** The version esbuild substitutes into the CLI (`packages/app/scripts/build-daemon.js`). */
export function daemonVersion(bytes) {
  const text = bytes.toString("utf8");
  const stamps = [...text.matchAll(/\bvar ORCA_VERSION = true \? "([^"\\]+)" :/g)];
  if (stamps.length !== 1) fail("daemon_version_unstamped", `${stamps.length} version stamps`);
  return stamps[0][1];
}

/** A packed ASAR body, or a refusal: an absent or unpacked entry has no bytes to check. */
function packedBody(asar, path, code = "asar_entry_missing") {
  const body = asar.read(path);
  if (!body) fail(code, path);
  return body;
}

/** The packaged `package.json` as a plain object, or a refusal instead of a parser exception. */
function asarPackageJson(asar) {
  let manifest;
  try {
    manifest = JSON.parse(packedBody(asar, "package.json").toString("utf8"));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail("asar_package_invalid", "package.json is not JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    fail("asar_package_invalid", "package.json is not an object");
  return manifest;
}

function inspectAsar(bytes, source, expectedVersion) {
  const asar = readAsar(bytes);
  const names = [...asar.files.keys()];
  const checks = [];
  const check = (name, condition, code, detail) => {
    if (!condition) fail(code, detail);
    checks.push(name);
  };
  const integrity = checkAsarIntegrity(asar);
  checks.push(`asar-integrity:${integrity}-files`);
  for (const path of ASAR_REQUIRED) check(`asar-has:${path}`, asar.read(path)?.length, "asar_entry_missing", path);
  for (const [pattern, why] of ASAR_FORBIDDEN) {
    const leaked = names.filter((name) => pattern.test(name));
    check(`asar-excludes:${why}`, !leaked.length, "asar_forbidden_entry", `${why}: ${leaked.slice(0, 3).join(", ")}`);
  }
  const manifest = asarPackageJson(asar);
  check("asar-package-name", manifest.name === source.app.name, "asar_package_mismatch", "name");
  check("asar-package-main", manifest.main === source.app.main, "asar_package_mismatch", "main");
  check("asar-package-version", manifest.version === expectedVersion, "asar_version_mismatch", manifest.version);
  for (const dependency of Object.keys(source.app.dependencies ?? {}))
    check(
      `asar-dependency:${dependency}`,
      asar.files.get(`node_modules/${dependency}/package.json`)?.kind === "file",
      "asar_dependency_missing",
      dependency,
    );
  const html = packedBody(asar, "dist/renderer/index.html").toString("utf8");
  const csp = contentSecurityPolicy(html);
  check("renderer-csp-matches-source", csp === source.csp, "csp_mismatch", csp);
  check("renderer-csp-no-unsafe", !/'unsafe-(?:inline|eval)'|\*/.test(csp), "csp_weakened", csp);
  check(
    "renderer-no-inline-script",
    [...html.matchAll(/<script\b([^>]*)>/gi)].every((m) => /\bsrc=/.test(m[1])),
    "renderer_inline_script",
  );
  check("renderer-no-remote-reference", !/\b(?:src|href)="(?:https?:)?\/\//i.test(html), "renderer_remote_reference");
  for (const [, reference] of html.matchAll(/\b(?:src|href)="\.\/([^"]+)"/g))
    check(
      `renderer-reference:${reference}`,
      asar.read(`dist/renderer/${reference}`)?.length,
      "renderer_reference_missing",
      reference,
    );
  const packagedFonts = names.filter((name) => name.startsWith("dist/renderer/") && name.endsWith(".woff2"));
  const fontDigests = new Set(packagedFonts.map((name) => sha256(packedBody(asar, name, "renderer_font_unreadable"))));
  for (const font of source.fonts)
    check(`renderer-font:${font.name}`, fontDigests.has(font.sha256), "renderer_font_missing", font.name);
  check(
    "renderer-font-count",
    packagedFonts.length === source.fonts.length,
    "renderer_font_unexpected",
    `${packagedFonts.length}`,
  );
  const main = packedBody(asar, "dist/main/index.js").toString("utf8");
  // Static text only; enforcement is a runtime observation in the plan.
  check(
    "main-window-static-hardening",
    /contextIsolation: true/.test(main) && /sandbox: true/.test(main),
    "main_hardening_missing",
  );
  return {
    checks,
    observations: {
      asarSha256: sha256(bytes),
      asarHeaderSha256: asar.headerSha256,
      asarEntries: names.length,
      unpackedEntries: names.filter((name) => asar.files.get(name).unpacked),
      // `files` excludes `*.d.ts` only; the app's own `.d.cts` and dependencies' typings ship.
      appDeclarationFiles: names.filter((name) => name.startsWith("dist/") && /\.d\.[cm]ts$/.test(name)),
      dependencyDeclarationFiles: names.filter((name) => name.startsWith("node_modules/") && /\.d\.[cm]?ts$/.test(name))
        .length,
      productionPackages: names.filter((name) => /^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(name)).length,
      renderer: { csp, fonts: packagedFonts.length },
    },
  };
}

/**
 * Refuse traversal through stored links or files, including before a `..` component.
 * Check the complete member index so archive order cannot hide an ancestor. Missing
 * directory entries are normal. This deliberately does not follow a link graph.
 */
function checkArchiveAncestors(byName, destination = (name) => name) {
  const check = (parts, member) => {
    const prefix = [];
    for (const part of parts) {
      const ancestor = prefix.join("/");
      const entry = byName.get(destination(ancestor));
      if (entry && entry.kind !== "directory") fail("archive_ancestor_not_directory", `${member}: ${ancestor}`);
      if (part === "..") {
        if (!prefix.length) fail("archive_link_escapes", member);
        prefix.pop();
      } else if (part && part !== ".") prefix.push(part);
    }
  };
  for (const entry of byName.values()) {
    const name = entry.name.replace(/\/$/, "");
    check(entry.name.split("/"), name);
    if (entry.kind === "symlink") check([...name.split("/").slice(0, -1), ...entry.linkName.split("/")], name);
    else if (entry.kind === "hardlink") check(entry.linkName.split("/"), name);
  }
}

/**
 * Supported Windows destinations use printable ASCII with no Win32 trimming,
 * device names, ADS or short-name aliases. Reject uncertain spellings instead of
 * guessing the target filesystem's Unicode/case/8.3 configuration.
 */
function windowsDestination(name) {
  return name.split("/").every((part) => {
    if (part === "." || part === ".." || part === "") return true;
    return (
      !/[^\x20-\x7e]|[<>:"|?*~\\]|[. ]$/.test(part) &&
      !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9]|LPT[0-9])$/i.test(part.split(".")[0].trimEnd())
    );
  });
}

/** One packaged application tree, from either a Linux tar.gz or a Windows zip. */
function inspectTree(entries, { platform, arch }, source, version, scratch) {
  const byName = new Map();
  const destinations = new Map();
  const destination = (name) => (platform === "win" ? name.toLowerCase() : name);
  for (const entry of entries) {
    if (!containedPath(entry.name)) fail("archive_path_escapes", JSON.stringify(entry.name));
    if (entry.linkName !== undefined && entry.kind === "symlink" && !containedLink(entry.name, entry.linkName))
      fail("archive_link_escapes", entry.name);
    if (entry.kind === "hardlink" && !containedPath(entry.linkName)) fail("archive_link_escapes", entry.name);
    if (
      platform === "win" &&
      (!windowsDestination(entry.name) || (entry.linkName !== undefined && !windowsDestination(entry.linkName)))
    )
      fail("archive_windows_path_invalid", entry.name);
    const key = entry.name.replace(/\/$/, "");
    const target = destination(key);
    if (destinations.has(target)) fail("archive_duplicate_entry", key);
    destinations.set(target, entry);
    byName.set(key, entry);
  }
  checkArchiveAncestors(destinations, destination);
  const roots = [...byName.keys()].filter((name) => /^(?:[^/]+\/)?resources\/app\.asar$/.test(name));
  if (roots.length !== 1) fail("archive_layout_unexpected", `${roots.length} app.asar candidates`);
  const prefix = roots[0].slice(0, -"resources/app.asar".length);
  const file = (path) => {
    const entry = byName.get(prefix + path);
    return entry?.kind === "file" ? entry : undefined;
  };
  const checks = [];
  const executable = file(platform === "linux" ? "orca" : "ORCA.exe");
  if (!executable) fail("executable_missing");
  if (platform === "linux") {
    if (readElf(executable.body).machine !== arch) fail("executable_arch_mismatch");
    if (executable.mode !== undefined && !(executable.mode & 0o111)) fail("executable_not_executable");
  } else {
    const pe = readPe(executable.body);
    if (pe.machine !== arch || pe.dll) fail("executable_arch_mismatch", pe.machine);
  }
  checks.push(`executable:${arch}`);
  for (const path of ELECTRON_RUNTIME[platform]) {
    if (!file(path)) fail("electron_runtime_missing", path);
    checks.push(`electron-runtime:${path}`);
  }
  const daemonEntries = [...byName.keys()].filter((name) => name.startsWith(`${prefix}resources/daemon/`));
  const daemon = file("resources/daemon/orca-daemon.mjs");
  if (!daemon || daemonEntries.length !== 1) fail("bundled_daemon_layout", daemonEntries.join(", ") || "absent");
  const stamped = daemonVersion(daemon.body);
  if (stamped !== version) fail("bundled_daemon_version_mismatch", stamped);
  checks.push("bundled-daemon:resources/daemon/orca-daemon.mjs", "bundled-daemon-version");
  const nativeEntries = [...byName.keys()].filter((name) => name.startsWith(`${prefix}resources/native/`));
  let nativeManifest;
  if (platform === "linux") {
    if (nativeEntries.length) fail("native_resources_unexpected", nativeEntries[0]);
    checks.push("native-resources:none-expected-on-linux");
  } else {
    const directory = `resources/native/diagnostics/win32-${arch}/`;
    const expected = WINDOWS_ADDONS.map((name) => prefix + directory + name);
    const actual = nativeEntries.filter((name) => byName.get(name).kind === "file").sort();
    const directories = nativeEntries.filter((name) => byName.get(name).kind === "directory");
    if (
      JSON.stringify(actual) !== JSON.stringify([...expected].sort()) ||
      actual.length + directories.length !== nativeEntries.length ||
      directories.some((d) => !`${prefix}${directory}`.startsWith(`${d}/`))
    )
      fail("native_resources_unexpected", actual.join(", "));
    const staged = mkdtempSync(join(scratch, "native-"));
    for (const name of WINDOWS_ADDONS) {
      const body = file(directory + name).body;
      if (name.endsWith(".node"))
        try {
          checkNativePE(body, arch);
        } catch {
          fail("native_addon_invalid", `${name} is not a ${arch} PE32+ DLL`);
        }
      writeFileSync(join(staged, name), body, { flag: "wx" });
    }
    // The packaging hook's own closed-manifest check, against the source at the candidate.
    try {
      nativeManifest = verifyNativePackage(staged, arch, source.appRoot, "win32");
    } catch {
      fail("native_manifest_mismatch", directory);
    }
    checks.push(`native-diagnostics:${directory}`);
  }
  const asar = inspectAsar(file("resources/app.asar").body, source, version);
  const updateConfig = file("resources/app-update.yml")?.body.toString("utf8");
  return {
    checks: [...checks, ...asar.checks],
    observations: {
      root: prefix || "(archive root)",
      entries: byName.size,
      daemonSha256: sha256(daemon.body),
      ...asar.observations,
      nativeDiagnostics: nativeManifest && { sourceSha256: nativeManifest.sourceSha256, stage: nativeManifest.stage },
      appUpdateConfig:
        updateConfig === undefined
          ? "absent"
          : {
              publisherName: /^publisherName:/m.test(updateConfig) ? "present" : "absent",
              url: /^url: (.+)$/m.exec(updateConfig)?.[1] ?? null,
            },
      linuxSandboxHelperMode: platform === "linux" ? (file("chrome-sandbox").mode ?? 0).toString(8) : undefined,
    },
  };
}

function inspectOne(artifact, source, version, scratch) {
  const { kind, platform, arch, bytes } = artifact;
  switch (kind) {
    case "linux-archive":
      return inspectTree(readTarGz(bytes), { platform, arch }, source, version, scratch);
    case "windows-archive":
      return inspectTree(readZip(bytes), { platform, arch }, source, version, scratch);
    case "windows-installer": {
      const pe = readPe(bytes);
      if (pe.dll) fail("installer_invalid", "image is a DLL");
      return {
        checks: ["installer-pe-image"],
        observations: {
          machine: pe.machine,
          sha512: sha512Base64(bytes),
          // Never "signed": validity, chain and publisher need native Windows verification.
          authenticode: pe.certificate.present ? "certificate-table-present-unverified" : "absent-unsigned",
        },
      };
    }
    case "blockmap": {
      const map = readBlockmap(bytes);
      return { checks: ["blockmap-shape"], observations: map };
    }
    case "update-metadata": {
      const metadata = readUpdateMetadata(bytes.toString("utf8"));
      return { checks: ["update-metadata-shape"], observations: metadata };
    }
    case "appimage": {
      if (readElf(bytes).machine !== arch) fail("appimage_arch_mismatch");
      const squashfs = bytes.indexOf("hsqs");
      if (squashfs < 0) fail("appimage_payload_missing");
      return {
        checks: ["appimage-elf-runtime", "appimage-squashfs-magic"],
        observations: { squashfsOffset: squashfs, contents: "not-inspected" },
      };
    }
    case "daemon": {
      const stamped = daemonVersion(bytes);
      if (stamped !== version) fail("daemon_version_mismatch", stamped);
      return { checks: ["daemon-version"], observations: { daemonSha256: sha256(bytes) } };
    }
  }
  fail("artifact_unrecognized", kind);
}

/** Relationships between supplied artifacts. Absent evidence is a refusal, not a skip. */
function crossCheck(results, version) {
  const checks = [];
  const failures = [];
  const byName = new Map(results.map((r) => [r.file, r]));
  const record = (name, ok, detail) =>
    ok ? checks.push(name) : failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  const prerelease = version.includes("-");
  for (const result of results.filter((r) => r.kind === "update-metadata" && r.status === "consistent")) {
    const { observations: m, arch } = result;
    const channel = result.file.startsWith("prerelease-") ? "prerelease" : "latest";
    record(`${result.file}:channel`, (channel === "prerelease") === prerelease, channel);
    record(`${result.file}:version`, m.version === version, m.version);
    const installer = byName.get(m.path);
    record(`${result.file}:path`, m.path === `ORCA-${version}-win-${arch}.exe`, m.path);
    record(`${result.file}:installer-supplied`, installer?.status === "consistent", m.path);
    if (installer?.status !== "consistent") continue;
    record(`${result.file}:sha512`, m.sha512 === installer.observations.sha512);
    record(
      `${result.file}:files`,
      m.files.length === 1 &&
        m.files[0].url === m.path &&
        m.files[0].sha512 === m.sha512 &&
        m.files[0].size === installer.size,
    );
  }
  for (const installer of results.filter((r) => r.kind === "windows-installer" && r.status === "consistent")) {
    const metadataName = `${prerelease ? "prerelease" : "latest"}-${installer.arch}.yml`;
    const metadata = byName.get(metadataName);
    record(
      `${installer.file}:metadata-supplied`,
      metadata?.kind === "update-metadata" &&
        metadata.status === "consistent" &&
        metadata.observations.path === installer.file,
      metadataName,
    );
    const map = byName.get(`${installer.file}.blockmap`);
    record(`${installer.file}:blockmap-supplied`, map?.status === "consistent");
    if (map?.status === "consistent")
      record(`${installer.file}:blockmap-covers-installer`, map.observations.coveredBytes === installer.size);
  }
  for (const map of results.filter((r) => r.kind === "blockmap" && r.status === "consistent")) {
    const installerName = map.file.slice(0, -".blockmap".length);
    const installer = byName.get(installerName);
    record(
      `${map.file}:installer-supplied`,
      installer?.kind === "windows-installer" && installer.status === "consistent",
      installerName,
    );
  }
  // One runner builds one daemon: the Linux job's tarballs and the standalone daemon are a
  // single build, as are the Windows job's two zips. Across runners, report rather than require.
  const daemons = results.filter((r) => r.status === "consistent" && r.observations?.daemonSha256);
  for (const group of [["linux-archive", "daemon"], ["windows-archive"]]) {
    const members = daemons.filter((r) => group.includes(r.kind));
    const digests = new Set(members.map((r) => r.observations.daemonSha256));
    if (members.length > 1) record(`daemon-identical:${group.join("+")}`, digests.size === 1, [...digests].join(" "));
  }
  return {
    checks,
    failures,
    daemonDigests: Object.fromEntries(daemons.map((r) => [r.file, r.observations.daemonSha256])),
  };
}

export function inspect({ candidatePath, sourceRoot, artifactPaths, allowPartial = false, git }) {
  const candidate = readCandidate(candidatePath);
  const source = readSource(sourceRoot, candidate.commit, git);
  if (source.version !== candidate.version) fail("source_version_mismatch", source.version);
  if (!artifactPaths.length) fail("artifacts_absent");
  const seen = new Set();
  const artifacts = artifactPaths.map((path) => {
    const file = basename(path);
    if (seen.has(file)) fail("artifact_duplicate", file);
    seen.add(file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("artifact_not_regular_file", file);
    if (stat.size > MAX_ARTIFACT_BYTES) fail("artifact_too_large", file);
    if (!(file in candidate.artifacts)) fail("artifact_not_in_candidate", file);
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    if (digest !== candidate.artifacts[file]) fail("artifact_hash_mismatch", file);
    return { file, sha256: digest, size: bytes.length, bytes, ...classify(file, candidate.version) };
  });
  const absent = Object.keys(candidate.artifacts)
    .filter((name) => !seen.has(name))
    .sort();
  if (absent.length && !allowPartial) fail("candidate_artifacts_absent", absent.join(", "));
  const scratch = mkdtempSync(join(tmpdir(), "orca-package-validation-"));
  let results;
  try {
    results = artifacts.map(({ bytes, ...artifact }) => {
      try {
        return {
          ...artifact,
          status: "consistent",
          ...inspectOne({ ...artifact, bytes }, source, candidate.version, scratch),
        };
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return { ...artifact, status: "refused", refusal: error.message };
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const cross = crossCheck(results, candidate.version);
  const refused = results.some((r) => r.status === "refused") || cross.failures.length > 0;
  return {
    format: 1,
    tool: "tools/package-validation/inspect.js",
    node: process.version,
    candidate: { commit: candidate.commit, version: candidate.version, manifestSha256: candidate.manifestSha256 },
    source: { head: source.head, version: source.version },
    status: refused ? "refused" : "consistent",
    complete: absent.length === 0,
    absent,
    artifacts: results,
    crossChecks: cross,
    notEstablished: NOT_ESTABLISHED,
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      candidate: { type: "string" },
      source: { type: "string" },
      artifact: { type: "string", multiple: true },
      "allow-partial": { type: "boolean" },
      out: { type: "string" },
    },
  });
  if (!values.candidate || !values.source || !values.artifact?.length) {
    process.stderr.write(
      "usage: inspect.js --candidate <manifest.json> --source <checkout> --artifact <file>... [--allow-partial] [--out <report.json>]\n",
    );
    return 2;
  }
  let report;
  try {
    report = inspect({
      candidatePath: resolve(values.candidate),
      sourceRoot: resolve(values.source),
      artifactPaths: values.artifact.map((path) => resolve(path)),
      allowPartial: !!values["allow-partial"],
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    return 1;
  }
  const text = JSON.stringify(report, null, 2) + "\n";
  // Evidence is never overwritten: an existing report is someone's record.
  if (values.out) writeFileSync(values.out, text, { flag: "wx" });
  else process.stdout.write(text);
  process.stderr.write(`${report.status}${report.complete ? "" : " (partial)"}\n`);
  return report.status === "consistent" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
