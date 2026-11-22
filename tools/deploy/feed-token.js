#!/usr/bin/env node
/**
 * Mint one update feed read token for a ring:
 *
 *   node tools/deploy/feed-token.js RING [--server]
 *
 * `--server` limits the token to the server bundle channel (#877): give it to a server, which
 * then reads nothing of the desktop channel. Without it the token reads both channels.
 *
 * Prints the token (give it to the tester; it goes in their ORCA_UPDATE_TOKEN_FILE) and the
 * `FEED_TOKENS` entry to merge into the Worker secret. Only the SHA-256 is kept server side,
 * so a lost token is replaced, never recovered.
 */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RINGS } from "./feed-worker/rings.js";

export function mint(ring, bytes = randomBytes(32), { server = false } = {}) {
  if (!RINGS.includes(ring)) throw new Error(`ring must be one of: ${RINGS.join(", ")}`);
  const token = bytes.toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, entry: { [hash]: server ? { ring, channel: "server" } : { ring } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const server = args.length === 2 && args[1] === "--server";
    if (args.length !== 1 && !server) throw new Error("usage: feed-token.js RING [--server]");
    const { token, entry } = mint(args[0], undefined, { server });
    console.log(`token: ${token}`);
    console.log(`FEED_TOKENS entry: ${JSON.stringify(entry)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
