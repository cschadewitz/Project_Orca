#!/usr/bin/env node
/**
 * The release check's own way to switch a store to SQLite in place (#339), for
 * tools/legacy-fence/run.js only. The shipped CLI refuses `orca store sqlite switch`
 * unconditionally while nothing can keep an already-running released ORCA out; this calls the
 * store package's switch directly, from this checkout's build, and is never shipped.
 *
 *   node tools/legacy-fence/switch.js <workspace>    (after `tsc -b tsconfig.build.json`)
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { switchStoreToSqlite } from "../../packages/store/dist/index.js";

const [workspace] = process.argv.slice(2);
if (!workspace) {
  console.error("usage: switch.js <workspace>");
  process.exit(2);
}
const { version } = createRequire(import.meta.url)("../../package.json");
const storeDir = join(resolve(workspace), ".orca");
const outcome = await switchStoreToSqlite(storeDir, { appVersion: version });
console.log(
  `${outcome.status} ${storeDir} (store format ${outcome.epoch})${outcome.backup ? `, backup ${outcome.backup}` : ""}`,
);
if (outcome.status !== "switched") process.exitCode = 1;
