// Version math and CHANGELOG bookkeeping for a release. Everything here is local and
// offline: the GitHub side (reading the milestone, opening the release PR, creating the
// release) lives in .github/workflows/release-*.yml, so this stays runnable by hand.
//
// Usage:
//   node tools/release.js version --bump minor [--pin 0.2.0-rc.1]   -> prints the next version
//   node tools/release.js prepare 0.2.0                             -> rewrites package.json + CHANGELOG.md
//   node tools/release.js notes 0.2.0                               -> prints that release's CHANGELOG body
//   node tools/release.js notes --unreleased                        -> prints what changelog.d/ holds
//   node tools/release.js line 0.7.1                                -> prints the branch it is cut from
//   node tools/release.js sync 0.7.1 <other CHANGELOG.md>           -> copies that section into CHANGELOG.md
//                                                                      (and, for a new minor's X.Y.0
//                                                                      or candidate, raises package.json
//                                                                      to it when it is behind)
//
// The notes themselves are not written here: a pull request drops a fragment into
// `changelog.d/` (tools/changelog.js) and `prepare` renders the lot into the dated
// section, so nothing has to be reconstructed from commit subjects and no two pull
// requests edit the same region of the same file.
//
// The versioning policy it implements is documented in docs/RELEASING.md.
import { readFileSync, writeFileSync } from "node:fs";
import { FRAGMENT_DIR, deleteFragments, readFragments, renderEntries } from "./changelog.js";
import { laneOf } from "./release-lane.js";

const PKG = "package.json";
const CHANGELOG = "CHANGELOG.md";

// What `## Unreleased` holds between releases: a pointer, because the entries themselves
// live in changelog.d/ until a release renders them.
const UNRELEASED_TEMPLATE = `## Unreleased

Pending entries live in [\`${FRAGMENT_DIR}/\`](${FRAGMENT_DIR}/), one file per entry; preparing a
release renders them into a dated section below. Run \`node tools/release.js notes --unreleased\`
to read them as they stand.
`;

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

/** The fragments, or a one-line error rather than a stack trace for a misnamed file. */
const pending = () => {
  try {
    return readFragments();
  } catch (err) {
    return die(err.message);
  }
};

