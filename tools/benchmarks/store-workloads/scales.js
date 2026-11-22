/**
 * Dataset scales for the store workload benchmark (#341). Each scale is a fixed, seeded shape so a
 * run on one backend can be compared with the same run on another. The sizes are chosen against
 * what ORCA stores today (see docs/performance/store-workloads/README.md for the reasoning):
 *
 * - small: one active plan and a handful of runs, a developer's first week.
 * - medium: a long-lived workspace: thousands of work items, runs with 10k-event agent logs.
 * - large: a busy shared daemon: tens of thousands of items, 100k-event runs, big collections.
 *
 * `smoke` is not a scale; it is the self-test's shape, small enough to run in CI on every push.
 */
export const SCALES = {
  smoke: {
    workItems: 20,
    dependencyFanIn: 2,
    traversalSamples: 5,
    runs: 2,
    eventsPerRun: 60,
    pageSize: 10,
    collectionDocs: 20,
    hotDocs: 2,
    opsPerWriter: 8,
    concurrency: [1, 2],
  },
  small: {
    workItems: 250,
    dependencyFanIn: 2,
    traversalSamples: 50,
    runs: 4,
    eventsPerRun: 1_000,
    pageSize: 100,
    collectionDocs: 200,
    hotDocs: 4,
    opsPerWriter: 40,
    concurrency: [1, 4, 16],
  },
  medium: {
    workItems: 2_500,
    dependencyFanIn: 2,
    traversalSamples: 100,
    runs: 4,
    eventsPerRun: 10_000,
    pageSize: 100,
    collectionDocs: 2_000,
    hotDocs: 8,
    opsPerWriter: 40,
    concurrency: [1, 4, 16],
  },
  large: {
    workItems: 25_000,
    dependencyFanIn: 2,
    traversalSamples: 100,
    runs: 2,
    eventsPerRun: 100_000,
    pageSize: 100,
    collectionDocs: 20_000,
    hotDocs: 16,
    opsPerWriter: 20,
    concurrency: [1, 4, 16],
  },
};

export const SCALE_NAMES = Object.keys(SCALES);
