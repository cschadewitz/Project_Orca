/** Real installed updater regression fixtures; only Electron/native boundaries use owned substitutes. */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// Resolve through the app's declared dependency, then its own dependency closure.
const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const updaterRequire = createRequire(appRequire.resolve("electron-updater"));
const { NsisUpdater } = appRequire("electron-updater");
const { DownloadedUpdateHelper } = updaterRequire("./DownloadedUpdateHelper.js");
const { DataSplitter } = updaterRequire("./differentialDownloader/DataSplitter.js");
const { GenericDifferentialDownloader } = updaterRequire("./differentialDownloader/GenericDifferentialDownloader.js");
const { executeTasksUsingMultipleRangeRequests } = updaterRequire(
  "./differentialDownloader/multipleRangeDownloader.js",
);
const { ElectronHttpExecutor } = updaterRequire("./electronHttpExecutor.js");
const { CancellationToken, HttpExecutor } = updaterRequire("builder-util-runtime");
const { gzipSync } = await import("node:zlib");

const digest = (data) => createHash("sha512").update(data).digest("base64");
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const cleanups = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "orca-updater-library-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function server(handler) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  cleanups.push(async () => {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
  });
  return `http://127.0.0.1:${instance.address().port}/`;
}

// Keep the library's download, digest and progress implementations. Replace only
// Electron's net.request with Node HTTP to an owned loopback server. This is not
// Electron TLS/session/proxy or installed Windows acceptance.
class LoopbackExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) {
    expect(options.protocol).toBe("http:");
    expect(options.hostname).toBe("127.0.0.1");
    return request(options, callback);
  }
  addRedirectHandlers(...args) {
    return HttpExecutor.prototype.addRedirectHandlers.call(this, ...args);
  }
}

describe("installed updater cache", () => {
  const payload = Buffer.from("synthetic installer bytes, never executed");
  it.each([undefined, null, "", 42, {}, "../outside.exe", "/absolute.exe", "nested/setup.exe"])(
    "rejects invalid cache name %j and cleans only its owned pending directory",
    async (fileName) => {
      const dir = await directory();
      const helper = new DownloadedUpdateHelper(dir);
      await mkdir(helper.cacheDirForPendingUpdate);
      await writeFile(join(dir, "outside.exe"), payload);
      await writeFile(
        join(helper.cacheDirForPendingUpdate, "update-info.json"),
        JSON.stringify({ fileName, sha512: digest(payload) }),
      );
      expect(await helper.getValidCachedUpdateFile({ info: { sha512: digest(payload) } }, logger())).toBeNull();
      expect(await readdir(helper.cacheDirForPendingUpdate)).toEqual([]);
      expect(await readFile(join(dir, "outside.exe"))).toEqual(payload);
    },
  );
  it("reuses a basename only after hashing the actual file; rejects corrupt bytes and changed metadata", async () => {
    const dir = await directory();
    for (const kind of ["valid", "corrupt", "metadata"]) {
      const helper = new DownloadedUpdateHelper(dir);
      await mkdir(helper.cacheDirForPendingUpdate, { recursive: true });
      const file = join(helper.cacheDirForPendingUpdate, "setup.exe");
      await writeFile(file, kind === "corrupt" ? "corrupted" : payload);
      await writeFile(
        join(helper.cacheDirForPendingUpdate, "update-info.json"),
        JSON.stringify({ fileName: "setup.exe", sha512: digest(payload) }),
      );
      const result = await helper.getValidCachedUpdateFile(
        { info: { sha512: digest(kind === "metadata" ? "other" : payload) } },
        logger(),
      );
      expect(result).toBe(kind === "valid" ? file : null);
      if (kind !== "valid") expect(await readdir(helper.cacheDirForPendingUpdate)).toEqual([]);
    }
  });
});

