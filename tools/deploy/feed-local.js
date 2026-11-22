#!/usr/bin/env node
/**
 * Run the desktop feed Worker (feed-worker/worker.js, unchanged) on this machine, over a
 * directory laid out like the R2 bucket, for the Windows update test (#863, item 5; adopted
 * from T3 Code's mock update server). Nothing here is a second implementation of the feed:
 * requests go through the Worker's own `handle`, only the bucket is a directory.
 *
 *   node tools/deploy/feed-local.js serve DIR PORT CERT KEY TOKENS_JSON
 *       Serve DIR over HTTPS on 127.0.0.1:PORT. TOKENS_JSON is the FEED_TOKENS value.
 *   node tools/deploy/feed-local.js snapshot DIR VERSION FROM...
 *       Copy the named files into DIR/VERSION/ and mark it complete, as feed-r2.sh does.
 *   node tools/deploy/feed-local.js rings DIR JSON
 *       Write DIR/rings.json after the same validation the Worker applies.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer as createHttps } from "node:https";
import { createServer as createHttp } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isVersion, validateRings } from "./feed-worker/rings.js";
import { handle } from "./feed-worker/worker.js";

/** The subset of the R2 binding the Worker uses: head and get (whole or one range). */
export function directoryBucket(root) {
  const base = resolve(root);
  const path = (key) => {
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new Error(`key outside the bucket: ${key}`);
    return full;
  };
  const stat = (key) => {
    try {
      const s = statSync(path(key));
      return s.isFile() ? s : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async head(key) {
      const s = stat(key);
      return s && { size: s.size, httpEtag: `"${s.size}-${Math.trunc(s.mtimeMs)}"` };
    },
    async get(key, options = {}) {
      const s = stat(key);
      if (!s) return null;
      const offset = options.range?.offset ?? 0;
      const length = options.range?.length ?? s.size - offset;
      const handle = await open(path(key));
      try {
        const bytes = Buffer.alloc(length);
        await handle.read(bytes, 0, length, offset);
        return { body: bytes, text: async () => bytes.toString("utf8") };
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * A Node server that turns each request into a fetch Request for the Worker. `log`, when
 * given, gets one line per request: method, path, Range and status, never the token.
 */
export function feedServer({ root, tokens, cert, key, log }) {
  const env = { FEED: directoryBucket(root), FEED_TOKENS: tokens };
  const listener = async (req, res) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const response = await handle(
        new Request(`https://${req.headers.host ?? "localhost"}${req.url}`, {
          method: req.method,
          headers,
        }),
        env,
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === "HEAD" || !response.body ? undefined : Buffer.from(await response.arrayBuffer()));
      log?.(`${req.method} ${req.url} range=${req.headers.range ?? "-"} ${response.status}`);
    } catch {
      res.writeHead(500, { "Cache-Control": "no-store" });
      res.end();
      log?.(`${req.method} ${req.url} range=${req.headers.range ?? "-"} 500`);
    }
  };
  return cert ? createHttps({ cert, key }, listener) : createHttp(listener);
}

export function snapshot(root, version, files) {
  if (!isVersion(version)) throw new Error(`invalid version: ${version}`);
  const dir = join(root, version);
  mkdirSync(dir, { recursive: true });
  for (const file of files) copyFileSync(file, join(dir, basename(file)));
  writeFileSync(join(dir, "complete.json"), `${JSON.stringify({ format: 1, version })}\n`);
}

export function writeRings(root, value) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "rings.json"), `${JSON.stringify(validateRings(value))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, ...rest] = process.argv.slice(2);
  try {
    if (command === "serve" && rest.length === 4) {
      const [port, cert, key, tokens] = rest;
      const server = feedServer({
        root,
        tokens,
        cert: readFileSync(cert),
        key: readFileSync(key),
        log: (line) => console.log(line),
      });
      server.listen(Number(port), "127.0.0.1", () => console.log(`feed on https://127.0.0.1:${port}/`));
    } else if (command === "snapshot" && rest.length >= 2) snapshot(root, rest[0], rest.slice(1));
    else if (command === "rings" && rest.length === 1) writeRings(root, JSON.parse(rest[0]));
    else
      throw new Error(
        "usage: feed-local.js serve DIR PORT CERT KEY TOKENS | snapshot DIR VERSION FILE... | rings DIR JSON",
      );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
