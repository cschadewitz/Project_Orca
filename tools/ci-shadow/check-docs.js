/** Check changed ordinary prose and local link targets without installing or running candidate code. */
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { docsOnly } from "./docs.js";
import { changes, git, snapshot } from "./git.js";

export function checkDocumentation(input) {
  if (git(input.repo, ["rev-parse", "HEAD"]).toString().trim() !== input.candidate)
    throw new Error("checkout_candidate_mismatch");
  if (!docsOnly(input)) throw new Error("ordinary_docs_and_unchanged_consumers_not_proven");
  const candidate = snapshot(input.repo, input.candidate);
  const paths = changes(input.repo, input.base, input.candidate, "merge-candidate").map((record) => record.path);
  for (const path of paths) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      git(input.repo, ["show", `${input.candidate}:${path}`]),
    );
    if (text.includes("\r") || !text.endsWith("\n") || /[ \t]+$/m.test(text))
      throw new Error(`invalid_prose_text:${path}`);
    let fence = null;
    const prose = text
      .split("\n")
      .filter((line) => {
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker;
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
          return false;
        }
        return !fence;
      })
      .join("\n");
    if (fence) throw new Error(`unclosed_prose_fence:${path}`);
    // File targets only. Remote URLs and heading fragments are not network/runtime checks.
    const links = [...prose.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
    for (const link of links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) continue;
      const destination = decodeURIComponent(link.split(/[?#]/)[0]);
      const target = posix.normalize(posix.join(posix.dirname(path), destination));
      if (
        target.startsWith("../") ||
        target.startsWith("/") ||
        (!candidate.files.has(target) && ![...candidate.files.keys()].some((file) => file.startsWith(`${target}/`)))
      )
        throw new Error(`missing_local_documentation_target:${path}`);
    }
  }
  if (git(input.repo, ["rev-parse", "HEAD"]).toString().trim() !== input.candidate)
    throw new Error("checkout_candidate_mismatch");
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checked = checkDocumentation({
    repo: process.cwd(),
    base: process.env.SHADOW_BASE,
    head: process.env.SHADOW_HEAD,
    candidate: process.env.GITHUB_SHA,
  });
  console.log(`Documentation: ${checked.length} inventoried files checked; runtime suite intentionally not run`);
}
