/**
 * The artifact store the fake bridge answers `artifacts.list` and `artifacts.get` from.
 *
 * It is a second fixture file rather than more data in `fixtures.ts` for the same reason
 * `artifactFixture()` is a second fixture in `packages/daemon/test/fixture.ts`: the run
 * list, the sequence numbers and the durations asserted against that one have to stay
 * exactly what they are, and an artifact story needs three versions of one name, which no
 * run in there has.
 *
 * The story is the daemon fixture's, deliberately: **`run-art` holds three versions of one
 * `spec`, produced by three attempts at one node, and a screenshot that is not text.** The
 * bodies here are longer than the daemon fixture's one-liners so that a `v2 → v3` diff has
 * added *and* removed lines to render; everything else — the ids, the names, the versions,
 * the media types, the omitted reason — is that fixture's, so a panel that works here works
 * against `orca serve` on a real store.
 *
 * The two artifacts `fixtures.ts` already has (`art-spec` on `run-parent`, `art-review` on
 * `run-gate`) are folded in from `RUN_DETAILS` rather than re-typed, so there is one
 * statement of what they are. `ArtifactView` carries no `runId` — a view is what a chip
 * draws, not the index row — so the run each one belongs to is stated here, which is how
 * `artifacts.list({ runId })` can filter the way the daemon does.
 */
import type { ArtifactOmitted, ArtifactView, RunsGetResult } from "@orca/protocol";
import { AS_OF, RUN_DETAILS, START } from "./fixtures.js";

/** Second `n` of the fixture clock, as `fixtures.ts` counts it. */
const at = (n: number): string => new Date(START + n * 1000).toISOString();

/** One row of the artifact index: the view a client lists, the run it is in, and its blob. */
export interface StoredArtifact {
  runId: string;
  view: ArtifactView;
  /** The body, when there is one to show. */
  text?: string;
  /** Present exactly when `text` is absent: it exists and is not being shown. */
  omitted?: ArtifactOmitted;
}

const SPEC_V1 = `# Spec

The SSO callback exchanges the code for a session.
`;

const SPEC_V2 = `# Spec v2

The SSO callback exchanges the code for a session.

- Redirect to the provider
- Exchange the code
- Set the session cookie
`;

const SPEC_V3 = `# Spec v3

The SSO callback exchanges the code for a session.

- Redirect to the provider
- Exchange the code
- Rotate the refresh token
- Set the session cookie
`;

export const SPEC_BODIES: Readonly<Record<number, string>> = { 1: SPEC_V1, 2: SPEC_V2, 3: SPEC_V3 };

/** `spec@v1`, `spec@v2`, `spec@v3` on `run-art`, one per attempt at the `spec` node. */
const SPEC_VERSIONS: StoredArtifact[] = [1, 2, 3].map((version) => ({
  runId: "run-art",
  view: {
    id: `art-spec-v${version}`,
    kind: "spec",
    name: "spec",
    version,
    mediaType: "text/markdown",
    size: SPEC_BODIES[version]?.length ?? 0,
    path: `/work/orca/.orca/artifacts/art-spec-v${version}.md`,
    createdAt: at(4 * version),
    producedByStepRunId: `s-spec-${version}`,
  },
  text: SPEC_BODIES[version] ?? "",
}));

/** The screenshot: a body the wire declines rather than one it does not have. */
const SCREENSHOT: StoredArtifact = {
  runId: "run-art",
  view: {
    id: "art-shot",
    kind: "generic",
    name: "screenshot",
    version: 1,
    mediaType: "image/png",
    size: 4096,
    path: "/work/orca/.orca/artifacts/art-shot.png",
    createdAt: at(13),
    producedByStepRunId: "s-spec-3",
  },
  omitted: { reason: "binary", detail: "image/png is not text; 4.0 kB on disk" },
};

/** The bodies of the two artifacts `fixtures.ts` already describes, by artifact id. */
const EXISTING_BODIES: Readonly<Record<string, string>> = {
  "art-spec": "# Spec\n\nThe SSO callback, as designed.\n",
  "art-review": "# Review\n\nLooks right. Ship it.\n",
};

const EXISTING: StoredArtifact[] = Object.entries(RUN_DETAILS).flatMap(([runId, detail]) =>
  detail.artifacts.map((view) => ({ runId, view, text: EXISTING_BODIES[view.id] ?? "" })),
);

/**
 * The whole store, oldest version first within a name — which is the order
 * `artifacts.list` promises, because `v1, v2, v3` reads in that order.
 */
export const ARTIFACTS: readonly StoredArtifact[] = [...EXISTING, ...SPEC_VERSIONS, SCREENSHOT];

/** By id, for `artifacts.get({ artifactId })`. */
export const ARTIFACTS_BY_ID: ReadonlyMap<string, StoredArtifact> = new Map(ARTIFACTS.map((a) => [a.view.id, a]));

/**
 * `runs.get` for `run-art` — the run the three spec versions belong to. It is not in
 * `RUNS`, so the run list is untouched; a test that needs the panel's consumed-by links on
 * this run scripts `runs.get` with it.
 */
export const RUN_ART: RunsGetResult = {
  run: {
    id: "run-art",
    name: "Spec revisions",
    workflowId: "sdlc",
    workflowVersion: "2",
    status: "succeeded",
    outcome: "success",
    createdAt: at(0),
    startedAt: at(1),
    finishedAt: at(14),
    durationMs: 13000,
  },
  workspace: { hostId: "local", cwd: "/work/orca", repo: "orca", branch: "main" },
  vars: { branch: "feat/sso" },
  steps: [1, 2, 3].map((attempt) => ({
    id: `s-spec-${attempt}`,
    runId: "run-art",
    nodeId: "spec",
    nodeType: "agent",
    attempt,
    status: attempt === 3 ? "succeeded" : "failed",
    scheduledAt: at(4 * attempt - 2),
    startedAt: at(4 * attempt - 1),
    finishedAt: at(4 * attempt),
    durationMs: 1000,
    agentId: "claude",
    agentSessionId: `sess-spec-${attempt}`,
    // The later attempts read the version before them: the panel's consumed-by links.
    inputArtifactIds: attempt === 1 ? [] : [`art-spec-v${attempt - 1}`],
    outputArtifactIds: [`art-spec-v${attempt}`],
    children: [],
    skippedBranches: [],
  })),
  artifacts: [...SPEC_VERSIONS, SCREENSHOT].map((a) => a.view),
  lastSeq: 14,
  asOf: AS_OF,
};
