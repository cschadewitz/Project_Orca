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
 * Usage: node packages/app/scripts/build-daemon.js [--outfile <path>]
 */
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appDir = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({
  options: { outfile: { type: "string" } },
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
  // The floor in the root package.json's `engines`. The desktop build runs it under
  // Electron's Node, which is newer; the standalone artifact may not.
  target: "node22",
  // An ESM bundle has no `require`, and a CommonJS dependency inlined into one can still
  // reach for it (`ws` does, for its optional native speedups). This is the documented
  // shim: a real `require` resolved relative to the bundle.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
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

const bytes = Object.values(result.metafile.outputs).reduce((total, out) => total + out.bytes, 0);
console.log(`daemon bundle: ${outfile.replace(repoRoot, "")} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
console.log(`run it with: node ${outfile.replace(appDir, "")} --cwd <workspace> serve`);
