/**
 * Bundle `orca serve` into the single file the desktop app ships and spawns.
 *
 * Input is the *built* CLI (`packages/cli/dist/main.js`), so `pnpm run build` comes first
 * and the bundle is made of the same JavaScript `node packages/cli/dist/main.js` runs — the
 * daemon in the desktop artifact and the daemon on the release page are one build of one
 * commit, which is the whole reason their protocol versions agree by construction
 * (docs/RELEASING.md).
 *
 * Output is `packages/app/dist/daemon/orca-daemon.mjs`: one ESM file with every workspace
 * package and every third-party dependency inlined, and no `node_modules` beside it. That
 * matters twice over. electron-builder would otherwise have to copy a pnpm store's worth of
 * symlinked directories into the app's resources, and the daemon has to keep working when
 * it is spawned from inside a signed, read-only application bundle.
 *
 * Nothing here is Electron-specific: the same file is the release's standalone daemon
 * artifact, runnable on any Node the repository supports.
 *
 * `--server` also writes, beside the bundle, the two programs the daemon starts from a path
 * relative to its own module: `native-io-worker.js` (the host-resources telemetry worker) and
 * `scripted-agent/main.js` (the scripted agent `orca demo` drives). Both are ESM, so the
 * directory needs a `package.json` with `"type": "module"`, which the headless server bundle
 * (tools/deploy/server-bundle.py, #876) carries. The desktop app's packaging takes the `.mjs`
 * alone and is unchanged.
 *
 * Usage: node packages/app/scripts/build-daemon.js [--outfile <path>] [--server]
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appDir = fileURLToPath(new URL("../", import.meta.url));

// The CLI reads the release version out of the root package.json at a path relative to the
// module doing the reading. Bundling moves that module, so the path stops meaning what it
// meant: it resolved to `packages/app/package.json` while the bundle sat in the app's dist
// (same version by coincidence, so nothing looked wrong) and to nothing once
// electron-builder relocated it to `resources/daemon/`, where the daemon died on startup
// before it could serve. Read the version here, where the layout is known, and substitute
// it below — the same manifest the CLI reads, so this is a second *route* to the version
// and not a second source of it.
const { version: releaseVersion } = createRequire(import.meta.url)("../../../package.json");

const { values } = parseArgs({
  options: { outfile: { type: "string" }, server: { type: "boolean" } },
});

const cliDist = fileURLToPath(new URL("../../cli/dist/", import.meta.url));
const outfile = values.outfile ?? fileURLToPath(new URL("../dist/daemon/orca-daemon.mjs", import.meta.url));

const result = await build({
  // A generated entry rather than `packages/cli/dist/main.js` itself. That file only runs
  // its own `main()` when `process.argv[1]` ends in `main.js` — the guard that lets the
  // rest of the repository import it as a module — and the bundle is called something
  // else, so imported as-is it would parse, export `main`, and exit 0 having served
  // nothing. Calling `main()` explicitly is the honest way to say "this file is a program".
  stdin: {
    contents: ['import { main } from "./main.js";', "process.exitCode = await main(process.argv.slice(2));", ""].join(
      "\n",
    ),
    resolveDir: cliDist,
    sourcefile: "orca-daemon.mjs",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // The floor in the root package.json's `engines`, also met by Electron's bundled Node.
  target: "node24",
  // An ESM bundle has no `require`, and a CommonJS dependency inlined into one can still
  // reach for it (`ws` does, for its optional native speedups). This is the documented
  // shim: a real `require` resolved relative to the bundle.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  // Substituted into `packages/cli/src/commands/index.ts`, which falls back to reading the
  // root package.json itself only when this is absent. The root's version and not a
  // package's: it is the version the tag, the changelog and the release page carry, and the
  // packages under packages/ never move off 0.1.0 (docs/RELEASING.md). So the bundled
  // daemon reports exactly what `orca serve` reports from the same commit, and both report
  // the release (#229).
  define: { __ORCA_VERSION__: JSON.stringify(releaseVersion), __ORCA_FIRST_RUN_BUNDLED__: "true" },
  // `ws`'s optional native accelerators. They are `try`-ed at runtime and absent here by
  // design — bundling a prebuilt binary per platform to shave a memcpy is not a trade
  // worth making for a loopback socket.
  external: ["bufferutil", "utf-8-validate"],
  // A stack trace out of the daemon is something an operator pastes into an issue, and a
  // bundle without a map makes it unreadable. The map stays on the machine that built it:
  // both the app's `extraResources` filter and the workflow's upload glob take `.mjs` only,
  // so a release carries the bundle and a CI run's failure can still be read where it
  // happened. Not minifying is the other half of that — the bundle is 1.7 MB of an artifact
  // measured in hundreds, and shrinking it would buy nothing but unreadable frames.
  sourcemap: true,
  minify: false,
  logLevel: "info",
  metafile: true,
});

// ORCA's Claude tool-call hook (#704), which a Claude agent runs once per tool call with the
// daemon's own runtime. It sits beside the bundle, where `claudePreToolHookScript()` looks
// for it, and is `.mjs` so the desktop app's `extraResources` filter carries it too.
await build({
  entryPoints: [fileURLToPath(new URL("../../agents/dist/bin/claude-pre-tool-hook.js", import.meta.url))],
  outfile: join(dirname(outfile), "claude-pre-tool-hook.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  minify: false,
  logLevel: "info",
});

if (values.server) {
  // Built from the compiled packages, the same JavaScript the unbundled daemon starts.
  for (const [entry, target] of [
    ["../../daemon/dist/host-resources/native-io-worker.js", "native-io-worker.js"],
    ["../../testing/dist/scripted-agent/main.js", "scripted-agent/main.js"],
  ]) {
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      outfile: join(dirname(outfile), target),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
      },
      minify: false,
      logLevel: "info",
    });
  }
}

const bytes = Object.values(result.metafile.outputs).reduce((total, out) => total + out.bytes, 0);
console.log(`daemon bundle: ${outfile.replace(repoRoot, "")} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
console.log(`run it with: node ${outfile.replace(appDir, "")} --cwd <workspace> serve`);

// The fixed daemon loader resolves only beside this exact bundle. Windows first-run
// refuses when either source-built addon is absent; no repository/runtime fallback.
if (process.platform === "win32") {
  const native = join(dirname(outfile), "../native/diagnostics", `win32-${process.arch}`);
  for (const name of ["first_run_windows.node", "diagnostics_clock.node"]) {
    const source = join(appDir, "native/diagnostics/build/Release", name);
    if (existsSync(source)) {
      mkdirSync(native, { recursive: true });
      copyFileSync(source, join(native, name));
    }
  }
}
