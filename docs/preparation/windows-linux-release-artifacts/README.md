# Windows/Linux release-artifact test plan (preparation)

Preparation for [#772](https://github.com/cschadewitz/Project_Orca/issues/772). Prepared
from main `4d5176c8d57c37f974517900935e6e28ea234082` on 27 October 2026; re-checked
against main `b4f36cabbd26465ad4742dd0581976a95f0f073b` on 9 November 2026.

This plan **does not choose a release version and does not designate any artifact as the
final candidate.** Candidate acceptance is coordinated separately, and the overarching
release checklist belongs to the owner of [RELEASING.md](../../RELEASING.md); this document
supplies the Windows/Linux artifact part of it. macOS and Apple Silicon work is excluded
throughout (see the `ship-group:native-mac-beta` issues).

Owned by this preparation: this document, the helpers in
[`tools/package-validation/`](../../../tools/package-validation/README.md) and their tests in
[`tools/test/package-validation/`](../../../tools/test/package-validation/inspect.test.js). Application and
updater behaviour, release workflows, `docs/RELEASING.md`, lockfiles,
`release-compatibility.json` and the active observer are not changed.

## What earlier work established, and what it left open

| Source | Established | Explicitly not established |
| --- | --- | --- |
| [#714](https://github.com/cschadewitz/Project_Orca/pull/714) electron-updater 6.8.11 | Real installed-library fixtures for cache, multipart, differential/fallback download, checksum and publisher-refusal dispatch, with owned Node HTTP and a stubbed Authenticode check | Native signed/installed Windows acceptance, App smoke, any actual install or update |
| [#720](https://github.com/cschadewitz/Project_Orca/pull/720) electron-builder 26.18.0 / Vite 8.3.5 | A real unsigned Linux x64 tarball: ASAR production closure, no dev-package leaks, daemon resource byte-equal to the build, eight fonts present; NSIS payload/blockmap probes on synthetic executables | Browser `file://` rendering and CSP enforcement, Electron App smoke, native Windows installed/signature acceptance |
| [UPDATING.md](../../UPDATING.md) | The Windows explicit check → download → restart contract and the failed-update recovery contract from #660/#677 | "Source/fixture tests do not establish packaged Windows/NSIS update success" |

The gaps in the right-hand column are what this plan's runtime procedures are for. The
static helper only re-establishes, for a specific candidate, what can be read from bytes.

## Evidence classes

Keep these separate in any report. Evidence from one class never stands in for another.

| Class | Where it can run | What it can establish | What it cannot |
| --- | --- | --- | --- |
| **S — static inspection** | Any host with Node ≥ 24 and Git, offline | Artifact bytes match the candidate manifest; archive/ASAR contents, bundled daemon path and version stamp, native resource architecture and manifests, CSP text, fonts, update metadata and blockmap shape agree with each other and with the source checkout | Anything about running, installing, signing or trust |
| **L — Linux runtime** | Disposable Linux VM or container with a display (Xvfb), x64 and arm64 | Launch, bundled daemon spawn, rendering, fonts, CSP enforcement, logs, shutdown of the tarball and AppImage | Anything about Windows |
| **W — Windows native runtime** | Disposable Windows VM (snapshot), x64 and arm64 | NSIS install/uninstall, launch, rendering, logs, shutdown | Signing or publisher trust when the installer is unsigned |
| **T — signing and trust** | Native Windows, with provisioned signing only | Authenticode validity, publisher identity, SmartScreen behaviour | Nothing while builds are unsigned: record "unsigned" |
| **U — update** | Disposable Windows VM plus a disposable HTTPS feed | The N→N+1 cycle, failure/recovery and rollback behaviour of the shipped updater | Linux/macOS updating (not shipped), Debian deployment updates (separate owner) |

Current builds are **unsigned** ([RELEASING.md](../../RELEASING.md#signing-and-notarisation)).
Until signing is provisioned, class T has exactly one valid result per installer: *unsigned*.
Do not create, import or trust a certificate to produce a different one.

## Inputs: the candidate manifest

Every run starts from an explicit candidate manifest. Paths and hashes are inputs; nothing
is discovered or defaulted.

```json
{
  "format": 1,
  "commit": "<full 40-character commit the artifacts were built from>",
  "version": "<version stamped into the artifacts>",
  "artifacts": {
    "ORCA-<version>-linux-x64.tar.gz": "<sha256>",
    "orca-daemon-<version>.mjs": "<sha256>"
  }
}
```

1. Record the producing workflow run: repository, workflow file, run id and attempt, the
   run's head commit, and the GitHub artifact names and digests. This is the only link from
   artifact to commit: **no commit is embedded in the artifacts**. The `version` field is
   the only identity stamped into them.
2. Download each artifact into a **new, empty directory** used for nothing else. Treat
   the contents as untrusted data: never run tools from inside that directory.
3. Compute SHA-256 twice, independently (for example `sha256sum` on Linux and
   `Get-FileHash -Algorithm SHA256` on Windows), and write the manifest only from values
   that agree. Store the manifest with the evidence before inspecting anything.
4. List every file the candidate consists of. Partial inspection is allowed only with an
   explicit flag and is reported as incomplete.

The manifest names a candidate under test. It is not a statement that the candidate is
final or accepted.

## S — static inspection

```sh
git -C <checkout> checkout --detach <commit>     # exactly the manifest commit, clean
node <checkout>/tools/package-validation/inspect.js \
  --candidate <evidence>/candidate.json --source <checkout> \
  --artifact <download>/ORCA-<version>-linux-x64.tar.gz \
  --artifact <download>/... \
  --out <evidence>/static-report.json
```

Run it with the helper from the same checkout it compares against, or from a reviewed
newer checkout passed a `--source` at the candidate commit. Exit status 0 is
`consistent`, 1 is `refused` (the report says why), 2 is a usage error. An existing
`--out` file is never overwritten. The helper reads bytes and the Git checkout; it writes
only the report and a temporary copy of the Windows native-addon files (deleted on exit)
so the packaging hook's own manifest check can run unchanged.

The report's `complete` field describes manifest coverage only. A supplied installer or
blockmap with a missing counterpart is `refused`, even if every manifest entry was supplied.

It refuses, rather than skips, when:

- the checkout is not exactly the manifest commit, or has local changes under
  `package.json`, `packages/app` or `packages/design/fonts`;
- the root `package.json` version, the manifest version, an ASAR `package.json` version or
  a bundled/standalone daemon's version stamp differ;
- a supplied file is not named in the manifest, its SHA-256 differs, or a manifest file is
  not supplied (unless `--allow-partial`);
- any installer, blockmap or update metadata lacks its required counterparts for the
  candidate version, architecture and channel (even when omitted from the manifest, or
  when `--allow-partial` is set);
- a file name is a macOS artifact or anything else it does not recognise.

| Requirement | Static check (report `checks` names) |
| --- | --- |
| Artifact-to-commit identity | Manifest SHA-256 for every file; source at manifest commit; version agreement across manifest, source, ASAR and daemon |
| Archive contents | Every tar/zip member and link contained in the archive root; drive-prefixed/UNC link targets and traversal through stored link or file ancestors refused regardless of entry order; one `resources/app.asar`; Linux `orca` ELF / Windows `ORCA.exe` PE for the named architecture |
| ASAR contents | Per-file SHA-256 integrity (whole file and every block, in the `floor(size / 4 MiB) + 1` block layout `@electron/asar` 3.4.1 writes) required on every file, a missing or partial record refused; any entry with an `unpacked` field refused (`asar_unpacked_unsupported`); offsets plain decimal strings (`asar_offset_invalid`); `asar-has:*` entrypoints; `asar-excludes:*` source maps, `.d.ts`, build state, `dist/daemon|release|diagnostics-native`, native addons, development packages; `asar-dependency:*` for each declared production dependency |
| Native dependencies and resources | `electron-runtime:*` presence; Windows `native-diagnostics:*` — exactly three `.node` PE32+ DLLs for the architecture plus a manifest that passes the packaging hook's closed check against the source; Linux has no `resources/native` |
| Bundled daemon | Exactly two files under `resources/daemon/`: `orca-daemon.mjs`, with one version stamp equal to the candidate, and a non-empty `claude-pre-tool-hook.mjs`, identical across one runner's archives. The daemon is byte-identical across one runner's outputs (Linux tarballs and the standalone `.mjs`; the two Windows zips) |
| Fonts | Every `packages/design/fonts/*.woff2` byte-identical in the packaged renderer, and no extra faces |
| CSP | Packaged `index.html` CSP equal to the source's, no `unsafe-*` or wildcard, no inline or remote script, every local reference present |
| Window hardening | `contextIsolation: true` and `sandbox: true` present in packaged main — static text only |
| Installer, metadata, blockmap | All three counterparts required; PE image; Authenticode table *absent → unsigned* or *present → unverified*; `latest-ARCH.yml` (stable) or `prerelease-ARCH.yml` channel, version, path, SHA-512 and size equal the supplied installer; blockmap chunks cover the installer exactly |
| AppImage | ELF runtime for x64 and a squashfs payload marker; contents not inspected |

The supported format subset is conservative. Tar follows the [tar/PAX contract](#tarpax-contract)
below. ZIP per-disk and total EOCD counts must agree, and the parsed records must consume
the full declared central directory up to EOCD; its comment length must match the supplied
bytes. Local filenames, flags and methods must agree with their central records. Both local
and central extra-field areas are checked as bounded records: only timestamp/owner tags
`0x5455`, `0x000a` and `0x7875` are supported. Unicode-path overrides (`0x7075`), ZIP64 and
unknown extension tags are refused. ASAR link targets are checked relative to the archive
root.

Update metadata must use the flat `version`, `files`, `path`, `sha512` and optional
`releaseDate` mapping. File entries accept `url`, `sha512`, `size` and optional numeric
`blockMapSize` (validated but not emitted or used as chunk-checksum evidence). Every value
must be a simple token, optionally in matching simple quotes; sizes are safe unsigned
decimal integers, and `releaseDate` must be a canonical UTC ISO timestamp with milliseconds.
Duplicate keys, unknown file fields, collections, tags, aliases, escaped/multiline values,
comments and quoted/flow mapping keys are refused.

Windows archive destinations are indexed case-insensitively for duplicates and ancestors.
Member paths and link targets must use printable ASCII without reserved device names,
alternate data streams, trailing dots/spaces or `~` short-name aliases. This deliberately
refuses uncertain spellings rather than guessing a target filesystem's Unicode or 8.3
configuration. Linux destination indexing remains case-sensitive.

An unexpected malformed packaged file (an ASAR `package.json` that is not a JSON object, an
ASAR entry marked `unpacked`) is a named refusal in the report, not a crash: the report is
always written and says why. Unpacked entries are refused outright, whatever the flag's
value: the producer emits none, and supporting them would mean checking each
`resources/app.asar.unpacked/<path>` tree member against the header's size and integrity,
which the inspector does not do.

Recorded, not judged: entry counts, ASAR and header digests, daemon digests per artifact
(Linux vs Windows builds come from different runners and may legitimately differ),
`app-update.yml` feed URL and whether `publisherName` is present, the Linux
`chrome-sandbox` mode, and declaration files that ship.

### Tar/PAX contract

`readTarGz` (`tools/package-validation/formats.js`) reads one defined subset and refuses
everything else with a named code. A refusal is not a partial success: the artifact is
`refused` and so is the report. Containment, duplicate, ancestor and bounds checks in
`inspect.js` apply unchanged to the *effective* path and link target that this contract
produces, so a long path is checked exactly like a short one.

Accepted forms:

- **Compression:** gzip, decompressed by Node's `gunzipSync` with a 1.5 GiB output cap.
  Concatenated gzip members are read as one stream, as `gzip -d` does; non-gzip bytes after
  the last member are refused (`tar_gzip_invalid`). Both are pinned by tests.
- **Headers:** POSIX ustar (`ustar\0` + version `00`) or old-GNU (`ustar  \0`). V7 (no
  magic) and any other magic/version are refused (`tar_header_unsupported`). The header
  checksum must match; numeric fields must be octal (GNU base-256 is refused).
- **Header name fields:** `name`, `prefix` and `linkname` must be valid UTF-8, as PAX
  values and GNU long names must (`tar_header_invalid`). A non-link member must have an
  empty `linkname`, and only a directory's effective name may end in `/`
  (`tar_header_invalid`): GNU tar extracts a regular file named `x/` as a directory.
- **Member types:** `0` and NUL (regular file), `5` (directory), `2` (symlink), `1`
  (hardlink). Directories and links must have size 0. A hardlink must name an earlier
  regular-file member by its exact effective name; a missing, later, non-file or
  self-referencing target is refused (`tar_hardlink_invalid`). Every other type is refused
  (`tar_member_unsupported`), including `7` (contiguous), `3`/`4`/`6` (devices, FIFO) and
  GNU `S`, `D`, `M`, `N`, `V`.
- **Extended headers:** per-member PAX `x` only on POSIX archives' members, GNU `L`/`K` only
  on old-GNU members. Global PAX `g` is refused (`tar_global_pax_unsupported`), even when
  benign, because it changes the meaning of every later member.

Effective names, in order of precedence within one header format:

- **POSIX member:** PAX `path`, else the ustar `prefix` (bytes 345–499) + `/` + `name`, else
  `name`. Link target: PAX `linkpath`, else the `linkname` field.
- **Old-GNU member:** GNU `L`, else `name`. Link target: GNU `K`, else `linkname`. Bytes
  345–499 of an old-GNU header are atime/ctime/offset fields and are **never** a prefix.
- **Shadowed fields:** when PAX `path` or GNU `L` supplies the name, the ustar
  `prefix`/`name` must still be a contained path; when PAX `linkpath` or GNU `K` supplies
  the target, the ustar `linkname` must still be a contained target
  (`tar_shadowed_field_unsafe`). A reader that ignores the extended header sees those fields
  instead. Writers put a truncated copy of the long value there, which passes; a truncated
  copy that splits a multibyte character is invalid UTF-8 and is refused.
- **GNU long names and PAX together:** there is no precedence rule between them. A PAX
  header before a GNU member, a GNU `L`/`K` before a POSIX member, or either kind carried
  in a header of the other format is refused (`tar_extended_header_mixed`).

PAX rules:

- **Key allowlist:** `path` and `linkpath` only. Any other key is refused
  (`tar_pax_key_unsupported`). That includes `size` (POSIX lets it override the header's
  size field; this reader takes the body length from the header and does not implement the
  override), every `GNU.sparse.*` key (the member would otherwise be read as a regular file
  whose body is a sparse map), `mtime`/`atime`/`ctime`, `uid`/`gid`/`uname`/`gname`,
  `hdrcharset`, `comment`, and vendor keys (`SCHILY.*`, `LIBARCHIVE.*`). The real producer
  output below uses no PAX at all, so nothing beyond the two long-path keys is needed.
- **Record framing:** each record is exactly `<length> <key>=<value>\n`, where `<length>`
  is a decimal with no sign, leading zero or padding and counts the whole record in bytes;
  the newline must be the last byte; the records must tile the header body exactly.
  Values must be valid UTF-8 without NUL or newline and non-empty. A key may appear once.
  The header body is capped at 64 KiB and must hold at least one record
  (`tar_pax_invalid`).
- **`linkpath` (or GNU `K`) before a member that is not a link** is refused
  (`tar_extended_header_invalid`).

GNU long-name rules: the `L`/`K` body is the name plus exactly one terminating NUL, valid
UTF-8, at most 4096 bytes of name (`tar_gnu_long_invalid`).

Repeated and dangling headers: at most one `x`, one `L` and one `K` may precede one member
(`tar_extended_header_repeated`). An extended header with no member after it is refused
(`tar_extended_header_dangling`).

End of archive: the archive must end with two zero blocks, and every byte after the first
zero block must be zero and the stream a multiple of 512 bytes, so record padding is
accepted but nothing can hide after the end marker (`tar_end_invalid`). A truncated body or
header is `tar_truncated`; an archive with no members is `tar_empty`.

Bounds: 100,000 members, 4096-byte effective paths and link targets (checked by
`containedPath`/`containedLink`), 64 KiB PAX headers, 4 KiB GNU long names, the gzip output
cap above.

#### Support matrix

Tests are in `tools/test/package-validation/formats.test.js` ("tar.gz contract", "asar")
and `inspect.test.js` ("tar/PAX contract in a packaged Linux archive", "ASAR integrity and
malformed packaged files"). The last rows cover the ASAR inside the tree.

| Form | Status | Evidence |
| --- | --- | --- |
| POSIX ustar regular files and directories, short names | **Supported** | Fixtures; real Linux x64 and arm64 `tar.gz` from main `b4f36ca` (the receipt below): all 77 headers are this form |
| POSIX ustar symlinks and hardlinks (a hardlink to an earlier regular file) | **Supported** | Fixtures only; the real output has none |
| ustar `prefix` + `name` (paths to 255 bytes) | **Supported** | Fixtures only |
| Per-member PAX `path` / `linkpath` (long and multibyte UTF-8 paths) | **Supported** | Fixtures only, including a 300-byte path, a 200-byte link target and inspector-level containment |
| Old-GNU members with GNU `L` / `K` long names | **Supported** | Fixtures only |
| Zero padding after the end marker (tar record blocking) | **Supported** | Fixtures; real output ends with exactly two zero blocks |
| Long paths or link targets that escape the root, or traverse a stored link/file ancestor | **Refused** (`archive_path_escapes`, `archive_link_escapes`, `archive_ancestor_not_directory`) | Fixtures, inspector level |
| PAX keys other than `path`/`linkpath`, including `size`, `GNU.sparse.*`, `mtime` | **Refused** (`tar_pax_key_unsupported`) | Fixtures, reader and inspector level |
| Global PAX `g` | **Refused** (`tar_global_pax_unsupported`) | Fixtures |
| Malformed PAX framing, duplicate keys, empty values or headers | **Refused** (`tar_pax_invalid`) | Fixtures (15 framing cases) |
| GNU long names mixed with PAX or POSIX members | **Refused** (`tar_extended_header_mixed`) | Fixtures |
| Repeated or dangling `x` / `L` / `K` | **Refused** | Fixtures |
| Link target on a non-link member (PAX, `K` or the ustar `linkname`); body on a directory or link | **Refused** | Fixtures |
| Unsafe ustar `name`/`prefix`/`linkname` shadowed by PAX `path`/`linkpath` or GNU `L`/`K` | **Refused** (`tar_shadowed_field_unsafe`) | Fixtures; a safe truncated copy is accepted |
| Hardlink to a missing, later, non-file member or itself | **Refused** (`tar_hardlink_invalid`) | Fixtures |
| Non-directory whose name ends in `/`; invalid UTF-8 in `name`, `prefix` or `linkname` | **Refused** (`tar_header_invalid`) | Fixtures |
| V7 or unknown magic; GNU base-256 numbers; types `7`, `3`, `4`, `6`, `S`, `D`, `M`, `V` and anything else | **Refused** | Fixtures |
| Missing or short end marker; non-zero bytes or a header after it | **Refused** (`tar_end_invalid`) | Fixtures |
| PAX `mtime`/`atime`/`ctime` alongside `path` (node-tar and GNU `--format=posix` long-path output) | **Not yet validated** | Refused today. If a future producer emits them for long paths, add them to the allowlist as validated inert decimals with tests, not by ignoring them |
| Multi-member (concatenated) gzip | **Supported** | Fixtures; read as one stream, as `gzip -d` does. Real output is one member |
| Non-gzip bytes after the gzip stream | **Refused** (`tar_gzip_invalid`) | Fixtures |
| Real producer output that uses long names (PAX or GNU) | **Not yet validated** | The current producer emits none (77 short ustar headers) |
| Windows `.zip` from a real producer | **Not yet validated** | Fixture-only; see "Limits" |
| ASAR per-file integrity in `@electron/asar` 3.4.1's block layout, including the extra empty block at exact 4 MiB multiples | **Supported** | Fixtures at 0, 1, 4 MiB − 1, 4 MiB, 4 MiB + 1 and 8 MiB; real output (1,475 files) |
| ASAR entries with an `unpacked` field (any value: `true`, `false`, `"no"`, `1`), on files or directories | **Not yet validated**; refused (`asar_unpacked_unsupported`) | Fixtures, reader and inspector level. Real output has none. Support would need each `app.asar.unpacked/<path>` member checked against the header's size and integrity |
| ASAR offsets other than a plain decimal string (`"0x0"`, `" 0 "`, `"0e0"`, `"-0"`, `"00"`) | **Refused** (`asar_offset_invalid`) | Fixtures |

### Real-producer compatibility receipt (9 November 2026, not a candidate)

This is the decision record's real-output receipt for the final parser. It is a local
validation build only: nothing was uploaded, and **it is not a release candidate** and
designates nothing.

| Item | Value |
| --- | --- |
| Producer source | main `b4f36cabbd26465ad4742dd0581976a95f0f073b`, clean checkout (no tracked changes), unmodified `packages/app/electron-builder.yml` |
| Inspector | branch `claude/fervent-euler-f9zivo` at merge `ae94cfb02daaad90b43814bb08620d96d8ce8ca6` (main `b4f36ca` merged in), unchanged by that merge: `formats.js` SHA-256 `96d900a1645aa2af921a829a86b4578c3ea1eee03df71838f1ad1517e9b345b3`, `inspect.js` `fd1e4f6d641ed84af93f48adedcc5a395c3e0dfcbfb5e984172d2654de3d0217`. The later hardening commit (unpacked ASAR entries, shadowed ustar fields, hardlink targets, trailing `/`, block layout, offsets, UTF-8 names) was re-run against the same four files; see the "Re-run after hardening" row |
| Version stamp | `0.6.0` is the root `package.json` version at `b4f36ca`, passed so that the ASAR and daemon stamps agree with the source. It is a local build's stamp, **not** a release claim: these hashes are not the published v0.6.0 release assets and must not be compared with them |
| Host and tools | Linux x64; Node 24.21.0; pnpm 12.4.2; electron-builder / app-builder-lib 26.18.0; Electron 44.10.0; `@electron/asar` 3.4.1; node-tar 7.5.22 in the lockfile |
| Producer commands | As `desktop.yml`'s Linux leg: `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm --filter @orca/app run build:daemon`, `pnpm --filter @orca/app exec electron-builder --publish never -c.extraMetadata.version=0.6.0`, then `cp packages/app/dist/daemon/orca-daemon.mjs packages/app/dist/release/orca-daemon-0.6.0.mjs`. The first `electron-builder` attempt failed on a `504 Gateway Time-out` from a download through the network proxy; the identical command was run once more and succeeded. No configuration was changed |
| Artifacts (SHA-256, computed twice: `sha256sum` and `openssl dgst -sha256`, which agreed) | `ORCA-0.6.0-linux-x64.tar.gz` `b97201289cca23faf57e28627b837091dc34c43d3d5cd73ec2e7cf6882e3fd30` (123,542,523 bytes); `ORCA-0.6.0-linux-x86_64.AppImage` `f54844d74583055a07e8759fff0d8e27f3befdc691a4de688758fb90c7e0cdec` (129,970,685); `ORCA-0.6.0-linux-arm64.tar.gz` `755d683cde9f839317f1d5d09349b002cb2f7fa7b1a8db2970b35b83bd6f58d4` (124,430,156); `orca-daemon-0.6.0.mjs` `d6d1ca0d1fc342f855d21e4a20628fd8820c1c92a36cdc1b4af5dcb11cbfc0a4` (3,642,836) |
| Command | `node tools/package-validation/inspect.js --candidate candidate.json --source <checkout at b4f36ca> --artifact <each of the four files> --out report.json` (no `--allow-partial`) |
| Result | Exit 0, report `status: consistent`, `complete: true`, no cross-check failures. Every artifact `consistent` |
| Negative control | The same tarball against a manifest with one changed hex digit: `refused: artifact_hash_mismatch`, exit 1 |
| Re-run after hardening | Same four files and manifest, inspector `formats.js` SHA-256 `d698cbe5286548a6f472fa68816480a1e0c12fe897951135d7abb41d77f57df5`, `inspect.js` `e42b8a6a0d2765aba63e60032c262d61dbac034977642be53729b2cc25b8792e`: exit 0, `status: consistent`, `complete: true`; both tarballs 77 members, 1,618 ASAR entries, `asar-integrity:1475-files`. The negative control again gives `artifact_hash_mismatch`, exit 1 |
| Where the report is | `candidate.json` and `report.json` were written to the session's scratch space and **are not retained**. The fields that matter are summarized in this table and the observations below |

Observations from the report and the tar headers:

- **Tar form:** each `tar.gz` has 77 members (73 regular files, 4 directories), all POSIX
  ustar headers (`ustar\0` `00`). There are no PAX (`x` or `g`) headers, no GNU `L`/`K`
  headers, no ustar `prefix`, no links, and exactly two zero blocks after the last member.
  The unchanged producer output sits wholly inside the "Supported" rows of the
  [support matrix](#support-matrix); it needs none of the long-path forms.
- **ASAR:** 1,618 entries; all 1,475 packed files carry and match whole-file and per-block
  SHA-256 integrity, which the inspector now requires; no unpacked entries; 24 production
  packages; eight fonts; CSP equal to the source.
- **Daemon:** stamp `0.6.0`; byte-identical in both tarballs and the standalone file.
- Unchanged from the earlier self-check: `dist/preload/index.d.cts` and 124 dependency
  typings ship, because `files` excludes only `*.d.ts` (harmless; for the packaging
  owner); `chrome-sandbox` is mode `755`, not setuid, so the Chromium sandbox depends on
  unprivileged user namespaces on the host (see L1); `app-update.yml` names
  `https://updates.invalid/` with no `publisherName`; electron-builder also writes
  `latest-linux.yml`, which `desktop.yml` does not upload and the inspector was not given.

Coverage and gaps:

- **Covered:** Linux x64 `tar.gz` and AppImage (ELF runtime and squashfs marker only;
  AppImage contents are not inspected), and the standalone daemon.
- **arm64 is a gap.** The arm64 `tar.gz` above came out of the same x64 `electron-builder`
  run, because the unmodified config lists both architectures. It passed, but it was
  packaged on an x64 host, not by the arm64 leg of `desktop.yml`, and no arm64 AppImage is
  configured. Treat it as a format observation, not arm64 evidence.
- **Windows is a gap.** No Windows zip, installer, blockmap or `latest-ARCH.yml` was built:
  Windows packaging needs the MSVC-built native diagnostics addons. Every Windows static
  check is still fixture-only, and the ZIP subset has not met a real electron-builder zip.
- Producer output from CI runners (as opposed to this local build) has not been inspected.

### Earlier self-check (27 October 2026, superseded)

Before the tar/PAX contract, an unsigned Linux x64 `tar.gz` and AppImage were built
locally from `4d5176c` (Electron 44.9.1, Node 24.21.0, `--publish never`, stamped 0.6.0)
and reported `consistent`. That report's "1,618 entries" was the ASAR entry count, not the
tar member count: the tree's member count was overwritten in the report, which now has a
separate `asarEntries`. The result predates the later parser restrictions and is kept only
as history; the receipt above replaces it.

## Runtime procedures (not run in this preparation)

Each procedure runs only in a **disposable** environment created for it and discarded
afterwards: a VM restored from a clean snapshot, or a fresh container. None runs on a
workstation, against a real workspace, over an existing installation, or with production
feed credentials. Stop and record "blocked" rather than changing a security setting
(sandbox sysctls, SmartScreen, Defender, execution policy, certificate stores) to proceed.

Common prerequisites for every runtime procedure:

- The static report for the same manifest is `consistent` for the artifact under test.
- The artifact is copied into the disposable environment and its SHA-256 recomputed there
  and recorded.
- Nothing listens on `127.0.0.1:6722` (the development default the app may fall back to on
  launch; a daemon there would be a different store). Record the check.
- `ORCA_DAEMON_URL`, `ORCA_UPDATE_URL` and `ORCA_UPDATE_TOKEN_FILE` are unset unless the
  procedure sets them. `HOME`/`%USERPROFILE%` and the profile belong to the disposable
  environment, so the app's default workspace (the home directory) is disposable too.
- A synthetic workspace: an empty directory, or one populated with the candidate's standalone
  daemon, which is the whole CLI: `node orca-daemon-<version>.mjs demo --dir <path> --keep`
  (scripted agents, no LLM). No
  real store, credentials or agent installations.

Common evidence layout, one directory per candidate commit:

```
<commit>/candidate.json            the manifest
<commit>/static-report.json        inspect.js output
<commit>/<procedure>-<os>-<arch>/  env.txt  hashes.txt  app.log  processes-*.txt  screenshots/  notes.md
<commit>/SHA256SUMS                over every file above
```

`env.txt` records OS build, architecture, display/DPI, Electron and Node versions reported
by the app, the user-namespace or SmartScreen state as found (not changed), and the time
zone. Never retain feed tokens, bearer headers, personal paths outside the disposable
environment, or real workspace contents.

### L1 — Linux tarball: clean launch, bundled daemon, logs, shutdown

- **Applies to:** `ORCA-<version>-linux-x64.tar.gz` and `-linux-arm64.tar.gz`, each on its
  own architecture.
- **Prerequisites:** a display (`xvfb-run`) and unprivileged user namespaces available as
  provisioned (`unshare --user --map-root-user true` succeeds). If they are not, record
  blocked; do not add `--no-sandbox` or change sysctls.
  The same tarball must pass S. Before extraction, use `readTarGz` from
  `tools/package-validation/formats.js` to prepare and retain a separate SHA-256 inventory
  of the three members named in step 1, hashing their bytes in memory. The static report
  emits ASAR and daemon digests but does not emit an executable digest.
- **Effects:** extracts into a new directory; creates one profile directory and one
  workspace directory; starts the app and its daemon child; writes only inside those
  directories and the disposable `HOME`.
- **Steps:**
  1. `mkdir -p "$RUN/app" "$RUN/profile" "$RUN/workspace"`, extract the tarball into
     `$RUN/app`, and record `sha256sum` of `orca`, `resources/app.asar` and
     `resources/daemon/orca-daemon.mjs`. They must equal the retained tar-member inventory;
     also cross-check `asarSha256` and `daemonSha256` in the static report.
  2. **First launch, no workspace set:** `setsid xvfb-run -a "$RUN/app/<root>/orca"
     --user-data-dir="$RUN/profile" >"$EVIDENCE/app-first.log" 2>&1 &`. Record whether the
     window opens on first-run setup (disconnected) or starts the bundled daemon.
     `packages/app/src/main/index.ts` says the packaged app without an explicit target or
     verified selection opens disconnected for setup; `desktop.yml`'s launch step expects a
     listening line in the same situation. Record which this candidate does; do not resolve
     the difference by assumption. Then close it as in step 5.
  3. **Launch with `ORCA_WORKSPACE="$RUN/workspace"`**, same command, logging to
     `app.log`.
  4. Observe within 60 s: a `[daemon]` line `orca daemon <version> listening on
     http://127.0.0.1:<port> (protocol <major.minor>)` with the candidate version;
     `ps -o pid,ppid,args -g <pgid>` shows the daemon child whose arguments include
     `<root>/resources/daemon/orca-daemon.mjs` (from the extracted tree, never another
     path) and whose environment (`/proc/<pid>/environ`) includes `ELECTRON_RUN_AS_NODE=1`;
     the status bar reads connected; `ss -ltnp` shows the port on loopback only.
  5. **Graceful shutdown:** close the window (or send `SIGTERM` to the main process only).
     Expected: the main process exits within 10 s (`SHUTDOWN_DEADLINE_MS`), the daemon child
     is gone, the port is closed, and no `orca-daemon.mjs` process remains. Record the exit
     status and timings. A leftover child is a failure; kill it only after recording it.
- **Logs to retain:** `app-first.log`, `app.log`, process listings before and after, a
  listing (names and sizes only) of `$RUN/profile` and `$RUN/workspace/.orca`.
- **Cleanup:** discard the VM/container. If only a directory tree was used, `kill -- -<pgid>`
  any survivors after recording them, then remove `$RUN`.

### L2 — Packaged rendering, fonts and CSP (Linux and Windows)

- **Applies to:** the launched tree from L1 or W3 on each architecture.
- **Prerequisites:** as L1/W3. For automated observation, Playwright's Electron driver on
  the disposable host launching the **packaged** executable (`executablePath`) with
  `--user-data-dir`; the existing smoke specs launch the workspace build instead, so they
  are a pattern, not a substitute.
- **Effects:** as L1/W3, plus screenshots.
- **Observations:**
  1. Screenshots of the shell in light and dark themes at 100% scale (and 150% on Windows).
     Text renders in IBM Plex (no fallback serif or system UI face), status glyphs render
     from the bundled symbol face, and nothing is clipped at the default window size.
  2. In the window: `document.fonts.check('14px "IBM Plex Sans"')` and the mono and symbol
     faces return true after `document.fonts.ready`; record each `FontFace` family and
     status. The packaged app has no `#type` route; that proof remains a dev-server check.
  3. `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content` equals
     the static report's `renderer.csp`. Inject an inline `<script>` and an inline style
     from the test driver: each must raise a `securitypolicyviolation` event and not
     execute. Normal start-up raises no CSP violation in the console.
  4. `typeof window.orca === "object"`, and `typeof require` and `typeof process` are
     `"undefined"` in the page (preload ran under `contextIsolation` and `sandbox`).
- **Evidence:** screenshots, the console log, a JSON of the evaluated values.
- **Cleanup:** as L1/W3.

### L3 — AppImage

As L1, launching `ORCA-<version>-linux-x86_64.AppImage` from a copy in `$RUN` after
`chmod +x`. If FUSE is unavailable, `APPIMAGE_EXTRACT_AND_RUN=1` extracts to a temporary
directory instead; record which was used. Do not install FUSE on a shared host. Expected
observations as L1; the daemon path is under the AppImage's mount or extraction directory.

### L4 — Standalone daemon

`node tools/probe-bundled-daemon.js <download>/orca-daemon-<version>.mjs` with Node ≥ 24,
from a checkout at the candidate commit. It owns a disposable workspace and its child, and
prints sanitized authenticated `hello` evidence: version equal to the candidate and the
expected protocol. Retain its output.

### W1 — Windows installer: hash, signature status, trust prompt

- **Applies to:** `ORCA-<version>-win-x64.exe` and `-win-arm64.exe`, on matching hardware or
  VMs.
- **Prerequisites:** a VM restored from a clean snapshot with **no ORCA installed**: no
  `%LOCALAPPDATA%\Programs\ORCA`, no `%APPDATA%\ORCA`, no ORCA entry under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`. If any exist, stop: never
  install over an existing application.
- **Effects:** none beyond reading the file and showing the OS trust prompt.
- **Steps and observations:**
  1. `Get-FileHash -Algorithm SHA256` equals the manifest.
  2. `Get-AuthenticodeSignature <installer> | Format-List *`. For current builds expect
     `Status : NotSigned` and no signer certificate, matching the static report's
     `absent-unsigned`. Record the full output. If a signature appears, record subject,
     issuer, thumbprint and timestamp, and report it as an unexpected finding: it is not
     release signing evidence unless signing has been provisioned and documented.
  3. Open the installer as a person would. Record the SmartScreen or unknown-publisher
     prompt (screenshot). Continuing past it is the explicit bootstrap trust decision
     UPDATING.md requires for unsigned installs; record who made it. If policy blocks it,
     record blocked; do not change SmartScreen, Defender or policy.

### W2 — Windows clean install and uninstall

- **Prerequisites:** W1 on the same VM and the same-architecture zip that passed S.
  Prepare and retain a separate SHA-256 inventory of the zip members listed below, using
  `readZip` from `tools/package-validation/formats.js` and hashing each member's bytes in
  memory. The inspector report emits ASAR and daemon hashes, but does not emit executable
  or native-addon hashes; those comparisons require this separate inventory.
- **Effects:** a per-user NSIS install (no elevation expected): the install directory
  (default `%LOCALAPPDATA%\Programs\ORCA`), an uninstall key under `HKCU`, Start menu
  shortcut(s) with AppUserModelID `dev.orca.desktop`. Uninstall removes them.
- **Observations:**
  1. No UAC prompt. Default and changed install directories both offered.
  2. Hash the installed `ORCA.exe`, `resources\app.asar`, `resources\daemon\orca-daemon.mjs`
     and `resources\native\diagnostics\win32-<arch>\*` and compare with the retained zip
     member inventory (also cross-check `asarSha256` and `daemonSha256` in S). Equality ties
     the installer payload to the inspected zip; a difference is a finding to explain,
     not to ignore.
  3. `reg export` the uninstall key to the evidence directory.
  4. After W3–W5, uninstall from Settings. Expected: install directory and uninstall key
     removed; record whether `%APPDATA%\ORCA` (profile) remains; the synthetic workspace is
     untouched.
- **Cleanup:** revert the VM snapshot.

### W3 — Windows launch, bundled daemon and logs

- **Prerequisites:** W2 installed; `ORCA_WORKSPACE` set for this process only to a new
  synthetic workspace; port 6722 free (`Get-NetTCPConnection -LocalPort 6722` empty).
- **Steps and observations:**
  1. First launch from the Start menu with no `ORCA_WORKSPACE`: record first-run setup or
     daemon start, as in L1 step 2. Close it.
  2. Launch with `Start-Process` and `-RedirectStandardOutput`/`-RedirectStandardError` into
     the evidence directory and `ORCA_WORKSPACE` set. Record whether main-process output is
     observable this way; if it is empty, say so rather than infer a log.
  3. `Get-CimInstance Win32_Process | Where-Object CommandLine -match 'orca-daemon'`: the
     child's executable is the installed `ORCA.exe`, its command line names the installed
     `resources\daemon\orca-daemon.mjs`, and its parent is the app. The status bar is
     connected with the candidate version.
  4. Profile listing (names and sizes) of `%APPDATA%\ORCA`, including `diagnostics` and
     `first-run` if present.
- **Cleanup:** W5, then W2 step 4.

### W4 — Windows rendering, fonts and CSP

L2 on the installed app, both architectures, at 100% and 150% display scaling.

### W5 — Windows graceful shutdown

Close the window. Expected: `ORCA.exe` processes exit within 10 s, no `orca-daemon`
child remains, the daemon port is closed. Repeat with a run in progress in the synthetic
workspace and record that shutdown still completes (it is bounded) and what the workspace
shows on the next launch. Retain process listings with timestamps.

## Update, failure/recovery and rollback (from the current updater contract)

Only Windows has an in-app updater (`packages/app/src/main/update-driver.ts`, contract in
[UPDATING.md](../../UPDATING.md)). It is packaged-win32-only, uses the generic provider on
channel `latest-<arch>`, sends `Authorization: Bearer` from `ORCA_UPDATE_TOKEN_FILE`,
requires an HTTPS `ORCA_UPDATE_URL` without credentials, disables automatic download and
install-on-quit, disallows downgrade and prerelease, and **ignores any offered version
containing `-`**. Consequences for testing:

- A prerelease candidate (`X.Y.Z-rc.N`) is published on the `prerelease-<arch>` channel and
  cannot be offered to a production client at all. The update tests need two
  **non-prerelease** builds, N and N+1, from the same pipeline. Do not rename or edit
  metadata to force a prerelease through: altered metadata is no longer the candidate.
- Choosing N and N+1 is the coordinator's decision. This plan does not choose them.
- The feed must be a **disposable** HTTPS host serving an immutable copy of N+1's
  published assets (`latest-<arch>.yml`, installer, blockmap) with a disposable read-only
  token created for the test, and a certificate the VM already trusts. Installing a root
  certificate to trust a test feed is a security-setting change and is out of scope; if no
  such host exists, record U-tests as blocked. Never point a test VM at the production
  `stable` feed or use its token.

Prerequisites for every U test: W1–W3 completed for N on a fresh VM snapshot; a backup copy
of the synthetic workspace and `%APPDATA%\ORCA` taken while the app is closed; N+1's static
report `consistent`.

| Id | Procedure | Expected observation (from the contract) | Evidence |
| --- | --- | --- | --- |
| U1 | Check → Download → quit normally → relaunch → Restart to update | Check does not download; download does not install; ordinary exit installs nothing (still N); after explicit restart the app is N+1, installed file hashes equal N+1's report, profile and workspace preserved | Screenshots of each state, version before/after, installed hashes, feed access log (status codes only) |
| U2 | Unsaved configuration, permission or answer draft, then Restart | Restart refused until drafts are saved, sent or discarded; nothing installs; retry works afterwards | Screenshots, version unchanged |
| U3 | A running agent operation in the bundled daemon (scripted workflow in the synthetic workspace), then Restart | Admission close refused while work is in flight; no work killed; parked gates survive a later successful restart | Run/event listing before and after |
| U4 | Feed offline, wrong token (401), N's blockmap absent from the feed, corrupt installer (bytes altered, metadata unchanged) | Check/download fails and can be retried; corrupt download is rejected by SHA-512 and never installed; an unavailable differential falls back to a full verified download; network and credential details never reach the renderer | Screenshots, app/feed status codes, version unchanged |
| U5 | Installer outcome unknown: end the installer process after `quitAndInstall` launches it (VM only) | Admission stays closed, no automatic reconnect, failure reported; workspace and first-run journal preserved for review. Do not delete the journal to unblock | Profile listing, app state, notes |
| U6 | Wrong-publisher installer | **Not applicable while unsigned:** `app-update.yml` has no `publisherName`, so there is no publisher to compare. Record "not applicable — unsigned". Run only once signing is provisioned, with N and N+1 signed by the release identity and a wrong-publisher N+1 | — |

**Rollback.** The updater refuses downgrade, so there is no in-app rollback. The supported
rollback is the one UPDATING.md describes: retain the known-good N installer and a
consistent pre-upgrade backup. R1: restore the pre-upgrade VM snapshot, or reinstall N into
a fresh snapshot and restore the backed-up workspace and profile, then repeat W3 and record
that N works on its own data. Installing N over N+1 on N+1-written data is not a supported
downgrade; if the store epoch in `release-compatibility.json` differs between N and N+1 it
must not be attempted, and even with equal epochs it is an observation, not acceptance.

**Linux.** There is no desktop updater on Linux. An N→N+1 change is a new extracted tree;
the applicable test is L1 for N+1 using a copy of the profile and workspace N created, and
rollback is L1 for N on the pre-upgrade copy. The Debian managed deployment
(`tools/deploy/orca-release.py`) is a separate server path with its own verification
boundary in UPDATING.md and is not part of this plan.

## Remaining native runs

None of these was run in this preparation, apart from the non-candidate Linux x64 static
receipt [above](#real-producer-compatibility-receipt-9-november-2026-not-a-candidate). Each needs a disposable environment and, for the
update tests, a coordinator decision on N, N+1 and the test feed.

| Run | Platform | Status |
| --- | --- | --- |
| S on real candidate output, all Windows/Linux files | Any | Not run (no candidate designated). Local non-candidate Linux x64 receipt only; arm64 and Windows are gaps |
| L1, L2, L3 | Linux x64 and arm64 | Not run |
| L4 | Node 24 host | Not run for a candidate (`desktop.yml` already runs it on build output) |
| W1–W5 | Windows x64 and arm64 | Not run |
| T (signature validity, publisher, SmartScreen reputation) | Windows | Not applicable until signing is provisioned |
| U1–U5, R1 | Windows x64 and arm64 | Not run; needs N/N+1 and a disposable feed |
| U6 | Windows | Not applicable while unsigned |

## Limits of the static helper

- It establishes consistency of supplied bytes, not provenance. Provenance rests on the
  retained workflow run record (step 1 of the inputs).
- It does not verify Authenticode, blockmap chunk checksums (BLAKE2b-144, which Node does
  not expose), or the full transitive production closure (#720 did that against an
  installed tree).
- It does not read AppImage (squashfs) contents or NSIS payloads, and it refuses rather
  than reads unpacked ASAR entries.
- The Electron runtime list is a presence check of a few core files, not a version check.
- Window hardening is a text check of the packaged main script; L2 observes enforcement.
- Tar input is limited to the [tar/PAX contract](#tarpax-contract). A refusal there is a
  prompt to extend the contract with tests, or to evaluate a maintained reader in a
  separately scoped follow-up, never to ignore the unsupported semantics.
- Zip64 archives are refused rather than read; current Windows zips are well under its
  limits, and a refusal here is a prompt to extend the reader, not to skip the check.
