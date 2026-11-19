// Inactive controller library: no CLI, spawn, ACP, or environment inheritance.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const POLICY = Object.freeze({
  frozen: true,
  offline: true,
  scripts: false,
  hooks: false,
  importMethod: "copy",
});
const plans = new WeakMap();
const codes = new Set(
  (
    "PLATFORM PATH SYMLINK PATH_TYPE CANONICAL INPUT_PATH INSTALL_POLICY LIFECYCLE_POLICY " +
    "WORKSPACE_POLICY OUTPUT_SYMLINK SHARED_OR_SPECIAL_FILE HOOK_OR_PRIVATE_CONFIG ASSIGNED_ROOT " +
    "RECORD IDENTITY GIT_IDENTITY RECORDED_IDENTITY INPUT_HASH MANAGER_IDENTITY MANAGER_HASH " +
    "CONTROL_PERMISSIONS PATH_OVERLAP CACHE_MISS SOURCE_HASH PARTIAL_OUTPUT CONTROLLER_REQUIRED " +
    "TRUSTED_PLAN_REQUIRED ALREADY_RESERVED CACHE_TYPE INSTALL_FAILED_OR_CACHE_MISS PREREQUISITE_OR_PARTIAL"
  ).split(" "),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => sha(JSON.stringify(value));
const check = (ok, code) => {
  if (!ok) throw new PreparationError(code);
};
export class PreparationError extends Error {
  constructor(code) {
    const safe = codes.has(code) ? code : "PREREQUISITE_OR_PARTIAL";
    super(`owned-root preparation: ${safe}`);
    this.code = safe;
  }
}
// Never surface OS errors, paths, child logs, or arbitrary thrown strings.
async function bounded(action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PreparationError && codes.has(error.code)) throw new PreparationError(error.code);
    throw new PreparationError("PREREQUISITE_OR_PARTIAL");
  }
}
const inside = (base, file) => file.startsWith(`${base}${path.sep}`);
async function canonical(file, directory = true) {
  check(typeof file === "string" && path.isAbsolute(file) && path.resolve(file) === file, "PATH");
  let current = path.parse(file).root;
  for (const component of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    check(!(await fs.lstat(current)).isSymbolicLink(), "SYMLINK");
  }
  const stat = await fs.lstat(file);
  check(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, "PATH_TYPE");
  check((await fs.realpath(file)) === file, "CANONICAL");
  return stat;
}
async function absent(file) {
  try {
    await fs.lstat(file);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
const inputName = (name) =>
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|(?:packages|tools)\/[^/.][^/]*\/package\.json)$/.test(name);
const forbidden = (name) => /^(\.npmrc|\.pnpmfile\..*|pnpmfile\..*|\.env(?:\..*)?)$/.test(name);

async function inputs(root) {
  const names = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  for (const directory of ["packages", "tools"]) {
    const parent = path.join(root, directory);
    if (await absent(parent)) continue;
    await canonical(parent);
    for (const name of (await fs.readdir(parent)).sort()) {
      const child = path.join(parent, name);
      const stat = await fs.lstat(child);
      check(!stat.isSymbolicLink(), "SYMLINK");
      if (stat.isDirectory() && !(await absent(path.join(child, "package.json"))))
        names.push(`${directory}/${name}/package.json`);
    }
  }
  const hashes = {};
  for (const name of names.sort()) {
    check(inputName(name), "INPUT_PATH");
    await canonical(path.join(root, name), false);
    const bytes = await fs.readFile(path.join(root, name));
    hashes[name] = sha(bytes);
    if (name.endsWith("package.json")) {
      const pkg = JSON.parse(bytes);
      check(!pkg.pnpm, "INSTALL_POLICY");
      for (const key of [
        "preinstall",
        "install",
        "postinstall",
        "preprepare",
        "prepare",
        "postprepare",
        "prepublish",
        "pnpm:devPreinstall",
      ])
        check(!Object.hasOwn(pkg.scripts ?? {}, key), "LIFECYCLE_POLICY");
    }
  }
  // Deliberately narrow YAML subset. Hash approval does not authorize new config keys.
  const lines = (await fs.readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  check(
    lines[0] === "packages:" && lines[1] === '  - "packages/*"' && lines[2] === '  - "tools/*"',
    "WORKSPACE_POLICY",
  );
  if (lines.length > 3) {
    check(lines[3] === "allowBuilds:", "WORKSPACE_POLICY");
    check(
      lines.slice(4).every((line) => /^ {2}(?:[\w@/.-]+|"[\w@/.-]+"):\s(?:true|false)$/.test(line)),
      "WORKSPACE_POLICY",
    );
  }
  return hashes;
}

// Source inventory never follows links or reads auth/config files. Metadata/report
// trees and only the enumerated dependency output directories are excluded.
async function inventory(root, excluded = [], links = false) {
  const entries = [];
  async function visit(relative) {
    const file = relative ? path.join(root, relative) : root;
    const stat = await fs.lstat(file);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      check(links, "OUTPUT_SYMLINK");
      const target = await fs.realpath(file);
      // A target inside an omitted tree has not been audited. It could hide
      // escaping links or shared files even though this first realpath is local.
      check(
        inside(root, target) &&
          !excluded.some((name) => {
            const omitted = path.join(root, name);
            return target === omitted || inside(omitted, target);
          }),
        "OUTPUT_SYMLINK",
      );
      entries.push([relative, "link", await fs.readlink(file)]);
    } else if (stat.isDirectory()) {
      entries.push([relative, "directory", mode]);
      for (const name of (await fs.readdir(file)).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        if (excluded.includes(child)) continue;
        check(!forbidden(name), "HOOK_OR_PRIVATE_CONFIG");
        await visit(child);
      }
    } else {
      check(stat.isFile() && stat.nlink === 1, "SHARED_OR_SPECIAL_FILE");
      entries.push([relative, "file", mode, sha(await fs.readFile(file))]);
    }
  }
  await visit("");
  return { entries, hash: digest(entries) };
}
function outputs(hashes) {
  return [
    "node_modules",
    ...Object.keys(hashes)
      .filter((name) => name !== "package.json" && name.endsWith("/package.json"))
      .map((name) => `${path.posix.dirname(name)}/node_modules`),
  ];
}
async function verify(c, controller, initial) {
  await canonical(c.parent);
  await canonical(c.root);
  check(path.dirname(c.root) === c.parent && c.cwd === c.root, "ASSIGNED_ROOT");
  check(c.record?.cwd === c.root && c.record?.branch === c.branch && c.record?.base === c.base, "RECORD");
  check(
    /^[0-9a-f]{40}$/.test(c.base) &&
      /^orca\/roots\/[a-zA-Z0-9_-]+$/.test(c.branch) &&
      c.branch === `orca/roots/${path.basename(c.root)}`,
    "IDENTITY",
  );
  const identity = await controller.readIdentity(c.root);
  check(
    identity.cwd === c.root && identity.branch === c.branch && identity.head === c.base && identity.clean === true,
    "GIT_IDENTITY",
  );
  check(
    identity.record?.cwd === c.record.cwd &&
      identity.record?.branch === c.record.branch &&
      identity.record?.base === c.record.base,
    "RECORDED_IDENTITY",
  );
  check(JSON.stringify(c.policy) === JSON.stringify(POLICY), "INSTALL_POLICY");
  const hashes = await inputs(c.root);
  check(JSON.stringify(hashes) === JSON.stringify(c.inputs), "INPUT_HASH");
  const pkg = JSON.parse(await fs.readFile(path.join(c.root, "package.json")));
  check(
    /^pnpm@\d+\.\d+\.\d+$/.test(c.manager?.identity) && pkg.packageManager === c.manager.identity,
    "MANAGER_IDENTITY",
  );
  const tool = await canonical(c.manager.executable, false);
  check((tool.mode & 0o111) !== 0 && sha(await fs.readFile(c.manager.executable)) === c.manager.sha256, "MANAGER_HASH");
  const observed = await controller.readManagerIdentity(c.manager.executable);
  check(observed === c.manager.identity, "MANAGER_IDENTITY");
  await canonical(c.cache);
  const control = await canonical(c.control);
  check(control.uid === process.getuid() && (control.mode & 0o777) === 0o700, "CONTROL_PERMISSIONS");
  const paths = [c.root, c.cache, c.control];
  check(
    paths.every((a) => paths.every((b) => a === b || (!inside(a, b) && !inside(b, a)))),
    "PATH_OVERLAP",
  );
  check(new Set(paths).size === 3 && !inside(c.root, c.manager.executable), "PATH_OVERLAP");
  const cache = await inventory(c.cache);
  check(cache.entries.some((entry) => entry[1] === "file") && cache.hash === c.cacheDigest, "CACHE_MISS");
  const excluded = [".git", ".orca", ...outputs(hashes)];
  const source = await inventory(c.root, excluded);
  check(source.hash === c.sourceDigest, "SOURCE_HASH");
  if (initial) for (const output of outputs(hashes)) check(await absent(path.join(c.root, output)), "PARTIAL_OUTPUT");
  return { hashes, source, cache };
}

export async function constructPlan(contract, controller) {
  return bounded(async () => {
    // UID, mode and executable-bit checks are Linux admission requirements.
    // Never substitute Windows ACL guesses or synthetic ownership observations.
    check(process.platform === "linux" && typeof process.getuid === "function", "PLATFORM");
    // Controller must supply a reviewed record, never reconstruct it from the root.
    check(
      controller?.exclusiveBeforeAgent === true &&
        controller.protectedState === true &&
        controller.immutablePrerequisites === true &&
        typeof controller.readIdentity === "function" &&
        typeof controller.readManagerIdentity === "function",
      "CONTROLLER_REQUIRED",
    );
    const c = structuredClone(contract);
    const evidence = await verify(c, controller, true);
    const modules = path.join(c.root, "node_modules");
    const store = path.join(modules, ".orca-store");
    const home = path.join(modules, ".orca-home");
    const plan = Object.freeze({
      executable: c.manager.executable,
      cwd: c.root,
      args: Object.freeze([
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--manage-package-manager-versions=false",
        "--package-manager-strict-version=true",
        "--package-import-method=copy",
        "--node-linker=isolated",
        "--enable-global-virtual-store=false",
        `--store-dir=${store}`,
        `--virtual-store-dir=${path.join(modules, ".pnpm")}`,
        "--verify-store-integrity=true",
        "--side-effects-cache=false",
        "--reporter=silent",
      ]),
      env: Object.freeze({
        PATH: "",
        HOME: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
        TMPDIR: home,
        CI: "true",
        COREPACK_ENABLE_NETWORK: "0",
        NPM_CONFIG_USERCONFIG: path.join(home, "empty.npmrc"),
        NPM_CONFIG_GLOBALCONFIG: path.join(home, "empty.npmrc"),
      }),
      stdio: Object.freeze(["ignore", "ignore", "ignore"]),
      timeoutMs: 120000,
    });
    plans.set(plan, { c, controller, evidence, modules, store, home });
    return plan;
  });
}

async function copyCache(source, destination) {
  await fs.mkdir(destination, { mode: 0o700 });
  for (const name of (await fs.readdir(source)).sort()) {
    const from = path.join(source, name),
      to = path.join(destination, name);
    const stat = await fs.lstat(from);
    if (stat.isDirectory()) await copyCache(from, to);
    else {
      check(stat.isFile() && stat.nlink === 1, "CACHE_TYPE");
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      await fs.chmod(to, 0o600);
    }
  }
}

// Injection point for a FUTURE trusted controller runner; this module supplies none.
// Synthetic tests use only JS filesystem callbacks, never a real package manager.
export async function prepare(plan, runner) {
  return bounded(async () => {
    check(process.platform === "linux" && typeof process.getuid === "function", "PLATFORM");
    const state = plans.get(plan);
    check(state && typeof runner === "function", "TRUSTED_PLAN_REQUIRED");
    const { c, controller, modules, store, home } = state;
    const slot = path.join(c.control, sha(c.root));
    const control = await canonical(c.control);
    check(control.uid === process.getuid() && (control.mode & 0o777) === 0o700, "CONTROL_PERMISSIONS");
    // Atomic reservation retained forever, including failures. Never auto-recover.
    try {
      await fs.mkdir(slot, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") throw new PreparationError("ALREADY_RESERVED");
      throw error;
    }
    await fs.writeFile(path.join(slot, "state.json"), JSON.stringify({ status: "preparing", contract: digest(c) }), {
      flag: "wx",
      mode: 0o600,
    });
    await verify(c, controller, true);
    await fs.mkdir(modules, { mode: 0o700 });
    await copyCache(c.cache, store);
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, "empty.npmrc"), "", { flag: "wx", mode: 0o600 });
    const result = await runner(plan);
    check(result?.exitCode === 0 && result?.cacheComplete === true, "INSTALL_FAILED_OR_CACHE_MISS");
    await verify(c, controller, false);
    await canonical(path.join(modules, ".pnpm"));
    await canonical(path.join(modules, ".modules.yaml"), false);
    // Audit the entire root's links/hardlinks, including all dependency outputs.
    const inventoryHash = await preparedFingerprint(c.root);
    const receipt = Object.freeze({ status: "prepared", contract: digest(c), inventory: inventoryHash });
    await fs.writeFile(path.join(slot, "prepared.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    return receipt;
  });
}

// For offline review/test fixture authors; does not approve, execute, or write.
export async function preparedFingerprint(root) {
  return bounded(async () => {
    await canonical(root);
    return (await inventory(root, [".git", ".orca"], true)).hash;
  });
}
export async function fingerprint(root) {
  return bounded(async () => {
    await canonical(root);
    const hashes = await inputs(root);
    return { inputs: hashes, sourceDigest: (await inventory(root, [".git", ".orca", ...outputs(hashes)])).hash };
  });
}
export async function cacheFingerprint(cache) {
  return bounded(async () => {
    await canonical(cache);
    return (await inventory(cache)).hash;
  });
}
