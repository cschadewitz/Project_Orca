/** Emit the retry fixture's source modules once; verify immutable inputs/output before every fresh fork. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const entry = "packages/engine/test/admission-retry-multiprocess/worker.ts";
export const retrySourceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (path: string) => hash(readFileSync(path));
interface Import {
  path: string;
  original?: string;
  external?: boolean;
  kind: string;
}
interface Graph {
  inputs: Record<string, { imports: Import[] }>;
}
interface Compiler {
  version: string;
  buildSync(options: Record<string, unknown>): { metafile: Graph };
}
interface Package {
  name: string;
  type: string;
  dependencies?: Record<string, string>;
}

export function compileRetryWorker(root = retrySourceRoot) {
  // Resolve esbuild through the already-declared tsx tool, never a phantom root dependency.
  const require = createRequire(join(root, "package.json"));
  const tsxManifest = require.resolve("tsx/package.json");
  const compilerRequire = createRequire(tsxManifest);
  const compiler = compilerRequire("esbuild") as Compiler;
  const controls = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.base.json",
    "packages/engine/test/admission-retry-multiprocess/compiled-worker.ts",
    "packages/engine/test/admission-retry-multiprocess/harness.ts",
  ];
  const inputs = new Map<string, string>();
  const capture = (path: string) => inputs.set(path, digest(path));
  for (const path of controls) capture(join(root, path));
  capture(tsxManifest);
  capture(compilerRequire.resolve("esbuild"));
  const options = {
    absWorkingDir: root,
    platform: "node",
    format: "esm",
    target: `node${process.versions.node}`,
    keepNames: true,
    tsconfig: join(root, "tsconfig.json"),
  };
  // Only discover the graph with a bundle. Executed output keeps individual ESM modules,
  // live bindings, dynamic imports, side effects and shared module identity.
  const graph = compiler.buildSync({
    ...options,
    entryPoints: [entry],
    bundle: true,
    treeShaking: false,
    packages: "external",
    write: false,
    metafile: true,
  }).metafile;
  const sources = Object.keys(graph.inputs).sort();
  const packages = [...new Set(sources.map((path) => path.split("/")[1]!))].sort();
  const aliases = new Map<string, string>();
  for (const path of sources) {
    if (!/^packages\/[^/]+\/(src|test)\/.*\.ts$/.test(path)) throw new Error(`Unsupported retry source: ${path}`);
    capture(join(root, path));
    for (const dependency of graph.inputs[path]!.imports) {
      if (!dependency.external && dependency.original?.startsWith("@orca/")) {
        const previous = aliases.get(dependency.original);
        if (previous && previous !== dependency.path) throw new Error("Ambiguous retry source alias");
        aliases.set(dependency.original, dependency.path);
      }
    }
  }
  const dependencies = new Map<string, string>();
  for (const name of packages) {
    const sourcePackage = join(root, "packages", name);
    capture(join(sourcePackage, "package.json"));
    const manifest = JSON.parse(readFileSync(join(sourcePackage, "package.json"), "utf8")) as Package;
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (version.startsWith("workspace:")) continue;
      const path = join(sourcePackage, "node_modules", dependency);
      const target = realpathSync(path);
      capture(join(target, "package.json"));
      dependencies.set(path, target);
    }
  }
  const verifyInputs = () => {
    for (const [path, expected] of inputs) {
      if (digest(path) !== expected) throw new Error(`Stale retry worker input: ${relative(root, path)}`);
    }
    for (const [path, expected] of dependencies) {
      if (realpathSync(path) !== expected) throw new Error(`Stale retry worker dependency: ${relative(root, path)}`);
    }
  };
  verifyInputs();
  const candidateHash = hash(
    JSON.stringify({
      node: process.version,
      compiler: compiler.version,
      inputs: [...inputs].map(([path, value]) => [relative(root, path), value]).sort(),
    }),
  );
  const parent = join(root, ".orca");
  mkdirSync(parent, { recursive: true });
  // No cross-run disk reuse: a missing/tampered artifact is an error, never a rebuild
  // or a fallback to saved dist. Each supervisor owns and removes its own directory.
  const directory = realpathSync(mkdtempSync(join(parent, `retry-worker-${candidateHash}-`)));
  const links = new Map<string, string>();
  const outputs = new Map<string, string>();
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    outputs.set(path, digest(path));
  };
  const link = (path: string, target: string) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, "junction");
    links.set(path, realpathSync(target));
  };
  try {
    compiler.buildSync({
      ...options,
      entryPoints: sources,
      outbase: root,
      outdir: directory,
      bundle: false,
      sourcemap: "inline",
      treeShaking: false,
    });
    write(join(directory, "package.json"), { type: "module" });
    for (const name of packages) {
      const sourcePackage = join(root, "packages", name);
      const emittedPackage = join(directory, "packages", name);
      const manifest = JSON.parse(readFileSync(join(sourcePackage, "package.json"), "utf8")) as Package;
      if (manifest.type !== "module") throw new Error("Retry closure requires ESM packages");
      const exports: Record<string, string> = {};
      for (const [specifier, source] of aliases) {
        if (specifier === manifest.name || specifier.startsWith(`${manifest.name}/`)) {
          exports[specifier === manifest.name ? "." : `.${specifier.slice(manifest.name.length)}`] =
            `./${relative(join("packages", name), source).replace(/\.ts$/, ".js")}`;
        }
      }
      write(join(emittedPackage, "package.json"), { name: manifest.name, type: manifest.type, exports });
      link(join(directory, "node_modules", manifest.name), emittedPackage);
      // Keep third-party packages external, resolving from each original importing
      // package's pnpm links. Their realpaths/conditions/identities remain the same.
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (version.startsWith("workspace:")) continue;
        const target = dependencies.get(join(sourcePackage, "node_modules", dependency))!;
        link(join(emittedPackage, "node_modules", dependency), target);
      }
    }
    for (const source of sources)
      outputs.set(
        join(directory, source.replace(/\.ts$/, ".js")),
        digest(join(directory, source.replace(/\.ts$/, ".js"))),
      );
    // Reject changes during compilation, including restored equal-size/equal-mtime edits.
    verifyInputs();
    // Derive the complete allowed tree from the emitted files and declared links,
    // never from a snapshot that could register an unexpected shadow package.
    const entries = new Map<string, "file" | "link" | "directory">([[directory, "directory"]]);
    for (const [paths, kind] of [
      [outputs, "file"],
      [links, "link"],
    ] as const) {
      for (const path of paths.keys()) {
        entries.set(path, kind);
        for (let parent = dirname(path); parent !== directory; parent = dirname(parent))
          entries.set(parent, "directory");
      }
    }
    const verifyTree = (path = directory) => {
      const expected = entries.get(path);
      const stat = lstatSync(path);
      // No-follow checks on every ancestor and file also bind emitted realpaths:
      // identical bytes through a replaced symlink must not change module identity.
      if (
        !expected ||
        (expected === "directory" && !stat.isDirectory()) ||
        (expected === "file" && !stat.isFile()) ||
        (expected === "link" && !stat.isSymbolicLink())
      )
        throw new Error(`Stale retry worker tree: ${relative(directory, path)}`);
      if (expected === "directory") {
        for (const name of readdirSync(path)) verifyTree(join(path, name));
      }
    };
    const verify = () => {
      verifyInputs();
      verifyTree();
      for (const [path, expected] of outputs) {
        if (digest(path) !== expected) throw new Error(`Stale retry worker artifact: ${relative(directory, path)}`);
      }
      for (const [path, expected] of links) {
        if (realpathSync(path) !== expected) throw new Error(`Stale retry worker link: ${relative(directory, path)}`);
      }
    };
    verify();
    return {
      entry: resolve(directory, entry.replace(/\.ts$/, ".js")),
      directory,
      candidateHash,
      sourceHashes: Object.fromEntries([...inputs].map(([path, value]) => [relative(root, path), value])),
      artifactHashes: Object.fromEntries([...outputs].map(([path, value]) => [relative(directory, path), value])),
      verify,
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
