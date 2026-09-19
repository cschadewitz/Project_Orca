// Version math and CHANGELOG bookkeeping for a release. Everything here is local and
// offline: the GitHub side (reading the milestone, opening the release PR, creating the
// release) lives in .github/workflows/release-*.yml, so this stays runnable by hand.
//
// Usage:
//   node tools/release.js version --bump minor [--pin 0.2.0-rc.1]   -> prints the next version
//   node tools/release.js prepare 0.2.0                             -> rewrites package.json + CHANGELOG.md
//   node tools/release.js notes 0.2.0                               -> prints that release's CHANGELOG body
//
// The versioning policy it implements is documented in docs/RELEASING.md.
import { readFileSync, writeFileSync } from "node:fs";

const PKG = "package.json";
const CHANGELOG = "CHANGELOG.md";

const UNRELEASED_TEMPLATE = `## Unreleased

### Store format

No change.

### Added

### Changed

### Fixed
`;

const die = (msg) => {
  console.error(msg);
  process.exit(1);
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
  const bumped = pkgText.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
  if (bumped === pkgText) die(`could not rewrite the version field in ${PKG}`);

  const lines = readFileSync(CHANGELOG, "utf8").split("\n");
  const { start, end, body } = unreleasedSection(lines);
  const entries = tidy(body);
  // A release whose notes nobody wrote is worse than no release: the PR checklist asks
  // for an entry per change, so an untouched template means the bookkeeping was skipped.
  if (!entries.some((l) => /^\s*[-*] /.test(l))) {
    die(`${CHANGELOG}'s Unreleased section has no entries; write the release notes first`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const replacement = [...UNRELEASED_TEMPLATE.split("\n"), `## ${version} - ${date}`, "", ...entries, ""];
  writeFileSync(CHANGELOG, [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n"));
  writeFileSync(PKG, bumped);
  console.error(`prepared ${version}: ${PKG} bumped, ${CHANGELOG} section dated ${date}`);
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
    notes(rest[0] ?? die("usage: node tools/release.js notes <version>"));
    break;
  default:
    die("usage: node tools/release.js <version|prepare|notes> [...]  (see the header comment)");
}
