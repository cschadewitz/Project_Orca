/** Real independent publisher for shared content and index concurrency tests. */
import { sha256, type Artifact } from "@orca/core";
import { FileArtifactStore } from "../../src/artifact-store.js";

const [dir, prefix, encoded] = process.argv.slice(2) as [string, string, string];
const body = Buffer.from(encoded, "base64");
const store = new FileArtifactStore(dir);
for (let i = 0; i < 10; i++) {
  const record: Artifact = {
    id: `${prefix}-${i}`,
    kind: "report",
    name: "shared",
    version: 1,
    mediaType: "text/markdown",
    contentHash: sha256(body),
    size: body.length,
    data: {},
    parents: [],
    producedBy: { runId: "run_test" },
    createdAt: "2026-10-25T00:00:00.000Z",
  };
  await store.put(record, body);
}
