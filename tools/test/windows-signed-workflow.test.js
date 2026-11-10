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
  expect(Object.keys(signed.jobs)).toEqual(["resolve", "prepare", "sign"]);
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
  const resolveWith = (requested, githubSha) => {
    const out = join(work, `out-${Math.random().toString(16).slice(2)}`);
    writeFileSync(out, "");
    execFileSync("bash", ["-c", script], {
      cwd: clone,
      env: { ...process.env, REQUESTED: requested, GITHUB_SHA: githubSha, GITHUB_OUTPUT: out },
      stdio: "pipe",
    });
    return readFileSync(out, "utf8");
  };
  let main;
  let candidate;
  let sideways;
  let toolChange;
  let unbranched;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "orca-resolve-"));
    const origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "tools/packaged-windows/build-bundle.js", "v1\n");
    main = commit(origin, "README", "main\n");
    git(origin, "checkout", "-qb", "candidate");
    candidate = commit(origin, "package.json", '{"version":"0.7.0-rc.1"}\n');
    git(origin, "checkout", "-qb", "tooling", main);
    toolChange = commit(origin, "tools/packaged-windows/build-bundle.js", "v2\n");
    git(origin, "checkout", "-qb", "old", `${main}~1`);
    sideways = commit(origin, "other", "x\n");
    git(origin, "checkout", "-q", "--detach", main);
    unbranched = commit(origin, "dangling", "d\n");
    git(origin, "checkout", "-q", "main");
    clone = join(work, "clone");
    git(work, "clone", "-q", "--no-local", origin, clone);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("defaults to the dispatching main commit", () => {
    expect(resolveWith("", main)).toBe(`sha=${main}\n`);
  });

  it("accepts a candidate on its own branch that descends from main and keeps the verifiers", () => {
    expect(resolveWith(candidate, main)).toBe(`sha=${candidate}\n`);
  });

  it.each([
    ["an abbreviated SHA", () => candidate.slice(0, 12)],
    ["an uppercase SHA", () => candidate.toUpperCase()],
    ["a branch name", () => "candidate"],
    ["a commit not descended from main", () => sideways],
    ["a commit that changes a signing verifier", () => toolChange],
    ["a commit on no branch of the repository", () => unbranched],
    ["an unknown commit", () => "0".repeat(40)],
  ])("refuses %s", (_, requested) => {
    expect(() => resolveWith(requested(), main)).toThrow();
  });

  it("is what prepare and sign check out, and the artifact name records", () => {
    for (const job of ["prepare", "sign"]) {
      expect(signed.jobs[job].needs).toContain("resolve");
      const checkout = signed.jobs[job].steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
      expect(checkout.with.ref).toBe("${{ needs.resolve.outputs.sha }}");
    }
    expect(signed.jobs.resolve.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(signed.jobs.resolve)).not.toMatch(/id-token|secrets\./);
    const upload = signed.jobs.sign.steps.find((s) => s.name === "Upload the signed artifacts");
    expect(upload.with.name).toBe("windows-signed-${{ needs.resolve.outputs.sha }}");
  });
});
