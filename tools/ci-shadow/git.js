/** Read immutable Git objects and NUL-delimited changes; never execute candidate code. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const sorted = (values) => [...new Set(values)].sort();
export const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
export const digest = (value) => hash(JSON.stringify(canonical(value)));
export const git = (repo, args, input) =>
  execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: repo,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });

export function validPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "\\",
    ) &&
    !path.startsWith("/") &&
    !path.startsWith("-") &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

const FULL_SHA = /^[a-f0-9]{40}$/;

/** Require every id to be a full 40-character id naming a commit that is present, in one `cat-file` call. */
export function commits(repo, shas) {
  const full = [...new Set(shas.filter((sha) => FULL_SHA.test(sha)))];
  const isCommit = new Map();
  if (full.length) {
    // One line per id: `<id> <type> <size>`, or `<id> missing`. Only a commit passes.
    const lines = git(repo, ["cat-file", "--batch-check"], full.join("\n") + "\n")
      .toString()
      .split("\n");
    if (lines.length !== full.length + 1 || lines[full.length] !== "") throw new Error("commit_unavailable");
    full.forEach((sha, index) => isCommit.set(sha, lines[index].startsWith(`${sha} commit `)));
  }
  // Judge in the order given, so the first bad id decides which error is thrown.
  for (const sha of shas) {
    if (!FULL_SHA.test(sha)) throw new Error("identity_requires_full_commit_sha");
    if (!isCommit.get(sha)) throw new Error("commit_unavailable");
  }
  return shas;
}

export const commit = (repo, sha) => commits(repo, [sha])[0];

/** Throw unless every one of `ancestors` is `descendant` or lies in its history. */
function requireAncestors(repo, ancestors, descendant) {
  // A commit that is not in the descendant's history is listed by `rev-list` (it reaches itself),
  // so an empty answer proves them all with one process. Only that proof may skip the strict
  // per-commit checks: any other answer, or a Git failure, falls through to them, and they
  // decide and report exactly as they always have.
  try {
    if (!git(repo, ["rev-list", "--max-count=1", ...ancestors, "--not", descendant, "--"]).length) return;
  } catch {
    // Not proven; the strict checks below decide.
  }
  for (const sha of ancestors) git(repo, ["merge-base", "--is-ancestor", sha, descendant]);
}

export function identities(repo, base, head, candidate) {
  commits(repo, [base, head, candidate]);
  const bases = git(repo, ["merge-base", "--all", base, head]).toString().trim().split("\n");
  if (bases.length !== 1 || !FULL_SHA.test(bases[0])) throw new Error("ambiguous_merge_base");
  requireAncestors(repo, [base, head], candidate);
  return { base, head, mergeBase: bases[0], candidate };
}

export function parseChanges(buffer, origin) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (text && !text.endsWith("\0")) throw new Error("truncated_diff");
  const parts = text.split("\0");
  parts.pop();
  const records = [];
  while (parts.length) {
    const status = parts.shift();
    if (!/^(?:[MADTU]|[RC](?:100|[1-9]?\d))$/.test(status)) throw new Error("malformed_diff_status");
    const oldPath = parts.shift();
    const path = /^[RC]/.test(status) ? parts.shift() : oldPath;
    if (oldPath === undefined || path === undefined) throw new Error("truncated_diff");
    records.push({ origin, status, path, oldPath: /^[RCD]/.test(status) ? oldPath : null });
  }
  return records;
}

export const changes = (repo, from, to, origin) =>
  parseChanges(
    git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", from, to, "--"]),
    origin,
  );

// A full commit id names immutable content, so its snapshot is read once per process. Anything
// else (a ref, `HEAD`, a revision expression) can move and is never cached. Nothing here caches
// HEAD, the work tree or refs: callers that need those re-read them every time.
const snapshots = new Map();
const SNAPSHOT_CACHE_LIMIT = 8;

export function snapshot(repo, sha) {
  if (!FULL_SHA.test(sha)) return readSnapshot(repo, sha);
  const key = `${resolve(repo)}\0${sha}`;
  let cached = snapshots.get(key);
  if (cached) snapshots.delete(key);
  else {
    cached = readSnapshot(repo, sha);
    // Shared between callers, so make a mistaken write fail loudly instead of leaking into a later read.
    for (const entry of cached.files.values()) Object.freeze(entry);
    Object.freeze(cached);
  }
  // Least recently used out first, so a long run cannot hold every snapshot it ever read.
  if (snapshots.size >= SNAPSHOT_CACHE_LIMIT) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(key, cached);
  return cached;
}

function readSnapshot(repo, sha) {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(git(repo, ["ls-tree", "-rz", "--full-tree", sha]));
  if (!raw.endsWith("\0")) throw new Error("truncated_tree");
  const entries = raw
    .slice(0, -1)
    .split("\0")
    .map((record) => {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("malformed_tree");
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    });
  const files = new Map(entries.map((entry) => [entry.path, entry]));
  const scripts = entries.filter((entry) => entry.type === "blob" && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.path));
  // The root tree is the first object of the batch, ahead of the script blobs: its header names
  // it, which saves a separate `rev-parse` process per snapshot.
  const batch = git(
    repo,
    ["cat-file", "--batch"],
    [`${sha}^{tree}`, ...scripts.map((entry) => entry.oid)].join("\n") + "\n",
  );
  const treeEnd = batch.indexOf(10);
  const treeHeader = /^([a-f0-9]{40}) tree (\d+)$/.exec(batch.subarray(0, treeEnd).toString());
  if (!treeHeader) throw new Error("invalid_tree_batch");
  let offset = treeEnd + 1 + Number(treeHeader[2]);
  if (batch[offset++] !== 10) throw new Error("truncated_tree_batch");
  for (const entry of scripts) {
    const end = batch.indexOf(10, offset);
    const header = batch.subarray(offset, end).toString();
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.oid) throw new Error("invalid_blob_batch");
    const size = Number(match[2]);
    offset = end + 1;
    entry.text = new TextDecoder("utf-8", { fatal: true }).decode(batch.subarray(offset, offset + size));
    offset += size;
    if (batch[offset++] !== 10) throw new Error("truncated_blob_batch");
  }
  if (offset !== batch.length) throw new Error("unexpected_blob_batch");
  return { sha, tree: treeHeader[1], files };
}
