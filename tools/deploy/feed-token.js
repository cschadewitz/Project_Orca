#!/usr/bin/env node
/**
 * Mint one desktop feed read token for a ring:
 *
 *   node tools/deploy/feed-token.js RING
 *
 * Prints the token (give it to the tester; it goes in their ORCA_UPDATE_TOKEN_FILE) and the
 * `FEED_TOKENS` entry to merge into the Worker secret. Only the SHA-256 is kept server side,
 * so a lost token is replaced, never recovered.
 */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RINGS } from "./feed-worker/rings.js";

export function mint(ring, bytes = randomBytes(32)) {
  if (!RINGS.includes(ring)) throw new Error(`ring must be one of: ${RINGS.join(", ")}`);
  const token = bytes.toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, entry: { [hash]: { ring } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { token, entry } = mint(process.argv[2]);
    console.log(`token: ${token}`);
    console.log(`FEED_TOKENS entry: ${JSON.stringify(entry)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
