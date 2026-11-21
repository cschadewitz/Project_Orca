/**
 * The real electron-updater NsisUpdater against the feed Worker, with the client's prerelease
 * policy: preview (opted in) is offered the rc, stable is not, and nobody downgrades. Electron's
 * network stack and Windows installation are substituted, so this is not packaged acceptance.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../deploy/feed-worker/worker.js";
import { acceptsVersion } from "../../packages/app/src/main/update-driver.ts";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const updaterRequire = createRequire(appRequire.resolve("electron-updater"));
const { NsisUpdater } = appRequire("electron-updater");
const { ElectronHttpExecutor } = updaterRequire("./electronHttpExecutor.js");
const { HttpExecutor } = updaterRequire("builder-util-runtime");

class LoopbackExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) {
    expect(options.hostname).toBe("127.0.0.1");
    return request(options, callback);
  }
  addRedirectHandlers(...args) {
    return HttpExecutor.prototype.addRedirectHandlers.call(this, ...args);
  }
}

const hex = (text) => createHash("sha256").update(text).digest("hex");
const TOKENS = { preview: "p".repeat(43), stable: "s".repeat(43) };
const installer = (version) => Buffer.from(`synthetic installer ${version}, never executed`);

function snapshot(version, channel) {
  const name = `ORCA-${version}-win-x64.exe`;
  const bytes = installer(version);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  return {
    [`${version}/${name}`]: bytes,
    [`${version}/${channel}-x64.yml`]: Buffer.from(
      `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${bytes.length}\n` +
        `path: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-11-21T00:00:00.000Z'\n`,
    ),
    [`${version}/complete.json`]: Buffer.from("{}"),
  };
}

const objects = new Map(
  Object.entries({
    ...snapshot("0.7.0", "latest"),
    ...snapshot("0.7.1-rc.1", "prerelease"),
    "rings.json": Buffer.from(
      JSON.stringify({
        format: 1,
        rings: {
          internal: { version: "0.7.1-rc.1" },
          preview: { version: "0.7.1-rc.1" },
          stable: { version: "0.7.0" },
        },
      }),
    ),
  }),
);
const bucket = {
  async head(key) {
    const data = objects.get(key);
    return data ? { size: data.length, httpEtag: `"${hex(data).slice(0, 8)}"` } : null;
  },
  async get(key, options = {}) {
    const data = objects.get(key);
    if (!data) return null;
    const { offset = 0, length = data.length - offset } = options.range ?? {};
    const slice = data.subarray(offset, offset + length);
    return { body: new Uint8Array(slice), text: async () => slice.toString() };
  },
};
const env = {
  FEED: bucket,
  FEED_TOKENS: JSON.stringify({ [hex(TOKENS.preview)]: { ring: "preview" }, [hex(TOKENS.stable)]: { ring: "stable" } }),
};

// electron-updater names the channel file after the platform; this is the Windows client.
const platform = Object.getOwnPropertyDescriptor(process, "platform");
beforeEach(() => Object.defineProperty(process, "platform", { ...platform, value: "win32" }));

const cleanups = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function feed() {
  const server = createServer(async (req, res) => {
    const response = await handle(
      new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers }),
      env,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/`;
}

async function client(version, token) {
  const dir = await mkdtemp(join(tmpdir(), "orca-feed-client-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "app-update.yml"), "updaterCacheDirName: cache\npublisherName: Owned Fixture Publisher\n");
  await mkdir(join(dir, "cache"), { recursive: true });
  const app = {
    version,
    name: "owned-feed-client-fixture",
    isPackaged: true,
    appUpdateConfigPath: join(dir, "app-update.yml"),
    baseCachePath: dir,
    userDataPath: dir,
    whenReady: async () => {},
    onQuit: vi.fn(),
    quit: vi.fn(),
  };
  const updater = new NsisUpdater(null, app);
  updater.httpExecutor = new LoopbackExecutor();
  // The same settings update-driver.ts applies.
  updater.setFeedURL({ provider: "generic", url: await feed(), channel: "latest-x64" });
  updater.requestHeaders = { Authorization: `Bearer ${token}` };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  updater.verifyUpdateCodeSignature = vi.fn(async () => null);
  updater.quitAndInstall = vi.fn();
  updater.doInstall = vi.fn();
  return updater;
}

/** What update-driver's check() would report: the offered version, or undefined. */
async function offered(updater, prerelease) {
  const result = await updater.checkForUpdates();
  if (!result || !acceptsVersion(result.updateInfo.version, prerelease ? { ORCA_UPDATE_PRERELEASE: "1" } : {}))
    return undefined;
  return result.isUpdateAvailable ? result.updateInfo.version : undefined;
}

describe("installed client against the ringed feed", () => {
  it("offers an opted-in preview install the rc and downloads its verified installer", async () => {
    const updater = await client("0.7.0", TOKENS.preview);
    expect(await offered(updater, true)).toBe("0.7.1-rc.1");
    const [path] = await updater.downloadUpdate();
    expect(await readFile(path)).toEqual(installer("0.7.1-rc.1"));
    expect(updater.verifyUpdateCodeSignature).toHaveBeenCalledOnce();
  });

  it("ignores the rc on a preview-ring install that did not opt in", async () => {
    expect(await offered(await client("0.7.0", TOKENS.preview), false)).toBeUndefined();
  });

  it("never offers the rc to stable, even with the opt-in set", async () => {
    expect(await offered(await client("0.6.0", TOKENS.stable), true)).toBe("0.7.0");
    expect(await offered(await client("0.7.0", TOKENS.stable), true)).toBeUndefined();
  });

  it("never downgrades: a newer stable install ignores the rc, an rc install ignores older stable", async () => {
    expect(await offered(await client("0.7.1", TOKENS.preview), true)).toBeUndefined();
    expect(await offered(await client("0.7.1-rc.1", TOKENS.stable), true)).toBeUndefined();
    expect(await offered(await client("0.7.1-rc.1", TOKENS.stable), false)).toBeUndefined();
  });

  it("refuses the feed without a valid token", async () => {
    await expect((await client("0.7.0", "x".repeat(43))).checkForUpdates()).rejects.toThrow(/401/);
  });
});