function multipart(parts, eol = "\r\n", boundary = "orca-boundary") {
  return Buffer.from(
    parts
      .map(
        (part) =>
          `--${boundary}${eol}Content-Type: application/octet-stream${eol}X-Owned: fixture${eol}${eol}${part}${eol}`,
      )
      .join("") + `--${boundary}--${eol}`,
  );
}
function sink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}
describe("installed multipart parser and watchdog", () => {
  it.each(["\r\n", "\n"])("parses %j headers and every two-chunk split, plus one-byte chunks", async (eol) => {
    const body = multipart(["ABC", "DEFG"], eol);
    for (const split of [...Array.from({ length: body.length - 1 }, (_, i) => i + 1), -1]) {
      const out = sink();
      const completed = vi.fn();
      const tasks = [
        { kind: 1, start: 0, end: 3 },
        { kind: 1, start: 3, end: 7 },
      ];
      const parser = new DataSplitter(
        out.stream,
        { tasks, start: 0, end: 2, oldFileFd: -1 },
        new Map([
          [0, 0],
          [1, 1],
        ]),
        "orca-boundary",
        [3, 4],
        completed,
        7,
      );
      const chunks =
        split === -1
          ? Array.from(body, (byte) => Buffer.from([byte]))
          : [body.subarray(0, split), body.subarray(split)];
      for (const chunk of chunks) {
        // Completion hands off after the requested parts, before any MIME epilogue.
        if (parser.isFinished) break;
        await new Promise((resolve, reject) => parser.write(chunk, (error) => (error ? reject(error) : resolve())));
      }
      parser.end();
      expect(completed, `split ${split}`).toHaveBeenCalledOnce();
      expect(out.bytes(), `split ${split}`).toEqual(Buffer.from("ABCDEFG"));
    }
  });

  it("keeps a successful first batch's watchdog from rejecting a later batch after 10 seconds", async () => {
    const dir = await directory();
    const count = 1004;
    const old = Buffer.alloc(count * 4);
    const next = Buffer.alloc(count * 4);
    for (let i = 0; i < count; i++) {
      old.writeUInt32LE(i, i * 4);
      next.writeUInt32LE(i % 2 === 0 ? i : i + count, i * 4);
    }
    const map = (bytes) => ({
      version: "2",
      files: [
        {
          name: "file",
          offset: 0,
          sizes: Array(count).fill(4),
          checksums: Array.from({ length: count }, (_, i) => digest(bytes.subarray(i * 4, i * 4 + 4))),
        },
      ],
    });
    let batches = 0;
    const url = await server((req, res) => {
      const ranges = req.headers.range
        .slice(6)
        .split(",")
        .map((range) => range.trim().split("-").map(Number));
      batches++;
      const send = () => {
        res.writeHead(206, { "Content-Type": "multipart/byteranges; boundary=orca-boundary" });
        // Binary payload, with the real multipart parser handling all 502 ranges.
        for (const [start, end] of ranges) {
          res.write(`--orca-boundary\r\nContent-Range: bytes ${start}-${end}/${next.length}\r\n\r\n`);
          res.write(next.subarray(start, end + 1));
          res.write("\r\n");
        }
        res.end("--orca-boundary--\r\n");
      };
      if (batches === 1) send();
      else {
        const timer = setTimeout(send, 10_100);
        cleanups.push(() => clearTimeout(timer));
      }
    });
    await writeFile(join(dir, "old"), old);
    const downloader = new GenericDifferentialDownloader(
      { size: next.length, sha512: digest(next) },
      new LoopbackExecutor(),
      {
        newUrl: new URL(url),
        oldFile: join(dir, "old"),
        newFile: join(dir, "new"),
        logger: logger(),
        isUseMultipleRangeRequest: true,
        cancellationToken: new CancellationToken(),
      },
    );
    await downloader.download(map(old), map(next));
    expect(batches).toBe(2);
    expect(await readFile(join(dir, "new"))).toEqual(next);
  }, 20_000);

  it("still rejects an ended response with missing parts after the watchdog grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let respond;
    const abort = vi.fn();
    const fakeRequest = { end() {}, abort };
    const reject = vi.fn();
    const out = sink();
    const downloader = {
      createRequestOptions: () => ({ headers: {} }),
      options: {},
      httpExecutor: {
        createRequest(_options, callback) {
          respond = callback;
          return fakeRequest;
        },
        addErrorAndTimeoutHandlers() {},
      },
    };
    executeTasksUsingMultipleRangeRequests(
      downloader,
      [
        { kind: 1, start: 0, end: 3 },
        { kind: 1, start: 3, end: 7 },
      ],
      out.stream,
      -1,
      reject,
    )(0);
    const response = new PassThrough();
    response.statusCode = 206;
    response.headers = { "content-type": "multipart/byteranges; boundary=orca-boundary" };
    respond(response);
    const ended = once(response, "end");
    response.end("--orca-boundary\r\nContent-Type: x\r\n\r\nA");
    await ended;
    await vi.advanceTimersByTimeAsync(9999);
    expect(reject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Response ends without calling any handlers" }),
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function feedFixture({
  oldPresent = true,
  corruptOld = false,
  corruptFull = false,
  missingBlockmap = false,
  signature = null,
} = {}) {
  const dir = await directory();
  const previous = Buffer.from("AAAABBBBCCCCDDDD");
  const payload = Buffer.from("AAAAxxxxCCCCyyyy");
  const blockmap = (data) => ({
    version: "2",
    files: [
      {
        name: "file",
        offset: 0,
        sizes: [4, 4, 4, 4],
        checksums: [0, 4, 8, 12].map((i) => digest(data.subarray(i, i + 4))),
      },
    ],
  });
  const oldMap = gzipSync(JSON.stringify(blockmap(previous)));
  const newMap = gzipSync(JSON.stringify(blockmap(payload)));
  const requests = [];
  let expectedToken = "Bearer owned-synthetic-first";
  const baseUrl = await server((req, res) => {
    const path = new URL(req.url, "http://owned.invalid").pathname;
    requests.push({ path, range: req.headers.range, authorization: req.headers.authorization });
    if (req.headers.authorization !== expectedToken) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (path.endsWith(".yml")) {
      res.end(
        JSON.stringify({
          version: "0.6.1",
          files: [{ url: "orca-0.6.1.exe", size: payload.length, sha512: digest(payload) }],
        }),
      );
    } else if (path.endsWith(".blockmap")) {
      if (missingBlockmap) {
        res.writeHead(404);
        res.end();
      } else res.end(path.includes("0.6.1") ? newMap : oldMap);
    } else if (req.headers.range) {
      const ranges = req.headers.range
        .slice(6)
        .split(",")
        .map((r) => r.trim().split("-").map(Number));
      if (ranges.length === 1) {
        const [start, end] = ranges[0];
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${payload.length}` });
        res.end(payload.subarray(start, end + 1));
      } else {
        res.writeHead(206, { "Content-Type": "multipart/byteranges; boundary=orca-boundary" });
        res.end(
          multipart(
            ranges.map(([start, end]) => payload.subarray(start, end + 1).toString()),
            "\n",
          ),
        );
      }
    } else {
      res.writeHead(200, { "Content-Length": payload.length });
      res.end(corruptFull ? Buffer.alloc(payload.length, "!") : payload);
    }
  });
  const config = join(dir, "app-update.yml");
  await writeFile(config, "updaterCacheDirName: cache\npublisherName: Owned Fixture Publisher\n");
  const app = {
    version: "0.6.0",
    name: "owned-updater-fixture",
    isPackaged: true,
    appUpdateConfigPath: config,
    baseCachePath: dir,
    userDataPath: dir,
    whenReady: async () => {},
    onQuit: vi.fn(),
    quit: vi.fn(() => {
      throw new Error("fixture must not quit");
    }),
  };
  const updater = new NsisUpdater(null, app);
  updater.httpExecutor = new LoopbackExecutor();
  updater.setFeedURL({ provider: "generic", url: baseUrl, channel: "latest-x64", useMultipleRangeRequest: true });
  updater.requestHeaders = { Authorization: expectedToken };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.logger = logger();
  // Native Authenticode verification cannot run on this Linux fixture. Exercise
  // the library's publisher dispatch and refusal with an explicit verifier stub.
  updater.verifyUpdateCodeSignature = vi.fn(async () => signature);
  updater.quitAndInstall = vi.fn(() => {
    throw new Error("fixture must not install");
  });
  updater.doInstall = vi.fn(() => {
    throw new Error("fixture must not install");
  });
  const cache = join(dir, "cache");
  await mkdir(join(cache, "pending"), { recursive: true });
  await writeFile(join(cache, "pending", "current.blockmap"), "stale pending map");
  await writeFile(join(cache, "current.blockmap"), oldMap);
  if (oldPresent)
    await writeFile(join(cache, "installer.exe"), corruptOld ? Buffer.alloc(previous.length, "!") : previous);
  return {
    updater,
    cache,
    requests,
    payload,
    newMap,
    app,
    rotate() {
      expectedToken = "Bearer owned-synthetic-rotated";
      updater.requestHeaders = { Authorization: expectedToken };
    },
  };
}

describe("installed NSIS updater with owned HTTP feed and inert bytes", () => {
  it.each(["differential", "evicted-installer", "corrupt-old", "missing-blockmap"])(
    "verifies %s download, fallback and matching cache state",
    async (kind) => {
      const f = await feedFixture({
        oldPresent: kind !== "evicted-installer",
        corruptOld: kind === "corrupt-old",
        missingBlockmap: kind === "missing-blockmap",
      });
      expect((await f.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
      expect(f.requests.every((r) => r.path.endsWith(".yml"))).toBe(true);
      const downloaded = vi.fn();
      f.updater.on("update-downloaded", downloaded);
      const paths = await f.updater.downloadUpdate();
      expect(paths).toHaveLength(1); // Public API remains Array<string> after internal result change.
      expect(await readFile(paths[0])).toEqual(f.payload);
      expect(downloaded).toHaveBeenCalledOnce();
      expect(f.updater.verifyUpdateCodeSignature).toHaveBeenCalledWith(
        ["Owned Fixture Publisher"],
        expect.stringContaining("temp-orca-0.6.1.exe"),
      );
      expect(f.requests.filter((r) => r.path.endsWith(".exe") && !r.range)).toHaveLength(
        kind === "differential" ? 0 : 1,
      );
      if (kind === "missing-blockmap") {
        await expect(readFile(join(f.cache, "current.blockmap"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(f.cache, "pending", "current.blockmap"))).rejects.toMatchObject({ code: "ENOENT" });
      } else expect(await readFile(join(f.cache, "current.blockmap"))).toEqual(f.newMap);
      if (kind === "corrupt-old")
        expect(f.updater.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("sha512 checksum mismatch after differential download"),
        );
      const beforeReuse = f.requests.length;
      expect(await f.updater.downloadUpdate()).toEqual(paths);
      expect(f.requests).toHaveLength(beforeReuse);
      expect(f.requests.every((r) => r.authorization === "Bearer owned-synthetic-first")).toBe(true);
      expect(f.app.onQuit).not.toHaveBeenCalled();
      expect(f.app.quit).not.toHaveBeenCalled();
      expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
      expect(f.updater.doInstall).not.toHaveBeenCalled();
    },
  );

  it.each(["checksum", "publisher"])(
    "refuses a full download with invalid %s and leaves no installable pending file",
    async (kind) => {
      const f = await feedFixture({
        missingBlockmap: true,
        corruptFull: kind === "checksum",
        signature: kind === "publisher" ? "wrong synthetic publisher" : null,
      });
      await f.updater.checkForUpdates();
      const downloaded = vi.fn();
      f.updater.on("update-downloaded", downloaded);
      await expect(f.updater.downloadUpdate()).rejects.toMatchObject({
        code: kind === "checksum" ? "ERR_CHECKSUM_MISMATCH" : "ERR_UPDATER_INVALID_SIGNATURE",
      });
      expect(downloaded).not.toHaveBeenCalled();
      expect(f.updater.installerPath).toBeNull();
      expect(await readdir(join(f.cache, "pending"))).toEqual([]);
      expect(f.app.onQuit).not.toHaveBeenCalled();
      if (kind === "checksum") {
        expect(f.updater.verifyUpdateCodeSignature).not.toHaveBeenCalled();
        expect(f.updater.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("sha512 checksum mismatch after full download"),
        );
      }
    },
  );

  it("retries a 401 with rotated synthetic authorization across metadata, blockmaps and ranges", async () => {
    const f = await feedFixture();
    f.updater.requestHeaders = { Authorization: "Bearer owned-synthetic-expired" };
    await expect(f.updater.checkForUpdates()).rejects.toMatchObject({ statusCode: 401 });
    f.rotate();
    expect((await f.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
    const offset = f.requests.length;
    await f.updater.downloadUpdate();
    expect(f.requests.slice(1).every((r) => r.authorization === "Bearer owned-synthetic-rotated")).toBe(true);
    expect(f.requests.slice(offset).some((r) => r.range)).toBe(true);
    expect(f.requests.slice(offset).some((r) => r.path.endsWith(".blockmap"))).toBe(true);
  });
});
