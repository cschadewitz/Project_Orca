/** Positive prose inventory: compare immutable Git objects and keep unknown/structural inputs full. */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { changes, digest, git, identities, snapshot } from "./git.js";

export const DOCS_PATH = "tools/ci-shadow/ordinary-docs.v1.json";
export const loadDocs = () => JSON.parse(readFileSync(new URL("./ordinary-docs.v1.json", import.meta.url), "utf8"));
export const consumerInventory = (files, docs) =>
  digest(
    [...files.values()]
      .filter((entry) => !docs.paths.includes(entry.path))
      .map(({ path, mode, oid }) => ({ path, mode, oid })),
  );

export function docsOnly(input, docs = loadDocs()) {
  const identity = identities(input.repo, input.base, input.head, input.candidate);
  const snaps = [snapshot(input.repo, input.base), snapshot(input.repo, input.candidate)];
  const records = [
    ...changes(input.repo, identity.mergeBase, input.head, "pr-head"),
    ...changes(input.repo, input.head, input.candidate, "merge-candidate"),
  ];
  // Compare the entire non-prose inventory, not just one known Markdown reader.
  // New/changed consumers, configuration, inventories and classifiers invalidate admission.
  return (
    docs.schemaVersion === 1 &&
    new Set(docs.paths).size === docs.paths.length &&
    records.length > 0 &&
    records.every(
      (record) =>
        record.status === "M" &&
        record.oldPath === null &&
        docs.paths.includes(record.path) &&
        snaps.every((snap) => snap.files.get(record.path)?.mode === "100644"),
    ) &&
    consumerInventory(snaps[0].files, docs) === consumerInventory(snaps[1].files, docs) &&
    snaps.every(
      (snap) =>
        snap.files.get(DOCS_PATH)?.text === readFileSync(new URL("./ordinary-docs.v1.json", import.meta.url), "utf8") &&
        ["tools/ci-shadow/docs.js", "tools/ci-shadow/git.js"].every((path) =>
          git(input.repo, ["show", `${snap.sha}:${path}`]).equals(
            readFileSync(new URL(`../../${path}`, import.meta.url)),
          ),
        ),
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let code = true;
  try {
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
      const input = {
        repo: process.cwd(),
        base: process.env.SHADOW_BASE,
        head: process.env.SHADOW_HEAD,
        candidate: process.env.GITHUB_SHA,
      };
      const parents = git(input.repo, ["show", "-s", "--format=%P", input.candidate]).toString().trim().split(" ");
      if (parents.join(" ") !== [input.base, input.head].join(" ")) throw new Error("candidate_parents_mismatch");
      code = !docsOnly(input);
    }
  } catch {
    console.log("Documentation proof unavailable; retaining runtime checks.");
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
  console.log(
    code ? "Runtime checks required" : "Only inventoried ordinary prose changed; documentation checks required",
  );
}
