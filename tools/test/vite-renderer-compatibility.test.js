/** Real Vite build/dev-server checks; file URL structure and HMR transport are not Electron UI proof. */
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import rendererConfig from "../../packages/app/vite.config.ts";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const { build, createServer } = await import(pathToFileURL(appRequire.resolve("vite")).href);
const productionCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";
const scratch = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "orca-vite-compat-"));
  scratch.push(dir);
  return dir;
}

it("builds real renderer assets with production CSP, relative file URLs, external fonts and source maps", async () => {
  // Vitest sets NODE_ENV=test. Match the real production build command so Vite
  // folds import.meta.env.DEV and excludes preview routes exactly as packaging does.
  vi.stubEnv("NODE_ENV", "production");
  const dir = await directory();
  const outDir = join(dir, "renderer");
  const mainMarker = join(dir, "main", "keep");
  await mkdir(join(dir, "main"));
  await writeFile(mainMarker, "main/preload output must survive");
  await build({ ...rendererConfig, configFile: false, logLevel: "silent", build: { ...rendererConfig.build, outDir } });
  const html = await readFile(join(outDir, "index.html"), "utf8");
  expect(html).toContain(`content="${productionCsp}"`);
  expect(html.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(
    /\bcrossorigin\b|unsafe-inline|localhost|127\.0\.0\.1|@vite\/client|@react-refresh/,
  );
  const refs = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((match) => match[1]);
  expect(refs.some((ref) => ref.endsWith(".js"))).toBe(true);
  expect(refs.some((ref) => ref.endsWith(".css"))).toBe(true);
  for (const ref of refs) {
    const url = new URL(ref, pathToFileURL(join(outDir, "index.html")));
    expect(url.protocol).toBe("file:");
    expect(relative(outDir, fileURLToPath(url)).startsWith("..")).toBe(false);
    expect((await readFile(url)).length).toBeGreaterThan(0);
  }
  const assets = await readdir(join(outDir, "assets"));
  const css = await readFile(
    join(
      outDir,
      refs.find((ref) => ref.endsWith(".css")),
    ),
    "utf8",
  );
  const fonts = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) =>
    match[1].replaceAll('"', "").replaceAll("'", ""),
  );
  expect(fonts).toHaveLength(8);
  expect(css).not.toContain("data:font");
  for (const font of fonts)
    expect(
      (
        await readFile(
          new URL(
            font,
            pathToFileURL(
              join(
                outDir,
                refs.find((ref) => ref.endsWith(".css")),
              ),
            ),
          ),
        )
      ).length,
    ).toBeGreaterThan(0);
  const js = refs.find((ref) => ref.endsWith(".js"));
  const map = JSON.parse(await readFile(join(outDir, js + ".map"), "utf8"));
  expect(map.version).toBe(3);
  expect(map.sources.some((source) => source.endsWith("renderer/src/main.tsx"))).toBe(true);
  expect(map.sourcesContent.length).toBe(map.sources.length);
  expect(assets.filter((name) => /preview|type-proof/.test(name))).toEqual([]);
  expect(await readFile(mainMarker, "utf8")).toBe("main/preload output must survive");
});

function message(socket, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      socket.removeEventListener("error", fail);
    };
    const receive = (event) => {
      const value = JSON.parse(event.data);
      if (predicate(value)) {
        cleanup();
        resolve(value);
      }
    };
    const fail = () => {
      cleanup();
      reject(new Error("owned HMR websocket failed"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("owned HMR websocket timed out"));
    }, 10_000);
    socket.addEventListener("message", receive);
    socket.addEventListener("error", fail);
  });
}

it("relaxes only served dev HTML and sends an actual HMR update after an owned file changes", async () => {
  const dir = await directory();
  const html = `<meta http-equiv="Content-Security-Policy" content="${productionCsp}"><script type="module" src="/hot.js"></script>`;
  await writeFile(join(dir, "index.html"), html);
  await writeFile(join(dir, "hot.js"), "export const value = 1; if (import.meta.hot) import.meta.hot.accept();");
  const server = await createServer({
    ...rendererConfig,
    configFile: false,
    root: dir,
    cacheDir: join(dir, "cache"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let socket;
  try {
    await server.listen();
    const address = server.httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    const served = await (await fetch(base)).text();
    expect(served).toContain("script-src 'self' 'unsafe-inline'");
    expect(served).toContain("style-src 'self' 'unsafe-inline'");
    expect(served).toContain("ws://127.0.0.1:*");
    expect(served).toContain("/@vite/client");
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(html);
    expect(await (await fetch(base + "/hot.js")).text()).toContain("createHotContext");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`, "vite-hmr");
    await message(socket, (value) => value.type === "connected");
    const update = message(socket, (value) => value.type === "update");
    await writeFile(join(dir, "hot.js"), "export const value = 2; if (import.meta.hot) import.meta.hot.accept();");
    const received = await update;
    expect(received.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "js-update", path: "/hot.js", acceptedPath: "/hot.js" }),
      ]),
    );
    expect(await (await fetch(base + "/hot.js")).text()).toContain("value = 2");
  } finally {
    if (socket && socket.readyState < 2) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
    await server.close();
  }
});
