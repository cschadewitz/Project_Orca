/**
 * Concurrent CI runs sharing the self-hosted pool must never stall each other. The job
 * shape (does `check` need the shards, and does it poll for them while holding a runner)
 * is read from the real ci.yml, then every interleaving of N runs on K runners is explored.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));

/** The pool-relevant shape of `check`: when it can start, and whether it then waits holding a runner. */
const shapeOf = (jobs) => {
  const needs = [jobs.check.needs].flat();
  const polls = jobs.check.steps.some(({ run }) => /actions\/runs\/.*\/jobs/.test(run ?? ""));
  return { checkNeedsShards: needs.includes("test"), checkPollsShards: polls };
};

/**
 * Explore every schedule of `runs` CI runs, each with `shards` shard jobs and one `check`,
 * on `runners` interchangeable self-hosted runners. Returns true if some reachable state
 * has unfinished jobs and no possible move (a stall no amount of waiting resolves).
 */
const canStall = ({ checkNeedsShards, checkPollsShards }, runs, shards, runners) => {
  // Per run: each shard and the check is 0 pending, 1 running, 2 done.
  const start = Array.from({ length: runs }, () => ({ shards: Array(shards).fill(0), check: 0 }));
  const key = (state) => JSON.stringify(state);
  const seen = new Set([key(start)]);
  const queue = [start];
  while (queue.length) {
    const state = queue.pop();
    const busy = state.reduce((n, run) => n + run.shards.filter((s) => s === 1).length + (run.check === 1), 0);
    const moves = [];
    state.forEach((run, r) => {
      const shardsDone = run.shards.every((s) => s === 2);
      run.shards.forEach((s, i) => {
        if (s === 0 && busy < runners) moves.push((next) => (next[r].shards[i] = 1));
        if (s === 1) moves.push((next) => (next[r].shards[i] = 2));
      });
      if (run.check === 0 && busy < runners && (!checkNeedsShards || shardsDone))
        moves.push((next) => (next[r].check = 1));
      if (run.check === 1 && (!checkPollsShards || shardsDone)) moves.push((next) => (next[r].check = 2));
    });
    const finished = state.every((run) => run.check === 2 && run.shards.every((s) => s === 2));
    if (!moves.length && !finished) return true;
    for (const move of moves) {
      const next = structuredClone(state);
      move(next);
      if (!seen.has(key(next))) {
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  return false;
};

const sizes = [];
for (const runs of [1, 2, 3])
  for (const shards of [1, 2]) for (const runners of [1, 2, 3]) sizes.push([runs, shards, runners]);

it("ci.yml starts check only after its shards and never polls for them", () => {
  expect(shapeOf(workflow.jobs)).toEqual({ checkNeedsShards: true, checkPollsShards: false });
});

it.each(sizes)("%i concurrent runs with %i shard(s) on %i runner(s) cannot stall", (runs, shards, runners) => {
  expect(canStall(shapeOf(workflow.jobs), runs, shards, runners)).toBe(false);
});

it("the model catches the old shape: check polling for shards while holding a runner", () => {
  const old = { checkNeedsShards: false, checkPollsShards: true };
  // Two runs, two runners, as the total-only picker allowed: both checks start first.
  expect(canStall(old, 2, 1, 2)).toBe(true);
  // A single run on a single runner stalls too, which is why the picker asked for two.
  expect(canStall(old, 1, 1, 1)).toBe(true);
});
