// What a closed milestone releases, and from where, decided before anything is written
// (docs/RELEASING.md, "Release lines"; release-prepare.yml). Given the milestone's version
// hints and the repository's lines and tags, it returns the version, its line `release/X.Y`,
// and whether that line has to be cut first (from `main` for a new minor, from the newest final
// tag for a patch), or refuses. release-prepare.yml pushes nothing until this has passed.
//
// Usage (offline apart from the cwd's git repository; main's checkout with every ref fetched):
//   node tools/release-plan.js plan --bump <none|patch|minor|major> [--pin V] [--title T]
//     -> prints `version=`, `base=`, `cut=` (empty, `main`, or a `vX.Y.Z` tag) and `from=`
//        (the commit a cut starts at), one per line, for GITHUB_OUTPUT
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { laneOf } from "./release-lane.js";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parse(version) {
  const m = SEMVER.exec(String(version ?? ""));
  if (!m) throw new Error(`not a semver version: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] };
}

export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (const key of ["major", "minor", "patch"]) if (x[key] !== y[key]) return x[key] - y[key];
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The next version for a bump. A candidate is finalized by the bump of its own level:
 * `0.9.0-rc.1` + minor is `0.9.0`, `0.8.1-rc.1` + patch is `0.8.1`, not the release after them.
 * Pre-1.0 a `major` bump counts as a minor one (docs/RELEASING.md, "Versioning").
 */
export function nextVersion(current, bump) {
  const { major, minor, patch, pre } = parse(current);
  const level = bump === "major" && major === 0 ? "minor" : bump;
  if (!["major", "minor", "patch"].includes(level))
    throw new Error(`unknown bump: ${bump} (expected major, minor or patch)`);
  if (pre !== undefined) {
    const own = patch > 0 ? "patch" : minor > 0 || major === 0 ? "minor" : "major";
    const rank = { patch: 0, minor: 1, major: 2 };
    if (rank[level] <= rank[own]) return `${major}.${minor}.${patch}`;
  }
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The plan, or an Error naming why there is none.
 * `repo`: { mainVersion, lines: { "0.9": { version } } (package.json version at each existing
 *   line's head), tags: ["v0.8.0", ...] }.
 * `milestone`: { bump, pin?, title? }.
 */
export function planRelease(milestone, repo) {
  const { bump, pin, title } = milestone;
  if (!pin && (bump ?? "none") === "none") throw new Error("no release:major/minor/patch label and no pinned version");
  const titled = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(title ?? "").trim())?.[1];
  const target = pin || titled || nextVersion(repo.mainVersion, bump);
  const t = parse(target);
  const base = laneOf(target);
  const lineName = base.slice("release/".length);
  const tags = new Set(repo.tags ?? []);
  if (tags.has(`v${target}`)) throw new Error(`tag v${target} already exists`);
  const line = repo.lines?.[lineName];

  let cut = "";
  let from;
  if (line) {
    from = line.version;
  } else if (t.patch === 0) {
    // A new minor's cut. Refuse while an older minor's line is still stabilizing its .0 (cut,
    // no final tagged): that is the next minor being cut by mistake, from a main that already
    // holds work the older .0 does not.
    const open = Object.keys(repo.lines ?? {})
      .filter((name) => compare(`${name}.0`, `${lineName}.0`) < 0 && !tags.has(`v${name}.0`))
      .sort((a, b) => compare(`${a}.0`, `${b}.0`));
    if (open.length)
      throw new Error(
        `release/${open[0]} is still stabilizing (no v${open[0]}.0 yet), so v${target} would cut the next minor ` +
          `early; finish ${open[0]}.0 first, or pin the version you meant`,
      );
    cut = "main";
    from = repo.mainVersion;
  } else {
    const finals = [...tags]
      .map((tag) => tag.slice(1))
      .filter((v) => SEMVER.test(v) && !parse(v).pre && laneOf(v) === base)
      .sort(compare);
    if (!finals.length)
      throw new Error(`${base} does not exist and no v${lineName}.* final is tagged to start it from`);
    cut = `v${finals.at(-1)}`;
    from = finals.at(-1);
  }
  // What the line (or what it is cut from) says, bumped by the labels, must be the target: a
  // version nobody asked for is never prepared.
  const version = pin || nextVersion(from, bump);
  if (version !== target)
    throw new Error(
      `the milestone names ${target} but its labels give v${version} from ${base}; fix the labels or pin the version`,
    );
  if (compare(version, from) <= 0) throw new Error(`v${version} is not after ${from}, which ${base} already holds`);
  return { version, base, cut };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const versionAt = (ref) => JSON.parse(git("show", `${ref}:package.json`)).version;

/** The repository as planRelease reads it, from the cwd's git refs (origin's branches, tags). */
export function readRepo() {
  const lines = {};
  for (const ref of git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/release/").split("\n")) {
    const m = /^refs\/remotes\/origin\/release\/(\d+\.\d+)$/.exec(ref);
    if (m) lines[m[1]] = { version: versionAt(ref) };
  }
  return {
    mainVersion: versionAt("refs/remotes/origin/main"),
    lines,
    tags: git("tag", "-l", "v*").split("\n").filter(Boolean),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  if (args[0] !== "plan") {
    console.error("usage: node tools/release-plan.js plan --bump <none|patch|minor|major> [--pin V] [--title T]");
    process.exit(1);
  }
  try {
    const plan = planRelease({ bump: flag("bump"), pin: flag("pin") || undefined, title: flag("title") }, readRepo());
    const start = plan.cut === "main" ? "refs/remotes/origin/main" : plan.cut ? `refs/tags/${plan.cut}` : "";
    console.log(`version=${plan.version}`);
    console.log(`base=${plan.base}`);
    console.log(`cut=${plan.cut}`);
    console.log(`from=${start ? git("rev-parse", `${start}^{commit}`) : ""}`);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