const parse = (version) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!m) die(`not a semver version: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] };
};

const currentVersion = () => {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  if (typeof pkg.version !== "string") die(`${PKG} has no version field`);
  return pkg.version;
};

/**
 * Pre-1.0 (major === 0) a `major` bump is deliberately treated as a minor one: under
 * semver 0.x promises nothing, and reaching 1.0.0 should be a decision rather than the
 * side effect of one label. Pin the version on the milestone to go to 1.0.0.
 */
function nextVersion(current, bump) {
  const { major, minor, patch } = parse(current);
  if (major === 0) {
    if (bump === "major" || bump === "minor") return `0.${minor + 1}.0`;
    if (bump === "patch") return `0.${minor}.${patch + 1}`;
  } else {
    if (bump === "major") return `${major + 1}.0.0`;
    if (bump === "minor") return `${major}.${minor + 1}.0`;
    if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  }
  return die(`unknown bump: ${bump} (expected major, minor or patch)`);
}

/** The `## Unreleased` body, and the line range it occupies, from a CHANGELOG's lines. */
function unreleasedSection(lines) {
  const start = lines.findIndex((l) => /^## +Unreleased *$/i.test(l));
  if (start === -1) die(`${CHANGELOG} has no "## Unreleased" heading`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return { start, end, body: lines.slice(start + 1, end) };
}

/** Drops `###` subsections that hold nothing but blank lines, and trims the edges. */
function tidy(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (/^### /.test(body[i])) {
      let j = i + 1;
      while (j < body.length && !/^#{2,3} /.test(body[j])) j++;
      if (body.slice(i + 1, j).every((l) => l.trim() === "")) {
        i = j - 1;
        continue;
      }
    }
    out.push(body[i]);
  }
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

function prepare(version) {
  parse(version);

  const pkgText = readFileSync(PKG, "utf8");
  // Already at this version means the bump merged and the publish did not follow: the
  // fix is to run Release (publish) against main, not to prepare the same release twice.
  if (currentVersion() === version) {
    die(
      `${PKG} already says ${version}; if release-publish.yml failed after the release ` +
        `pull request merged, dispatch it against main instead (docs/RELEASING.md)`,
    );
  }
  const bumped = pkgText.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
  if (bumped === pkgText) die(`could not rewrite the version field in ${PKG}`);

  const lines = readFileSync(CHANGELOG, "utf8").split("\n");
  const { start, end, body } = unreleasedSection(lines);
  // Entries are fragments now. One written by hand into `## Unreleased` would be thrown
  // away by the rewrite below, so say so instead of losing it.
  if (tidy(body).some((l) => /^\s*[-*] /.test(l))) {
    die(`${CHANGELOG}'s Unreleased section has entries written by hand; move them into ${FRAGMENT_DIR}/ first`);
  }

  const fragments = pending();
  // A release whose notes nobody wrote is worse than no release: the PR checklist asks
  // for a fragment per change, so an empty directory means the bookkeeping was skipped.
  if (!fragments.length) die(`${FRAGMENT_DIR}/ has no fragments; write the release notes first`);
  const entries = renderEntries(fragments);

  const date = new Date().toISOString().slice(0, 10);
  const replacement = [...UNRELEASED_TEMPLATE.split("\n"), `## ${version} - ${date}`, "", ...entries, ""];
  writeFileSync(CHANGELOG, [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n"));
  writeFileSync(PKG, bumped);
  deleteFragments(fragments);
  console.error(
    `prepared ${version}: ${PKG} bumped, ${CHANGELOG} section dated ${date} from ` +
      `${fragments.length} fragment(s), which are now deleted`,
  );
}

const compare = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  for (const key of ["major", "minor", "patch"]) if (x[key] !== y[key]) return x[key] - y[key];
  // A prerelease sorts below its final (0.7.1-rc.1 < 0.7.1); two prereleases by text.
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
};

/** A version's `## X.Y.Z - date` section as lines (heading included), or undefined. */
function sectionOf(lines, version) {
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `));
  if (start === -1) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return { start, end };
}

/**
 * Copies `version`'s section from a line branch's CHANGELOG into this one, in version
 * order, so `main` records a release that was cut from `release/X.Y`. Running it again
 * changes nothing; a different section already here for the version is a stop.
 *
 * A new minor (`X.Y.0` or its candidate) is released from its line too, so `main` would never
 * learn its version, and the next minor's prepare would compute `X.Y.0` again. Its record
 * therefore also raises `package.json` to it when `main` is behind. A patch never does.
 */
function sync(version, sourcePath) {
  parse(version);
  const source = readFileSync(sourcePath, "utf8").split("\n");
  const found = sectionOf(source, version);
  if (!found) die(`${sourcePath} has no section for ${version}`);
  const section = source.slice(found.start, found.end);
  while (section.length && section[section.length - 1].trim() === "") section.pop();

  const lines = readFileSync(CHANGELOG, "utf8").split("\n");
  const here = sectionOf(lines, version);
  if (here) {
    const existing = lines.slice(here.start, here.end);
    while (existing.length && existing[existing.length - 1].trim() === "") existing.pop();
    if (existing.join("\n") === section.join("\n")) {
      console.error(`${CHANGELOG} already has the ${version} section; nothing changed`);
      raiseVersion(version);
      return;
    }
    die(`${CHANGELOG} already has a different ${version} section; reconcile it by hand`);
  }
  // Before the first released section older than this version, after `## Unreleased`.
  unreleasedSection(lines);
  let at = lines.findIndex((l) => {
    const m = /^## (\d+\.\d+\.\d+(?:-\S+)?) /.exec(l);
    return m && compare(m[1], version) < 0;
  });
  if (at === -1) at = lines.length;
  writeFileSync(CHANGELOG, [...lines.slice(0, at), ...section, "", ...lines.slice(at)].join("\n"));
  console.error(`${CHANGELOG}: added the ${version} section from ${sourcePath}`);
  raiseVersion(version);
}

/** Raises package.json to a new minor's released version when it is behind; else nothing. */
function raiseVersion(version) {
  if (parse(version).patch !== 0) return;
  const current = currentVersion();
  if (compare(version, current) <= 0) return;
  const pkgText = readFileSync(PKG, "utf8");
  const bumped = pkgText.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
  if (bumped === pkgText) die(`could not rewrite the version field in ${PKG}`);
  writeFileSync(PKG, bumped);
  console.error(`${PKG}: raised from ${current} to ${version}`);
}

/** What `prepare` would render today, without writing anything. */
function unreleasedNotes() {
  const fragments = pending();
  if (fragments.length) console.log(renderEntries(fragments).join("\n"));
  else console.error(`${FRAGMENT_DIR}/ is empty; nothing is pending`);
}

function notes(version) {
  const lines = readFileSync(CHANGELOG, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `));
  if (start === -1) die(`${CHANGELOG} has no section for ${version}`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  console.log(tidy(lines.slice(start + 1, end)).join("\n"));
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};

switch (command) {
  case "version": {
    // A pinned version on the milestone wins over the label-derived bump; that is how a
    // release candidate or a deliberate 1.0.0 is expressed.
    const pin = flag("pin");
    if (pin) {
      parse(pin);
      console.log(pin);
    } else {
      console.log(nextVersion(currentVersion(), flag("bump") ?? "patch"));
    }
    break;
  }
  case "prepare":
    prepare(rest[0] ?? die("usage: node tools/release.js prepare <version>"));
    break;
  case "notes":
    if (rest.includes("--unreleased")) unreleasedNotes();
    else notes(rest[0] ?? die("usage: node tools/release.js notes <version> | notes --unreleased"));
    break;
  case "line":
    // The policy itself lives in release-lane.js, shared by prepare, publish and signing.
    try {
      console.log(laneOf(rest[0] ?? die("usage: node tools/release.js line <version>")));
    } catch (err) {
      die(err.message);
    }
    break;
  case "sync":
    if (rest.length !== 2) die("usage: node tools/release.js sync <version> <source CHANGELOG.md>");
    sync(rest[0], rest[1]);
    break;
  default:
    die("usage: node tools/release.js <version|prepare|notes|line|sync> [...]  (see the header comment)");
}
