// Shared by codemod.mjs and audit.mjs: reads map.json and applies it to text and paths.
// Pure functions only, so tools/test/rename-codemod.test.js can pin every rule.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

export const MAP_PATH = fileURLToPath(new URL("./map.json", import.meta.url));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `**` crosses directories, `*` stays inside one segment. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

export function loadMap(path = MAP_PATH) {
  return compileMap(JSON.parse(readFileSync(path, "utf8")));
}

export function compileMap(raw) {
  return {
    raw,
    lineMarker: raw.lineMarker,
    blockStart: raw.blockStart,
    blockEnd: raw.blockEnd,
    exclude: raw.exclude.map(globToRegExp),
    binary: new Set(raw.binaryExtensions),
    keep: raw.keep.map((k) => new RegExp(k.pattern, "g")),
    rules: raw.rules.map((r) => ({
      re: new RegExp(r.regex ? r.from : escape(r.from), "g"),
      to: r.to,
    })),
  };
}

export const isExcluded = (map, path) => map.exclude.some((re) => re.test(path));
export const isBinaryPath = (map, path) => map.binary.has(extname(path).toLowerCase());

/** Rename one run of text with no keep markers in it. Returns the text and how many replacements. */
export function renameSpan(map, text) {
  const held = [];
  let masked = text;
  for (const re of map.keep) {
    masked = masked.replace(re, (m) => {
      held.push(m);
      return `\uE000${held.length - 1}\uE000`;
    });
  }
  let count = 0;
  for (const { re, to } of map.rules) {
    masked = masked.replace(re, () => {
      count++;
      return to;
    });
  }
  return { text: masked.replace(/\uE000(\d+)\uE000/g, (_, i) => held[Number(i)]), count };
}

/** Rename a file's text, leaving lines marked `rename-keep` and blocks between the start/end markers. */
export function renameText(map, text) {
  const lines = text.split(/(?<=\n)/);
  let inBlock = false;
  let count = 0;
  const out = lines.map((line) => {
    if (line.includes(map.blockStart)) inBlock = true;
    if (line.includes(map.blockEnd)) {
      inBlock = false;
      return line;
    }
    if (inBlock || line.includes(map.lineMarker)) return line;
    const r = renameSpan(map, line);
    count += r.count;
    return r.text;
  });
  return { text: out.join(""), count };
}

/** New path for a tracked file, or the same path when nothing in it changes. */
export function renamePath(map, path) {
  if (isExcluded(map, path)) return path;
  return path
    .split("/")
    .map((seg) => renameSpan(map, seg).text)
    .join("/");
}

/** Matches the audit counts as a leftover: the three spellings, never `orCa` inside EditorCanvas. */
export const LEFTOVER = /orca|Orca|ORCA/g;

/** Leftover occurrences in text after keep patterns and keep markers are set aside. */
export function leftovers(map, text) {
  const found = [];
  let inBlock = false;
  text.split("\n").forEach((line, i) => {
    if (line.includes(map.blockStart)) inBlock = true;
    if (line.includes(map.blockEnd)) {
      inBlock = false;
      return;
    }
    if (inBlock || line.includes(map.lineMarker)) return;
    let masked = line;
    for (const re of map.keep) masked = masked.replace(re, (m) => "\uE000".repeat(m.length));
    for (const m of masked.matchAll(LEFTOVER)) found.push({ line: i + 1, column: m.index + 1, text: line.trim() });
  });
  return found;
}
