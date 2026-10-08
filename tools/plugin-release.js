/** Compose candidate closed ESM plugin releases; approval/pin delivery is a separate trusted operation. */
import { createHash } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Reuse the reviewed daemon bundler and tooling parser, at their existing lockfile versions.
// The daemon's require shim and optional native externals are deliberately unavailable here.
const { build } = createRequire(new URL("../packages/app/package.json", import.meta.url))("esbuild");
const ts = createRequire(new URL("./eslint-config/package.json", import.meta.url))("typescript");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => new Error("Unsupported plugin release composition");

// This bounded profile excludes code loaders, native/process/network/filesystem facilities.
// Source review still owns semantic closure: this syntax policy is not a hostile-JS sandbox.
const builtins = new Set([
  "node:assert",
  "node:assert/strict",
  "node:buffer",
  "node:crypto",
  "node:events",
  "node:path",
  "node:path/posix",
  "node:path/win32",
  "node:querystring",
  "node:string_decoder",
  "node:url",
  "node:util",
  "node:util/types",
]);
const loaders = new Set([
  "require",
  "module",
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "WebAssembly",
  "createRequire",
  "getBuiltinModule",
  "global",
  "globalThis",
  "fetch",
  "Worker",
  "Deno",
  "Bun",
  "constructor",
  "__proto__",
  "binding",
  "dlopen",
  "mainModule",
]);

function auditSyntax(source, file, emitted = false) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw refuse();
  function moduleName(node) {
    if (!node || !ts.isStringLiteral(node) || !node.text.length) throw refuse();
    if (node.text.startsWith("node:") && !builtins.has(node.text)) throw refuse();
    if (emitted && !builtins.has(node.text)) throw refuse();
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) moduleName(node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) moduleName(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1) throw refuse();
      moduleName(node.arguments[0]);
    }
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && loaders.has(node.text)) throw refuse();
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

function exactObject(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw refuse();
}

async function readBounded(path, limit) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw refuse();
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size || (await file.stat()).size !== info.size) throw refuse();
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

/**
 * Build without importing/executing any plugin. Input is a reviewed composition plan, not
 * runtime config or release authority. Return a candidate digest, never a trusted reference.
 * Every dependency must be reviewable JS ESM or JSON, with bounded literal import edges.
 */
export async function composePluginRelease(plan) {
  try {
    exactObject(plan, ["plugins"]);
    if (!Array.isArray(plan.plugins) || !plan.plugins.length || plan.plugins.length > 64) throw refuse();
    const ids = new Set();
    const definitions = plan.plugins.map((plugin) => {
      exactObject(plugin, ["entry", "id", "schemaVersion"]);
      if (
        typeof plugin.entry !== "string" ||
        !isAbsolute(plugin.entry) ||
        typeof plugin.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,99}$/.test(plugin.id) ||
        ids.has(plugin.id) ||
        !Number.isSafeInteger(plugin.schemaVersion) ||
        plugin.schemaVersion < 1
      )
        throw refuse();
      ids.add(plugin.id);
      return { entry: plugin.entry, id: plugin.id, schemaVersion: plugin.schemaVersion };
    });
    const bundles = [];
    const plugins = [];
    for (const plugin of definitions) {
      let inputBytes = 0;
      const path = `plugins/${plugin.id}.mjs`;
      const result = await build({
        absWorkingDir: dirname(plugin.entry),
        entryPoints: [`./${basename(plugin.entry)}`],
        outfile: path,
        bundle: true,
        platform: "node",
        format: "esm",
        target: `node${process.versions.node}`,
        write: false,
        metafile: true,
        sourcemap: false,
        splitting: false,
        minify: false,
        logLevel: "silent",
        plugins: [
          {
            name: "reviewed-closed-esm",
            setup(builder) {
              builder.onLoad({ filter: /.*/ }, async ({ path: input }) => {
                const bytes = await readBounded(input, 16 * 1024 * 1024);
                inputBytes += bytes.length;
                if (bytes.length > 16 * 1024 * 1024 || inputBytes > 128 * 1024 * 1024) throw refuse();
                const source = bytes.toString("utf8");
                if (input.endsWith(".json")) {
                  JSON.parse(source);
                  return { contents: source, loader: "json" };
                }
                if (!/\.(mjs|js)$/.test(input)) throw refuse();
                auditSyntax(source, input);
                return { contents: source, loader: "js" };
              });
            },
          },
        ],
      });
      if (result.warnings.length || result.outputFiles.length !== 1) throw refuse();
      const outputs = Object.values(result.metafile.outputs);
      if (outputs.length !== 1 || Object.values(result.metafile.inputs).some((input) => input.format === "cjs"))
        throw refuse();
      const externalImports = [
        ...new Set(
          outputs[0].imports.map((edge) => {
            if (!edge.external || !builtins.has(edge.path)) throw refuse();
            return edge.path;
          }),
        ),
      ].sort();
      const bytes = Buffer.from(result.outputFiles[0].contents);
      if (bytes.length > 64 * 1024 * 1024) throw refuse();
      auditSyntax(bytes.toString("utf8"), path, true);
      bundles.push({ path, bytes });
      plugins.push({
        spec: `./${path}`,
        id: plugin.id,
        schemaVersion: plugin.schemaVersion,
        closure: "closed-node-esm-bundle-v1",
        path,
        sha256: hash(bytes),
        externalImports,
      });
    }
    const manifest = {
      contractVersion: 1,
      runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
      plugins,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.length > 128 * 1024) throw refuse();
    return { manifest, manifestBytes, bundles, candidateManifestSha256: hash(manifestBytes) };
  } catch {
    // Do not expose source text or bundler diagnostics from a refused candidate.
    throw refuse();
  }
}

/** Write a complete candidate only to a new directory; never replace an approved installation. */
export async function writePluginRelease(plan, destination) {
  const candidate = await composePluginRelease(plan);
  await mkdir(destination);
  try {
    await mkdir(join(destination, "plugins"));
    for (const bundle of candidate.bundles) await writeFile(join(destination, bundle.path), bundle.bytes);
    await writeFile(join(destination, "plugin-release.json"), candidate.manifestBytes);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return candidate;
}

// Local candidate generation only. No publisher, signer, config mutation or pin injection.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { plan: { type: "string" }, out: { type: "string" } } });
    if (!values.plan || !values.out) throw refuse();
    const bytes = await readBounded(values.plan, 128 * 1024);
    const candidate = await writePluginRelease(JSON.parse(bytes.toString("utf8")), resolve(values.out));
    console.log(JSON.stringify({ candidateManifestSha256: candidate.candidateManifestSha256, approved: false }));
  } catch {
    console.error("Plugin release candidate refused");
    process.exitCode = 1;
  }
}
