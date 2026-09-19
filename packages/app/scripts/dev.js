// `pnpm --filter @orca/app dev`: the Vite dev server for the renderer plus an Electron
// process pointed at it, in one foreground command.
//
// Why a script rather than two package scripts and `concurrently`: Electron has to start
// *after* the dev server is listening and has to learn its URL, and killing one when the
// other exits is the difference between Ctrl-C ending the session and leaving an orphaned
// Electron behind. Both are a dozen lines here and another dependency otherwise.
//
// Reload is asymmetric and that is on purpose. The renderer hot-reloads through Vite; main
// and preload are compiled by `tsc -b` before launch, so a change there needs a restart.
// Watching and restarting the whole app on every main-process keystroke costs a window
// reload and a fresh daemon handshake each time, which is worse than typing Ctrl-C.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** Run a command to completion, failing the whole script if it fails. */
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

// Electron loads dist/main/index.js and dist/preload/index.js; they are tsc's output, and
// the project references mean this also builds protocol and whatever it needs.
console.log("[orca] building main and preload…");
await run("pnpm", ["exec", "tsc", "-b", "packages/app"], repoRoot);

const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)) });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("the Vite dev server did not report a local URL");
console.log(`[orca] renderer dev server on ${url}`);

const electron = spawn("pnpm", ["exec", "electron", "."], {
  cwd: appDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, ORCA_RENDERER_URL: url },
});

let shuttingDown = false;
const shutdown = async (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
  process.exit(code);
};

electron.on("exit", (code) => void shutdown(code ?? 0));
electron.on("error", (e) => {
  console.error("[orca] could not start Electron:", e.message);
  void shutdown(1);
});
// Ctrl-C reaches Electron too (same process group); this closes the dev server behind it.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(0));
