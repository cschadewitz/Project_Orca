/** Conservative consumer graph; frozen inventory bounds the reviewed presentation-only island. */
import { createRequire } from "node:module";
import { posix } from "node:path";
import { digest, sorted, validPath } from "./git.js";

const require = createRequire(new URL("../eslint-config/package.json", import.meta.url));
const ts = require("typescript");
export const MANIFEST_PATH = "tools/ci-shadow/ownership.v1.json";
export const TOOL_PATHS = [
  "tools/ci-shadow/git.js",
  "tools/ci-shadow/graph.js",
  "tools/ci-shadow/selector.js",
  "tools/ci-shadow/cli.js",
  "tools/ci-shadow/plan.schema.v1.json",
];

export function discover(files) {
  return sorted(
    [...files.keys()].filter(
      (path) =>
        /^packages\/[^/]+\/test\/.+\.test\.ts$/.test(path) ||
        /^packages\/app\/renderer\/test\/.+\.test\.tsx?$/.test(path) ||
        /^tools\/test\/.+\.test\.js$/.test(path),
    ),
  );
}

function unreviewedAmbientReferences(source, allowed) {
  // Bind only this virtual module. No libraries, dependency resolution or candidate I/O.
  const name = "/shadow-candidate.ts";
  const virtualSource = ts.createSourceFile(name, source.text, ts.ScriptTarget.Latest, true, source.scriptKind);
  const host = {
    getSourceFile: (path) => (path === name ? virtualSource : undefined),
    getDefaultLibFileName: () => "unused.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (path) => path === name,
    readFile: (path) => (path === name ? virtualSource.text : undefined),
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
    [name],
    { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    host,
  );
  const checker = program.getTypeChecker();
  const unknown = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (!symbol && !allowed.includes(node.text)) unknown.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(virtualSource);
  return sorted(unknown);
}

function accessShape(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${accessShape(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${accessShape(node.expression)}()`;
  if (ts.isNewExpression(node)) return `new:${accessShape(node.expression)}()`;
  if (ts.isParenthesizedExpression(node)) return accessShape(node.expression);
  return `syntax:${ts.SyntaxKind[node.kind]}`;
}

export function imports(text, path, allowedAmbientReferences) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error("source_parse_error");
  const dependencies = [];
  const bindings = [];
  const callTargets = [];
  const memberReferences = [];
  let unsafe = false;
  const visit = (node) => {
    // Arguments and wording may change, but new API capabilities need graph review.
    if (ts.isCallExpression(node)) callTargets.push(accessShape(node.expression));
    if (ts.isNewExpression(node)) callTargets.push(`new:${accessShape(node.expression)}`);
    if (ts.isPropertyAccessExpression(node)) memberReferences.push(accessShape(node));
    if (
      ts.isElementAccessExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isObjectBindingPattern(node) ||
      ts.isArrayBindingPattern(node) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left)))
    )
      unsafe = true;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      dependencies.push(node.moduleSpecifier.text);
      const module = node.moduleSpecifier.text;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const type = clause?.isTypeOnly ? "type" : "value";
        if (!clause) bindings.push(`${module}::side-effect`);
        if (clause?.name) bindings.push(`${module}::${type}::default::${clause.name.text}`);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
          bindings.push(`${module}::${type}::namespace::${clause.namedBindings.name.text}`);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const binding of clause.namedBindings.elements)
            bindings.push(
              `${module}::${binding.isTypeOnly ? "type" : type}::named::${binding.propertyName?.text ?? binding.name.text}::${binding.name.text}`,
            );
      } else {
        // A new foreign re-export also expands this island's public capability surface.
        bindings.push(`${module}::re-export::${node.exportClause?.getText(source) ?? "*"}`);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) {
        dependencies.push(expression.text);
        bindings.push(`${expression.text}::require::${node.name.text}`);
      }
      unsafe = true;
    }
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
    )
      unsafe = true;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && ["require", "eval", "Function"].includes(node.expression.text)))
    )
      unsafe = true;
    // A new file/transport/ambient execution boundary cannot enter the initial pure island.
    if (
      ts.isIdentifier(node) &&
      [
        "process",
        "globalThis",
        "window",
        "document",
        "navigator",
        "EventSource",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "caches",
        "fetch",
        "XMLHttpRequest",
        "WebSocket",
        "Worker",
        "importScripts",
        "require",
        "eval",
        "Function",
        "constructor",
        "Reflect",
        "Proxy",
      ].includes(node.text)
    )
      unsafe = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (allowedAmbientReferences && unreviewedAmbientReferences(source, allowedAmbientReferences).length) unsafe = true;
  return {
    dependencies: sorted(dependencies),
    bindings: sorted(bindings),
    callTargets: sorted(callTargets),
    memberReferences: sorted(memberReferences),
    unsafe,
  };
}

export function coveredInventory(files, manifest) {
  return digest(
    [...files.values()]
      .filter(
        ({ path }) =>
          !manifest.islands.some((island) => island.paths.includes(path)) &&
          !manifest.prosePaths.includes(path) &&
          !path.startsWith("tools/ci-shadow/") &&
          path !== "tools/test/ci-shadow-selection.test.js" &&
          !path.startsWith("tools/test/ci-shadow/") &&
          path !== "docs/ci-shadow-selection.md",
      )
      .map(({ path, mode, oid }) => ({ path, mode, oid }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}

export function validateManifest(manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.graphVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.reviewedInventoryHash) ||
    !/^[a-f0-9]{40}$/.test(manifest.reviewedCommit) ||
    !Array.isArray(manifest.islands) ||
    !Array.isArray(manifest.prosePaths) ||
    !Array.isArray(manifest.edges) ||
    !Array.isArray(manifest.runners) ||
    !Array.isArray(manifest.fullChecks) ||
    !Array.isArray(manifest.targetedChecks) ||
    !Array.isArray(manifest.fullRiskRules)
  )
    throw new Error("invalid_manifest");
  const paths = [...manifest.prosePaths, ...manifest.islands.flatMap((island) => island.paths)];
  if (manifest.prosePaths.some((path) => path !== "docs/ci-shadow-selection.md"))
    throw new Error("unreviewed_prose_allowlist");
  if (paths.some((path) => !validPath(path)) || sorted(paths).length !== paths.length)
    throw new Error("ambiguous_manifest");
  for (const island of manifest.islands) {
    if (
      island.id !== "renderer-time-presentation" ||
      !island.paths.length ||
      !island.paths.every((path) =>
        ["packages/app/renderer/src/ui/format-time.ts", "packages/app/renderer/test/format-time.test.tsx"].includes(
          path,
        ),
      ) ||
      typeof island.dependencies !== "object" ||
      !island.dependencies ||
      typeof island.importBindings !== "object" ||
      !island.importBindings ||
      island.paths.some(
        (path) =>
          !Array.isArray(island.importBindings[path]) ||
          island.importBindings[path].some((binding) => typeof binding !== "string"),
      ) ||
      ["callTargets", "memberReferences"].some(
        (field) =>
          !island[field] ||
          typeof island[field] !== "object" ||
          island.paths.some(
            (path) =>
              !Array.isArray(island[field][path]) || island[field][path].some((value) => typeof value !== "string"),
          ),
      ) ||
      typeof island.ambientReferences !== "object" ||
      !island.ambientReferences ||
      island.paths.some(
        (path) =>
          !Array.isArray(island.ambientReferences[path]) ||
          island.ambientReferences[path].some((reference) => !["Date", "Math", "undefined"].includes(reference)),
      )
    )
      throw new Error("invalid_island");
  }
  for (const edge of manifest.edges)
    if (!edge.from || !edge.to || !edge.kind || !edge.evidence) throw new Error("invalid_edge");
  for (const rule of manifest.fullRiskRules) {
    if (!rule.id || !rule.pattern || !rule.owner || !rule.reason) throw new Error("invalid_risk_rule");
    new RegExp(rule.pattern);
  }
  for (const runner of manifest.runners)
    if (
      !runner.id ||
      !validPath(runner.config) ||
      !runner.files?.length ||
      runner.files.some((path) => !validPath(path)) ||
      !runner.platforms?.length
    )
      throw new Error("invalid_runner");
  return manifest;
}

const fileNode = (path) => `file:${path}`;
const packageNode = (name) => `package:${name}`;
export function graph(snapshot, manifest) {
  const { files } = snapshot;
  const tests = discover(files);
  const edges = [];
  const gaps = [];
  const add = (from, to, kind) => edges.push({ from, to, kind });
  const resolve = (consumer, specifier) => {
    specifier = specifier.replace(/\?(?:raw|url)$/, "");
    let target;
    if (specifier.startsWith(".")) target = posix.normalize(posix.join(posix.dirname(consumer), specifier));
    else if (specifier.startsWith("@orca/")) {
      const [name, ...rest] = specifier.slice(6).split("/");
      const packagePath = [...files.values()].find(
        (entry) =>
          entry.path.endsWith("/package.json") && entry.text && JSON.parse(entry.text).name === `@orca/${name}`,
      )?.path;
      if (!packagePath) {
        gaps.push({ path: consumer, reason: "unknown_workspace_package", specifier });
        return;
      }
      const pkg = JSON.parse(files.get(packagePath).text);
      const exportKey = rest.length ? `./${rest.join("/")}` : ".";
      const wildcard = Object.keys(pkg.exports ?? {}).find(
        (key) => key.endsWith("/*") && exportKey.startsWith(key.slice(0, -1)),
      );
      let exported =
        typeof pkg.exports === "string" ? pkg.exports : (pkg.exports?.[exportKey] ?? pkg.exports?.[wildcard]);
      if (wildcard && typeof exported === "string")
        exported = exported.replace("*", exportKey.slice(wildcard.length - 1));
      const exportedPath = typeof exported === "string" ? exported : (exported?.import ?? exported?.default);
      target =
        exportedPath && typeof exportedPath === "string"
          ? posix.join(posix.dirname(packagePath), exportedPath)
          : posix.join(posix.dirname(packagePath), "src", rest.join("/") || "index");
    } else return;
    const sourceTarget = target.replace(/^(packages\/[^/]+)\/dist\//, "$1/src/");
    const bare = sourceTarget.replace(/\.[cm]?jsx?$/, "");
    const candidates = [
      target,
      sourceTarget,
      `${bare}.ts`,
      `${bare}.tsx`,
      `${bare}.cts`,
      `${bare}.mts`,
      `${bare}.js`,
      `${bare}/index.ts`,
    ];
    const found = candidates.find((path) => files.has(path));
    if (found)
      add(
        fileNode(found),
        fileNode(consumer),
        target !== sourceTarget ? "compiled-import-source" : "static-import-or-alias",
      );
    else gaps.push({ path: consumer, reason: "unresolved_static_import", specifier });
  };
  for (const entry of files.values()) {
    const pkg = /^packages\/([^/]+)\//.exec(entry.path)?.[1];
    if (pkg) {
      add(fileNode(entry.path), packageNode(pkg), "ownership");
      if (tests.includes(entry.path)) add(packageNode(pkg), fileNode(entry.path), "domain-superset");
    }
    if (entry.path.startsWith("packages/app/renderer/"))
      add(fileNode(entry.path), "domain:renderer", "renderer-ownership");
    if (/\.[cm]?[jt]sx?$/.test(entry.path) && entry.text) {
      try {
        for (const specifier of imports(entry.text, entry.path).dependencies) resolve(entry.path, specifier);
      } catch {
        gaps.push({ path: entry.path, reason: "source_parse_error" });
      }
    }
    if (/^packages\/[^/]+\/package\.json$/.test(entry.path)) {
      const pkgManifest = JSON.parse(entry.text);
      for (const name of Object.keys({ ...pkgManifest.dependencies, ...pkgManifest.devDependencies }))
        if (name.startsWith("@orca/")) add(packageNode(name.slice(6)), packageNode(pkg), "workspace-dependency");
    }
    if (/^packages\/[^/]+\/tsconfig\.json$/.test(entry.path)) {
      const config = ts.parseConfigFileTextToJson(entry.path, entry.text);
      if (config.error) gaps.push({ path: entry.path, reason: "tsconfig_parse_error" });
      else
        for (const ref of config.config.references ?? []) {
          const name = posix.basename(posix.normalize(posix.join(posix.dirname(entry.path), ref.path)));
          add(packageNode(name), packageNode(pkg), "typescript-reference");
        }
    }
  }
  // Selecting the entire app test domain includes source readers and main-side consumers.
  add(packageNode("app"), "domain:renderer", "app-consumer-superset");
  for (const path of tests.filter((path) => path.startsWith("packages/app/")))
    add("domain:renderer", fileNode(path), "renderer-and-app-test-domain");
  for (const edge of manifest.edges) {
    add(edge.from, edge.to, edge.kind);
    for (const node of [edge.from, edge.to])
      if (node.startsWith("file:") && !files.has(node.slice(5)))
        gaps.push({ path: node.slice(5), reason: "explicit_edge_missing" });
  }
  for (const runner of manifest.runners) {
    for (const path of [runner.config, ...runner.files])
      if (!files.has(path)) gaps.push({ path, reason: "runner_input_missing" });
  }
  const inventoryHash = coveredInventory(files, manifest);
  const complete =
    inventoryHash === manifest.reviewedInventoryHash &&
    tests.length > 0 &&
    gaps.length === 0 &&
    [...files.values()].every((entry) => validPath(entry.path) && ["100644", "100755"].includes(entry.mode));
  const uniqueEdges = [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
  );
  // Static imports are a lower bound. Frozen inventory + domain supersets certify only the named island.
  return {
    sha: snapshot.sha,
    tree: snapshot.tree,
    inventoryHash,
    complete,
    tests,
    edges: uniqueEdges,
    gaps,
    hash: digest({ inventoryHash, tests, edges: uniqueEdges, gaps }),
  };
}

export function consumers(graphs, paths) {
  const outgoing = new Map();
  for (const graph of graphs)
    for (const edge of graph.edges) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
      outgoing.get(edge.from).add(edge.to);
    }
  const visited = new Set(paths.map(fileNode));
  const queue = [...visited];
  for (const node of queue)
    for (const next of outgoing.get(node) ?? [])
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
  return sorted(visited);
}
