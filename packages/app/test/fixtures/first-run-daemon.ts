/** Disposable compiled CLI entry. This version marker avoids relying on a relocated package.json. */
Reflect.set(globalThis, "__ORCA_VERSION__", "synthetic-first-run");
const { main } = await import("../../../cli/src/main.js");
process.exitCode = await main(process.argv.slice(2));
