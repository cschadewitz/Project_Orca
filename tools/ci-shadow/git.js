/** Read immutable Git objects and NUL-delimited changes; never execute candidate code. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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

export function commit(repo, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("identity_requires_full_commit_sha");
  if (git(repo, ["cat-file", "-t", sha]).toString().trim() !== "commit") throw new Error("commit_unavailable");
  return sha;
}

export function identities(repo, base, head, candidate) {
  [base, head, candidate].forEach((sha) => commit(repo, sha));
  const bases = git(repo, ["merge-base", "--all", base, head]).toString().trim().split("\n");
  if (bases.length !== 1 || !/^[a-f0-9]{40}$/.test(bases[0])) throw new Error("ambiguous_merge_base");
  for (const sha of [base, head]) git(repo, ["merge-base", "--is-ancestor", sha, candidate]);
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

export function snapshot(repo, sha) {
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
  if (scripts.length) {
    const batch = git(repo, ["cat-file", "--batch"], scripts.map((entry) => entry.oid).join("\n") + "\n");
    let offset = 0;
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
  }
  return {
    sha,
    tree: git(repo, ["rev-parse", `${sha}^{tree}`])
      .toString()
      .trim(),
    files,
  };
}
