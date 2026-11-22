/** Bundle packages/cli/native-probe/store-carryover-probe.ts beside a copy of the packaged x64 first-run boundary, as the daemon bundle is laid out. */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../..");
const out = process.argv[2];
if (!out) throw new Error("usage: node build-store-carryover-probe.js <output directory>");
await build({
  entryPoints: [join(repo, "packages/cli/native-probe/store-carryover-probe.ts")],
  outfile: join(out, "bin", "probe.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  define: { __ORCA_FIRST_RUN_BUNDLED__: "true", __ORCA_VERSION__: '"0.0.0-probe"' },
  logLevel: "info",
});
const native = join(out, "native", "diagnostics", "win32-x64");
mkdirSync(native, { recursive: true });
for (const name of ["first_run_windows.node", "diagnostics_clock.node"])
  copyFileSync(join(repo, "packages/app/dist/diagnostics-native/win32-x64", name), join(native, name));
